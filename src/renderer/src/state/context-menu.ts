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
import { t } from "../../../shared/i18n/core";
import { NEW_FILE_FORMATS, type NewFileFormatId } from "../../../shared/new-file-contract";
import type { ActionCapabilities } from "../../../shared/actions-contract";
import { archiveFormatOf } from "../../../shared/archive-formats";
import type { ServiceEntry } from "../../../shared/services-contract";
import type { FsTagCatalog, FsTagColor } from "../../../shared/fs-contract";
import { TAG_MENU_COLORS, tagKey } from "./tags";
import {
	DEFAULT_CONTEXT_MENU_SETTINGS,
	matchesMagicAction,
	normalizeContextMenuSettings,
	type ContextMenuSectionId,
	type ContextMenuSettings,
	type MagicActionTargetDescriptor,
} from "../../../shared/context-menu-contract";

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
	| "compress7z"
	| "extract"
	| "putBack"
	| "trash"
	| "emptyTrash"
	| "newFolder"
	| "newFile"
	| "service"
	| "toggleTag"
	| "magicAction"
	// The automation rules list (자동화 tab): these never reach the Finder controller's runMenuAction.
	| "editRule"
	| "addRule"
	| "deleteRule"
	| "openRuleFolder"
	| "revealRule";

export type MenuTone = "default" | "danger" | "warning";

export interface FinderMenuItem {
	readonly kind: "item";
	readonly action: FinderMenuAction;
	readonly label: string;
	readonly keycap: string | null;
	readonly tone: MenuTone;
	readonly disabled: boolean;
	readonly magicActionId?: string;
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
	/** Every selected entry in order (used to evaluate multi-item Magic Action conditions). */
	readonly targets?: readonly MagicActionTargetDescriptor[];
	/** User customization of built-in item visibility, section order, and custom Magic Actions. */
	readonly contextMenu?: ContextMenuSettings;
}

