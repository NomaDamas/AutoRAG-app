// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/renderer/src/components/Inspector";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { NO_CAPABILITIES } from "../src/shared/actions-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const noop = (): void => {};
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const pdf: FinderEntry = { name: "deck.pdf", path: "/work/deck.pdf", kind: "file", ext: "pdf", size: 10, mtimeMs: 1_700_000_000_000, birthtimeMs: 0 };

function render(handlers: { onTrash?: (entry: FinderEntry) => void; onToggleIndex?: (entry: FinderEntry) => void } = {}, folderInView = false): void {
	act(() =>
		root.render(
			<Inspector
				entry={pdf}
				entries={[pdf]}
				indexStatus={null}
				folderInView={folderInView}
				onToggleIndex={handlers.onToggleIndex ?? noop}
				onTrash={handlers.onTrash ?? noop}
				onCopyPath={noop}
				onAskAi={noop}
				actionCapabilities={NO_CAPABILITIES}
				onAction={noop}
				loadOpenWithApplications={async () => []}
				family={null}
				onOpenMember={noop}
				view="info"
				evidence={[]}
				evidenceSelected={0}
				onSelectEvidence={noop}
				onRevealPath={noop}
				onToast={noop}
				imageActions={{ onOpenImage: noop, onOpenUrl: noop }}
			/>,
		),
	);
}

const group = (): HTMLElement | null => host.querySelector('[role="toolbar"]');
const names = (): string[] => [...(group()?.querySelectorAll("button") ?? [])].map((button) => button.getAttribute("aria-label") ?? "");

describe("the inspector's file actions", () => {
	it("are one row of icon buttons named by their tooltips, without Open or AI 요약", () => {
		render();
		const labels = names();
		expect(labels.slice(0, 3)).toEqual(["인덱싱에 포함", "휴지통", "경로 복사"]);
		expect(labels).not.toContain("열기");
		expect(labels).not.toContain("AI 요약");
		for (const button of group()?.querySelectorAll("button") ?? []) expect(button.textContent).toBe(button.getAttribute("aria-label"));
	});

	it("leaves the bottom action bar to multi-selections", () => {
		render();
		expect(host.querySelector(".inspector-actions")).toBeNull();
	});

	it("runs the clicked action on the shown file", () => {
		const onTrash = vi.fn();
		const onToggleIndex = vi.fn();
		render({ onTrash, onToggleIndex });
		const press = (id: string): void => {
			const button = [...(group()?.querySelectorAll("button") ?? [])].find((candidate) => candidate.dataset["action"] === id);
			act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		};
		press("trash");
		press("index");
		expect(onTrash).toHaveBeenCalledWith(pdf);
		expect(onToggleIndex).toHaveBeenCalledWith(pdf);
	});

	it("offers no Trash for the folder standing in for an empty selection", () => {
		render({}, true);
		expect(names()).not.toContain("휴지통");
	});
});
