/**
 * Row context menu contents.
 *
 * The first two groups and the trash item are the reference's (handoff README
 * §2 "Context menu"). The middle group is the standard Finder file-operation
 * set the product requires on top of the design: copy / paste / cut /
 * duplicate / rename / copy path. "Show in Enclosing Folder" is a product
 * addition too, and only the virtual Recents view offers it — elsewhere the
 * row already lives in the folder it would open.
 *
 * The row-action group mirrors the Inspector's headline actions — new folder,
 * open with, compress, extract, share — so the representative jobs are one
 * right-click away. It is capability-gated (`ActionCapabilities`): an item
 * whose engine is missing never renders, and the multi-selection keeps only
 * the batch-meaningful items.
 */

import { deleteKeyLabel, enterKeyLabel, formatShortcut } from "../lib/shortcuts";
import { NEW_FILE_FORMATS, type NewFileFormatId } from "../../../shared/new-file-contract";
import type { ActionCapabilities } from "../../../shared/actions-contract";
import { archiveFormatOf } from "../../../shared/archive-formats";
import type { ServiceEntry } from "../../../shared/services-contract";
import type { FsTagCatalog, FsTagColor } from "../../../shared/fs-contract";
import { TAG_MENU_COLORS, tagKey } from "./tags";

export type FinderMenuAction =
	| "quickLook"
	| "open"
	| "openWith"
	| "showInEnclosingFolder"
	| "toggleIndex"
	| "retryIndex"
	| "copy"
	| "paste"
	| "cut"
	| "duplicate"
	| "rename"
	| "copyPath"
	| "share"
	| "compress"
	| "extract"
	| "putBack"
	| "trash"
	| "emptyTrash"
	| "newFolder"
	| "newFile"
	| "service"
	| "toggleTag";

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

/** One leaf of a popout. */
export interface FinderMenuSubmenuItem {
	readonly kind: "submenu-item";
	readonly action: FinderMenuAction;
	readonly label: string;
	/** The document format a `newFile` item creates; null otherwise. */
	readonly format: NewFileFormatId | null;
	/** The OS service a `service` leaf performs; absent on every other leaf. */
	readonly serviceId?: string;
	/** The Finder tag a `toggleTag` leaf adds or removes. */
	readonly tagName?: string;
	/** The whole selection carries this tag; choosing it removes the tag. */
	readonly checked?: boolean;
}

/** A parent row that opens a popout panel on hover (the "새로 만들기" and "서비스" submenus). */
export interface FinderMenuSubmenu {
	readonly kind: "submenu";
	readonly label: string;
	readonly items: readonly FinderMenuSubmenuEntry[];
}

/** A popout row: a leaf, or (for 서비스) one more parent for an application's services. */
export type FinderMenuSubmenuEntry = FinderMenuSubmenuItem | FinderMenuSubmenu;

export type FinderMenuEntry = FinderMenuItem | FinderMenuSeparator | FinderMenuSubmenu | FinderMenuTagRow;

/**
 * Finder's row of colour dots: each dot is the tag Finder gives that colour
 * (a Mac that renamed Red to "Research" shows Research under the red dot), and
 * one click tags or untags the selection with it. `hint` is the line Finder
 * prints while the pointer is on the dot: Add "X" or Remove "X".
 */
export interface FinderMenuTagRow {
	readonly kind: "tags";
	readonly label: string;
	readonly swatches: readonly {
		readonly name: string;
		readonly color: FsTagColor;
		readonly checked: boolean;
		readonly hint: string;
	}[];
}

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
	/** What this machine can run; a missing engine removes its row action. */
	readonly capabilities: ActionCapabilities;
	/** Whether 새 폴더 can create in the folder the menu acts on. */
	readonly canCreateFolder: boolean;
	/** The OS services offered for the selection; absent or empty hides 서비스. */
	readonly services?: readonly ServiceEntry[];
	/** Finder's tags and the tags (lower-case) every selected row carries; absent or unsupported hides the tag items. */
	readonly tags?: { readonly catalog: FsTagCatalog; readonly shared: ReadonlySet<string> };
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

/**
 * The 서비스 parent: services without a group sit directly in it, and each
 * application's services open under one row named for the application. Null
 * when there is nothing to offer, and always inside the Trash, where a row goes
 * back or away rather than to another app.
 */
function servicesSubmenu(
	services: readonly ServiceEntry[] | undefined,
	inTrash: boolean,
	tr: (key: string, def: string, opt?: Record<string, unknown>) => string,
): FinderMenuSubmenu | null {
	if (inTrash || services === undefined || services.length === 0) return null;
	const leaf = (service: ServiceEntry): FinderMenuSubmenuItem => ({
		kind: "submenu-item",
		action: "service",
		label: service.name,
		format: null,
		serviceId: service.id,
	});
	const items: FinderMenuSubmenuEntry[] = services.filter((service) => service.group === null).map(leaf);
	const groups = new Map<string, FinderMenuSubmenuItem[]>();
	for (const service of services) {
		if (service.group === null) continue;
		groups.set(service.group, [...(groups.get(service.group) ?? []), leaf(service)]);
	}
	for (const [group, children] of groups) items.push({ kind: "submenu", label: group, items: children });
	return { kind: "submenu", label: tr("contextMenu.services", "서비스"), items };
}