function item(
	action: FinderMenuAction,
	label: string,
	options: { keycap?: string; tone?: MenuTone; disabled?: boolean; magicActionId?: string } = {},
): FinderMenuItem {
	return {
		kind: "item",
		action,
		label,
		keycap: options.keycap ?? null,
		tone: options.tone ?? "default",
		disabled: options.disabled ?? false,
		...(options.magicActionId === undefined ? {} : { magicActionId: options.magicActionId }),
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
	return { kind: "submenu", label: t("contextMenu.services"), items };
}

/**
 * Finder's tag block: the seven colour dots as one row, then a "Tags" submenu
 * listing every tag Finder knows (ticked when the whole selection carries it).
 * Empty off macOS, in the Trash, and when the registry has nothing to offer.
 */
function tagMenuEntries(input: ContextMenuInput): FinderMenuEntry[] {
	const tags = input.tags;
	if (tags === undefined || !tags.catalog.supported || input.inTrash === true) return [];
	const names = tags.catalog.colorNames;
	const swatches = TAG_MENU_COLORS.flatMap((color) => {
		// The tag Finder pins for this colour, else the OS's own colour name.
		const pinned = tags.catalog.tags.find((tag) => tag.color === color && tag.sidebar);
		const name = pinned?.name ?? names[color] ?? "";
		if (name === "") return [];
		const checked = tags.shared.has(tagKey(name));
		const hint = checked ? t("finderState.contextMenu.removeTag", { name }) : t("finderState.contextMenu.addTag", { name });
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
	if (swatches.length > 0) entries.push({ kind: "tags", label: t("contextMenu.tags"), swatches });
	if (leaves.length > 0) entries.push({ kind: "submenu", label: t("contextMenu.tagsMenu"), items: leaves });
	return entries;
}

export function buildContextMenu(input: ContextMenuInput): FinderMenuEntry[] {
	const isFolder = input.target.kind === "folder";
	const multi = input.selectionCount > 1;
	const settings = input.contextMenu === undefined ? DEFAULT_CONTEXT_MENU_SETTINGS : normalizeContextMenuSettings(input.contextMenu);
	const hiddenItems = new Set<string>(settings.hiddenItems);
	const hiddenSections = new Set<string>(settings.hiddenSections);

	const targetDescriptors: readonly MagicActionTargetDescriptor[] =
		input.targets !== undefined && input.targets.length > 0
			? input.targets
			: Array.from({ length: Math.max(1, input.selectionCount) }, () => input.target);

	// Build each section's own sub-groups; non-empty sub-groups are joined with SEPARATOR.
	const sectionGroups: Record<ContextMenuSectionId, FinderMenuEntry[][]> = {
		open: [],
		magic: [],
		index: [],
		clipboard: [],
		actions: [],
		services: [],
		tags: [],
		trash: [],
	};

	if (!hiddenSections.has("open")) {
		const openMain: FinderMenuEntry[] = [];
		if (isFolder) {
			if (!hiddenItems.has("builtin:open")) {
				openMain.push(item("open", t("contextMenu.open"), { keycap: enterKeyLabel() }));
			}
		} else if (!hiddenItems.has("builtin:quickLook")) {
			openMain.push(item("quickLook", t("finderState.contextMenu.quickLook"), { keycap: "space" }));
		}
		if (!isFolder && input.inTrash !== true && input.capabilities.openWith && !hiddenItems.has("builtin:openWith")) {
			openMain.push(item("openWith", t("contextMenu.openWith")));
		}
		if (openMain.length > 0) sectionGroups.open.push(openMain);

		if (input.inRecents === true && !hiddenItems.has("builtin:showInEnclosingFolder")) {
			sectionGroups.open.push([item("showInEnclosingFolder", t("finderState.contextMenu.showInEnclosingFolder"))]);
		}
	}

	if (!hiddenSections.has("magic") && input.inTrash !== true) {
		const magicEntries: FinderMenuEntry[] = settings.magicActions
			.filter((action) => matchesMagicAction(action, targetDescriptors))
			.map((action) => item("magicAction", action.label, { magicActionId: action.id }));
		if (magicEntries.length > 0) sectionGroups.magic.push(magicEntries);
	}

	if (!hiddenSections.has("index") && !isFolder && !hiddenItems.has("builtin:toggleIndex")) {
		sectionGroups.index.push([
			input.indexFailed === true
				? item("retryIndex", t("contextMenu.retryIndex"), { tone: "warning" })
				: item("toggleIndex", input.indexIncluded ? t("contextMenu.excludeFromIndex") : t("contextMenu.includeInIndex")),
		]);
	}

	if (!hiddenSections.has("clipboard")) {
		const clip: FinderMenuEntry[] = [];
		if (!hiddenItems.has("builtin:copy")) {
			clip.push(item("copy", t("contextMenu.copy"), { keycap: formatShortcut({ key: "C" }) }));
		}
		if (!hiddenItems.has("builtin:paste")) {
			clip.push(item("paste", t("contextMenu.paste"), { keycap: formatShortcut({ key: "V" }), disabled: input.clipboardCount === 0 }));
		}
		if (!hiddenItems.has("builtin:cut")) {
			clip.push(item("cut", t("contextMenu.cut"), { keycap: formatShortcut({ key: "X" }) }));
		}
		if (!hiddenItems.has("builtin:duplicate")) {
			clip.push(item("duplicate", t("contextMenu.duplicate"), { keycap: formatShortcut({ key: "D" }) }));
		}
		if (!hiddenItems.has("builtin:rename")) {
			clip.push(item("rename", t("contextMenu.rename"), { keycap: formatShortcut({ key: "R" }), disabled: multi }));
		}
		if (!hiddenItems.has("builtin:copyPath")) {
			clip.push(item("copyPath", t("contextMenu.copyPath")));
		}
		if (clip.length > 0) sectionGroups.clipboard.push(clip);
	}

	if (!hiddenSections.has("actions") && input.inTrash !== true) {
		const rowActions: FinderMenuItem[] = [];
		if (input.canCreateFolder && !hiddenItems.has("builtin:newFolder")) {
			rowActions.push(item("newFolder", t("contextMenu.newFolder")));
		}
		if (input.capabilities.archive) {
			if (!multi && archiveFormatOf(input.target.name) !== null && !hiddenItems.has("builtin:extract")) {
				rowActions.push(item("extract", t("contextMenu.extract")));
			}
			if (!hiddenItems.has("builtin:compress")) {
				rowActions.push(
					item(
						"compress",
						multi
							? t("contextMenu.compressCount", { count: input.selectionCount })
							: t("contextMenu.compress"),
					),
				);
			}
			if (!hiddenItems.has("builtin:compress7z")) {
				rowActions.push(item("compress7z", t("contextMenu.compress7z")));
			}
		}
		if (input.capabilities.share && !hiddenItems.has("builtin:share")) {
			rowActions.push(item("share", t("contextMenu.share")));
		}
		if (rowActions.length > 0) sectionGroups.actions.push(rowActions);
	}

	if (!hiddenSections.has("services") && !hiddenItems.has("builtin:services")) {
		const services = servicesSubmenu(input.services, input.inTrash === true);
		if (services !== null) sectionGroups.services.push([services]);
	}

	// Locked invariant: Tags (`tags` section / `builtin:tags`) can NEVER be hidden.
	const tagItems = tagMenuEntries(input);
	if (tagItems.length > 0) sectionGroups.tags.push(tagItems);

	if (!hiddenSections.has("trash") && !hiddenItems.has("builtin:trash")) {
		sectionGroups.trash.push([
			input.inTrash === true
				? item(
						"putBack",
						multi
							? t("contextMenu.putBackCount", { count: input.selectionCount })
							: t("contextMenu.putBack"),
					)
				: item(
						"trash",
						multi
							? t("contextMenu.moveToTrashCount", { count: input.selectionCount })
							: t("contextMenu.moveToTrash"),
						{
							keycap: deleteKeyLabel(),
							tone: "danger",
						},
					),
		]);
	}

	const entries: FinderMenuEntry[] = [];
	for (const sectionId of settings.sectionOrder) {
		for (const group of sectionGroups[sectionId]) {
			if (group.length === 0) continue;
			if (entries.length > 0) entries.push(SEPARATOR);
			entries.push(...group);
		}
	}
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
export function buildBackgroundContextMenu(input: BackgroundMenuInput): FinderMenuEntry[] {
	const submenu: FinderMenuSubmenu = {
		kind: "submenu",
		label: t("contextMenu.new"),
		items: [
			{ kind: "submenu-item", action: "newFolder", label: t("contextMenu.newFolder"), format: null },
			...NEW_FILE_FORMATS.map(
				(format): FinderMenuSubmenuItem => ({
					kind: "submenu-item",
					action: "newFile",
					label: t(format.label),
					format: format.id,
				}),
			),
		],
	};
	const services = servicesSubmenu(input.services, input.inTrash === true);
	return [
		submenu,
		SEPARATOR,
		item("paste", t("contextMenu.paste"), { keycap: formatShortcut({ key: "V" }), disabled: input.clipboardCount === 0 }),
		...(services === null ? [] : [SEPARATOR, services]),
		...(input.inTrash === true ? [SEPARATOR, item("emptyTrash", t("contextMenu.emptyTrash"), { tone: "danger" })] : []),
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
