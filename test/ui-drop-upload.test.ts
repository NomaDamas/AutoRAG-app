// @vitest-environment happy-dom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaneShell } from "../src/renderer/src/components/FinderPane";
import { createDirectoryStore } from "../src/renderer/src/data/directory-store";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import { createEntrySidecar } from "../src/renderer/src/data/entry-sidecar";
import { createFixtureSource } from "../src/renderer/src/data/source";
import { createControllerStore } from "../src/renderer/src/hooks/usePaneControllers";
import { FINDER_DRAG_TYPE, readDropFiles, readDropPaths, type DropData } from "../src/renderer/src/state/attachments";
import { DEFAULT_LIST_COLUMNS } from "../src/renderer/src/state/list-columns";
import { createWorkspace, focusedPane } from "../src/renderer/src/state/workspace";
import { VIEW_MODE_STORAGE_KEY, type ViewMode } from "../src/renderer/src/state/view-mode";
import { setAppLanguage } from "../src/shared/i18n";
import { t } from "../src/shared/i18n/core";
import { RECENTS_PATH } from "../src/shared/fs-contract";

// Index status is unrelated to drops; keep the real pane, controller, rows,
// transfer planning, and directory store connected so a wiring regression fails.
vi.mock("../src/renderer/src/components/IndexProblemBanner", () => ({ IndexProblemBanner: () => null }));
vi.mock("../src/renderer/src/components/SettingsView", () => ({ SettingsView: () => null }));
vi.mock("../src/renderer/src/components/AutomationsTab", () => ({ AutomationsTab: () => null }));

type UploadFiles = (folder: string, files: File[]) => Promise<{ name: string; ok: boolean }[]>;
const bridge: {
	pathForFile: (file: File) => string;
	fs: { uploadFiles?: UploadFiles; startDrag: (paths: readonly string[]) => void };
} = {
	pathForFile: () => "",
	fs: { startDrag: () => undefined },
};
Reflect.set(window, "autorag", bridge);
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { FinderPane } = await import("../src/renderer/src/components/FinderPane");

const folder: FinderEntry = {
	name: "child",
	path: "/host/child",
	kind: "folder",
	ext: "",
	size: null,
	mtimeMs: 0,
	birthtimeMs: 0,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.pathForFile = () => "";
	delete bridge.fs.uploadFiles;
	localStorage.clear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	localStorage.clear();
	await setAppLanguage("ko");
});

function drop(files: readonly File[], data: Readonly<Record<string, string>> = {}): DropData<File> {
	return {
		types: [...(files.length > 0 ? ["Files"] : []), ...Object.keys(data)],
		items: files.map((file) => ({
			kind: "file",
			getAsFile: () => file,
			webkitGetAsEntry: () => ({ isDirectory: false }),
		})),
		getData: (format) => data[format] ?? "",
	};
}

/** Await an exact callback with a deadline, never a timer-based rendering guess. */
async function signalled<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("Drop completion was not signalled")), 2000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

async function mount(mode: ViewMode = "list", path = "/host") {
	localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
	const list = vi.fn(async () => [folder]);
	const copyInto = vi.fn(async () => ({ ok: ["/host/report.txt"], failed: [] }));
	const moveInto = vi.fn(async () => ({ ok: ["/host/report.txt"], failed: [] }));
	const source = { ...createFixtureSource(), initialPath: "/host", list, copyInto, moveInto };
	const sidecar = createEntrySidecar();
	const store = createDirectoryStore({ source, sidecar });
	const controllers = createControllerStore();
	const toast = Promise.withResolvers<string>();
	const onToast = vi.fn((message: string) => toast.resolve(message));
	const shell: PaneShell = {
		source,
		store: controllers,
		directoryData: { store, sidecar },
		quickLook: { onQuickLook: () => undefined, closeQuickLook: () => undefined, isQuickLookOpen: () => false },
		update: () => undefined,
		onFocusSearch: () => undefined,
		onFocusComposer: () => undefined,
		onToast,
		deliverToAi: () => undefined,
		onSettingsChanged: () => undefined,
		setListColumns: () => undefined,
		beginTabDrag: () => undefined,
		endTabDrag: () => undefined,
	};
	function Harness() {
		const [workspace, setWorkspace] = useState(() => createWorkspace(path));
		shell.update = setWorkspace;
		return createElement(FinderPane, {
			pane: focusedPane(workspace),
			focused: true,
			canCloseTabs: false,
			split: false,
			showHiddenFiles: false,
			listColumns: DEFAULT_LIST_COLUMNS,
			draggingTabId: null,
			shell,
		});
	}
	await act(async () => root.render(createElement(Harness)));
	const load = vi.spyOn(store, "load");
	return { store, controllers, onToast, toast, list, load, copyInto, moveInto };
}

