/**
 * The quick-search launcher's model, free of React and the bridge: which rows the result list shows for a query, how
 * the keyboard selection moves, which key does what, and which actions a row offers.
 *
 * Rows come from two sources that answer at different speeds: the file-name index (tens of milliseconds) and the local
 * document index (a MinSync query, about a second). Name matches come first; a content match for a file already listed
 * by name is not listed twice. A non-empty query always ends with the "Ask Dazzi" row.
 */

import type { LocaleKey } from "../../../shared/i18n/core";
import { chordFromKeyEvent, type RecordableKeyEvent } from "../../../shared/shortcuts-contract";
import type { FinderEntry } from "../data/entries";

export type LauncherSection = "recent" | "name" | "content";

export type LauncherRow =
	| {
			readonly kind: "file";
			readonly id: string;
			readonly section: LauncherSection;
			readonly entry: FinderEntry;
			/** The passage the content index matched; null for name and recent rows. */
			readonly snippet: string | null;
			readonly line: number | null;
	  }
	| { readonly kind: "ask"; readonly id: string; readonly query: string };

export interface ContentRowInput {
	readonly entry: FinderEntry;
	readonly snippet: string;
	readonly line: number | null;
	readonly score: number;
}

/** Most rows a section shows: the launcher is for the first screen of hits, the Finder is for browsing all of them. */
export const SECTION_LIMIT = 8;

function fold(text: string): string {
	return text.normalize("NFC").toLowerCase();
}

const WORD_BOUNDARY = /[\s._\-()[\]]/u;

/** 0: the name starts with the query, 1: a word in it does, 2: it contains it, 3: the index matched it otherwise (a path). */
function nameRank(name: string, needle: string): number {
	const folded = fold(name);
	const at = folded.indexOf(needle);
	if (at === 0) return 0;
	if (at > 0) return WORD_BOUNDARY.test(folded[at - 1] ?? "") ? 1 : 2;
	return 3;
}

/** Name hits ordered like a launcher: prefix, then word start, then substring; shorter and newer names first in a tier. */
export function rankNameHits(entries: readonly FinderEntry[], query: string): FinderEntry[] {
	const needle = fold(query.trim());
	return entries
		.map((entry, index) => ({ entry, index, rank: nameRank(entry.name, needle) }))
		.sort((a, b) => a.rank - b.rank || a.entry.name.length - b.entry.name.length || b.entry.mtimeMs - a.entry.mtimeMs || a.index - b.index)
		.map(({ entry }) => entry);
}

export function buildLauncherRows(input: {
	readonly query: string;
	readonly recents: readonly FinderEntry[];
	readonly names: readonly FinderEntry[];
	readonly content: readonly ContentRowInput[];
}): LauncherRow[] {
	const query = input.query.trim();
	const file = (section: LauncherSection, entry: FinderEntry, snippet: string | null = null, line: number | null = null): LauncherRow => ({
		kind: "file",
		id: `${section}:${entry.path}`,
		section,
		entry,
		snippet,
		line,
	});
	if (query.length === 0) return input.recents.slice(0, SECTION_LIMIT).map((entry) => file("recent", entry));
	const names = rankNameHits(input.names, query).slice(0, SECTION_LIMIT);
	const listed = new Set(names.map((entry) => entry.path));
	const content = input.content.filter((hit) => !listed.has(hit.entry.path)).slice(0, SECTION_LIMIT);
	return [
		...names.map((entry) => file("name", entry)),
		...content.map((hit) => file("content", hit.entry, hit.snippet, hit.line)),
		{ kind: "ask", id: "ask", query },
	];
}

/** `anchor` is where a Shift range started; `focus` is the row the keyboard is on. */
export interface LauncherSelection {
	readonly anchor: number;
	readonly focus: number;
}

export function moveSelection(selection: LauncherSelection, delta: 1 | -1, count: number, extend: boolean): LauncherSelection {
	if (count === 0) return { anchor: 0, focus: 0 };
	const focus = Math.min(count - 1, Math.max(0, selection.focus + delta));
	return { anchor: extend ? selection.anchor : focus, focus };
}

/** The files a copy or a drag carries: every file row between anchor and focus. */
export function selectedPaths(rows: readonly LauncherRow[], selection: LauncherSelection): string[] {
	const from = Math.min(selection.anchor, selection.focus);
	const to = Math.max(selection.anchor, selection.focus);
	const paths: string[] = [];
	for (let index = from; index <= to; index += 1) {
		const row = rows[index];
		if (row?.kind === "file") paths.push(row.entry.path);
	}
	return paths;
}

