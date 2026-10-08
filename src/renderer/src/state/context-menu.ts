/**
 * Row context menu contents.
 *
 * The first two groups and the trash item are the reference's (handoff README
 * §2 "Context menu"). The middle group is the standard Finder file-operation
 * set the product requires on top of the design: copy / paste / cut /
 * duplicate / rename / copy path. "Show in Enclosing Folder" is a product
 * addition too, and only the virtual Recents view offers it — elsewhere the
 * row already lives in the folder it would open.
 */

import { deleteKeyLabel, enterKeyLabel, formatShortcut } from "../lib/shortcuts";
import { NEW_FILE_FORMATS, type NewFileFormatId } from "../../../shared/new-file-contract";

export type FinderMenuAction =
	| "quickLook"
	| "open"
	| "showInEnclosingFolder"
	| "toggleIndex"
	| "retryIndex"
	| "copy"
	| "paste"
	| "cut"
	| "duplicate"
	| "rename"
	| "copyPath"
	| "putBack"
	| "trash"
	| "emptyTrash"
	| "newFolder"
	| "newFile";

export type MenuTone = "default" | "danger" | "warning";

export interface FinderMenuItem {
	readonly kind: "item";
	readonly action: FinderMenuAction;
	readonly label: string;
	readonly keycap: string | null;
	readonly tone: MenuTone;
	readonly disabled: boolean;
}

export interface FinderMenuSeparator {
	readonly kind: "separator";
}

/** One row of the New submenu's popout. */
export interface FinderMenuSubmenuItem {
	readonly kind: "submenu-item";
	readonly action: FinderMenuAction;
	readonly label: string;
	/** The document format a `newFile` item creates; null for the folder item. */
	readonly format: NewFileFormatId | null;
}

/** A parent row that opens a popout panel on hover (the "새로 만들기" submenu). */
export interface FinderMenuSubmenu {
	readonly kind: "submenu";
	readonly label: string;
	readonly items: readonly FinderMenuSubmenuItem[];
}

export type FinderMenuEntry = FinderMenuItem | FinderMenuSeparator | FinderMenuSubmenu;

export interface ContextMenuInput {
	readonly target: { readonly name: string; readonly kind: "file" | "folder" };
	readonly selectionCount: number;
	readonly indexIncluded: boolean;
	readonly indexFailed?: boolean;
	/** Items held by the in-app file clipboard; 0 disables 붙여넣기. */
	readonly clipboardCount: number;
	/** True while the listing is the virtual Recents location. */
	readonly inRecents?: boolean;
	/** True while the listing is the Trash location: rows go back (Put Back) instead of to the Trash. */
	readonly inTrash?: boolean;
}

function item(
	action: FinderMenuAction,
	label: string,
	options: { keycap?: string; tone?: MenuTone; disabled?: boolean } = {},
): FinderMenuItem {
	return {
		kind: "item",
		action,
		label,
		keycap: options.keycap ?? null,
		tone: options.tone ?? "default",
		disabled: options.disabled ?? false,
	};
}

const SEPARATOR: FinderMenuSeparator = { kind: "separator" };

export function buildContextMenu(
	input: ContextMenuInput,
	translate?: (key: string, def: string, opt?: Record<string, unknown>) => string,
): FinderMenuEntry[] {
	const isFolder = input.target.kind === "folder";
	const multi = input.selectionCount > 1;
	const tr = (key: string, def: string, opt?: Record<string, unknown>): string => (translate ? translate(key, def, opt) : def);
	const entries: FinderMenuEntry[] = [
		isFolder
			? item("open", tr("contextMenu.open", "열기"), { keycap: enterKeyLabel() })
			: item("quickLook", tr("contextMenu.quickLook", "Quick Look"), { keycap: "space" }),
	];
	if (input.inRecents === true) {
		entries.push(SEPARATOR, item("showInEnclosingFolder", tr("contextMenu.showInEnclosingFolder", "Show in Enclosing Folder")));
	}

	if (!isFolder) {
		entries.push(SEPARATOR);
		entries.push(
			input.indexFailed === true
				? item("retryIndex", tr("contextMenu.retryIndex", "인덱싱 다시 시도"), { tone: "warning" })
				: item("toggleIndex", input.indexIncluded ? tr("contextMenu.excludeFromIndex", "인덱싱에서 제외") : tr("contextMenu.includeInIndex", "인덱싱에 포함")),
		);
	}

	entries.push(
		SEPARATOR,
		item("copy", tr("contextMenu.copy", "복사"), { keycap: formatShortcut({ key: "C" }) }),
		item("paste", tr("contextMenu.paste", "붙여넣기"), { keycap: formatShortcut({ key: "V" }), disabled: input.clipboardCount === 0 }),
		item("cut", tr("contextMenu.cut", "잘라내기"), { keycap: formatShortcut({ key: "X" }) }),
		item("duplicate", tr("contextMenu.duplicate", "복제")),
		item("rename", tr("contextMenu.rename", "이름 변경"), { disabled: multi }),
		item("copyPath", tr("contextMenu.copyPath", "경로 복사")),
		SEPARATOR,
		input.inTrash === true
			? item(
					"putBack",
					multi
						? tr("contextMenu.putBackCount", `${input.selectionCount}개 항목 원래 위치로 복원`, { count: input.selectionCount })
						: tr("contextMenu.putBack", "원래 위치로 복원"),
				)
			: item(
					"trash",
					multi
						? tr("contextMenu.moveToTrashCount", `${input.selectionCount}개 항목 휴지통으로 이동`, { count: input.selectionCount })
						: tr("contextMenu.moveToTrash", "휴지통으로 이동"),
					{
						keycap: deleteKeyLabel(),
						tone: "danger",
					},
				),
		);
	return entries;
}

