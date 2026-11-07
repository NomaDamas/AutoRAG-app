// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexingPage } from "../src/renderer/src/components/settings/AppsPages";
import { resetIndexActivityForTests } from "../src/renderer/src/hooks/useIndexActivity";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { setAppLanguage } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import type { IndexMap, IndexMapState } from "../src/shared/index-map-contract";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, JsonObject } from "../src/shared/settings-contract";

// The settings pages read `window.autorag.settings` while they are imported; hoisted code runs before the imports.
const bridge = vi.hoisted(() => {
	const state: { config: Record<string, unknown> } = { config: {} };
	const settings = { configPatch: vi.fn(), configRefresh: vi.fn(), refreshScheduleGet: vi.fn(), refreshScheduleApply: vi.fn(), sourcesList: vi.fn() };
	Reflect.set(globalThis, "autorag", { settings });
	return { state, settings };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const snapshotOf = (config: Record<string, unknown>): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: config as JsonObject });

const file = (path: string, state: IndexMapState): ScanFile => ({ path, name: path.split("/").at(-1)!, state });
const folder = (path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir => ({ path, name: path.split("/").at(-1)!, files, dirs, sealed: null });
const mapOfScope = (): IndexMap => buildIndexMap({ roots: [folder("/r", [file("/r/top.md", "indexed")], [folder("/r/notes", [file("/r/notes/a.md", "unindexed")])])], truncated: false });

const RUNNING: IndexActivitySnapshot = {
	...IDLE_INDEX_ACTIVITY,
	state: "running",
	origin: "app",
	startedAt: "2026-11-07T09:00:00.000Z",
	items: [{ key: "local", kind: "local", id: null, state: "running", phase: "minsync", counts: null, error: null }],
	fraction: 0.4,
};

function Host(): ReturnType<typeof IndexingPage> {
	const [snapshot, setSnapshot] = useState(() => snapshotOf(bridge.state.config));
	return <IndexingPage snapshot={snapshot} onSaved={setSnapshot} sources={null} sourcesPending={false} setSources={vi.fn()} onOpenSource={vi.fn()} />;
}

async function mount(activity: IndexActivitySnapshot = IDLE_INDEX_ACTIVITY, config: Record<string, unknown> = { searchPaths: ["/r"] }): Promise<void> {
	bridge.state.config = config;
	Reflect.set(globalThis, "autorag", {
		settings: bridge.settings,
		fs: { indexMap: async () => mapOfScope(), onIndexRefreshed: () => () => {} },
		indexActivity: { get: async () => activity, onChange: () => () => {} },
	});
	await act(async () => root.render(<Host />));
	await act(async () => {});
}

beforeEach(async () => {
	await setAppLanguage("en");
	for (const mock of Object.values(bridge.settings)) mock.mockReset();
	bridge.settings.refreshScheduleGet.mockResolvedValue(null);
	bridge.settings.configPatch.mockImplementation(async (ops: readonly AutoRagConfigUpdate[]) => {
		const next = structuredClone(bridge.state.config);
		for (const op of ops) {
			if ("remove" in op) delete next[op.path[0]!];
			else next[op.path[0]!] = structuredClone(op.value);
		}
		bridge.state.config = next;
		return snapshotOf(next);
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
	resetIndexActivityForTests();
});

const click = (element: Element | null): Promise<void> => act(async () => {
	expect(element).not.toBeNull();
	element!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
});
const sector = (path: string): Element | null => host.querySelector(`.index-map-chart path[data-path="${path}"]:not([data-kind="parcel"])`);

describe("Settings → Indexing", () => {
	it("shows the index map in the progress section, right under the progress bar", async () => {
		await mount(RUNNING);

		const section = host.querySelector(".index-map-panel")?.closest(".settings-section");
		expect(section).not.toBeNull();
		const card = section!.querySelector(".settings-activity");
		expect(card).not.toBeNull();
		expect(card!.compareDocumentPosition(host.querySelector(".index-map-panel")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(host.querySelectorAll(".index-map-chart path[data-node-id]").length).toBeGreaterThan(0);
	});

	it("shows the map when nothing is indexing too, under the idle line", async () => {
		await mount();

		expect(host.querySelector('[data-testid="index-activity-idle"]')).not.toBeNull();
		expect(host.querySelector(".index-map-panel")).not.toBeNull();
	});

	it("leaves a folder out from the map and writes it to excludePaths", async () => {
		await mount();
		await click(sector("/r/notes"));
		await click(host.querySelector('[data-action="index-map-exclude"]'));

		expect(bridge.settings.configPatch).toHaveBeenCalledExactlyOnceWith([{ path: ["excludePaths"], value: ["/r/notes"] }]);
	});

	it("brings a folder back from the map, and removes the key when the list is empty", async () => {
		await mount(IDLE_INDEX_ACTIVITY, { searchPaths: ["/r"], excludePaths: ["/r/notes"] });
		await click(sector("/r/notes"));
		await click(host.querySelector('[data-action="index-map-include"]'));

		expect(bridge.settings.configPatch).toHaveBeenCalledExactlyOnceWith([{ path: ["excludePaths"], remove: true }]);
	});
});
