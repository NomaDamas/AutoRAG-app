// @vitest-environment happy-dom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { setAppLanguage } from "../src/shared/i18n/core";
import { VOICE_MAX_SECONDS, type VoiceBridge, type VoiceClip } from "../src/shared/voice-contract";
import { useVoiceInput, type VoiceInput } from "../src/renderer/src/state/useVoiceInput";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A MediaRecorder that records what the hook asked of it and lets a test end the recording. */
class FakeRecorder {
	static last: FakeRecorder | null = null;
	static supported: Record<string, true> = { "audio/webm;codecs=opus": true };
	static isTypeSupported(type: string): boolean {
		return FakeRecorder.supported[type] === true;
	}
	state: "inactive" | "recording" = "inactive";
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	constructor(
		readonly stream: FakeStream,
		options?: { mimeType?: string },
	) {
		this.mimeType = options?.mimeType ?? "";
		FakeRecorder.last = this;
	}
	start(): void {
		this.state = "recording";
	}
	stop(): void {
		this.state = "inactive";
		this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }) });
		this.onstop?.();
	}
}

class FakeStream {
	stopped = 0;
	getTracks(): { stop(): void }[] {
		return [{ stop: () => (this.stopped += 1) }];
	}
}

let host: HTMLDivElement;
let root: Root;
let input: VoiceInput;
let transcripts: string[];
let submitFlags: boolean[];
let errors: string[];
let bridge: VoiceBridge;
let stream: FakeStream;
let getUserMedia: Mock<() => Promise<FakeStream>>;
let transcribed: VoiceClip[];

