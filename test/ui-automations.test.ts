import { afterEach, describe, expect, it } from "vitest";
import {
	actionShort,
	addPrompt,
	agentAccessText,
	editPrompt,
	failReason,
	folderLabel,
	foldersText,
	kindsText,
	lastRunText,
	relativeTime,
	ruleTitle,
	rulesWatching,
	runTone,
	whatText,
	whenText,
} from "../src/renderer/src/state/automations";
import type { AutomationRule, AutomationRun } from "../src/shared/automation-contract";
import { setAppLanguage } from "../src/shared/i18n/core";

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);
const MIN = 60_000;

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
	return { startedAt: NOW - 3 * MIN, durationMs: 21_000, eventCount: 1, exitCode: 0, signal: null, timedOut: false, ...overrides };
}

function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
	return {
		id: "downloads-pdf-summary",
		paths: ["/Users/jeffrey/Downloads"],
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "search", "이 문서를 세 줄로 요약해줘"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: run(),
		...overrides,
	};
}

afterEach(async () => {
	await setAppLanguage("ko");
});

describe("folder names", () => {
	it("calls a home folder by the name the Finder sidebar gives it, in the interface language", async () => {
		expect(folderLabel("/Users/jeffrey/Downloads")).toBe("다운로드");
		expect(folderLabel("/Users/jeffrey/Desktop/")).toBe("데스크탑");
		await setAppLanguage("en");
		expect(folderLabel("/Users/jeffrey/Downloads")).toBe("Downloads");
		expect(folderLabel("/home/jeffrey/Documents")).toBe("Documents");
		expect(folderLabel("C:\\Users\\jeffrey\\Pictures")).toBe("Pictures");
	});

	it("keeps the real name of any other folder, including one that merely shares a home folder's name", () => {
		expect(folderLabel("/Users/jeffrey/Documents/Notes")).toBe("Notes");
		expect(folderLabel("/srv/projects/Downloads")).toBe("Downloads");
	});

	it("names the first of several folders and counts the rest", async () => {
		expect(foldersText(["/Users/j/Documents/Notes", "/Users/j/Documents/Projects"])).toBe("Notes 외 1곳");
		await setAppLanguage("en");
		expect(foldersText(["/Users/j/Documents/Notes", "/a/b", "/a/c"])).toBe("Notes and 2 more");
		expect(foldersText(["/Users/j/Downloads"])).toBe("Downloads");
	});
});

describe("file kinds from include globs", () => {
	it("maps extensions to the kind a person says, merging spellings of one kind", () => {
		expect(kindsText(["**/*.pdf"])).toBe("PDF");
		expect(kindsText(["**/*.hwp", "**/*.hwpx"])).toBe("HWP");
		expect(kindsText(["**/*.jpg", "**/*.jpeg", "**/*.heic", "**/*.PNG"])).toBe("이미지");
		expect(kindsText(["**/*.pdf", "**/*.docx"])).toBe("PDF·Word");
	});

	it("says every file for the default glob and screenshot for a screenshot pattern", () => {
		expect(kindsText(["**"])).toBe("모든 파일");
		expect(kindsText(["Screen Shot*.png"])).toBe("스크린샷");
		expect(kindsText(["Screenshot*.png", "스크린샷*.png"])).toBe("스크린샷");
	});

	it("shows an unknown extension as itself and a pattern it cannot read as written", () => {
		expect(kindsText(["**/*.xyz"])).toBe(".xyz");
		expect(kindsText(["invoices/**"])).toBe("invoices/**");
	});

	it("shortens a long mix to the first three kinds", () => {
		expect(kindsText(["**/*.pdf", "**/*.docx", "**/*.xlsx", "**/*.md", "**/*.txt"])).toBe("PDF·Word·Excel 외 2종");
	});
});

