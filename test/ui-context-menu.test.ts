import { describe, expect, it } from "vitest";
import {
	buildBackgroundContextMenu,
	buildContextMenu,
	estimateMenuHeight,
	menuPlacement,
} from "../src/renderer/src/state/context-menu";
import type { ContextMenuInput, FinderMenuEntry, FinderMenuItem, FinderMenuSubmenu } from "../src/renderer/src/state/context-menu";
import { NEW_FILE_FORMATS } from "../src/shared/new-file-contract";
import { NO_CAPABILITIES, type ActionCapabilities } from "../src/shared/actions-contract";

/** Every engine present, so the row menu's full action set is reachable. */
const MAC: ActionCapabilities = {
	openWith: true,
	share: true,
	archive: true,
	imageFormats: [],
	videoContainers: [],
};

const file = {
	target: { name: "a.pdf", kind: "file" as const },
	selectionCount: 1,
	indexIncluded: true,
	clipboardCount: 0,
	capabilities: MAC,
	canCreateFolder: true,
};

function items(entries: ReturnType<typeof buildContextMenu>): FinderMenuItem[] {
	return entries.filter((e): e is FinderMenuItem => e.kind === "item");
}

describe("buildContextMenu", () => {
	it("opens with Quick Look and its space keycap for a file", () => {
		const first = items(buildContextMenu(file))[0];
		expect(first?.label).toBe("Quick Look");
		expect(first?.keycap).toBe("space");
		expect(first?.action).toBe("quickLook");
	});

	it("opens with 열기 and the return keycap for a folder", () => {
		const menu = buildContextMenu({ ...file, target: { name: "Finance", kind: "folder" } });
		const first = items(menu)[0];
		expect(first?.label).toBe("열기");
		expect(first?.keycap).toBe("↩");
		expect(first?.action).toBe("open");
	});

	it("offers the index toggle for files only", () => {
		expect(items(buildContextMenu(file)).map((i) => i.label)).toContain("인덱싱에서 제외");
		expect(items(buildContextMenu({ ...file, indexIncluded: false })).map((i) => i.label)).toContain("인덱싱에 포함");
		const folder = items(buildContextMenu({ ...file, target: { name: "Finance", kind: "folder" } }));
		expect(folder.map((i) => i.action)).not.toContain("toggleIndex");
	});

	it("lists the row actions in Finder order", () => {
		expect(items(buildContextMenu(file)).map((i) => i.action)).toEqual([
			"quickLook",
			"openWith",
			"toggleIndex",
			"copy",
			"paste",
			"cut",
			"duplicate",
			"rename",
			"copyPath",
			"newFolder",
			"compress",
			"share",
			"trash",
		]);
	});

	it("enables 붙여넣기 only when the clipboard has items", () => {
		const disabled = items(buildContextMenu(file)).find((i) => i.action === "paste");
		expect(disabled?.disabled).toBe(true);
		const enabled = items(buildContextMenu({ ...file, clipboardCount: 2 })).find((i) => i.action === "paste");
		expect(enabled?.disabled).toBe(false);
	});

	it("shows the clipboard shortcuts on 복사 / 붙여넣기 / 잘라내기", () => {
		const menu = items(buildContextMenu(file));
		expect(menu.find((i) => i.action === "copy")?.keycap).toBe("⌘C");
		expect(menu.find((i) => i.action === "paste")?.keycap).toBe("⌘V");
		expect(menu.find((i) => i.action === "cut")?.keycap).toBe("⌘X");
	});

	it("disables 이름 변경 for a multi-selection", () => {
		const single = items(buildContextMenu(file)).find((i) => i.action === "rename");
		expect(single?.disabled).toBe(false);
		const many = items(buildContextMenu({ ...file, selectionCount: 3 })).find((i) => i.action === "rename");
		expect(many?.disabled).toBe(true);
	});

	it("marks the trash item destructive and counts a multi-selection", () => {
		const one = items(buildContextMenu(file)).at(-1);
		expect(one?.label).toBe("휴지통으로 이동");
		expect(one?.keycap).toBe("⌫");
		expect(one?.tone).toBe("danger");
		const many = items(buildContextMenu({ ...file, selectionCount: 4 })).at(-1);
		expect(many?.label).toBe("4개 항목 휴지통으로 이동");
	});

	it("separates the groups exactly like the reference", () => {
		expect(buildContextMenu(file).map((e) => e.kind)).toEqual([
			"item",
			"item",
			"separator",
			"item",
			"separator",
			"item",
			"item",
			"item",
			"item",
			"item",
			"item",
			"separator",
			"item",
			"item",
			"item",
			"separator",
			"item",
		]);
	});
});

