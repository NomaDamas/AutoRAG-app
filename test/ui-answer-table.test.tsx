// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProseBlocks } from "../src/renderer/src/components/AiSearchPanel";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const IMAGE_ACTIONS = { onOpenImage: () => undefined, onOpenUrl: () => undefined };

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

function render(text: string, onCitation: (number: number) => void = () => undefined, unresolved: readonly number[] = []): void {
	act(() => root.render(<ProseBlocks text={text} selected={null} unresolved={unresolved} onCitation={onCitation} imageActions={IMAGE_ACTIONS} />));
}

const TABLE_ANSWER = ["두 플랜을 비교하면 다음과 같습니다.", "", "| 플랜 | 가격 | 비고 |", "|:--|--:|---|", "| **Pro** [1] | 20 | 팀용<br>연간 결제 |", "| Free | 0 | 개인 [2] |", "", "자세한 내용은 문서를 참고하세요."].join("\n");

describe("AI Search answer pipe table", () => {
	it("renders a markdown pipe table as a real table instead of literal pipes", () => {
		render(TABLE_ANSWER);
		const table = host.querySelector("table");
		expect(table).not.toBeNull();
		expect([...table!.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual(["플랜", "가격", "비고"]);
		expect(table!.querySelectorAll("tbody tr")).toHaveLength(2);
		expect(host.textContent).not.toContain("|--");
		expect(host.textContent).not.toContain("| 플랜");
		expect(table!.querySelectorAll("thead th")[1]?.getAttribute("style")).toContain("text-align: right");
		expect(table!.querySelector("tbody strong")?.textContent).toBe("Pro");
		expect(table!.querySelectorAll("tbody td")[2]?.querySelectorAll("br")).toHaveLength(1);
		expect(host.querySelectorAll("p")).toHaveLength(2);
	});

	it("keeps citation chips inside table cells clickable, and drops unresolved ones", () => {
		const onCitation = vi.fn();
		render(TABLE_ANSWER, onCitation, [2]);
		const chips = [...host.querySelectorAll("table .cite")];
		expect(chips.map((chip) => chip.textContent)).toEqual(["1"]);
		act(() => (chips[0] as HTMLButtonElement).click());
		expect(onCitation).toHaveBeenCalledWith(1);
	});
});
