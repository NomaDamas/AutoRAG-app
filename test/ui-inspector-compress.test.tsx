// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inspector } from "../src/renderer/src/components/Inspector";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import type { FileActionTarget } from "../src/renderer/src/state/file-actions";
import { NO_CAPABILITIES, type ActionCapabilities } from "../src/shared/actions-contract";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const noop = (): void => {};
const ARCHIVE: ActionCapabilities = { ...NO_CAPABILITIES, archive: true };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

function file(name: string, kind: "file" | "folder" = "file"): FinderEntry {
	return { name, path: `/work/${name}`, kind, ext: kind === "file" ? "txt" : "", size: 10, mtimeMs: 1_700_000_000_000, birthtimeMs: 0 };
}

function render(entries: readonly FinderEntry[], capabilities: ActionCapabilities, onAction: (target: FileActionTarget) => void = noop): void {
	act(() =>
		root.render(
			<Inspector
				entry={entries.length === 1 ? (entries[0] ?? null) : null}
				entries={entries}
				indexStatus={null}
				onToggleIndex={noop}
				onTrash={noop}
				onCopyPath={noop}
				onAskAi={noop}
				actionCapabilities={capabilities}
				onAction={onAction}
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

const bar = (): HTMLElement | null => host.querySelector(".inspector-file-actions");
const barLabels = (): string[] => [...(bar()?.querySelectorAll("button") ?? [])].map((button) => (button.textContent ?? "").trim());

describe("Inspector compress", () => {
	it("offers no Compress for a single file or folder", () => {
		render([file("a.txt")], ARCHIVE);
		expect(barLabels()).not.toContain("압축");
		render([file("docs", "folder")], ARCHIVE);
		expect(barLabels()).not.toContain("압축");
	});

	it("offers one Compress menu button, and nothing else, for a multi-selection", () => {
		render([file("a.txt"), file("b.txt")], ARCHIVE);
		expect(barLabels()).toEqual(["압축"]);
	});

	it("has no action bar for a multi-selection when the machine cannot archive", () => {
		render([file("a.txt"), file("b.txt")], NO_CAPABILITIES);
		expect(bar()).toBeNull();
	});

	it("sends the chosen format as a compress request", () => {
		const onAction = vi.fn();
		render([file("a.txt"), file("b.txt")], ARCHIVE, onAction);
		act(() => bar()?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const items = [...document.querySelectorAll('[role="menuitem"]')];
		expect(items.map((item) => (item.textContent ?? "").trim())).toEqual(["ZIP으로 압축", "7z로 압축"]);
		act(() => items[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(onAction).toHaveBeenCalledWith({ kind: "request", request: { kind: "compress", format: "7z" } }, expect.anything());
	});
});