describe("the sentence a person reads", () => {
	it("titles a rule by its trigger and its action", () => {
		expect(ruleTitle(rule())).toBe("새 PDF → Dazzi에게 맡기기");
		expect(ruleTitle(rule({ events: ["create", "update", "delete"], include: ["**"], run: ["autorag", "refresh"] }))).toBe("파일 변경 → 검색 색인 최신화");
		expect(ruleTitle(rule({ include: ["**"], run: ["autorag", "search", "x"] }))).toBe("새 파일 → Dazzi에게 맡기기");
	});

	it("names a script rule by the script, not by the runtime that starts it", () => {
		const script = rule({ include: ["**/*.heic"], run: ["node", "/Users/jeffrey/.autorag/bin/to-png.mjs"] });
		expect(actionShort(script)).toBe("to-png.mjs 실행");
		expect(whatText(script)).toBe("to-png.mjs 프로그램으로 처리");
		expect(actionShort(rule({ run: ["/opt/homebrew/bin/hwp5", "--to", "pdf"] }))).toBe("hwp5 실행");
	});

	it("says when the rule fires, with the folder first in Korean and last in English", async () => {
		expect(whenText(rule())).toBe("다운로드에 PDF 파일이 새로 생기면");
		expect(whenText(rule({ events: ["create", "update"], paths: ["/Users/j/Documents/Notes", "/Users/j/Documents/Projects"], include: ["**/*.md"] }))).toBe("Notes 외 1곳에 Markdown 파일이 생기거나 수정되면");
		expect(whenText(rule({ events: ["create", "update", "delete"], include: ["**"] }))).toBe("다운로드에 파일이 바뀔 때마다");
		await setAppLanguage("en");
		expect(whenText(rule())).toBe("PDF files are created in Downloads");
		expect(whenText(rule({ events: ["create", "update", "delete"], include: ["**"] }))).toBe("Files change in Downloads");
	});

	it("keeps the whole instruction for a card and cuts it for a narrow list", () => {
		const long = rule({ run: ["autorag", "search", "이 문서를 세 줄로 요약해서 같은 폴더에 요약.md로 저장해줘"] });
		expect(whatText(long, { full: true })).toBe("“이 문서를 세 줄로 요약해서 같은 폴더에 요약.md로 저장해줘”");
		expect(whatText(long)).toBe("“이 문서를 세 줄로 요약해서 같은 폴더에…”");
		expect(whatText(rule({ run: ["autorag", "refresh"] }))).toBe("검색 색인을 최신으로 맞춤");
	});

	it("reads in every interface language", async () => {
		for (const language of ["en", "ja", "zh"] as const) {
			await setAppLanguage(language);
			const text = [ruleTitle(rule()), whenText(rule()), whatText(rule({ run: ["autorag", "refresh"] }))].join(" ");
			expect(text, language).not.toMatch(/[\uac00-\ud7a3]/);
			expect(text, language).not.toContain("automations.");
		}
	});
});

describe("a rule that runs an AI agent", () => {
	const triage = rule({
		include: ["**/*.pdf"],
		run: [],
		agent: { profile: "file-triage", task: "Summarize each new PDF in three lines" },
	});
	const organizer = rule({ run: [], agent: { profile: "file-organizer", task: "Move each new PDF into a folder named for its year" } });

	it("names the action as the AI doing it, not as a program called nothing", () => {
		expect(actionShort(triage)).toBe("AI가 처리하기");
		expect(ruleTitle(triage)).toBe("새 PDF → AI가 처리하기");
	});

	it("says what the agent was asked, in full for a card and cut for a narrow list", () => {
		expect(whatText(triage, { full: true })).toBe("“Summarize each new PDF in three lines”");
		expect(whatText(organizer)).toBe("“Move each new PDF into…”");
		expect(whatText(organizer, { full: true })).toBe("“Move each new PDF into a folder named for its year”");
	});

	it("says whether the agent only reads or may change files", () => {
		expect(agentAccessText(triage)).toBe("읽기만 함");
		expect(agentAccessText(organizer)).toBe("파일을 바꿀 수 있음");
		expect(agentAccessText(rule())).toBeNull();
	});

	it("reads in every interface language", async () => {
		for (const language of ["en", "ja", "zh"] as const) {
			await setAppLanguage(language);
			const text = [ruleTitle(triage), whatText(triage), agentAccessText(triage), agentAccessText(organizer)].join(" ");
			expect(text, language).not.toMatch(/[\uac00-\ud7a3]/);
			expect(text, language).not.toContain("automations.");
		}
	});
});

