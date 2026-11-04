import { useEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n/core";
import type { AppSettings } from "../../../shared/settings-contract";
import { VOICE_MAX_SECONDS, type VoiceBridge, type VoiceReadiness } from "../../../shared/voice-contract";
import { conversionErrorMessage } from "./convert-rename";

/** What the microphone button is doing: nothing, recording, or waiting for the transcript. */
export type VoicePhase = "idle" | "listening" | "transcribing";

export interface VoiceInputOptions {
	readonly voice: VoiceBridge;
	/** The Interface language: the language the speech is recognized in. */
	readonly language: AppSettings["language"];
	/** Called with the sentence that was heard (never empty); `submit` is true when stopped via the send button. */
	readonly onTranscript: (text: string, submit?: boolean) => void;
	/** Called with a message to show; the hook is back at `idle` when it fires. */
	readonly onError: (message: string) => void;
}

/**
 * The microphone-permission dialog. `needed`: the OS refuses the app the
 * microphone. `waiting`: the system settings were opened; the app checks again
 * when it regains focus. `still-denied`: it came back and the switch is still
 * off. null: no dialog.
 */
export type VoicePermission = "needed" | "waiting" | "still-denied" | null;

export interface VoiceInput {
	readonly phase: VoicePhase;
	/** Live microphone stream while `listening` (null before `getUserMedia` resolves and after stopping). */
	readonly stream: MediaStream | null;
	readonly permission: VoicePermission;
	/** Starts recording; while recording, ends it and sends the clip; while transcribing, does nothing. */
	toggle(): void;
	/** Ends a recording, transcribes it, and asks the caller to submit immediately. */
	stopAndSend(): void;
	/** Ends a recording without sending it. */
	cancel(): void;
	/** The dialog's main button: opens the OS microphone settings and waits for the person to come back. */
	openSettings(): void;
	/** Closes the dialog without recording. */
	dismissPermission(): void;
}

/** Containers `MediaRecorder` may offer, best first: the speech service decodes all of them. */
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"] as const;

function recorderMimeType(): string | undefined {
	return MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** A recording in progress: stopping it hands over the clip, cancelling it hands over nothing. */
interface Recording {
	readonly recorder: MediaRecorder;
	readonly stream: MediaStream;
	readonly chunks: Blob[];
	readonly mimeType: string;
	/** True once the person cancelled: the clip is dropped instead of sent. */
	cancelled: boolean;
	/** True when stopped with the direct-send button rather than stop-to-draft. */
	submit: boolean;
}

/**
 * Dictation for the AI Search composer: record from the microphone, send the
 * clip through `window.autorag.voice`, and hand back the text. The microphone
 * is held only while recording and released on stop, cancel, error and unmount.
 */
export function useVoiceInput(options: VoiceInputOptions): VoiceInput {
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [stream, setStream] = useState<MediaStream | null>(null);
	const phaseRef = useRef<VoicePhase>("idle");
	const recordingRef = useRef<Recording | null>(null);
	const timerRef = useRef<number | undefined>(undefined);
	const startingRef = useRef(false);
	/** Newest options without re-creating the handlers: the recorder's callbacks outlive a render. */
	const optionsRef = useRef(options);
	optionsRef.current = options;
	/** False after unmount, so a late transcript never sets state or reaches the composer. */
	const mountedRef = useRef(true);
	const [permission, setPermission] = useState<VoicePermission>(null);
	/** The dialog's state for the focus listener, which outlives the render that set it. */
	const permissionRef = useRef<VoicePermission>(null);

	function move(next: VoicePhase): void {
		phaseRef.current = next;
		setPhase(next);
	}

	function showPermission(next: VoicePermission): void {
		permissionRef.current = next;
		setPermission(next);
	}

	function clearTimer(): void {
		window.clearTimeout(timerRef.current);
		timerRef.current = undefined;
	}

	function fail(message: string): void {
		move("idle");
		optionsRef.current.onError(message);
	}

	async function send(recording: Recording): Promise<void> {
		const blob = new Blob(recording.chunks, { type: recording.mimeType });
		const { voice, language, onTranscript } = optionsRef.current;
		try {
			const result = await voice.transcribe({ audio: await blob.arrayBuffer(), mimeType: recording.mimeType, language });
			if (!mountedRef.current) return;
			const text = result.text.trim();
			if (text.length === 0) {
				fail(t("aiSearch.voiceNoSpeech"));
				return;
			}
			move("idle");
			onTranscript(text, recording.submit);
		} catch (error) {
			if (mountedRef.current) fail(t("aiSearch.voiceFailed", { message: conversionErrorMessage(error) }));
		}
	}

	function finish(recording: Recording): void {
		clearTimer();
		recordingRef.current = null;
		for (const track of recording.stream.getTracks()) track.stop();
		if (!mountedRef.current) return;
		setStream(null);
		if (recording.cancelled) {
			move("idle");
			return;
		}
		move("transcribing");
		void send(recording);
	}

	async function start(): Promise<void> {
		startingRef.current = true;
		const { voice } = optionsRef.current;
		let readiness: VoiceReadiness;
		try {
			readiness = await voice.prepare();
		} catch {
			startingRef.current = false;
			fail(t("aiSearch.voiceUnavailable"));
			return;
		}
		if (readiness === "signed-out") {
			startingRef.current = false;
			fail(t("main.account.signInFirst"));
			return;
		}
		if (readiness === "microphone-denied") {
			startingRef.current = false;
			move("idle");
			showPermission("needed");
			return;
		}
		let liveStream: MediaStream;
		try {
			liveStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			startingRef.current = false;
			move("idle");
			// The OS refused the stream although its switch looked on (a policy, or a choice made since): the same way out.
			if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")) showPermission("needed");
			else optionsRef.current.onError(t("aiSearch.voiceUnavailable"));
			return;
		}
		startingRef.current = false;
		if (!mountedRef.current) {
			for (const track of liveStream.getTracks()) track.stop();
			return;
		}
		const mimeType = recorderMimeType();
		const recorder = new MediaRecorder(liveStream, mimeType === undefined ? undefined : { mimeType });
		const recording: Recording = { recorder, stream: liveStream, chunks: [], mimeType: recorder.mimeType || mimeType || "audio/webm", cancelled: false, submit: false };
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) recording.chunks.push(event.data);
		};
		recorder.onstop = () => finish(recording);
		recordingRef.current = recording;
		setStream(liveStream);
		move("listening");
		recorder.start();
		// Stop a few seconds before the service's 60 s limit so a long dictation is sent instead of refused.
		timerRef.current = window.setTimeout(() => {
			if (recorder.state === "recording") recorder.stop();
		}, VOICE_MAX_SECONDS * 1000);
	}

	function toggle(): void {
		if (phaseRef.current === "transcribing" || startingRef.current) return;
		const recording = recordingRef.current;
		if (phaseRef.current === "listening") {
			if (recording !== null && recording.recorder.state === "recording") recording.recorder.stop();
			return;
		}
		showPermission(null);
		void start();
	}


	function stopAndSend(): void {
		const recording = recordingRef.current;
		if (phaseRef.current !== "listening" || recording === null || recording.recorder.state !== "recording") return;
		recording.submit = true;
		recording.recorder.stop();
	}
	function cancel(): void {
		const recording = recordingRef.current;
		if (recording === null) return;
		recording.cancelled = true;
		if (recording.recorder.state === "recording") recording.recorder.stop();
		else finish(recording);
	}

	// Back from the system settings: the app regains focus, and if the microphone is now allowed the recording the person asked for starts.
	useEffect(() => {
		if (permission !== "waiting" && permission !== "still-denied") return;
		const recheck = (): void => {
			void optionsRef.current.voice
				.prepare()
				.catch((): VoiceReadiness => "microphone-denied")
				.then((readiness) => {
					if (!mountedRef.current || permissionRef.current === null) return;
					if (readiness === "microphone-denied") {
						showPermission("still-denied");
						return;
					}
					showPermission(null);
					void start();
				});
		};
		window.addEventListener("focus", recheck);
		return () => window.removeEventListener("focus", recheck);
	}, [permission]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			clearTimer();
			const recording = recordingRef.current;
			if (recording === null) return;
			// `finish` is the one place the microphone is released: it runs from the recorder's stop event.
			recording.cancelled = true;
			if (recording.recorder.state === "recording") recording.recorder.stop();
			else finish(recording);
		};
	}, []);

	function openSettings(): void {
		showPermission("waiting");
		void optionsRef.current.voice.openMicrophoneSettings().catch(() => showPermission("still-denied"));
	}

	return { phase, stream, permission, toggle, stopAndSend, cancel, openSettings, dismissPermission: () => showPermission(null) };
}