export interface BackgroundMenuInput {
	/** Items held by the in-app file clipboard; 0 disables 붙여넣기. */
	readonly clipboardCount: number;
	/** True while the listing is the Trash location: the menu offers 휴지통 비우기. */
	readonly inTrash?: boolean;
}

/**
 * The empty-space (background) context menu. "새로 만들기" opens a submenu with
 * a folder and every new-file format; 붙여넣기 pastes the in-app file clipboard
 * into the folder in view. It never carries row actions — those need a target.
 */
export function buildBackgroundContextMenu(
	input: BackgroundMenuInput,
	translate?: (key: string, def: string, opt?: Record<string, unknown>) => string,
): FinderMenuEntry[] {
	const tr = (key: string, def: string, opt?: Record<string, unknown>): string => (translate ? translate(key, def, opt) : def);
	const submenu: FinderMenuSubmenu = {
		kind: "submenu",
		label: tr("contextMenu.new", "새로 만들기"),
		items: [
			{ kind: "submenu-item", action: "newFolder", label: tr("contextMenu.newFolder", "새 폴더"), format: null },
			...NEW_FILE_FORMATS.map(
				(format): FinderMenuSubmenuItem => ({
					kind: "submenu-item",
					action: "newFile",
					label: format.label,
					format: format.id,
				}),
			),
		],
	};
	return [
		submenu,
		SEPARATOR,
		item("paste", tr("contextMenu.paste", "붙여넣기"), { keycap: formatShortcut({ key: "V" }), disabled: input.clipboardCount === 0 }),
		...(input.inTrash === true
			? [SEPARATOR, item("emptyTrash", tr("contextMenu.emptyTrash", "휴지통 비우기"), { tone: "danger" })]
			: []),
	];
}

/* ------------------------------------------------------------- positioning */

export interface MenuPoint {
	readonly x: number;
	readonly y: number;
}

export interface MenuSize {
	readonly width: number;
	readonly height: number;
}

export interface MenuPlacement {
	readonly left: number;
	readonly top: number;
}

/** Keeps the fixed-position menu inside the window, like the reference's
 * "opens upward when the row is among the last 4" rule for the access menu. */
/** Mirrors --w-context-menu; the placement math needs the number. */
export const CONTEXT_MENU_WIDTH = 220;
const MENU_MARGIN = 8;
const MENU_ITEM_HEIGHT = 28;
/** 1px rule plus its 4px margins. */
const MENU_SEPARATOR_HEIGHT = 9;
/** --space-5 padding, top and bottom. */
const MENU_PADDING = 5;

export function estimateMenuHeight(entries: readonly FinderMenuEntry[]): number {
	let height = MENU_PADDING * 2;
	for (const entry of entries) {
		height += entry.kind === "separator" ? MENU_SEPARATOR_HEIGHT : MENU_ITEM_HEIGHT;
	}
	return height;
}

/** Estimated menu height for `count` plain items (the Inspector action menus have no separators). */
export function menuHeightForItems(count: number): number {
	return MENU_PADDING * 2 + count * MENU_ITEM_HEIGHT;
}

export function menuPlacement(cursor: MenuPoint, size: MenuSize, viewport: MenuSize): MenuPlacement {
	const left = Math.max(MENU_MARGIN, Math.min(cursor.x, viewport.width - size.width - MENU_MARGIN));
	const overflows = cursor.y + size.height > viewport.height - MENU_MARGIN;
	const top = overflows ? Math.max(MENU_MARGIN, cursor.y - size.height) : cursor.y;
	return { left, top };
}
