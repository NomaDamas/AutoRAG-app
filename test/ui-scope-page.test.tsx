// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScopePage } from "../src/renderer/src/components/settings/ScopePage";
import { setAppLanguage } from "../src/shared/i18n";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, JsonObject } from "../src/shared/settings-contract";

// The settings pages read `window.autorag.settings` while they are imported; hoisted code runs before the imports,
// so the one bridge object they capture is the one the tests drive.
const bridge = vi.hoisted(() => {
	const state: { config: Record<string, unknown> } = { config: {} };
	const settings = { configPatch: vi.fn() };
	Reflect.set(globalThis, "autorag", { settings });
	return { state, settings };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const snapshotOf = (config: Record<string, unknown>): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: config as JsonObject });

/** The writes the page makes are top-level leaves; apply them the way the real patch does, all or nothing. */
function apply(config: Record<string, unknown>, ops: readonly AutoRagConfigUpdate[]): Record<string, unknown> {
	const next = structuredClone(config);
	for (const op of ops) {
		const key = op.path[0]!;
		expect(op.path).toHaveLength(1);
		if ("remove" in op) delete next[key];
		else next[key] = structuredClone(op.value);
	}
	return next;
}

interface Setup {
	readonly config?: Record<string, unknown>;
	readonly remote?: boolean;
	readonly picked?: readonly string[];
	/** What the exclusion chooser returns. */
	readonly pickedExclusions?: readonly string[];
	readonly home?: string;
}

function Host(): ReturnType<typeof ScopePage> {
	const [snapshot, setSnapshot] = useState(() => snapshotOf(bridge.state.config));
	return <ScopePage snapshot={snapshot} onSaved={setSnapshot} />;
}

async function mount({ config = { searchPaths: ["/r"] }, remote = false, picked = [], pickedExclusions = [], home = "/home/me" }: Setup = {}): Promise<{
	readonly pickFolders: ReturnType<typeof vi.fn>;
	readonly pickPaths: ReturnType<typeof vi.fn>;
}> {
	bridge.state.config = config;
	const pickFolders = vi.fn(async () => picked.map((path) => ({ path })));
	const pickPaths = vi.fn(async () => pickedExclusions);
	Reflect.set(globalThis, "autorag", {
		settings: bridge.settings,
		onboarding: { pickFolders, pickPaths },
		fs: {
			locations: async () => [{ name: "me", path: home, section: "favorites", icon: "home" }],
		},
	});
	Reflect.set(window, "autoragIsRemote", remote ? true : undefined);
	await act(async () => root.render(<Host />));
	return { pickFolders, pickPaths };
}

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.settings.configPatch.mockReset();
	bridge.settings.configPatch.mockImplementation(async (ops: readonly AutoRagConfigUpdate[]) => {
		bridge.state.config = apply(bridge.state.config, ops);
		return snapshotOf(bridge.state.config);
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	document.body.replaceChildren();
	Reflect.set(globalThis, "autorag", { settings: bridge.settings });
	Reflect.deleteProperty(window, "autoragIsRemote");
});

const click = (element: Element | null): Promise<void> => act(async () => {
	expect(element).not.toBeNull();
	element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const button = (name: string): HTMLButtonElement | null => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name) ?? null;
const lists = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".scope-list")];
const pathsIn = (list: HTMLElement | undefined): string[] => [...(list?.querySelectorAll(".scope-row-path") ?? [])].map((row) => row.textContent ?? "");
const folderRows = (): string[] => pathsIn(lists()[0]);
const alertText = (): string | null => host.querySelector('[role="alert"]')?.textContent ?? null;

