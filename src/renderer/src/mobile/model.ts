/**
 * The phone shell's pure model: whether this session gets it, the folder
 * listing's order and grouping, middle truncation of names, the Recents day
 * buckets, the item menu's contents, and the per-tab navigation stacks.
 *
 * Everything here is a plain function of its inputs so the shell's decisions
 * are tested without a DOM; `MobileApp.tsx` only renders what these return.
 */

import type { MagicAction } from "../../../shared/context-menu-contract";
import { matchesMagicAction } from "../../../shared/context-menu-contract";
import { remotePreviewMime } from "../../../shared/remote-contract";
import type { FinderEntry } from "../data/entries";
import { dirname } from "../state/paths";
import { sortEntries, explicitSort, type SortKey } from "../state/sort";
import { visibleEntries } from "../state/visibility";

/**
 * The widest viewport the phone shell takes. The largest iPhone in portrait is
 * 440 CSS px wide; a little headroom covers large Android phones and the iPhone
 * in a browser with a narrow side bar. Tablets in portrait start at 744px and
 * keep the desktop layout, as do phones turned to landscape wider than this.
 */
export const MOBILE_MAX_WIDTH = 500;

export interface DeviceSignals {
	/** `window.autoragIsRemote`: the renderer runs in the remote browser session. */
	readonly remote: boolean;
	/** The layout viewport's CSS width. */
	readonly width: number;
	/** The viewport's CSS height. */
	readonly height: number;
	/** `(pointer: coarse)`: the primary pointer is a finger. */
	readonly coarse: boolean;
	/** `navigator.userAgentData.mobile`, or a phone user-agent string. */
	readonly phoneAgent: boolean;
}

/**
 * The phone shell runs only inside a remote browser session, never in the
 * desktop window, and only on a phone-sized screen: the shorter side of the
 * viewport is within `MOBILE_MAX_WIDTH`. A phone is detected by its agent or a
 * touch-first narrow screen; a desktop browser narrowed to phone width also
 * gets it, so the layout is the same one a phone sees.
 */
export function wantsMobileShell(signals: DeviceSignals): boolean {
	if (!signals.remote) return false;
	const shortSide = Math.min(signals.width, signals.height);
	if (signals.phoneAgent && shortSide <= MOBILE_MAX_WIDTH) return true;
	return signals.width <= MOBILE_MAX_WIDTH || (signals.coarse && shortSide <= MOBILE_MAX_WIDTH);
}

/** A phone user agent (iPhone, Android phones, the common "Mobile" token); tablets are excluded. */
export function isPhoneUserAgent(userAgent: string, uaDataMobile: boolean | undefined): boolean {
	if (uaDataMobile !== undefined) return uaDataMobile;
	if (/iPad|Tablet/iu.test(userAgent)) return false;
	return /iPhone|iPod|Android.+Mobile|Windows Phone|Mobile Safari|\bMobile\b/iu.test(userAgent);
}

/* -------------------------------------------------------------- Listing -- */

export type MobileSortKey = Extract<SortKey, "name" | "date" | "size" | "kind">;
export const MOBILE_SORT_KEYS: readonly MobileSortKey[] = ["name", "date", "size", "kind"];

export interface MobileSort {
	readonly key: MobileSortKey;
	readonly ascending: boolean;
}

export const DEFAULT_MOBILE_SORT: MobileSort = { key: "name", ascending: true };

/** Tapping the current key flips its direction; another key starts in its natural direction (names A→Z, dates newest first). */
export function nextSort(current: MobileSort, key: MobileSortKey): MobileSort {
	if (current.key === key) return { key, ascending: !current.ascending };
	return { key, ascending: key === "name" || key === "kind" };
}

/** Folders first, like Files on iPhone, then the chosen order; dotfiles follow the hidden-files setting. */
export function mobileListing(entries: readonly FinderEntry[], sort: MobileSort, showHidden: boolean): FinderEntry[] {
	const shown = visibleEntries(entries, showHidden);
	const sorted = sortEntries(shown, explicitSort(sort.key, sort.ascending ? 1 : -1));
	return [...sorted.filter((entry) => entry.kind === "folder"), ...sorted.filter((entry) => entry.kind !== "folder")];
}