describe("how the last run went", () => {
	it("tells a clean exit from a failure, a timeout, a missing program, and no run yet", () => {
		expect(runTone(null)).toBe("never");
		expect(runTone(run())).toBe("ok");
		expect(runTone(run({ exitCode: 2 }))).toBe("fail");
		expect(runTone(run({ exitCode: null, timedOut: true }))).toBe("fail");
		expect(runTone(run({ exitCode: null, error: "spawn hwp5 ENOENT" }))).toBe("fail");
	});

	it("explains a failure in words", async () => {
		expect(failReason(run({ exitCode: null, timedOut: true }))).toBe("시간 초과");
		expect(failReason(run({ exitCode: null, error: "spawn hwp5 ENOENT" }))).toBe("‘hwp5’ 프로그램을 찾을 수 없음");
		expect(failReason(run({ exitCode: 2 }))).toBe("오류 코드 2");
		expect(failReason(run({ exitCode: null, error: "EACCES: permission denied" }))).toBe("EACCES: permission denied");
		await setAppLanguage("en");
		expect(failReason(run({ exitCode: null, error: "spawn hwp5 ENOENT" }))).toBe("Program ‘hwp5’ was not found");
	});

	it("writes relative times in the interface language", async () => {
		expect(relativeTime(NOW - 20_000, NOW)).toBe("방금");
		expect(relativeTime(NOW - 3 * MIN, NOW)).toBe("3분 전");
		expect(relativeTime(NOW - 41 * MIN, NOW)).toBe("41분 전");
		expect(relativeTime(NOW - 19 * 60 * MIN, NOW)).toBe("19시간 전");
		expect(relativeTime(NOW - 3 * 24 * 60 * MIN, NOW)).toBe("3일 전");
		await setAppLanguage("en");
		expect(relativeTime(NOW - 3 * MIN, NOW)).toBe("3 minutes ago");
		expect(relativeTime(NOW - 20_000, NOW)).toBe("just now");
	});

	it("never prints a future time for a clock that ran backwards", () => {
		expect(relativeTime(NOW + 5 * MIN, NOW)).toBe("방금");
	});

	it("summarises the last run for a list row", () => {
		expect(lastRunText(rule(), NOW)).toBe("3분 전 · 성공");
		expect(lastRunText(rule({ lastRun: run({ exitCode: 1 }) }), NOW)).toBe("3분 전 · 실패");
		expect(lastRunText(rule({ lastRun: null }), NOW)).toBe("아직 실행 안 됨");
	});
});

describe("rules that watch a folder", () => {
	const downloads = rule({ id: "a", paths: ["/Users/j/Downloads"] });
	const notes = rule({ id: "b", paths: ["/Users/j/Documents/Notes", "/Users/j/Documents/Projects"] });
	const rules = [downloads, notes];

	it("matches the watched folder itself and any folder inside it, since the watch is recursive", () => {
		expect(rulesWatching(rules, "/Users/j/Downloads").map((r) => r.id)).toEqual(["a"]);
		expect(rulesWatching(rules, "/Users/j/Downloads/2026/invoices").map((r) => r.id)).toEqual(["a"]);
		expect(rulesWatching(rules, "/Users/j/Documents/Projects").map((r) => r.id)).toEqual(["b"]);
	});

	it("does not match a parent, a sibling, or a folder that only shares a name prefix", () => {
		expect(rulesWatching(rules, "/Users/j/Documents")).toEqual([]);
		expect(rulesWatching(rules, "/Users/j/Downloads-old")).toEqual([]);
		expect(rulesWatching(rules, "/Users/j")).toEqual([]);
	});

	it("is not fooled by a trailing slash or Windows separators", () => {
		expect(rulesWatching(rules, "/Users/j/Downloads/").map((r) => r.id)).toEqual(["a"]);
		const windows = rule({ id: "w", paths: ["C:\\Users\\j\\Downloads"] });
		expect(rulesWatching([windows], "C:\\Users\\j\\Downloads\\sub").map((r) => r.id)).toEqual(["w"]);
	});
});

describe("the prompts that open an AI Search draft", () => {
	it("asks to change this rule by id, with what it does now, and leaves the change for the person to type", () => {
		const prompt = editPrompt(rule());
		expect(prompt).toContain("downloads-pdf-summary");
		expect(prompt).toContain("다운로드에 PDF 파일이 새로 생기면");
		expect(prompt.endsWith(": ")).toBe(true);
		expect(prompt).not.toContain("\n");
	});

	it("asks to create a rule and ends where the person starts typing", () => {
		expect(addPrompt()).toBe("새 자동화 규칙을 만들어줘. 언제, 어떤 파일에, 무엇을 할지: ");
	});

	it("is written in the interface language, with the rule named the same way", async () => {
		await setAppLanguage("en");
		expect(editPrompt(rule())).toBe("Edit this automation rule — downloads-pdf-summary (PDF files are created in Downloads). What to change: ");
		expect(addPrompt()).toBe("Create a new automation rule. When, on which files, and what to do: ");
		for (const language of ["ja", "zh"] as const) {
			await setAppLanguage(language);
			const text = editPrompt(rule()) + addPrompt();
			expect(text, language).not.toMatch(/[\uac00-\ud7a3]/);
			expect(text, language).toContain("downloads-pdf-summary");
		}
	});
});
