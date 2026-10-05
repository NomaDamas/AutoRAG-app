import { describe, expect, it } from "vitest";
import {
	evidenceDetail,
	evidenceKind,
	evidenceSourceUrl,
	findEvidenceSource,
	feedbackToastText,
	nextEvidenceFeedback,
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

describe("nextEvidenceFeedback", () => {
	it("toggles the same value off and switches between up and down", () => {
		expect(nextEvidenceFeedback(null, "up")).toBe("up");
		expect(nextEvidenceFeedback("up", "up")).toBeNull();
		expect(nextEvidenceFeedback("up", "down")).toBe("down");
		expect(nextEvidenceFeedback("down", "down")).toBeNull();
		expect(nextEvidenceFeedback(null, "down")).toBe("down");
	});
});

describe("feedbackToastText", () => {
	it("matches the reference toasts by number and value", () => {
		expect(feedbackToastText(3, "up")).toBe("근거 3 — 도움이 됨으로 기록했습니다");
		expect(feedbackToastText(3, "down")).toBe("근거 3 — 다음 검색부터 우선순위를 낮춥니다");
	});
});
