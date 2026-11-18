/**
 * The quick-search launcher page (DESIGN.md §2a): one text field and a result list, driven entirely from the keyboard
 * and fully usable with the mouse. The model (rows, selection, keys, actions) is `state/launcher.ts`; this file only
 * wires it to the bridge and draws it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import type { ContentSearchState } from "../../../shared/content-search-contract";
import { useTranslation } from "../../../shared/i18n";
import type { QuickSearchBridge } from "../../../shared/quick-search-contract";
import { formatShortcutChord } from "../../../shared/shortcuts-contract";
import { SearchIcon, SparklesIcon } from "../components/icons";
import { EntryTile } from "../components/primitives/EntryTile";
import { entryFromFs, type FinderEntry } from "../data/entries";
import { markTerms } from "../lib/mark-terms";
import {
	actionsFor,
	buildLauncherRows,
	launcherKeyAction,
	moveSelection,
	selectedPaths,
	type ContentRowInput,
	type LauncherActionId,
	type LauncherRow,
	type LauncherSelection,
} from "../state/launcher";
import { dirname } from "../state/paths";

/** Content search runs a MinSync query; it waits for a pause in typing so one keystroke is not one query. */
const CONTENT_DEBOUNCE_MS = 180;

interface Results {
	readonly query: string;
	readonly names: readonly FinderEntry[];
	readonly content: readonly ContentRowInput[];
	readonly contentState: ContentSearchState | "pending";
}

const NO_RESULTS: Results = { query: "", names: [], content: [], contentState: "ok" };