describe("buildContextMenu row actions", () => {
	const zip = { ...file, target: { name: "bundle.zip", kind: "file" as const } };
	const actionsOf = (input: Partial<ContextMenuInput>) => items(buildContextMenu({ ...file, ...input })).map((i) => i.action);

	it("offers the headline actions right where the row is", () => {
		expect(items(buildContextMenu(zip)).map((i) => i.action)).toEqual([
			"quickLook",
			"openWith",
			"toggleIndex",
			"copy",
			"paste",
			"cut",
			"duplicate",
			"rename",
			"copyPath",
			"newFolder",
			"extract",
			"compress",
			"share",
			"trash",
		]);
		expect(items(buildContextMenu(file)).find((i) => i.action === "openWith")?.label).toBe("다른 앱으로 열기");
		expect(items(buildContextMenu(file)).find((i) => i.action === "compress")?.label).toBe("압축");
		expect(items(buildContextMenu(file)).find((i) => i.action === "share")?.label).toBe("공유");
		expect(items(buildContextMenu(file)).find((i) => i.action === "newFolder")?.label).toBe("새 폴더");
		expect(items(buildContextMenu(zip)).find((i) => i.action === "extract")?.label).toBe("압축 해제");
	});

	it("hides every engine-gated item when the machine has no engines", () => {
		expect(actionsOf({ target: { name: "bundle.zip", kind: "file" }, capabilities: NO_CAPABILITIES })).toEqual([
			"quickLook",
			"toggleIndex",
			"copy",
			"paste",
			"cut",
			"duplicate",
			"rename",
			"copyPath",
			"newFolder",
			"trash",
		]);
	});

	it("keeps Open With off folders and the other row actions on them", () => {
		expect(actionsOf({ target: { name: "Finance", kind: "folder" } })).not.toContain("openWith");
		expect(actionsOf({ target: { name: "Finance", kind: "folder" } })).toContain("compress");
		expect(actionsOf({ target: { name: "Finance", kind: "folder" } })).toContain("share");
		expect(actionsOf({ target: { name: "Finance", kind: "folder" } })).toContain("newFolder");
	});

	it("offers Extract for one archive, never a non-archive", () => {
		expect(actionsOf({ target: { name: "bundle.zip", kind: "file" } })).toContain("extract");
		expect(actionsOf({ target: { name: "bundle.tar", kind: "file" } })).toContain("extract");
		expect(actionsOf({ target: { name: "bundle.tar.gz", kind: "file" } })).toContain("extract");
		expect(actionsOf({ target: { name: "notes.txt", kind: "file" } })).not.toContain("extract");
		expect(actionsOf({ target: { name: "bundle.zip", kind: "file" }, selectionCount: 2 })).not.toContain("extract");
	});

	it("keeps the batch actions and drops the single-target ones on a multi-selection", () => {
		const many = items(buildContextMenu({ ...zip, selectionCount: 3 }));
		expect(many.find((i) => i.action === "compress")?.label).toBe("3개 항목 압축");
		expect(many.find((i) => i.action === "share")?.label).toBe("공유");
		expect(many.map((i) => i.action)).toContain("openWith");
		expect(many.map((i) => i.action)).not.toContain("extract");
	});

	it("keeps the row actions out of the Trash", () => {
		const trashed = actionsOf({ inTrash: true });
		expect(trashed).not.toContain("openWith");
		expect(trashed).not.toContain("extract");
		expect(trashed).not.toContain("compress");
		expect(trashed).not.toContain("share");
		expect(trashed).not.toContain("newFolder");
	});

	it("hides 새 폴더 where a folder cannot be created", () => {
		expect(actionsOf({ canCreateFolder: false })).not.toContain("newFolder");
	});
});

describe("buildContextMenu in the Recents view", () => {
	const recentFile = { ...file, inRecents: true };

	it("offers Show in Enclosing Folder for a recent file", () => {
		const entry = items(buildContextMenu(recentFile)).find((i) => i.action === "showInEnclosingFolder");
		expect(entry?.label).toBe("Show in Enclosing Folder");
		expect(entry?.keycap).toBeNull();
		expect(entry?.tone).toBe("default");
		expect(entry?.disabled).toBe(false);
	});

	it("keeps the item out of ordinary folder listings", () => {
		expect(items(buildContextMenu(file)).map((i) => i.action)).not.toContain("showInEnclosingFolder");
	});

	it("places it in its own group right after the open group", () => {
		const entries = buildContextMenu(recentFile);
		expect(entries.slice(0, 5).map((e) => e.kind)).toEqual(["item", "item", "separator", "item", "separator"]);
		expect(items(entries)[2]?.action).toBe("showInEnclosingFolder");
	});

	it("adds exactly one item and one separator to the height estimate", () => {
		expect(estimateMenuHeight(buildContextMenu(recentFile))).toBe(estimateMenuHeight(buildContextMenu(file)) + 28 + 9);
	});
});