function target(selector: string): HTMLElement {
	const element = host.querySelector<HTMLElement>(selector);
	if (element === null) throw new Error(`Drop target missing: ${selector}`);
	return element;
}

function dispatchDrop(element: HTMLElement, data: DropData<File>, altKey = false): Event {
	const event = new Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		dataTransfer: { value: data },
		altKey: { value: altKey },
	});
	element.dispatchEvent(event);
	return event;
}

describe("readDropFiles", () => {
	it("leaves desktop files on their original path even when uploads are available", () => {
		// Given a native File with an absolute disk path.
		const file = new File(["report"], "report.txt");
		const data = drop([file]);
		const pathForFile = () => "/downloads/report.txt";
		// When both path and upload readers inspect the drop.
		const paths = readDropPaths(data, pathForFile);
		const files = readDropFiles(data, pathForFile, true);
		// Then the original transfer path wins.
		expect(paths).toEqual(["/downloads/report.txt"]);
		expect(files).toEqual([]);
	});

	it("returns the original browser File objects only with upload support", () => {
		// Given pathless browser files.
		const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];
		const data = drop(files);
		// When the browser and desktop capabilities inspect the same drop.
		const browser = readDropFiles(data, () => "", true);
		const desktop = readDropFiles(data, () => "", false);
		// Then only the browser receives the exact File objects.
		expect(browser).toEqual(files);
		expect(browser[0]).toBe(files[0]);
		expect(browser[1]).toBe(files[1]);
		expect(desktop).toEqual([]);
	});

	it("keeps Finder row and file URL paths ahead of uploads", () => {
		// Given a pathless File accompanied by an existing host path.
		const file = new File(["report"], "report.txt");
		const payloads = [
			{ [FINDER_DRAG_TYPE]: JSON.stringify([{ path: "/host/report.txt", name: file.name, kind: "file" }]) },
			{ "text/uri-list": "file:///host/report.txt" },
		];
		// When each path format is read.
		for (const payload of payloads) {
			// Then neither becomes a byte upload.
			expect(readDropFiles(drop([file], payload), () => "", true)).toEqual([]);
		}
	});

	it("skips directory and unavailable file items", () => {
		// Given a browser directory and protected/non-file items.
		const data: DropData<File> = {
			types: ["Files"],
			getData: () => "",
			items: [
				{ kind: "file", getAsFile: () => new File([], "folder"), webkitGetAsEntry: () => ({ isDirectory: true }) },
				{ kind: "file", getAsFile: () => null },
				{ kind: "string", getAsFile: () => new File([], "text") },
			],
		};
		// When upload files are extracted.
		const files = readDropFiles(data, () => "", true);
		// Then no incomplete directory or non-file upload is attempted.
		expect(files).toEqual([]);
	});
});