/** The row's icon in page CSS pixels: the preview zooms out of it and back into it. */
function rowIconRect(list: HTMLElement | null, index: number): { x: number; y: number; width: number; height: number } | null {
	const icon = list?.querySelector(`[data-row-index="${index}"] .tile, [data-row-index="${index}"] svg`);
	if (icon === null || icon === undefined) return null;
	const box = icon.getBoundingClientRect();
	return box.width > 0 && box.height > 0 ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

export function QuickSearch({ bridge }: { readonly bridge: QuickSearchBridge }): ReactElement {
	const { t } = useTranslation();
	const platform = bridge.platform;
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [recents, setRecents] = useState<readonly FinderEntry[]>([]);
	const [results, setResults] = useState<Results>(NO_RESULTS);
	const [selection, setSelection] = useState<LauncherSelection>({ anchor: 0, focus: 0 });
	const [panel, setPanel] = useState<{ readonly index: number } | null>(null);
	const [icons, setIcons] = useState<ReadonlyMap<string, string>>(new Map());
	const [notice, setNotice] = useState<string | null>(null);
	/** The row the Quick Look panel shows; null while it is closed. */
	const [previewPath, setPreviewPath] = useState<string | null>(null);
	/** The person moved through the rows since they last typed: Space previews instead of typing a space. */
	const [browsing, setBrowsing] = useState(false);

	const rows = useMemo(
		() => buildLauncherRows({ query, recents, names: results.query === query.trim() ? results.names : [], content: results.query === query.trim() ? results.content : [] }),
		[query, recents, results],
	);
	const focused = rows[selection.focus];
	const actions = actionsFor(focused);
	const pending = query.trim().length > 0 && (results.query !== query.trim() || results.contentState === "pending");

	// Every summon starts fresh: the query is selected so typing replaces it, the recents are re-read.
	useEffect(() => {
		const refresh = (): void => {
			setPanel(null);
			setNotice(null);
			setPreviewPath(null);
			setBrowsing(false);
			inputRef.current?.focus();
			inputRef.current?.select();
			void bridge.recents().then(
				(entries) => setRecents(entries.filter((entry) => entry.kind === "file" || entry.kind === "folder").map(entryFromFs)),
				() => setRecents([]),
			);
		};
		refresh();
		return bridge.onShown(refresh);
	}, [bridge]);

	// Names answer at once; content after a pause. A newer query cancels the older one in the worker.
	useEffect(() => {
		const text = query.trim();
		setSelection({ anchor: 0, focus: 0 });
		setPanel(null);
		if (text.length === 0) {
			setResults(NO_RESULTS);
			return;
		}
		let live = true;
		void bridge.searchNames(text).then(
			(hits) => {
				if (live) setResults((current) => ({ query: text, names: hits.map((hit) => entryFromFs(hit.entry)), content: current.query === text ? current.content : [], contentState: current.query === text ? current.contentState : "pending" }));
			},
			() => undefined,
		);
		const timer = window.setTimeout(() => {
			void bridge.searchContent(text).then(
				(outcome) => {
					if (!live) return;
					const content = outcome.hits.map((hit) => ({ entry: entryFromFs(hit.entry), snippet: hit.snippet, line: hit.line, score: hit.score }));
					setResults((current) => ({ query: text, names: current.query === text ? current.names : [], content, contentState: outcome.state }));
				},
				(error: unknown) => {
					if (live && !(error instanceof Error && error.name === "AbortError")) setResults((current) => ({ ...current, query: text, contentState: "unavailable" }));
				},
			);
		}, CONTENT_DEBOUNCE_MS);
		return () => {
			live = false;
			window.clearTimeout(timer);
		};
	}, [bridge, query]);

	// OS icons for the rows on screen (Finder's own enrichment path), each asked for once; a row without one keeps its letter tile.
	const askedIcons = useRef(new Set<string>());
	useEffect(() => {
		const targets = rows.flatMap((row) => (row.kind === "file" && !askedIcons.current.has(row.entry.path) ? [{ path: row.entry.path, kind: row.entry.kind, ext: row.entry.ext, mtimeMs: row.entry.mtimeMs }] : []));
		if (targets.length === 0) return;
		for (const target of targets) askedIcons.current.add(target.path);
		void bridge.icons(targets).then(
			(enriched) => {
				const found = enriched.filter((item) => item.iconUrl !== null);
				if (found.length === 0) return;
				setIcons((current) => {
					const next = new Map(current);
					for (const item of found) if (item.iconUrl !== null) next.set(item.path, item.iconUrl);
					return next;
				});
			},
			() => undefined,
		);
	}, [bridge, rows]);

	// Keep the keyboard row in view.
	useEffect(() => {
		listRef.current?.querySelector(`[data-row-index="${selection.focus}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selection.focus]);

	// While the preview is open it follows the focused row, as Finder's Quick Look follows the selection; a row that is
	// not a file (the Ask row) or a query that emptied the list closes it.
	const previewTarget = previewPath === null ? null : focused?.kind === "file" ? focused.entry : null;
	useEffect(() => {
		if (previewPath === null) return;
		if (previewTarget === null) {
			setPreviewPath(null);
			void bridge.preview.hide(null).catch(() => undefined);
			return;
		}
		if (previewTarget.path === previewPath) return;
		setPreviewPath(previewTarget.path);
		void bridge.preview.show({ path: previewTarget.path, name: previewTarget.name, kind: previewTarget.kind }, rowIconRect(listRef.current, selection.focus)).catch((error: unknown) => setNotice(error instanceof Error ? error.message : String(error)));
	}, [bridge, previewPath, previewTarget, selection.focus]);

	// The panel closes itself (Escape or Space with it focused) and steps through the rows with its arrow keys.
	useEffect(() => {
		const offClosed = bridge.preview.onClosed(() => {
			setPreviewPath(null);
			inputRef.current?.focus();
		});
		const offNavigate = bridge.preview.onNavigate((delta) => {
			setBrowsing(true);
			setSelection((current) => moveSelection(current, delta, rows.length, false));
		});
		return () => {
			offClosed();
			offNavigate();
		};
	}, [bridge, rows.length]);

	const togglePreview = useCallback(
		(index: number): void => {
			if (previewPath !== null) {
				setPreviewPath(null);
				void bridge.preview.hide(rowIconRect(listRef.current, index)).catch(() => undefined);
				return;
			}
			const row = rows[index];
			if (row?.kind !== "file") return;
			setPreviewPath(row.entry.path);
			void bridge.preview.show({ path: row.entry.path, name: row.entry.name, kind: row.entry.kind }, rowIconRect(listRef.current, index)).catch((error: unknown) => {
				setPreviewPath(null);
				setNotice(error instanceof Error ? error.message : String(error));
			});
		},
		[bridge, previewPath, rows],
	);

	const flash = useCallback((text: string) => setNotice(text), []);

	const run = useCallback(
		async (action: LauncherActionId, index = selection.focus): Promise<void> => {
			const row = rows[index];
			const paths = index === selection.focus ? selectedPaths(rows, selection) : row?.kind === "file" ? [row.entry.path] : [];
			const first = row?.kind === "file" ? row.entry.path : (paths[0] ?? null);
			try {
				switch (action) {
					case "open":
						if (row?.kind === "ask") {
							await bridge.ask(row.query);
							return;
						}
						if (first === null) return;
						await bridge.open(first);
						bridge.hide("handoff");
						return;
					case "preview":
						togglePreview(index);
						return;
					case "revealOs":
						if (first === null) return;
						await bridge.reveal(first);
						bridge.hide("handoff");
						return;
					case "showInApp":
						if (first !== null) await bridge.revealInApp(first);
						return;
					case "copyFile":
						if (paths.length === 0) return;
						await bridge.copyFiles(paths);
						flash(t("quickSearch.copiedFiles", { count: paths.length }));
						return;
					case "copyPath":
						if (paths.length === 0) return;
						await bridge.copyPaths(paths);
						flash(t("quickSearch.copiedPaths", { count: paths.length }));
						return;
					case "askAbout":
						if (paths.length > 0) await bridge.attach(paths);
						return;
					case "askQuery":
						if (query.trim().length > 0) await bridge.ask(query.trim());
						return;
				}
			} catch (error) {
				flash(error instanceof Error ? error.message : String(error));
			}
		},
		[bridge, flash, query, rows, selection, t, togglePreview],
	);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		const input = inputRef.current;
		const textSelected = input !== null && document.activeElement === input && input.selectionStart !== input.selectionEnd;
		const action = launcherKeyAction(event.nativeEvent, { panelOpen: panel !== null, textSelected, browsing, queryEmpty: query.length === 0, previewOpen: previewPath !== null }, platform);
		if (action === null) return;
		event.preventDefault();
		switch (action.type) {
			case "dismiss":
				if (panel !== null) setPanel(null);
				else if (previewPath !== null) togglePreview(selection.focus);
				else if (query.length > 0) setQuery("");
				else bridge.hide("restore");
				return;
			case "move":
				setBrowsing(true);
				setSelection((current) => moveSelection(current, action.delta, rows.length, action.extend));
				return;
			case "jump":
				setBrowsing(true);
				setSelection(action.to === "first" ? { anchor: 0, focus: 0 } : { anchor: rows.length - 1, focus: rows.length - 1 });
				return;
			case "run":
				void run(action.action);
				return;
			case "panel":
				setPanel((current) => (current === null && actions.length > 0 ? { index: 0 } : null));
				return;
			case "panelMove":
				setPanel((current) => (current === null ? null : { index: Math.min(actions.length - 1, Math.max(0, current.index + action.delta)) }));
				return;
			case "panelRun": {
				const chosen = panel === null ? undefined : actions[panel.index];
				setPanel(null);
				if (chosen !== undefined) void run(chosen.id);
				return;
			}
		}
	};

	const onRowClick = (event: MouseEvent, index: number): void => {
		setPanel(null);
		setBrowsing(true);
		setSelection((current) => (event.shiftKey ? { anchor: current.anchor, focus: index } : { anchor: index, focus: index }));
		inputRef.current?.focus();
	};

	const onRowDragStart = (event: DragEvent, index: number): void => {
		const row = rows[index];
		if (row?.kind !== "file") return;
		event.preventDefault();
		const inRange = index >= Math.min(selection.anchor, selection.focus) && index <= Math.max(selection.anchor, selection.focus);
		bridge.startDrag(inRange ? selectedPaths(rows, selection) : [row.entry.path]);
	};

	const from = Math.min(selection.anchor, selection.focus);
	const to = Math.max(selection.anchor, selection.focus);
	const sectionLabel: Record<string, string> = {
		recent: t("quickSearch.sections.recent"),
		name: t("quickSearch.sections.names"),
		content: t("quickSearch.sections.content"),
		ask: t("quickSearch.sections.ask"),
	};
	const contentNote =
		query.trim().length === 0 || results.query !== query.trim()
			? null
			: results.contentState === "off"
				? t("quickSearch.contentOff")
				: results.contentState === "unavailable"
					? t("quickSearch.contentUnavailable")
					: null;

	const hint = (id: LauncherActionId, chord: string, label: string): ReactElement => (
		<button type="button" className="qs__hint" onMouseDown={(event) => event.preventDefault()} onClick={() => void run(id)}>
			<span className="qs__key">{formatShortcutChord(chord, platform)}</span>
			{label}
		</button>
	);

	return (
		<div className="qs" onKeyDown={onKeyDown} role="dialog" aria-label={t("quickSearch.title")}>
			<div className="qs__bar">
				<SearchIcon size={18} />
				<input
					ref={inputRef}
					className="qs__input"
					value={query}
					onChange={(event) => {
						setBrowsing(false);
						setQuery(event.target.value);
					}}
					placeholder={t("quickSearch.placeholder")}
					aria-label={t("quickSearch.placeholder")}
					aria-controls="qs-results"
					aria-activedescendant={focused === undefined ? undefined : `qs-row-${selection.focus}`}
					spellCheck={false}
					autoFocus
				/>
				{pending ? <span className="qs__spinner" role="status" aria-label={t("quickSearch.searching")} /> : null}
			</div>
			<div className="qs__list" id="qs-results" role="listbox" aria-multiselectable="true" ref={listRef}>
				{rows.length === 0 ? (
					<div className="qs__empty">{query.trim().length === 0 ? t("quickSearch.emptyRecents") : t("quickSearch.noResults")}</div>
				) : (
					rows.map((row, index) => {
						const section = row.kind === "file" ? row.section : "ask";
						const previous = rows[index - 1];
						const startsSection = previous === undefined || (previous.kind === "file" ? previous.section : "ask") !== section;
						return (
							<div key={row.id}>
								{startsSection ? <div className="qs__section">{sectionLabel[section]}</div> : null}
								{row.kind === "file" ? (
									<FileRowView
										row={row}
										index={index}
										query={query}
										iconUrl={icons.get(row.entry.path)}
										selected={index >= from && index <= to}
										focused={index === selection.focus}
										onClick={onRowClick}
										onOpen={(at) => void run("open", at)}
										onDragStart={onRowDragStart}
									/>
								) : (
									<div
										id={`qs-row-${index}`}
										data-row-index={index}
										className="qs__row"
										role="option"
										aria-selected={index >= from && index <= to}
										data-focus={index === selection.focus}
										onClick={(event) => onRowClick(event, index)}
										onDoubleClick={() => void run("askQuery")}
									>
										<span className="qs__ask-icon">
											<SparklesIcon />
										</span>
										<span className="qs__text">
											<span className="qs__name">{t("quickSearch.askRow", { query: row.query })}</span>
										</span>
									</div>
								)}
							</div>
						);
					})
				)}
				{contentNote === null ? null : <div className="qs__empty">{contentNote}</div>}
			</div>
			{panel === null ? null : (
				<div className="qs__panel" role="menu" aria-label={t("quickSearch.actionsTitle")}>
					{actions.map((action, index) => (
						<div
							key={action.id}
							className="qs__row"
							role="menuitem"
							aria-selected={index === panel.index}
							onMouseEnter={() => setPanel({ index })}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								setPanel(null);
								void run(action.id);
							}}
						>
							<span className="qs__name">{t(action.label)}</span>
							<span className="qs__key">{formatShortcutChord(action.chord, platform)}</span>
						</div>
					))}
				</div>
			)}
			<div className="qs__foot">
				<span className="qs__foot-spacer" role="status">
					{notice ?? (focused?.kind === "file" ? dirname(focused.entry.path) : "")}
				</span>
				{focused?.kind === "ask" ? hint("askQuery", "Enter", t("quickSearch.actions.askQuery")) : hint("open", "Enter", t("quickSearch.actions.open"))}
				{focused?.kind === "file" ? hint("preview", "Space", t("quickSearch.hints.preview")) : null}
				{focused?.kind === "file" ? hint("copyFile", "Mod+C", t("quickSearch.hints.copy")) : null}
				<button type="button" className="qs__hint" onMouseDown={(event) => event.preventDefault()} onClick={() => setPanel((current) => (current === null && actions.length > 0 ? { index: 0 } : null))}>
					<span className="qs__key">{formatShortcutChord("Mod+K", platform)}</span>
					{t("quickSearch.hints.actions")}
				</button>
			</div>
		</div>
	);
}

function FileRowView({
	row,
	index,
	query,
	iconUrl,
	selected,
	focused,
	onClick,
	onOpen,
	onDragStart,
}: {
	readonly row: Extract<LauncherRow, { kind: "file" }>;
	readonly index: number;
	readonly query: string;
	readonly iconUrl: string | undefined;
	readonly selected: boolean;
	readonly focused: boolean;
	readonly onClick: (event: MouseEvent, index: number) => void;
	readonly onOpen: (index: number) => void;
	readonly onDragStart: (event: DragEvent, index: number) => void;
}): ReactElement {
	const entry = iconUrl === undefined ? row.entry : { ...row.entry, iconUrl };
	return (
		<div
			id={`qs-row-${index}`}
			data-row-index={index}
			data-path={row.entry.path}
			className="qs__row"
			role="option"
			aria-selected={selected}
			data-focus={focused}
			draggable
			onClick={(event) => onClick(event, index)}
			onDoubleClick={() => onOpen(index)}
			onDragStart={(event) => onDragStart(event, index)}
		>
			<EntryTile entry={entry} size={22} />
			<span className="qs__text">
				<span className="qs__name">{row.entry.name}</span>
				{row.snippet === null ? <span className="qs__where">{dirname(row.entry.path)}</span> : <span className="qs__snippet">{markTerms(row.snippet, query)}</span>}
			</span>
		</div>
	);
}