function Harness({ language = "ko" as const }: { readonly language?: "ko" | "en" }): ReactElement {
	input = useVoiceInput({
		voice: bridge,
		language,
		onTranscript: (text, submit) => {
			transcripts.push(text);
			submitFlags.push(submit === true);
		},
		onError: (message) => errors.push(message),
	});
	return <span>{input.phase}</span>;
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	setAppLanguage("en");
	transcripts = [];
	submitFlags = [];
	errors = [];
	transcribed = [];
	stream = new FakeStream();
	getUserMedia = vi.fn(async () => stream);
	bridge = {
		prepare: vi.fn(async () => "ready" as const),
		openMicrophoneSettings: vi.fn(async () => {}),
		transcribe: vi.fn(async (clip: VoiceClip) => {
			transcribed.push(clip);
			return { text: "지난달 매출 보고서 찾아 줘", seconds: 3 };
		}),
	};
	FakeRecorder.last = null;
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

async function mount(language: "ko" | "en" = "ko"): Promise<void> {
	await act(async () => root.render(<Harness language={language} />));
}

describe("useVoiceInput", () => {
	it("records on the first toggle and sends the clip with the interface language on the second", async () => {
		await mount("ko");
		expect(input.phase).toBe("idle");

		await act(async () => input.toggle());
		await flush();
		expect(input.phase).toBe("listening");
		expect(bridge.prepare).toHaveBeenCalledOnce();
		expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
		expect(FakeRecorder.last?.mimeType).toBe("audio/webm;codecs=opus");

		await act(async () => input.toggle());
		await flush();

		expect(stream.stopped).toBe(1);
		expect(transcribed).toHaveLength(1);
		expect(transcribed[0]?.language).toBe("ko");
		expect(transcribed[0]?.mimeType).toBe("audio/webm;codecs=opus");
		expect(transcribed[0]?.audio.byteLength).toBe(4);
		expect(transcripts).toEqual(["지난달 매출 보고서 찾아 줘"]);
		expect(errors).toEqual([]);
		expect(input.phase).toBe("idle");
	});

	it("exposes the live microphone stream only while listening so the waveform can read it", async () => {
		await mount();
		expect(input.stream).toBeNull();
		await act(async () => input.toggle());
		await flush();
		expect(input.stream).toBe(stream);
		await act(async () => input.toggle());
		await flush();
		expect(input.stream).toBeNull();
	});

	it("stops by itself a few seconds before the service's limit and still transcribes", async () => {
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => vi.advanceTimersByTime(VOICE_MAX_SECONDS * 1000));
		await flush();
		expect(FakeRecorder.last?.state).toBe("inactive");
		expect(transcribed).toHaveLength(1);
	});

	it("reports silence instead of adding an empty sentence", async () => {
		bridge = { ...bridge, transcribe: vi.fn(async () => ({ text: "  ", seconds: 3 })) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.toggle());
		await flush();
		expect(transcripts).toEqual([]);
		expect(errors).toEqual(["No speech was heard. Please try again."]);
		expect(input.phase).toBe("idle");
	});

	it("asks a signed-out person to sign in and never opens the microphone", async () => {
		bridge = { ...bridge, prepare: vi.fn(async () => "signed-out" as const) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		expect(errors).toEqual(["Sign in to your Dazzi account first."]);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(input.phase).toBe("idle");
	});

	it("opens the permission dialog instead of recording when the system refuses the microphone, and never opens it for anything else", async () => {
		bridge = { ...bridge, prepare: vi.fn(async () => "microphone-denied" as const) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		expect(input.permission).toBe("needed");
		expect(errors).toEqual([]);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(input.phase).toBe("idle");
	});

	it("the dialog's settings button opens the system's microphone settings and the dialog waits for the person to come back", async () => {
		bridge = { ...bridge, prepare: vi.fn(async () => "microphone-denied" as const), openMicrophoneSettings: vi.fn(async () => {}) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.openSettings());
		await flush();
		expect(bridge.openMicrophoneSettings).toHaveBeenCalledOnce();
		expect(input.permission).toBe("waiting");
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("starts recording by itself once the person allowed the microphone in the system settings and came back to the app", async () => {
		const prepare = vi.fn<() => Promise<"ready" | "microphone-denied" | "signed-out">>(async () => "microphone-denied");
		bridge = { ...bridge, prepare, openMicrophoneSettings: vi.fn(async () => {}) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.openSettings());
		await flush();
		prepare.mockResolvedValue("ready");
		await act(async () => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(input.permission).toBe(null);
		expect(input.phase).toBe("listening");
		expect(getUserMedia).toHaveBeenCalledOnce();
	});

	it("keeps the dialog open when the person came back without allowing it, and closes it without recording when dismissed", async () => {
		bridge = { ...bridge, prepare: vi.fn(async () => "microphone-denied" as const), openMicrophoneSettings: vi.fn(async () => {}) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.openSettings());
		await flush();
		await act(async () => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(input.permission).toBe("still-denied");
		await act(async () => input.dismissPermission());
		await act(async () => window.dispatchEvent(new Event("focus")));
		await flush();
		expect(input.permission).toBe(null);
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it("opens the dialog when the operating system refuses the stream even though its switch looked on", async () => {
		getUserMedia.mockRejectedValueOnce(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
		await mount();
		await act(async () => input.toggle());
		await flush();
		expect(input.permission).toBe("needed");
		expect(errors).toEqual([]);
		expect(input.phase).toBe("idle");
	});

	it("shows the unavailable message instead of an unhandled rejection when the readiness check itself fails", async () => {
		bridge = { ...bridge, prepare: vi.fn(async () => { throw new Error("voice.prepare is not available from a browser"); }) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		expect(errors).toEqual(["No microphone is available on this device."]);
		expect(getUserMedia).not.toHaveBeenCalled();
		expect(input.phase).toBe("idle");
	});

	it("tells a missing microphone from a refused one", async () => {
		getUserMedia.mockRejectedValueOnce(Object.assign(new Error("none"), { name: "NotFoundError" }));
		await mount();
		await act(async () => input.toggle());
		await flush();
		expect(errors).toEqual(["No microphone is available on this device."]);
		expect(input.phase).toBe("idle");
	});

	it("shows the service's message when transcription fails and returns to idle so the person can retry", async () => {
		bridge = { ...bridge, transcribe: vi.fn(async () => { throw new Error("Error invoking remote method 'voice:transcribe': Error: Weekly usage quota exceeded"); }) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.toggle());
		await flush();
		expect(errors).toEqual(["Could not transcribe your voice: Weekly usage quota exceeded"]);
		expect(input.phase).toBe("idle");
	});

	it("ignores a toggle while the clip is being transcribed", async () => {
		let release: (value: { text: string; seconds: number }) => void = () => {};
		bridge = { ...bridge, transcribe: vi.fn(() => new Promise<{ text: string; seconds: number }>((resolve) => { release = resolve; })) };
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.toggle());
		await flush();
		expect(input.phase).toBe("transcribing");
		await act(async () => input.toggle());
		await flush();
		expect(bridge.transcribe).toHaveBeenCalledOnce();
		await act(async () => release({ text: "안녕", seconds: 1 }));
		await flush();
		expect(transcripts).toEqual(["안녕"]);
	});

	it("releases the microphone without transcribing when cancelled or unmounted mid-recording", async () => {
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.cancel());
		await flush();
		expect(stream.stopped).toBe(1);
		expect(bridge.transcribe).not.toHaveBeenCalled();
		expect(input.phase).toBe("idle");

		await act(async () => input.toggle());
		await flush();
		act(() => root.unmount());
		expect(stream.stopped).toBe(2);
		expect(bridge.transcribe).not.toHaveBeenCalled();
		root = createRoot(host);
	});

	it("distinguishes stopping into the draft from stopping to send immediately", async () => {
		await mount();
		await act(async () => input.toggle());
		await flush();
		await act(async () => input.toggle());
		await flush();

		await act(async () => input.toggle());
		await flush();
		await act(async () => input.stopAndSend());
		await flush();

		expect(submitFlags).toEqual([false, true]);
	});
});
