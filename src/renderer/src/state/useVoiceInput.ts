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
	/** Called with the sentence that was heard (never empty). */
	readonly onTranscript: (text: string) => void;
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
	/** Whole seconds recorded so far while `listening`. */
	readonly seconds: number;
	readonly permission: VoicePermission;
	/** Starts recording; while recording, ends it and sends the clip; while transcribing, does nothing. */
	toggle(): void;
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
}

/**
 * Dictation for the AI Search composer: record from the microphone, send the
 * clip through `window.autorag.voice`, and hand back the text. The microphone
 * is held only while recording and released on stop, cancel, error and unmount.
 */
export function useVoiceInput(options: VoiceInputOptions): VoiceInput {
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const [seconds, setSeconds] = useState(0);
	const phaseRef = useRef<VoicePhase>("idle");
	const recordingRef = useRef<Recording | null>(null);
	const timerRef = useRef<number | undefined>(undefined);
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
		window.clearInterval(timerRef.current);
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
			onTranscript(text);
		} catch (error) {
			if (mountedRef.current) fail(t("aiSearch.voiceFailed", { message: conversionErrorMessage(error) }));
		}
	}

	function finish(recording: Recording): void {
		clearTimer();
		recordingRef.current = null;
		for (const track of recording.stream.getTracks()) track.stop();
		if (recording.cancelled || !mountedRef.current) {
			if (mountedRef.current) move("idle");
			return;
		}
		setSeconds(0);
		move("transcribing");
		void send(recording);
	}

	async function start(): Promise<void> {
		move("listening");
		setSeconds(0);
		const { voice } = optionsRef.current;
		let readiness: VoiceReadiness;
		try {
			readiness = await voice.prepare();
		} catch {
			fail(t("aiSearch.voiceUnavailable"));
			return;
		}
		if (readiness === "signed-out") {
			fail(t("main.account.signInFirst"));
			return;
		}
		if (readiness === "microphone-denied") {
			move("idle");
			showPermission("needed");
			return;
		}
		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (error) {
			move("idle");
			// The OS refused the stream although its switch looked on (a policy, or a choice made since): the same way out.
			if (error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError")) showPermission("needed");
			else optionsRef.current.onError(t("aiSearch.voiceUnavailable"));
			return;
		}
		if (!mountedRef.current) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}
		const mimeType = recorderMimeType();
		const recorder = new MediaRecorder(stream, mimeType === undefined ? undefined : { mimeType });
		const recording: Recording = { recorder, stream, chunks: [], mimeType: recorder.mimeType || mimeType || "audio/webm", cancelled: false };
		recorder.ondataavailable = (event) => {
			if (event.data.size > 0) recording.chunks.push(event.data);
		};
		recorder.onstop = () => finish(recording);
		recordingRef.current = recording;
		recorder.start();
		const startedAt = Date.now();
		timerRef.current = window.setInterval(() => {
			const elapsed = Math.floor((Date.now() - startedAt) / 1000);
			setSeconds(elapsed);
			// Stop a few seconds before the service's 60 s limit so a long dictation is sent instead of refused.
			if (elapsed >= VOICE_MAX_SECONDS && recorder.state === "recording") recorder.stop();
		}, 250);
	}

	function toggle(): void {
		if (phaseRef.current === "transcribing") return;
		const recording = recordingRef.current;
		if (phaseRef.current === "listening") {
			// Between the button press and the stream opening there is no recorder yet: a second press ends nothing.
			if (recording !== null && recording.recorder.state === "recording") recording.recorder.stop();
			return;
		}
		showPermission(null);
		void start();
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

	return { phase, seconds, permission, toggle, cancel, openSettings, dismissPermission: () => showPermission(null) };
}