/**
 * Splits a name for middle truncation: the head shrinks with an ellipsis and
 * the tail (the last few characters before the extension, plus the
 * extension) always stays, since names in one folder often differ only at the end.
 */
export function splitName(name: string, folder: boolean): { readonly head: string; readonly tail: string } {
	const dot = name.lastIndexOf(".");
	if (folder || dot <= 0 || name.length < 16) return { head: name, tail: "" };
	const cut = Math.max(0, dot - 4);
	return { head: name.slice(0, cut), tail: name.slice(cut) };
}

/* -------------------------------------------------------------- Recents -- */

export type RecentsBucket = "today" | "yesterday" | "week" | "month" | "older";
export const RECENTS_BUCKETS: readonly RecentsBucket[] = ["today", "yesterday", "week", "month", "older"];

const DAY_MS = 86_400_000;

function startOfDay(ms: number): number {
	const date = new Date(ms);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** Calendar days between `ms` and `now`, by local midnight (a file from 23:59 yesterday is 1 day old at 00:01). */
export function daysAgo(ms: number, now: number): number {
	return Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
}

export function recentsBucket(ms: number, now: number): RecentsBucket {
	const days = daysAgo(ms, now);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	if (days < 7) return "week";
	if (days < 31) return "month";
	return "older";
}

export interface RecentsGroup {
	readonly bucket: RecentsBucket;
	readonly entries: readonly FinderEntry[];
}

/** Newest first, grouped by day bucket; empty buckets are left out. */
export function groupRecents(entries: readonly FinderEntry[], now: number): readonly RecentsGroup[] {
	const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs);
	const groups = new Map<RecentsBucket, FinderEntry[]>();
	for (const entry of sorted) {
		const bucket = recentsBucket(entry.mtimeMs, now);
		const list = groups.get(bucket) ?? [];
		list.push(entry);
		groups.set(bucket, list);
	}
	return RECENTS_BUCKETS.flatMap((bucket) => {
		const list = groups.get(bucket);
		return list === undefined ? [] : [{ bucket, entries: list }];
	});
}

/* ------------------------------------------------------------ Previews -- */

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | null;

/** What the browser can show for a file, from the same MIME table the remote preview endpoint serves. */
export function previewKind(entry: Pick<FinderEntry, "kind" | "path">): PreviewKind {
	if (entry.kind === "folder") return null;
	const mime = remotePreviewMime(entry.path);
	if (mime === null) return null;
	if (mime.startsWith("image/")) return "image";
	if (mime.startsWith("video/")) return "video";
	if (mime.startsWith("audio/")) return "audio";
	if (mime === "application/pdf") return "pdf";
	return "text";
}

/* --------------------------------------------------------- Item menu -- */

export type MenuItemId =
	| "quickLook"
	| "info"
	| "reveal"
	| "ask"
	| "magic"
	| "tools"
	| "compress"
	| "extract"
	| "index"
	| "duplicate"
	| "rename"
	| "copyPath"
	| "tags"
	| "trash"
	| "restore";

export interface ItemMenuInput {
	readonly entries: readonly FinderEntry[];
	/** The rows live in the Trash: only restore applies. */
	readonly inTrash: boolean;
	/** The menu opened outside a folder listing (Recents, search): offer "상위 폴더에서 보기". */
	readonly outsideFolder: boolean;
	/** Every target is in the AI search index. */
	readonly allIndexed: boolean;
	readonly magicActions: readonly MagicAction[];
	/** The host can run compress / extract for this session (`ActionCapabilities.archive`). */
	readonly archive: boolean;
	/** Finder tags exist on the host (macOS). */
	readonly tags: boolean;
}

export interface ItemMenu {
	/** Copy · Move · Download strip on top. */
	readonly quick: boolean;
	readonly items: readonly MenuItemId[];
	readonly magic: readonly MagicAction[];
	/** Label hint for the 인덱싱 row: include or exclude. */
	readonly indexIncludes: boolean;
}

/**
 * The long-press menu, folded for a phone. Desktop's sections keep their order
 * (state/context-menu.ts) but the verbs used most move to the quick strip, and
 * compress / extract / indexing / duplicate collapse into one "빠른 작업"
 * submenu, so the whole menu fits under the lifted row without scrolling.
 * Native-only commands (다른 앱으로 열기, 서비스, 공유) are not offered: the
 * remote bridge refuses them.
 */
