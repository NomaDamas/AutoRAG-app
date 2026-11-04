import type { PreviewBridge } from "../preview/shared/contract";
import type { ContentSearchResult } from "./content-search-contract";
import type { FsEnrichmentTarget, FsEntry, FsEntryEnrichment, FsSearchResult } from "./fs-contract";
import { decomposeShortcutChord, parseShortcutChord } from "./shortcuts-contract";

/**
 * The quick-search launcher: a small window a system-wide shortcut summons over whatever app is in front, to find a
 * file by name or by what it says and act on it from the keyboard (open, reveal, copy, show in Dazzi, ask Dazzi).
 * Shared by the main process (the window and the global shortcut), its preload, the launcher page and Settings.
 */

export interface QuickSearchSettings {
	/** The global shortcut is registered. */
	readonly enabled: boolean;
	/** Canonical chord (`shortcuts-contract` form, e.g. `Alt+Space`); always holds ⌘/Ctrl or ⌥/Alt. */
	readonly chord: string;
}

/** ⌥Space on macOS, Alt+Space on Windows: the launcher key DESIGN.md §2 reserves. */
export const DEFAULT_QUICK_SEARCH_CHORD = "Alt+Space";

export const DEFAULT_QUICK_SEARCH_SETTINGS: QuickSearchSettings = { enabled: true, chord: DEFAULT_QUICK_SEARCH_CHORD };

/**
 * A chord that may be registered system-wide: valid, and held with ⌘/Ctrl or ⌥/Alt. A bare key (Space, F5, Enter)
 * would be taken from every other app, so it is refused even though an in-app shortcut may use one.
 */
export function isGlobalChord(chord: string): boolean {
	const parts = decomposeShortcutChord(chord);
	return parts !== null && (parts.mod || parts.alt);
}

/** Stored settings, repaired: an unknown shape or a chord that cannot be global falls back to the default. */
export function normalizeQuickSearchSettings(raw: unknown): QuickSearchSettings {
	if (typeof raw !== "object" || raw === null) return DEFAULT_QUICK_SEARCH_SETTINGS;
	const enabled = "enabled" in raw && typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_QUICK_SEARCH_SETTINGS.enabled;
	const parsed = "chord" in raw && typeof raw.chord === "string" ? parseShortcutChord(raw.chord) : null;
	const chord = parsed?.ok === true && isGlobalChord(parsed.chord) ? parsed.chord : DEFAULT_QUICK_SEARCH_CHORD;
	return { enabled, chord };
}

/** Electron's accelerator names for the keys the canonical chord spells differently. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
	ArrowUp: "Up",
	ArrowDown: "Down",
	ArrowLeft: "Left",
	ArrowRight: "Right",
	Enter: "Return",
};

/** The Electron accelerator for a canonical chord (`Mod+Shift+K` → `CommandOrControl+Shift+K`); null when it is not global. */
export function chordToAccelerator(chord: string): string | null {
	if (!isGlobalChord(chord)) return null;
	const parts = decomposeShortcutChord(chord);
	if (parts === null) return null;
	return [parts.mod ? "CommandOrControl" : null, parts.alt ? "Alt" : null, parts.shift ? "Shift" : null, ACCELERATOR_KEYS[parts.key] ?? parts.key]
		.filter((token): token is string => token !== null)
		.join("+");
}

export const QUICK_SEARCH_CHANNELS = {
	/** main → launcher: the window was just summoned; select the query so typing replaces it. */
	shown: "quick-search:shown",
	/** launcher → main (send): hide the window; `restore` gives the foreground back to the app that had it. */
	hide: "quick-search:hide",
	/** launcher → main (invoke): show this path selected in the Dazzi Finder. */
	revealInApp: "quick-search:reveal-in-app",
	/** launcher → main (invoke): a new AI Search tab in the Dazzi Finder asks the text. */
	ask: "quick-search:ask",
	/** launcher → main (invoke): the paths become drafts of the nearest AI Search tab, for a question the person types. */
	attach: "quick-search:attach",
	/** Finder → main (invoke): whether the global shortcut is registered, and why not. */
	status: "quick-search:status",
	/** Finder → main (invoke): Settings is recording a new chord; the global one is released meanwhile so the keys reach it. */
	recording: "quick-search:recording",
} as const;

export const QUICK_SEARCH_PAGE = "quick-search.html";

/** Whether the configured shortcut is live. `error` is set when it is enabled and the OS refused it (another app holds it). */
export interface QuickSearchStatus {
	readonly registered: boolean;
	readonly error: "taken" | null;
}

/** How the launcher goes away: `restore` hands the foreground back (Escape, a copy); `handoff` leaves it to what the action opened. */
export type QuickSearchHideMode = "restore" | "handoff";

/** `window.launcher`: what the launcher page can do. File operations go to the fs worker like the Finder's. */
export interface QuickSearchBridge {
	readonly platform: string;
	readonly language: "ko" | "en" | "ja" | "zh";
	onLanguage(listener: (language: "ko" | "en" | "ja" | "zh") => void): () => void;
	onShown(listener: () => void): () => void;
	hide(mode: QuickSearchHideMode): void;
	revealInApp(path: string): Promise<void>;
	ask(query: string): Promise<void>;
	attach(paths: readonly string[]): Promise<void>;
	/** A row dragged out of the window becomes a real file drag (the Finder's `fs:startDrag`). */
	startDrag(paths: readonly string[]): void;
	/** Filename search; a newer call supersedes (and cancels) the one in flight. */
	searchNames(query: string): Promise<readonly FsSearchResult[]>;
	/** Content search; a newer call supersedes (and cancels) the one in flight. */
	searchContent(query: string): Promise<ContentSearchResult>;
	/** The Finder's Recents, newest first: what the launcher shows before anything is typed. */
	recents(): Promise<readonly FsEntry[]>;
	icons(targets: readonly FsEnrichmentTarget[]): Promise<readonly FsEntryEnrichment[]>;
	open(path: string): Promise<void>;
	reveal(path: string): Promise<void>;
	copyFiles(paths: readonly string[]): Promise<void>;
	copyPaths(paths: readonly string[]): Promise<void>;
	/** The launcher's own Quick Look panel (Space), the same preview the Finder shows; it closes when the launcher hides. */
	readonly preview: PreviewBridge;
}

/** `window.autorag.quickSearch` in the Finder: Settings reads the status and pauses the shortcut while recording. */
export interface QuickSearchSettingsBridge {
	status(): Promise<QuickSearchStatus>;
	setRecording(recording: boolean): Promise<void>;
}