describe("Settings → Search Scope", () => {
	it("lists the search folders and the exclusions; the index map is on Settings → Indexing, not here", async () => {
		await mount({ config: { searchPaths: ["/r"], excludePaths: ["/r/private"] } });

		expect(folderRows()).toEqual(["/r"]);
		expect(pathsIn(lists()[1])).toEqual(["/r/private"]);
		expect(host.querySelector(".index-map-panel")).toBeNull();
	});

	it("adds the folders picked in the system dialog in one write, in the order picked", async () => {
		const { pickFolders } = await mount({ picked: ["/data/a", "/data/b"] });
		await click(button("Add folder"));

		expect(pickFolders).toHaveBeenCalledOnce();
		expect(bridge.settings.configPatch).toHaveBeenCalledOnce();
		expect(bridge.settings.configPatch).toHaveBeenCalledWith([{ path: ["searchPaths"], value: ["/r", "/data/a", "/data/b"] }]);
		expect(folderRows()).toEqual(["/r", "/data/a", "/data/b"]);
	});

	it("folds the folders a wider pick now contains into it, so one folder never sits inside another", async () => {
		await mount({ config: { searchPaths: ["/data/a", "/data/b", "/z"] }, picked: ["/data"] });
		await click(button("Add folder"));

		expect(bridge.state.config.searchPaths).toEqual(["/z", "/data"]);
	});

	it("writes nothing when the dialog is cancelled", async () => {
		await mount({ picked: [] });
		await click(button("Add folder"));

		expect(bridge.settings.configPatch).not.toHaveBeenCalled();
		expect(alertText()).toBeNull();
	});

	it("says why a folder was not added, and still adds the others in the same pick", async () => {
		await mount({ picked: ["/r/notes", "/other"] });
		await click(button("Add folder"));

		expect(alertText()).toContain("/r/notes");
		expect(bridge.state.config.searchPaths).toEqual(["/r", "/other"]);
	});

	it("writes nothing when every picked folder is rejected", async () => {
		await mount({ picked: ["/r"] });
		await click(button("Add folder"));

		expect(bridge.settings.configPatch).not.toHaveBeenCalled();
		expect(alertText()).toContain("/r");
	});

	it("removes a folder together with the exclusions that only meant something under it, in one write", async () => {
		await mount({ config: { searchPaths: ["/a", "/b"], excludePaths: ["/a/x", "/b/y"] } });
		await click(lists()[0]!.querySelector(".scope-row-remove"));

		expect(bridge.settings.configPatch).toHaveBeenCalledOnce();
		expect(bridge.state.config).toEqual({ searchPaths: ["/b"], excludePaths: ["/b/y"] });
	});

	it("removes the key itself when the last folder or the last exclusion goes, rather than writing an empty list", async () => {
		await mount({ config: { searchPaths: ["/a"], excludePaths: ["/a/x"] } });
		await click(lists()[0]!.querySelector(".scope-row-remove"));

		expect(bridge.state.config).toEqual({});
	});

	it("adds exclusions from 제외 추가's menu: the system chooser, without duplicates, in one write", async () => {
		const { pickPaths } = await mount({ config: { searchPaths: ["/r"], excludePaths: ["/r/a"] }, pickedExclusions: ["/r/a", "/r/b.xlsx", "/r/c"] });
		await click(button("Add exclusion"));
		const items = [...host.querySelectorAll<HTMLButtonElement>('.scope-menu [role="menuitem"]')];
		expect(items.at(-1)?.textContent).toBe("Enter a path");
		await click(items[0] ?? null);

		expect(pickPaths).toHaveBeenCalledOnce();
		expect(bridge.settings.configPatch).toHaveBeenCalledOnce();
		expect(bridge.state.config.excludePaths).toEqual(["/r/a", "/r/b.xlsx", "/r/c"]);
		expect(host.textContent).toContain("Exclusions you added");
	});

	it("types an exclusion's path from 경로 직접 입력", async () => {
		const { pickPaths } = await mount();
		await click(button("Add exclusion"));
		await click([...host.querySelectorAll<HTMLButtonElement>('.scope-menu [role="menuitem"]')].find((item) => item.textContent === "Enter a path") ?? null);
		expect(pickPaths).not.toHaveBeenCalled();

		const input = document.body.querySelector<HTMLInputElement>(".settings-modal input");
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "/r/secret");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(document.body.querySelector(".settings-modal .settings-btn-primary"));
		expect(bridge.state.config.excludePaths).toEqual(["/r/secret"]);
	});

	it("folds the automatically excluded developer folders behind 자세히", async () => {
		await mount();
		expect(host.querySelector(".scope-dev-body")).toBeNull();
		await click(button("Details"));
		expect(host.querySelector(".scope-dev-names")?.textContent).toContain("node_modules");
		expect(button("Hide")).not.toBeNull();
	});

	it("in a remote browser, where no system dialog exists, asks for the path and expands ~ to the home folder", async () => {
		const { pickFolders } = await mount({ remote: true });
		await click(button("Add folder"));
		expect(pickFolders).not.toHaveBeenCalled();

		const input = document.body.querySelector<HTMLInputElement>(".settings-modal input");
		expect(input).not.toBeNull();
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "~/Notes/");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await click(document.body.querySelector(".settings-modal .settings-btn-primary"));

		expect(bridge.state.config.searchPaths).toEqual(["/r", "/home/me/Notes"]);
	});
});
