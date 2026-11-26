// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { LATER_MS, putOff, readPutOff, suggestTemplate, type SuggestableTemplate } from "../src/renderer/src/state/automation-suggest";

const NOW = 1_800_000_000_000;
const none = (): boolean => false;

describe("suggestTemplate", () => {
	it.each([
		["ko", "다운로드에 있는 PDF 요약해줘"],
		["en", "summarize the pdfs I downloaded"],
		["ja", "このPDFファイルを要約して"],
		["zh", "帮我总结这个PDF文件"],
		["a file name", "read report-2026.pdf for me"],
	])("finds a PDF question in %s", (_language, question) => {
		expect(suggestTemplate(question, none, {}, NOW)).toBe("pdf");
	});

	it.each([
		["ko", "어제 찍은 스크린샷 찾아줘"],
		["ko, spaced", "스크린 샷 어디 있어?"],
		["ko, 캡처", "화면 캡처한 거 보여줘"],
		["en", "find my latest Screenshot"],
		["en, two words", "where are my screen shots"],
		["ja", "昨日のスクリーンショットはどこ?"],
		["ja, short", "スクショを探して"],
		["zh", "找一下昨天的截图"],
		["zh, 截屏", "我的截屏在哪里"],
	])("finds a screenshot question in %s", (_language, question) => {
		expect(suggestTemplate(question, none, {}, NOW)).toBe("screenshot");
	});

	it("says nothing when no recommendation's words are there", () => {
		expect(suggestTemplate("이번 주 회의록 찾아줘", none, {}, NOW)).toBeNull();
		// A word that only contains the letters is not the file type.
		expect(suggestTemplate("open the pdfcatalog folder", none, {}, NOW)).toBeNull();
	});

	it("puts a screenshot ahead of a PDF when both match", () => {
		expect(suggestTemplate("스크린샷을 PDF로 묶어줘", none, {}, NOW)).toBe("screenshot");
	});

	it("skips a recommendation a rule already does, and falls through to the next", () => {
		const taken = (id: SuggestableTemplate): boolean => id === "screenshot";
		expect(suggestTemplate("스크린샷을 PDF로 묶어줘", taken, {}, NOW)).toBe("pdf");
		expect(suggestTemplate("스크린샷 찾아줘", taken, {}, NOW)).toBeNull();
		expect(suggestTemplate("summarize this pdf", () => true, {}, NOW)).toBeNull();
	});

	it("stays quiet for seven days after 나중에, then may suggest again", () => {
		expect(suggestTemplate("pdf 요약", none, { pdf: NOW - 60_000 }, NOW)).toBeNull();
		expect(suggestTemplate("pdf 요약", none, { pdf: NOW - LATER_MS + 1 }, NOW)).toBeNull();
		expect(suggestTemplate("pdf 요약", none, { pdf: NOW - LATER_MS }, NOW)).toBe("pdf");
		expect(suggestTemplate("pdf 요약", none, { pdf: NOW - 8 * 24 * 60 * 60 * 1000 }, NOW)).toBe("pdf");
		// Putting off one suggestion leaves the other free.
		expect(suggestTemplate("스크린샷을 PDF로", none, { screenshot: NOW - 60_000 }, NOW)).toBe("pdf");
	});
});

describe("putOff and readPutOff", () => {
	afterEach(() => window.localStorage.clear());

	it("remembers when each suggestion was put off", () => {
		expect(readPutOff()).toEqual({});
		putOff("pdf", NOW);
		putOff("screenshot", NOW + 5);
		expect(readPutOff()).toEqual({ pdf: NOW, screenshot: NOW + 5 });
		expect(suggestTemplate("pdf", none, readPutOff(), NOW + 1_000)).toBeNull();
	});

	it("reads a broken store as nothing put off", () => {
		window.localStorage.setItem("dazzi.automationNudge.later", "{not json");
		expect(readPutOff()).toEqual({});
	});
});