/**
 * Finder's tag block: the seven colour dots as one row, then a "Tags" submenu
 * listing every tag Finder knows (ticked when the whole selection carries it).
 * Empty off macOS, in the Trash, and when the registry has nothing to offer.
 */
function tagMenuEntries(
	input: ContextMenuInput,
	tr: (key: string, def: string, opt?: Record<string, unknown>) => string,
): FinderMenuEntry[] {
	const tags = input.tags;
	if (tags === undefined || !tags.catalog.supported || input.inTrash === true) return [];
	const names = tags.catalog.colorNames;
	const swatches = TAG_MENU_COLORS.flatMap((color) => {
		// The tag Finder pins for this colour, else the OS's own colour name.
		const pinned = tags.catalog.tags.find((tag) => tag.color === color && tag.sidebar);
		const name = pinned?.name ?? names[color] ?? "";
		if (name === "") return [];
		const checked = tags.shared.has(tagKey(name));
		const hint = checked
			? tr("contextMenu.removeTag", `Remove “${name}”`, { name })
			: tr("contextMenu.addTag", `Add “${name}”`, { name });
		return [{ name, color, checked, hint }];
	});
	const leaves: FinderMenuSubmenuItem[] = tags.catalog.tags.map((tag) => ({
		kind: "submenu-item",
		action: "toggleTag",
		label: tag.name,
		format: null,
		tagName: tag.name,
		checked: tags.shared.has(tagKey(tag.name)),
	}));
	const entries: FinderMenuEntry[] = [];
	if (swatches.length > 0) entries.push({ kind: "tags", label: tr("contextMenu.tags", "태그"), swatches });
	if (leaves.length > 0) entries.push({ kind: "submenu", label: tr("contextMenu.tagsMenu", "태그…"), items: leaves });
	return entries;
}

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
	// The open group, Finder-style: 다른 앱으로 열기 sits directly under 열기.
	// Like the row-action group below, it never appears inside the Trash.
	if (!isFolder && input.inTrash !== true && input.capabilities.openWith) {
		entries.push(item("openWith", tr("contextMenu.openWith", "다른 앱으로 열기")));
	}
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
		item("duplicate", tr("contextMenu.duplicate", "복제"), { keycap: formatShortcut({ key: "D" }) }),
		item("rename", tr("contextMenu.rename", "이름 변경"), { keycap: formatShortcut({ key: "R" }), disabled: multi }),
		item("copyPath", tr("contextMenu.copyPath", "경로 복사")),
	);

	// The row-action group: the Inspector's headline actions, run on the whole
	// selection. Capability-gated, and never offered inside the Trash — a
	// trashed row goes back (Put Back) or away, not into an archive or a sheet.
	const rowActions: FinderMenuItem[] = [];
	if (input.inTrash !== true) {
		if (input.canCreateFolder) {
			rowActions.push(item("newFolder", tr("contextMenu.newFolder", "새 폴더")));
		}
		if (input.capabilities.archive) {
			// Extraction is single-target: one archive row on its own.
			if (!multi && archiveFormatOf(input.target.name) !== null) {
				rowActions.push(item("extract", tr("contextMenu.extract", "압축 해제")));
			}
			rowActions.push(
				item(
					"compress",
					multi
						? tr("contextMenu.compressCount", `${input.selectionCount}개 항목 압축`, { count: input.selectionCount })
						: tr("contextMenu.compress", "압축"),
				),
			);
		}
		if (input.capabilities.share) {
			rowActions.push(item("share", tr("contextMenu.share", "공유")));
		}
	}
	if (rowActions.length > 0) {
		entries.push(SEPARATOR, ...rowActions);
	}
	const services = servicesSubmenu(input.services, input.inTrash === true, tr);
	if (services !== null) entries.push(SEPARATOR, services);

	const tagItems = tagMenuEntries(input, tr);
	if (tagItems.length > 0) entries.push(SEPARATOR, ...tagItems);

	entries.push(
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
	/** The OS services offered for the folder in view; absent or empty hides 서비스. */
	readonly services?: readonly ServiceEntry[];
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
	const services = servicesSubmenu(input.services, input.inTrash === true, tr);
	return [
		submenu,
		SEPARATOR,
		item("paste", tr("contextMenu.paste", "붙여넣기"), { keycap: formatShortcut({ key: "V" }), disabled: input.clipboardCount === 0 }),
		...(services === null ? [] : [SEPARATOR, services]),
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
/** The colour-dot row: 16px swatches over a one-line hover caption, plus padding. */
const MENU_TAG_ROW_HEIGHT = 52;
/** 1px rule plus its 4px margins. */
const MENU_SEPARATOR_HEIGHT = 9;
/** --space-5 padding, top and bottom. */
const MENU_PADDING = 5;

export function estimateMenuHeight(entries: readonly FinderMenuEntry[]): number {
	let height = MENU_PADDING * 2;
	for (const entry of entries) {
		height += entry.kind === "separator" ? MENU_SEPARATOR_HEIGHT : entry.kind === "tags" ? MENU_TAG_ROW_HEIGHT : MENU_ITEM_HEIGHT;
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