export function itemMenu(input: ItemMenuInput): ItemMenu {
	const { entries } = input;
	if (input.inTrash) return { quick: false, items: ["restore"], magic: [], indexIncludes: false };
	const single = entries.length === 1;
	const folderOnly = single && entries[0]?.kind === "folder";
	const items: MenuItemId[] = [];
	if (single && !folderOnly) items.push("quickLook");
	if (single) items.push("info");
	if (single && input.outsideFolder) items.push("reveal");
	items.push("ask");
	const magic = input.magicActions.filter((action) =>
		matchesMagicAction(
			action,
			entries.map((entry) => ({ kind: entry.kind, name: entry.name })),
		),
	);
	if (magic.length > 0) items.push("magic");
	items.push("tools");
	if (single) items.push("rename");
	items.push("copyPath");
	if (input.tags) items.push("tags");
	items.push("trash");
	return { quick: true, items, magic, indexIncludes: !input.allIndexed };
}

/** The 빠른 작업 submenu rows for these targets; compress and extract only where the host can run them. */
export function toolItems(entries: readonly FinderEntry[], archive: boolean): readonly MenuItemId[] {
	const items: MenuItemId[] = [];
	if (archive) items.push("compress");
	if (archive && entries.length === 1 && entries[0]?.ext === "zip") items.push("extract");
	items.push("index", "duplicate");
	return items;
}

/* ------------------------------------------------------- Navigation -- */

/** Recents is not a tab: 둘러보기's 즐겨찾기 lists it, and it opens there like any place. */
export type MobileTab = "browse" | "ai" | "automations" | "settings";
export const MOBILE_TABS: readonly MobileTab[] = ["browse", "ai", "automations", "settings"];

export type MobileRoute =
	| { readonly kind: "places" }
	| { readonly kind: "folder"; readonly path: string }
	| { readonly kind: "recents" }
	| { readonly kind: "chat" }
	| { readonly kind: "rules" }
	| { readonly kind: "rule"; readonly id: string }
	| { readonly kind: "settings" }
	| { readonly kind: "settingsPage"; readonly category: string };

export type MobileStacks = Readonly<Record<MobileTab, readonly MobileRoute[]>>;

export const INITIAL_STACKS: MobileStacks = {
	browse: [{ kind: "places" }],
	ai: [{ kind: "chat" }],
	automations: [{ kind: "rules" }],
	settings: [{ kind: "settings" }],
};

export function pushRoute(stacks: MobileStacks, tab: MobileTab, route: MobileRoute): MobileStacks {
	return { ...stacks, [tab]: [...stacks[tab], route] };
}

/** One level back; the root stays. */
export function popRoute(stacks: MobileStacks, tab: MobileTab): MobileStacks {
	const stack = stacks[tab];
	return stack.length <= 1 ? stacks : { ...stacks, [tab]: stack.slice(0, -1) };
}

/** Tapping the tab you are on returns to its root, like iOS. */
export function popToRoot(stacks: MobileStacks, tab: MobileTab): MobileStacks {
	const stack = stacks[tab];
	return stack.length <= 1 ? stacks : { ...stacks, [tab]: stack.slice(0, 1) };
}

/**
 * Show `folder` in 둘러보기 the way the path bar would: the places root, then
 * one folder route per ancestor from the volume down, so back walks up the tree.
 */
export function revealStack(folder: string, ancestors: readonly string[]): readonly MobileRoute[] {
	return [{ kind: "places" }, ...ancestors.map((path) => ({ kind: "folder" as const, path })), { kind: "folder", path: folder }];
}

/** Every ancestor folder of `path`, root first, not including `path` itself (`C:\Users\me\x` → `C:\`, `C:\Users`, `C:\Users\me`). */
export function ancestorPaths(path: string): readonly string[] {
	const out: string[] = [];
	for (let current = dirname(path); current !== "" && current !== path && !out.includes(current); current = dirname(current)) {
		out.unshift(current);
		if (dirname(current) === current) break;
	}
	return out;
}