describe("buildContextMenu in the Trash view", () => {
	it("offers Put Back instead of Move to Trash", () => {
		const menu = items(buildContextMenu({ ...file, inTrash: true }));
		expect(menu.map((i) => i.action)).toContain("putBack");
		expect(menu.map((i) => i.action)).not.toContain("trash");
		expect(menu.at(-1)?.label).toBe("원래 위치로 복원");
		expect(menu.at(-1)?.keycap).toBeNull();
	});

	it("counts a multi-selection in the Put Back item", () => {
		const menu = items(buildContextMenu({ ...file, inTrash: true, selectionCount: 4 }));
		expect(menu.at(-1)?.label).toBe("4개 항목 원래 위치로 복원");
	});

	it("keeps Move to Trash in ordinary folder listings", () => {
		const menu = items(buildContextMenu(file));
		expect(menu.map((i) => i.action)).toContain("trash");
		expect(menu.map((i) => i.action)).not.toContain("putBack");
	});
});

describe("buildBackgroundContextMenu", () => {
	const submenuOf = (entries: readonly FinderMenuEntry[]): FinderMenuSubmenu => {
		const entry = entries.find((candidate): candidate is FinderMenuSubmenu => candidate.kind === "submenu");
		if (entry === undefined) throw new Error("no submenu entry");
		return entry;
	};

	it("offers a New submenu with a folder and every document format", () => {
		const submenu = submenuOf(buildBackgroundContextMenu({ clipboardCount: 0 }));
		expect(submenu.label).toBe("새로 만들기");
		expect(submenu.items.map((entry) => entry.action)).toEqual([
			"newFolder",
			...NEW_FILE_FORMATS.map(() => "newFile"),
		]);
		expect(submenu.items.map((entry) => entry.label)).toEqual([
			"새 폴더",
			...NEW_FILE_FORMATS.map((format) => format.label),
		]);
	});

	it("carries each submenu item's file format, and none for the folder", () => {
		const submenu = submenuOf(buildBackgroundContextMenu({ clipboardCount: 0 }));
		const [folder, ...files] = submenu.items;
		expect(folder?.format).toBeNull();
		expect(files.map((entry) => entry.format)).toEqual(NEW_FILE_FORMATS.map((format) => format.id));
	});

	it("separates the New submenu from paste and disables paste without clipboard items", () => {
		const entries = buildBackgroundContextMenu({ clipboardCount: 0 });
		expect(entries.map((entry) => entry.kind)).toEqual(["submenu", "separator", "item"]);
		const paste = entries.find((entry): entry is FinderMenuItem => entry.kind === "item");
		expect(paste?.action).toBe("paste");
		expect(paste?.keycap).toBe("⌘V");
		expect(paste?.disabled).toBe(true);
		expect(
			buildBackgroundContextMenu({ clipboardCount: 3 }).find((entry) => entry.kind === "item"),
		).toMatchObject({ disabled: false });
	});

	it("offers 휴지통 비우기 in the Trash view, destructive", () => {
		const menu = items(buildBackgroundContextMenu({ clipboardCount: 0, inTrash: true }));
		const emptyTrash = menu.find((i) => i.action === "emptyTrash");
		expect(emptyTrash?.label).toBe("휴지통 비우기");
		expect(emptyTrash?.tone).toBe("danger");
	});

	it("keeps the ordinary folder menu without the Trash", () => {
		expect(items(buildBackgroundContextMenu({ clipboardCount: 0 })).map((i) => i.action)).not.toContain("emptyTrash");
	});

	it("counts the submenu parent as one row in the height estimate", () => {
		expect(estimateMenuHeight(buildBackgroundContextMenu({ clipboardCount: 0 }))).toBe(2 * 28 + 1 * 9 + 2 * 5);
	});
});

describe("menuPlacement", () => {
	const size = { width: 220, height: 300 };
	const viewport = { width: 1440, height: 900 };

	it("anchors at the cursor when the menu fits", () => {
		expect(menuPlacement({ x: 400, y: 200 }, size, viewport)).toEqual({ left: 400, top: 200 });
	});

	it("flips above the cursor when the bottom edge would clip", () => {
		expect(menuPlacement({ x: 400, y: 800 }, size, viewport)).toEqual({ left: 400, top: 500 });
	});

	it("pulls back from the right edge", () => {
		expect(menuPlacement({ x: 1400, y: 200 }, size, viewport)).toEqual({ left: 1212, top: 200 });
	});

	it("clamps the left edge to the window margin", () => {
		expect(menuPlacement({ x: 2, y: 10 }, size, viewport)).toEqual({ left: 8, top: 10 });
	});

	it("clamps a menu taller than the viewport to the top margin", () => {
		expect(menuPlacement({ x: 400, y: 10 }, { width: 220, height: 1000 }, viewport)).toEqual({ left: 400, top: 8 });
	});
});

describe("estimateMenuHeight", () => {
	it("measures items, separators, and the menu padding", () => {
		expect(estimateMenuHeight(buildContextMenu(file))).toBe(13 * 28 + 4 * 9 + 2 * 5);
	});
});
