// @vitest-environment happy-dom
import { act, createRef, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileList } from "../src/renderer/src/components/FileList";
import type { RowCallbacks } from "../src/renderer/src/components/FileRow";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { DirectoryDataContext } from "../src/renderer/src/hooks/useDirectoryData";
import { buildFolderTree } from "../src/renderer/src/state/folder-tree";
import { DEFAULT_LIST_COLUMNS } from "../src/renderer/src/state/list-columns";
import { setAppLanguage } from "../src/shared/i18n";
import type { IndexStatus } from "../src/shared/index-contract";
import { row } from "./support/disclosure-rows";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const noop = (): void => undefined;
const PATH = "/r/report.md";

let host: HTMLDivElement;
let root: Root;
let sidecar = createEntrySidecar();
let toggles = 0;

const callbacks: RowCallbacks = {
	onClick: noop,
	onOpen: noop,
	onContextMenu: noop,
	onToggleIndex: () => {
		toggles += 1;
	},
	onPointerDown: noop,
	onDragOver: noop,
	onDrop: noop,
	dropTargetPath: null,
	onToggleStack: noop,
	onToggleFolder: noop,
	onRenameChange: noop,
	onRenameCommit: noop,
	onRenameCancel: noop,
	onVisible: noop,
};

function List(): ReactElement {
	return (
		<DirectoryDataContext value={{ store: {} as never, sidecar }}>
			<FileList
				sections={[{ label: null, rows: buildFolderTree([row(PATH)], { expanded: new Set(), childrenOf: () => undefined }) }]}
				listRef={createRef<HTMLDivElement>()}
				searching={false}
				emptyText="empty"
				selectedKeys={[]}
				focusedZone
				flashPath={null}
				renamePath={null}
				renameDraft=""
				listPath="/r"
				columns={DEFAULT_LIST_COLUMNS}
				minWidth={null}
				versionFamilyError={null}
				onRetryVersionFamilies={noop}
				background={{ onDragOver: noop, onDrop: noop, onDragLeave: noop, onContextMenu: noop }}
				dropBackground={false}
				callbacks={callbacks}
			/>
		</DirectoryDataContext>
	);
}

const status = (kind: IndexStatus["kind"], excluded: boolean): IndexStatus => ({ path: PATH, kind, excluded, toggleable: true, detail: "" });
const box = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[role="gridcell"] button[role="checkbox"]') as HTMLButtonElement;
const setStatus = (next: IndexStatus): void => act(() => sidecar.setIndexStatuses([next]));

beforeEach(async () => {
	await setAppLanguage("en");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
	sidecar = createEntrySidecar();
	toggles = 0;
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
	await setAppLanguage("ko");
});

describe("the list's index checkbox while its change is saved", () => {
	it("fills an empty box pale while it is being checked, until the saved status arrives", () => {
		sidecar.setIndexStatuses([status("excluded", true)]);
		act(() => root.render(<List />));
		expect(box().getAttribute("aria-checked")).toBe("false");

		act(() => box().click());
		expect(toggles).toBe(1);
		expect(box().dataset.indexPending).toBe("check");
		expect(box().className).toContain("bg-chk-pending-on");
		expect(box().getAttribute("aria-busy")).toBe("true");
		// A second click while it saves does not send another toggle.
		act(() => box().click());
		expect(toggles).toBe(1);

		setStatus(status("pending", false));
		expect(box().dataset.indexPending).toBeUndefined();
		expect(box().getAttribute("aria-checked")).toBe("true");
	});

	it("fills a checked box's background grey while it is being cleared", () => {
		sidecar.setIndexStatuses([status("included", false)]);
		act(() => root.render(<List />));
		act(() => box().click());
		expect(box().dataset.indexPending).toBe("uncheck");
		expect(box().className).toContain("bg-chk-pending-off");
		expect(box().className).not.toContain("bg-accent");

		setStatus(status("excluded", true));
		expect(box().dataset.indexPending).toBeUndefined();
		expect(box().getAttribute("aria-checked")).toBe("false");
	});

	it("shows no wait when the click changes nothing: no status yet, or one a parent folder decides", () => {
		act(() => root.render(<List />));
		act(() => box().click());
		expect(box().dataset.indexPending).toBeUndefined();

		setStatus({ ...status("excluded", true), toggleable: false });
		act(() => box().click());
		expect(box().dataset.indexPending).toBeUndefined();
	});

	it("gives the box back when no status arrives (a failed save)", () => {
		sidecar.setIndexStatuses([status("excluded", true)]);
		act(() => root.render(<List />));
		act(() => box().click());
		expect(box().dataset.indexPending).toBe("check");
		act(() => void vi.advanceTimersByTime(15_000));
		expect(box().dataset.indexPending).toBeUndefined();
		expect(box().getAttribute("aria-checked")).toBe("false");
	});
});