export type LauncherActionId = "open" | "preview" | "revealOs" | "showInApp" | "copyFile" | "copyPath" | "askAbout" | "askQuery";

export interface LauncherAction {
	readonly id: LauncherActionId;
	readonly label: LocaleKey;
	/** Canonical chord shown beside the action (`shortcuts-contract` form). */
	readonly chord: string;
}

const FILE_ACTIONS: readonly LauncherAction[] = [
	{ id: "open", label: "quickSearch.actions.open", chord: "Enter" },
	{ id: "preview", label: "quickSearch.actions.preview", chord: "Space" },
	{ id: "revealOs", label: "quickSearch.actions.revealOs", chord: "Mod+Enter" },
	{ id: "showInApp", label: "quickSearch.actions.showInApp", chord: "Mod+Shift+Enter" },
	{ id: "copyFile", label: "quickSearch.actions.copyFile", chord: "Mod+C" },
	{ id: "copyPath", label: "quickSearch.actions.copyPath", chord: "Mod+Shift+C" },
	{ id: "askAbout", label: "quickSearch.actions.askAbout", chord: "Mod+Alt+Enter" },
];
const ASK_ACTIONS: readonly LauncherAction[] = [{ id: "askQuery", label: "quickSearch.actions.askQuery", chord: "Enter" }];

export function actionsFor(row: LauncherRow | undefined): readonly LauncherAction[] {
	if (row === undefined) return [];
	return row.kind === "ask" ? ASK_ACTIONS : FILE_ACTIONS;
}

export type LauncherKeyAction =
	| { readonly type: "move"; readonly delta: 1 | -1; readonly extend: boolean }
	| { readonly type: "jump"; readonly to: "first" | "last" }
	| { readonly type: "run"; readonly action: LauncherActionId }
	| { readonly type: "panel" }
	| { readonly type: "panelMove"; readonly delta: 1 | -1 }
	| { readonly type: "panelRun" }
	| { readonly type: "dismiss" };

const CHORD_ACTIONS: Readonly<Record<string, LauncherActionId>> = {
	Enter: "open",
	"Mod+Enter": "revealOs",
	"Mod+Shift+Enter": "showInApp",
	"Alt+Enter": "askQuery",
	"Mod+Alt+Enter": "askAbout",
	"Mod+C": "copyFile",
	"Mod+Y": "preview",
	"Mod+Shift+C": "copyPath",
};

/**
 * What a keydown in the launcher does; null leaves it to the text field. `textSelected` is true when the query field
 * has a selection: ⌘C then copies that text, as it would in any text field.
 *
 * Space previews the focused row (Finder's Quick Look) only when it cannot be part of the query: nothing is typed yet,
 * the person moved through the rows (`browsing`, cleared by the next keystroke into the field), or a preview is open
 * and Space closes it. Otherwise it types a space. ⌘Y / Ctrl+Y previews at any time.
 */
export function launcherKeyAction(
	event: RecordableKeyEvent,
	context: { readonly panelOpen: boolean; readonly textSelected: boolean; readonly browsing?: boolean; readonly queryEmpty?: boolean; readonly previewOpen?: boolean },
	platform: string,
): LauncherKeyAction | null {
	const decoded = chordFromKeyEvent(event, platform);
	if (decoded.kind === "cancel") return { type: "dismiss" };
	if (decoded.kind !== "valid") {
		// Plain arrows are reserved in the shortcut contract, so they never decode as a chord.
		const shift = event.shiftKey ?? event.shift ?? false;
		const plain = !(event.metaKey ?? false) && !(event.ctrlKey ?? false) && !(event.altKey ?? false);
		if (!plain || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return null;
		const delta = event.key === "ArrowDown" ? 1 : -1;
		return context.panelOpen ? { type: "panelMove", delta } : { type: "move", delta, extend: shift };
	}
	const chord = decoded.chord;
	if (chord === "Mod+K") return { type: "panel" };
	if (context.panelOpen) return chord === "Enter" ? { type: "panelRun" } : null;
	if (chord === "Mod+ArrowUp") return { type: "jump", to: "first" };
	if (chord === "Mod+ArrowDown") return { type: "jump", to: "last" };
	if (chord === "Mod+C" && context.textSelected) return null;
	if (chord === "Space") return context.browsing === true || context.queryEmpty === true || context.previewOpen === true ? { type: "run", action: "preview" } : null;
	const action = CHORD_ACTIONS[chord];
	return action === undefined ? null : { type: "run", action };
}
