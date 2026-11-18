import { describe, expect, it } from "vitest";
import { APP_LANGUAGES } from "../src/shared/language-contract";
import { appendTranscript, isVoiceClip, VOICE_MAX_BYTES, voiceFileName, voiceLanguageCode } from "../src/shared/voice-contract";

describe("voiceLanguageCode", () => {
	it("maps every interface language to a code the speech service accepts", () => {
		expect(APP_LANGUAGES.map((language) => voiceLanguageCode(language))).toEqual(["ko-KR", "en-US", "ja-JP", "cmn-Hans-CN"]);
	});
});

describe("isVoiceClip", () => {
	const audio = new Uint8Array([1, 2, 3]).buffer;

	it("accepts a recorded clip", () => {
		expect(isVoiceClip({ audio, mimeType: "audio/webm;codecs=opus", language: "ko" })).toBe(true);
	});

	it("refuses an empty clip, an oversized clip, and a clip over the service's size limit by one byte", () => {
		expect(isVoiceClip({ audio: new ArrayBuffer(0), mimeType: "audio/webm", language: "ko" })).toBe(false);
		expect(isVoiceClip({ audio: new ArrayBuffer(VOICE_MAX_BYTES), mimeType: "audio/webm", language: "ko" })).toBe(true);
		expect(isVoiceClip({ audio: new ArrayBuffer(VOICE_MAX_BYTES + 1), mimeType: "audio/webm", language: "ko" })).toBe(false);
	});

	it("refuses a non-audio type, an unknown language, and anything that is not an object", () => {
		expect(isVoiceClip({ audio, mimeType: "text/html", language: "ko" })).toBe(false);
		expect(isVoiceClip({ audio, mimeType: "audio/webm", language: "fr" })).toBe(false);
		expect(isVoiceClip({ audio, mimeType: "audio/webm", language: "__proto__" })).toBe(false);
		expect(isVoiceClip({ audio: [1, 2, 3], mimeType: "audio/webm", language: "ko" })).toBe(false);
		expect(isVoiceClip(null)).toBe(false);
		expect(isVoiceClip("clip")).toBe(false);
	});
});

describe("voiceFileName", () => {
	it("names the upload after the recorder's container", () => {
		expect(voiceFileName("audio/webm;codecs=opus")).toBe("voice.webm");
		expect(voiceFileName("audio/ogg;codecs=opus")).toBe("voice.ogg");
		expect(voiceFileName("audio/mp4")).toBe("voice.m4a");
		expect(voiceFileName("audio/mpeg")).toBe("voice.mp3");
	});
});

describe("appendTranscript", () => {
	it("starts an empty draft with the sentence", () => {
		expect(appendTranscript("", "  지난달 매출을 찾아 줘 ")).toBe("지난달 매출을 찾아 줘");
	});

	it("separates the sentence from typed text by one space, and never doubles an existing one", () => {
		expect(appendTranscript("보고서", "요약해 줘")).toBe("보고서 요약해 줘");
		expect(appendTranscript("보고서 ", "요약해 줘")).toBe("보고서 요약해 줘");
		expect(appendTranscript("보고서\n", "요약해 줘")).toBe("보고서\n요약해 줘");
	});

	it("leaves the draft alone when nothing was heard", () => {
		expect(appendTranscript("보고서", "")).toBe("보고서");
		expect(appendTranscript("보고서", "   ")).toBe("보고서");
	});
});
