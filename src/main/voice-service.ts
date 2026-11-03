import { DEFAULT_ACCOUNT_BASE_URL } from "../shared/account-contract";
import { t } from "../shared/i18n/core";
import { isJsonObject } from "../shared/settings-contract";
import { voiceFileName, voiceLanguageCode, type VoiceClip, type VoiceReadiness, type VoiceTranscript } from "../shared/voice-contract";

/**
 * Dictation for AI Search: a recorded clip goes to the hosted service's
 * `POST /v1/audio/transcriptions` (Google Cloud Speech-to-Text V2, metered
 * against the account's weekly credits) with the account key the sign-in
 * stored. The key never leaves the main process, and nothing is sent unless
 * the person pressed the microphone button and is signed in.
 */

/** The hosted model id: the one the server lists for `GET /v1/models?operation=transcription`. */
const TRANSCRIPTION_MODEL = "google/stt-v2-standard";
/** The service answers within seconds; this is the ceiling for a stuck connection. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The operating system's microphone permission for the app (injected for tests). */
export interface MicrophoneAccess {
	/** `granted`, `denied`, `restricted` or `not-determined`. */
	status(): Promise<string>;
	/** Shows the operating system's prompt; resolves true when the person allowed it. */
	ask(): Promise<boolean>;
	/** Opens the operating system's microphone privacy settings, where a refusal is undone. */
	openSettings(): Promise<void>;
}

/** The two `systemPreferences` calls the adapter uses on macOS. */
export interface MediaAccessPreferences {
	getMediaAccessStatus(mediaType: "microphone"): string;
	askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
}

export interface MicrophoneAccessDeps {
	readonly platform: NodeJS.Platform;
	readonly preferences: MediaAccessPreferences;
	/** Electron `shell.openExternal`: the settings pages are URL schemes. */
	readonly openExternal: (url: string) => Promise<void>;
	/** Runs a program and resolves its stdout; rejects on a non-zero exit (Windows `reg.exe`). */
	readonly run?: (command: string, args: readonly string[]) => Promise<string>;
}

const MAC_MICROPHONE_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const WINDOWS_MICROPHONE_SETTINGS = "ms-settings:privacy-microphone";
/** Windows keeps Settings › Privacy › Microphone here: `Value` on the key is "Microphone access", on `NonPackaged` "Let desktop apps access your microphone". */
const WINDOWS_CONSENT_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";

/**
 * The operating system's microphone permission for this platform.
 *
 * macOS: the TCC status, the system's own Allow / Don't Allow prompt (shown
 * once per app; after a refusal only System Settings can change it).
 *
 * Windows: the two privacy switches the person sets in Settings. Electron's
 * `getMediaAccessStatus` cannot be used there: it reports the WinRT device
 * access of the calling app, which for an unpackaged desktop app is "granted"
 * whatever the switches say (measured on Windows 11 build 26200). A value the
 * person never set is absent from the registry and means on. Windows has no
 * prompt of an app's own: a switch that is off is turned on in Settings.
 *
 * Linux: Electron offers neither call; the browser layer's own permission decides.
 */
export function systemMicrophoneAccess(deps: MicrophoneAccessDeps): MicrophoneAccess {
	if (deps.platform === "darwin") {
		return {
			status: async () => deps.preferences.getMediaAccessStatus("microphone"),
			ask: () => deps.preferences.askForMediaAccess("microphone"),
			openSettings: () => deps.openExternal(MAC_MICROPHONE_SETTINGS),
		};
	}
	if (deps.platform === "win32") {
		const run = deps.run;
		const switchIsOff = async (key: string): Promise<boolean> => {
			if (run === undefined) return false;
			// A missing value is normal on a profile that never touched the switch: `reg query` exits non-zero then.
			const output = await run("reg.exe", ["query", key, "/v", "Value"]).catch(() => "");
			return /^\s*Value\s+REG_SZ\s+Deny\s*$/imu.test(output);
		};
		return {
			status: async () => ((await switchIsOff(WINDOWS_CONSENT_KEY)) || (await switchIsOff(`${WINDOWS_CONSENT_KEY}\\NonPackaged`)) ? "denied" : "granted"),
			ask: async () => true,
			openSettings: () => deps.openExternal(WINDOWS_MICROPHONE_SETTINGS),
		};
	}
	return { status: async () => "granted", ask: async () => true, openSettings: async () => {} };
}

export interface VoiceServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	/** The account key of the signed-in user; null when signed out or rejected. */
	readonly readKey: () => Promise<string | null>;
	readonly microphone: MicrophoneAccess;
	readonly fetch?: typeof fetch;
}

export interface VoiceService {
	transcribe(clip: VoiceClip): Promise<VoiceTranscript>;
	prepare(): Promise<VoiceReadiness>;
	openMicrophoneSettings(): Promise<void>;
}

export function createVoiceService(deps: VoiceServiceDeps): VoiceService {
	const doFetch = deps.fetch ?? fetch;

	function baseUrl(): string {
		const configured = deps.env.AUTORAG_BASE_URL?.trim();
		return (configured !== undefined && configured.length > 0 ? configured : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "");
	}

	async function transcribe(clip: VoiceClip): Promise<VoiceTranscript> {
		const key = await deps.readKey();
		if (key === null) throw new Error(t("main.account.signInFirst"));
		const form = new FormData();
		form.set("file", new Blob([clip.audio], { type: clip.mimeType.split(";")[0] ?? clip.mimeType }), voiceFileName(clip.mimeType));
		form.set("model", TRANSCRIPTION_MODEL);
		form.set("language", voiceLanguageCode(clip.language));
		let response: Response;
		try {
			response = await doFetch(`${baseUrl()}/v1/audio/transcriptions`, {
				method: "POST",
				headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
				body: form,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch {
			throw new Error(t("main.account.unreachable"));
		}
		const body: unknown = await response.json().catch(() => null);
		if (!response.ok) {
			const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : null;
			throw new Error(typeof error?.message === "string" && error.message.length > 0 ? error.message : t("main.account.httpStatus", { status: response.status }));
		}
		if (!isJsonObject(body) || typeof body.text !== "string") throw new Error(t("main.voice.unreadableTranscript"));
		return { text: body.text, seconds: typeof body.duration === "number" && Number.isFinite(body.duration) ? body.duration : 0 };
	}

	async function prepare(): Promise<VoiceReadiness> {
		// Signed out is checked first: the hosted service would refuse the clip, so neither a recording nor the system prompt is worth it.
		if ((await deps.readKey()) === null) return "signed-out";
		const status = await deps.microphone.status();
		if (status === "granted") return "ready";
		// A denied or restricted microphone cannot be asked again: the operating system only reports it, and its settings are where it changes.
		if (status !== "not-determined") return "microphone-denied";
		return (await deps.microphone.ask()) ? "ready" : "microphone-denied";
	}

	return { transcribe, prepare, openMicrophoneSettings: () => deps.microphone.openSettings() };
}
