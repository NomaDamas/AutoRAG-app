// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceExcerpt, type ExcerptImages } from "../src/renderer/src/components/EvidenceBlocks";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const IMAGES: ExcerptImages = { folder: "/Users/me/docs", actions: { onOpenImage: () => undefined, onOpenUrl: () => undefined } };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function render(text: string): void {
	act(() => root.render(<EvidenceExcerpt text={text} images={IMAGES} />));
}

const cellTexts = (): string[] => [...host.querySelectorAll("td, th")].map((cell) => cell.textContent ?? "");

describe("EvidenceExcerpt", () => {
	it("renders spreadsheet rows cut out of their table as a table, not literal tags", () => {
		render(
			[
				"발표 목차(최신 v0.6)에 별도 항목 존재",
				"사용 시나리오</td><td>15</td></tr>",
				"<tr><td>고도화 후 실제 사용 시나리오 &amp; 경쟁 우위</td><td>16</td></tr>",
				"<tr><td>20</td><td>기관별",
			].join("\n"),
		);
		expect(host.querySelectorAll(".evidence__block--html table")).toHaveLength(1);
		expect(cellTexts()).toEqual(["사용 시나리오", "15", "고도화 후 실제 사용 시나리오 & 경쟁 우위", "16", "20", "기관별"]);
		expect(host.textContent).not.toContain("<td>");
		expect(host.querySelector(".evidence__block--paragraph")?.textContent).toBe("발표 목차(최신 v0.6)에 별도 항목 존재");
	});

	it("strips active content from chunk HTML", () => {
		render('<div onclick="steal()"><p>본문</p><script>alert(1)</script><img src="https://tracker.example/p.gif"><a href="javascript:x()">링크</a></div>');
		const block = host.querySelector(".evidence__block--html");
		expect(block?.innerHTML).not.toMatch(/script|onclick|javascript:|tracker/u);
		expect(block?.textContent).toBe("본문링크");
	});

	it("renders a pipe table with its header, alignment, and inline markdown in cells", () => {
		render("| 항목 | 쪽 |\n|---|---:|\n| **로드맵** | 18 |");
		const table = host.querySelector(".evidence__block--table table");
		expect(table?.querySelectorAll("thead th")).toHaveLength(2);
		expect(table?.querySelector("tbody strong")?.textContent).toBe("로드맵");
		expect(table?.querySelectorAll("tbody td")[1]?.getAttribute("style")).toContain("text-align: right");
	});

	it("breaks a pipe cell at <br> instead of printing the tag", () => {
		render("| 2.2.2 | 발전성(35)<br>활용성(15) <br>ㆍSW 개발 |\n| 2.2.3 | 관리 |");
		const cell = host.querySelectorAll(".evidence__block--table td")[1];
		expect(cell?.querySelectorAll("br")).toHaveLength(2);
		expect(cell?.textContent).toBe("발전성(35)활용성(15) ㆍSW 개발");
		expect(host.textContent).not.toContain("<br>");
	});

	it("keeps markdown blocks rendering as before", () => {
		render("## 승인 규칙\n- 항목\n```\n<td>코드</td>\n```");
		expect(host.querySelectorAll(".evidence__block--heading")).toHaveLength(1);
		expect(host.querySelectorAll(".evidence__block--list")).toHaveLength(1);
		expect(host.querySelector(".evidence__block--code")?.textContent).toBe("<td>코드</td>");
		expect(host.querySelector("table")).toBeNull();
	});
});
