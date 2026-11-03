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

/** The slice of Electron's `systemPreferences` the microphone check needs (injected for tests). */
export interface MicrophoneAccess {
	/** `granted`, `denied`, `restricted` or `not-determined`. */
	status(): string;
	/** Shows the operating system's prompt; resolves true when the person allowed it. */
	ask(): Promise<boolean>;
}

/** The two `systemPreferences` calls the adapter uses; Electron has the first on macOS and Windows, the second on macOS only. */
export interface MediaAccessPreferences {
	getMediaAccessStatus(mediaType: "microphone"): string;
	askForMediaAccess(mediaType: "microphone"): Promise<boolean>;
}

/**
 * The operating system's microphone permission for this platform. macOS
 * reports it and can raise its prompt; Windows reports it (a privacy switch the
 * person controls) but the app has no prompt to raise; on Linux Electron offers
 * neither, so the web layer's own permission decides.
 */
export function systemMicrophoneAccess(platform: NodeJS.Platform, preferences: MediaAccessPreferences): MicrophoneAccess {
	if (platform === "darwin") {
		return { status: () => preferences.getMediaAccessStatus("microphone"), ask: () => preferences.askForMediaAccess("microphone") };
	}
	if (platform === "win32") {
		return { status: () => preferences.getMediaAccessStatus("microphone"), ask: async () => true };
	}
	return { status: () => "granted", ask: async () => true };
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
		const status = deps.microphone.status();
		if (status === "granted") return "ready";
		// A denied or restricted microphone cannot be asked again: the operating system only reports it, and its settings are where it changes.
		if (status !== "not-determined") return "microphone-denied";
		return (await deps.microphone.ask()) ? "ready" : "microphone-denied";
	}

	return { transcribe, prepare };
}
