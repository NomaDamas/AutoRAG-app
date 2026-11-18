import type { AppSettings } from "./settings-contract";

/** IPC channel names. Keep in 1:1 sync with the main-process handlers. */
export const VOICE_CHANNELS = {
	transcribe: "voice:transcribe",
	prepare: "voice:prepare",
	openMicrophoneSettings: "voice:openMicrophoneSettings",
} as const;

export type VoiceChannel = (typeof VOICE_CHANNELS)[keyof typeof VOICE_CHANNELS];

/**
 * The hosted speech-to-text endpoint takes at most 10 MB and 60 seconds per
 * request. A recording stops itself a few seconds short of the audio limit,
 * and a clip over the size limit is refused before it leaves the computer.
 */
export const VOICE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICE_MAX_SECONDS = 55;

/** The recognition language the server accepts for each interface language. */
const STT_LANGUAGE: Readonly<Record<AppSettings["language"], string>> = {
	ko: "ko-KR",
	en: "en-US",
	ja: "ja-JP",
	zh: "cmn-Hans-CN",
};

export function voiceLanguageCode(language: AppSettings["language"]): string {
	return STT_LANGUAGE[language];
}

/** One recorded clip, as the renderer hands it to the main process. */
export interface VoiceClip {
	/** The recorded bytes (`MediaRecorder` output). */
	readonly audio: ArrayBuffer;
	/** The recorder's MIME type, for example `audio/webm;codecs=opus`. */
	readonly mimeType: string;
	readonly language: AppSettings["language"];
}

export interface VoiceTranscript {
	/** What was said; empty when the service heard no speech. */
	readonly text: string;
	/** Seconds of audio the service billed. */
	readonly seconds: number;
}

/** True when `value` is a clip the main process may send: a non-empty, size-bounded audio clip with a known language. */
export function isVoiceClip(value: unknown): value is VoiceClip {
	if (typeof value !== "object" || value === null) return false;
	const clip = value as Record<string, unknown>;
	return (
		clip.audio instanceof ArrayBuffer &&
		clip.audio.byteLength > 0 &&
		clip.audio.byteLength <= VOICE_MAX_BYTES &&
		typeof clip.mimeType === "string" &&
		/^audio\/[a-z0-9.+-]+(?:;.*)?$/iu.test(clip.mimeType) &&
		typeof clip.language === "string" &&
		Object.hasOwn(STT_LANGUAGE, clip.language)
	);
}

/** The file name the multipart upload carries: the extension tells the service nothing, but the type must match the bytes. */
export function voiceFileName(mimeType: string): string {
	const subtype = mimeType.split(";")[0]?.split("/")[1]?.toLowerCase() ?? "webm";
	const extension = subtype === "mpeg" ? "mp3" : subtype === "x-m4a" || subtype === "mp4" ? "m4a" : subtype;
	return `voice.${extension}`;
}

/**
 * Add a dictated sentence to what is already typed: a space between them when
 * the draft does not already end in whitespace, nothing added to an empty draft.
 */
export function appendTranscript(draft: string, transcript: string): string {
	const text = transcript.trim();
	if (text.length === 0) return draft;
	if (draft.length === 0 || /\s$/u.test(draft)) return `${draft}${text}`;
	return `${draft} ${text}`;
}

/**
 * What stands between the microphone button and a recording. `ready`: record.
 * `signed-out`: the hosted service would refuse the clip, so nothing is
 * recorded. `microphone-denied`: the operating system refuses the app the
 * microphone and only its settings can change that (macOS after a "Don't
 * Allow", Windows with a privacy switch off).
 */
export type VoiceReadiness = "ready" | "signed-out" | "microphone-denied";

/** Exposed to the Finder window as `window.autorag.voice`. */
export interface VoiceBridge {
	/** Rejects with a user-readable message when the sign-in is missing, the service is unreachable, or it refuses the clip. */
	transcribe(clip: VoiceClip): Promise<VoiceTranscript>;
	/**
	 * Checked before every recording: whether the person is signed in, and
	 * whether the app may use the microphone. On macOS the first call raises the
	 * system's own Allow / Don't Allow prompt and waits for the answer.
	 */
	prepare(): Promise<VoiceReadiness>;
	/** Opens the operating system's microphone privacy settings (macOS Privacy & Security › Microphone, Windows Settings › Privacy › Microphone). */
	openMicrophoneSettings(): Promise<void>;
}
