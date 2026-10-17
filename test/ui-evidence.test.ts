import { describe, expect, it } from "vitest";
import {
	collectSessionEvidence,
	evidenceDetail,
	evidenceHeading,
	evidenceKind,
	evidenceSourceUrl,
	findEvidenceSource,
	isLocalEvidenceSource,
	sessionEvidencePaths,
	unresolvedCitationNumbers,
} from "../src/renderer/src/state/evidence";

describe("findEvidenceSource", () => {
	const source = "/Documents/참고 자료/Andrej Karpathy가 추천한 nanoclaw 사용기.pdf";
	const decomposed = { path: source.normalize("NFD") };

	it("matches a composed citation to a decomposed filename and keeps the listing identity", () => {
		expect(findEvidenceSource([decomposed], source)).toBe(decomposed);
	});

	it("matches a decomposed citation to a composed filename", () => {
		const composed = { path: source };
		expect(findEvidenceSource([composed], source.normalize("NFD"))).toBe(composed);
	});

	it("prefers the exact filename when canonically equivalent files both exist", () => {
		const exact = { path: source };
		expect(findEvidenceSource([decomposed, exact], source)).toBe(exact);
	});

	it("does not rewrite spaces, case, or URI escapes into a different file", () => {
		const entry = { path: "/Documents/Café notes.pdf" };
		for (const wrong of ["Café  notes.pdf", "café notes.pdf", "Café%20notes.pdf", "Café notes.pdf ", "missing.pdf"]) {
			expect(findEvidenceSource([entry], `/Documents/${wrong}`)).toBeUndefined();
		}
	});
});

describe("evidenceDetail", () => {
	it("shows the confidence as a percentage", () => {
		expect(evidenceDetail(0.8735)).toBe("관련도 87%");
		expect(evidenceDetail(1)).toBe("관련도 100%");
	});

	it("shows nothing when the librarian measured no confidence", () => {
		expect(evidenceDetail(undefined)).toBeNull();
		expect(evidenceDetail(0)).toBe("관련도 0%");
	});
});

describe("evidenceHeading", () => {
	it("keeps a local file's name", () => {
		expect(evidenceHeading("refund-policy.md", "/Users/jeff/Documents/refund-policy.md")).toBe("refund-policy.md");
	});

	it("labels a datasource chunk by datasource and instance instead of its opaque id", () => {
		expect(evidenceHeading("msg-1", "/kakao/work/chunks/msg-1")).toBe("kakao · work");
		expect(evidenceHeading("a1", "/discord/guild-9/chunks/a1")).toBe("discord · guild-9");
	});

	it("keeps the title for a web page and for a missing source", () => {
		expect(evidenceHeading("Pricing", "https://example.com/pricing")).toBe("Pricing");
		expect(evidenceHeading("Memo", null)).toBe("Memo");
	});

	it("keeps a datasource title that is not an opaque chunk id", () => {
		expect(evidenceHeading("Q3 plan", "/obsidian/vault/notes/Q3 plan.md")).toBe("Q3 plan");
	});
});

describe("evidenceKind", () => {
	it("maps a file-like title to its kind tile", () => {
		expect(evidenceKind("Q3_마케팅예산_v3.xlsx")).toBe("xlsx");
		expect(evidenceKind("예산승인_품의서_0915.pdf")).toBe("pdf");
	});

	it("falls back to the document tile for names without a known extension", () => {
		expect(evidenceKind("RE: Q3 마케팅 예산 최종 승인 요청")).toBe("md");
	});
});

