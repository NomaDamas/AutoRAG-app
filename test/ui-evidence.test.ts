import { describe, expect, it } from "vitest";
import {
	evidenceDetail,
	evidenceKind,
	findEvidenceSource,
	feedbackToastText,
	nextEvidenceFeedback,
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

describe("nextEvidenceFeedback", () => {
	it("toggles the same value off and switches between up and down", () => {
		expect(nextEvidenceFeedback(null, "up")).toBe("up");
		expect(nextEvidenceFeedback("up", "up")).toBeNull();
		expect(nextEvidenceFeedback("up", "down")).toBe("down");
		expect(nextEvidenceFeedback("down", "down")).toBeNull();
		expect(nextEvidenceFeedback(null, "down")).toBe("down");
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

describe("feedbackToastText", () => {
	it("matches the reference toasts by number and value", () => {
		expect(feedbackToastText(3, "up")).toBe("근거 3 — 도움이 됨으로 기록했습니다");
		expect(feedbackToastText(3, "down")).toBe("근거 3 — 다음 검색부터 우선순위를 낮춥니다");
	});
});