describe("FinderPane drop uploads", () => {
	it.each(["list", "icons", "columns"] satisfies ViewMode[])("uploads on the %s background and relists the host folder", async (mode) => {
		// Given an upload-capable browser and a real pane in each layout.
		const files = [new File(["report"], "report.txt")];
		const upload = vi.fn<UploadFiles>(async () => [{ name: "report.txt", ok: true }]);
		bridge.fs.uploadFiles = upload;
		const h = await mount(mode);
		const selectors = { list: '[role="treegrid"]', icons: ".icon-grid", columns: '.column[data-path="/host"]' };
		const destination = target(selectors[mode]);
		// When the file lands on the listing background.
		let event: Event | undefined;
		await act(async () => {
			event = dispatchDrop(destination, drop(files));
			await signalled(h.toast.promise);
		});
		// Then it uploads once, refreshes the captured folder, and never copies paths.
		expect(event?.defaultPrevented).toBe(true);
		expect(upload).toHaveBeenCalledExactlyOnceWith("/host", files);
		expect(h.load).toHaveBeenCalledWith("/host", "silent");
		expect(h.copyInto).not.toHaveBeenCalled();
		expect(h.moveInto).not.toHaveBeenCalled();
	});

	it("claims a folder-row drop so the listing background cannot upload it twice", async () => {
		// Given a folder row inside a listing.
		const files = [new File(["report"], "report.txt")];
		const upload = vi.fn<UploadFiles>(async () => [{ name: "report.txt", ok: true }]);
		bridge.fs.uploadFiles = upload;
		const h = await mount();
		// When the drop bubbles from the row through its background.
		await act(async () => {
			dispatchDrop(target('[role="row"][data-path="/host/child"]'), drop(files));
			await signalled(h.toast.promise);
		});
		// Then only the row's folder receives the upload.
		expect(upload).toHaveBeenCalledExactlyOnceWith("/host/child", files);
		expect(h.load).toHaveBeenCalledWith("/host/child", "silent");
	});

	it("uploads a browser file dropped onto a folder tab", async () => {
		// Given a real folder tab and browser upload support.
		const files = [new File(["report"], "report.txt")];
		const upload = vi.fn<UploadFiles>(async () => [{ name: "report.txt", ok: true }]);
		bridge.fs.uploadFiles = upload;
		const h = await mount();
		// When the file lands on the tab strip.
		await act(async () => {
			dispatchDrop(target('[data-tab-id="1"]'), drop(files));
			await signalled(h.toast.promise);
		});
		// Then the tab's host folder receives the upload.
		expect(upload).toHaveBeenCalledExactlyOnceWith("/host", files);
		expect(h.load).toHaveBeenCalledWith("/host", "silent");
	});

	it.each([false, true])("preserves desktop copy/move with alt=%s and no upload method", async (altKey) => {
		// Given the desktop preload: a disk path and no uploadFiles method.
		bridge.pathForFile = () => "/downloads/report.txt";
		const h = await mount();
		// When a native file is dropped with the existing modifier semantics.
		await act(async () => {
			dispatchDrop(target('[role="treegrid"]'), drop([new File(["report"], "report.txt")]), altKey);
			await signalled(h.toast.promise);
		});
		// Then the existing controller receives exactly the original transfer.
		expect(altKey ? h.moveInto : h.copyInto).toHaveBeenCalledExactlyOnceWith(["/downloads/report.txt"], "/host");
		expect(altKey ? h.copyInto : h.moveInto).not.toHaveBeenCalled();
	});

	it("surfaces a refused upload through the existing translated copy toast", async () => {
		// Given an HTTP refusal represented by ok:false.
		bridge.fs.uploadFiles = async () => [{ name: "report.txt", ok: false }];
		const h = await mount();
		// When that browser file is dropped.
		await act(async () => {
			dispatchDrop(target('[role="treegrid"]'), drop([new File(["report"], "report.txt")]));
			await signalled(h.toast.promise);
		});
		// Then the existing toast names the failure and the folder is revalidated.
		expect(h.onToast).toHaveBeenCalledWith(t("finderState.toast.batchFailedSingle", {
			name: "report.txt",
			reason: t("finderState.toast.batchFailed.copy"),
			message: t("common.error"),
		}));
		expect(h.load).toHaveBeenCalledWith("/host", "silent");
	});

	it("surfaces a rejected upload's actual error", async () => {
		// Given a transport failure.
		bridge.fs.uploadFiles = async () => { throw new Error("Upload connection lost"); };
		const h = await mount();
		// When the upload rejects.
		await act(async () => {
			dispatchDrop(target('[role="treegrid"]'), drop([new File(["report"], "report.txt")]));
			await signalled(h.toast.promise);
		});
		// Then the operator sees the error, never a successful copy.
		expect(h.onToast).toHaveBeenCalledExactlyOnceWith("Upload connection lost");
		expect(h.copyInto).not.toHaveBeenCalled();
	});

	it("does not upload into a virtual listing with no host folder", async () => {
		// Given Recents, which collects files across folders.
		const upload = vi.fn<UploadFiles>(async () => []);
		bridge.fs.uploadFiles = upload;
		const h = await mount("list", RECENTS_PATH);
		// When a pathless file is dropped there.
		act(() => { dispatchDrop(target('[role="treegrid"]'), drop([new File(["report"], "report.txt")])); });
		// Then neither upload nor disk transfer starts.
		expect(upload).not.toHaveBeenCalled();
		expect(h.copyInto).not.toHaveBeenCalled();
		expect(h.moveInto).not.toHaveBeenCalled();
	});
});
