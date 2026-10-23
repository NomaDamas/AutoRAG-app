import { describe, expect, it } from "vitest";
import { buildTextIndex, locateExcerpt } from "../src/preview/shared/locate";

describe("locateExcerpt", () => {
	it("finds an excerpt whose whitespace and line breaks differ from the viewer's text runs", () => {
		const pieces = ["제1조(목적) 이 규정은 회사의 ", "환불 절차를 정한", "다. 제2조(정의) 다음과 같다."];
		const hit = locateExcerpt(buildTextIndex(pieces), "이 규정은 회사의\n환불 절차를   정한다.");
		expect(hit).not.toBeNull();
		expect(hit!.score).toBe(1);
		expect(hit!.ranges.map((range) => pieces[range.piece]!.slice(range.start, range.end))).toEqual(["이 규정은 회사의", "환불 절차를 정한", "다"]);
	});

	it("matches a chunk cut out of an HTML table against the cells in reading order", () => {
		const pieces = ["대출대상", "수분양자 중 계약금 10% 이상 납부자", "대출금액", "세대당 분양금액의 60%이내", "대출금리"];
		const excerpt = "<tr><td>대출금액</td><td>세대당 분양금액의 60%이내</td></tr>";
		const hit = locateExcerpt(buildTextIndex(pieces), excerpt);
		expect(hit).not.toBeNull();
		expect(hit!.ranges.map((range) => pieces[range.piece]!.slice(range.start, range.end))).toEqual(["대출금액", "세대당 분양금액의 60%이내"]);
	});

	it("matches a markdown pipe-table chunk with escapes and separators", () => {
		const pieces = ["Item", "Content", "Companies covered", "6 listed firms spanning 6 distinct industries"];
		const excerpt = "| Item | Content | | --- | --- | | Companies covered | 6 listed firms spanning 6 distinct industries |";
		const hit = locateExcerpt(buildTextIndex(pieces), excerpt);
		expect(hit).not.toBeNull();
		expect(hit!.ranges[0]).toEqual({ piece: 0, start: 0, end: 4 });
		expect(hit!.ranges.at(-1)).toEqual({ piece: 3, start: 0, end: pieces[3]!.length });
	});

	it("tolerates a few characters the viewer extracted differently, and says so in the score", () => {
		const pieces = ["The retrieval quality depends on the chunking strategy and the embedding model chosen for the corpus."];
		const hit = locateExcerpt(buildTextIndex(pieces), "The retreival quality depends on the chunkng strategy and the embedding model chosen for the corpus.");
		expect(hit).not.toBeNull();
		expect(hit!.score).toBeLessThan(1);
		expect(hit!.score).toBeGreaterThan(0.9);
		expect(hit!.ranges).toEqual([{ piece: 0, start: 0, end: pieces[0]!.length - 1 }]);
	});

	it("compares full-width, decomposed Hangul, and case-folded text as the same characters", () => {
		const decomposed = "중도금대출 안내".normalize("NFD");
		const pieces = [`ＡＵＴＯＲＡＧ ${decomposed}`];
		const hit = locateExcerpt(buildTextIndex(pieces), "AutoRAG 중도금대출 안내");
		expect(hit).not.toBeNull();
		expect(hit!.score).toBe(1);
		expect(hit!.ranges).toEqual([{ piece: 0, start: 0, end: pieces[0]!.length }]);
	});

	it("picks the occurrence of a repeated sentence that the rest of the excerpt sits next to", () => {
		const repeated = "자세한 내용은 담당 지점에 문의하시기 바랍니다.";
		const pieces = [repeated, "중도금 대출 조건 안내", repeated, "대출 접수 기간은 4월 6일부터 4월 9일까지입니다."];
		const hit = locateExcerpt(buildTextIndex(pieces), `${repeated}\n대출 접수 기간은 4월 6일부터 4월 9일까지입니다.`);
		expect(hit).not.toBeNull();
		expect(hit!.ranges[0]!.piece).toBe(2);
		expect(hit!.ranges.at(-1)!.piece).toBe(3);
	});

	it("drops a segment that only matches far from the rest of the excerpt", () => {
		const filler = "본문 내용이 이어집니다. ".repeat(80);
		const pieces = ["승인 체인 원본 첨부 필수", filler, "일반 환불은 5영업일 내 처리합니다.", "예외는 임원 승인이 필요합니다."];
		const hit = locateExcerpt(buildTextIndex(pieces), "일반 환불은 5영업일 내 처리합니다. ... 예외는 임원 승인이 필요합니다. ... 승인 체인 원본 첨부 필수");
		expect(hit).not.toBeNull();
		expect(hit!.ranges.map((range) => range.piece)).toEqual([2, 3]);
	});

	it("finds nothing for a bare file path, document metadata, or text the document does not contain", () => {
		const index = buildTextIndex(["수협은행 중도금대출 비대면과정 안내", "대출금리 및 상환 방법"]);
		expect(locateExcerpt(index, "/Users/someone/Downloads/대출 안내.pdf")).toBeNull();
		expect(locateExcerpt(index, "Pages: 2 / Page size: 801.96 x 567 pts / PDF version: 1.7")).toBeNull();
		expect(locateExcerpt(index, "완전히 다른 문서에 있는 문장입니다.")).toBeNull();
		expect(locateExcerpt(index, "")).toBeNull();
		expect(locateExcerpt(buildTextIndex([]), "수협은행 중도금대출")).toBeNull();
	});

	it("ignores markdown image and link syntax around the cited text", () => {
		const pieces = ["See the architecture overview for the indexing pipeline details."];
		const excerpt = "See the [architecture overview](https://example.com/arch) for the indexing pipeline details. ![image](figure-3.png)";
		const hit = locateExcerpt(buildTextIndex(pieces), excerpt);
		expect(hit).not.toBeNull();
		expect(hit!.score).toBe(1);
	});
});