describe("evidenceSourceUrl", () => {
	it("recognizes a web page source, including a non-ASCII path", () => {
		expect(evidenceSourceUrl("https://music.bugs.co.kr/artist/20047596")).toBe("https://music.bugs.co.kr/artist/20047596");
		expect(evidenceSourceUrl("  http://example.com/위키  ")).toBe("http://example.com/%EC%9C%84%ED%82%A4");
	});

	it("leaves file paths and datasource ids to the Finder reveal", () => {
		expect(evidenceSourceUrl("/Users/me/Documents/brief.md")).toBeNull();
		expect(evidenceSourceUrl("C:\\Users\\me\\brief.md")).toBeNull();
		expect(evidenceSourceUrl("/kakao/room/42")).toBeNull();
	});

	it("never treats other schemes or broken text as a web page", () => {
		expect(evidenceSourceUrl("file:///etc/passwd")).toBeNull();
		expect(evidenceSourceUrl("javascript:alert(1)")).toBeNull();
		expect(evidenceSourceUrl("mailto:a@b.c")).toBeNull();
		expect(evidenceSourceUrl("https://")).toBeNull();
		expect(evidenceSourceUrl("")).toBeNull();
	});
});

describe("unresolvedCitationNumbers", () => {
	const evidence = [{ number: 1 }, { number: 2 }];

	it("returns cited numbers that have no matching evidence entry", () => {
		expect(unresolvedCitationNumbers("9명 [6]. 현재 5명 [1][2][4][6].", evidence)).toEqual([6, 4]);
	});

	it("returns nothing when every citation resolves", () => {
		expect(unresolvedCitationNumbers("현재 5명 [1][2].", evidence)).toEqual([]);
	});

	it("returns nothing when the answer cites nothing", () => {
		expect(unresolvedCitationNumbers("일반 지식으로 답합니다.", evidence)).toEqual([]);
	});
});

describe("isLocalEvidenceSource and sessionEvidencePaths", () => {
	it("accepts local POSIX and Windows paths and rejects null, web URLs, and datasource virtual ids", () => {
		expect(isLocalEvidenceSource("/Users/jeff/Documents/policy.md")).toBe(true);
		expect(isLocalEvidenceSource("C:\\Users\\jeff\\Documents\\policy.md")).toBe(true);
		expect(isLocalEvidenceSource("/obsidian/vault/notes/Q3 plan.md")).toBe(true);
		expect(isLocalEvidenceSource(null)).toBe(false);
		expect(isLocalEvidenceSource("")).toBe(false);
		expect(isLocalEvidenceSource("https://example.com/doc")).toBe(false);
		expect(isLocalEvidenceSource("/kakao/work/chunks/msg-1")).toBe(false);
		expect(isLocalEvidenceSource("/slack/team/messages/42")).toBe(false);
		expect(isLocalEvidenceSource("/discord/srv/images/9")).toBe(false);
	});

	it("gathers unique local file paths in order across all turns and phases of a session", () => {
		const composed = "/Users/jeff/Documents/한글 정책.md".normalize("NFC");
		const decomposed = composed.normalize("NFD");
		const phases = [
			{
				answer: "turn 1 quick",
				evidence: [
					{ number: 1, title: "한글 정책.md", summary: "", source: composed, excerpts: [] },
					{ number: 2, title: "web", summary: "", source: "https://example.com", excerpts: [] },
				],
			},
			{
				answer: "turn 1 deep",
				evidence: [
					{ number: 1, title: "한글 정책.md", summary: "", source: decomposed, excerpts: [] },
					{ number: 2, title: "kakao", summary: "", source: "/kakao/work/chunks/7", excerpts: [] },
					{ number: 3, title: "budget.xlsx", summary: "", source: "/Users/jeff/Desktop/budget.xlsx", excerpts: [] },
				],
			},
			null,
			{
				answer: "turn 2 deep",
				evidence: [
					{ number: 1, title: "memo.txt", summary: "", source: "/Users/jeff/Notes/memo.txt", excerpts: [] },
					{ number: 2, title: "budget.xlsx", summary: "", source: "/Users/jeff/Desktop/budget.xlsx", excerpts: [] },
				],
			},
		];
		const collected = collectSessionEvidence(phases);
		expect(sessionEvidencePaths(collected)).toEqual([
			composed,
			"/Users/jeff/Desktop/budget.xlsx",
			"/Users/jeff/Notes/memo.txt",
		]);
	});
});
