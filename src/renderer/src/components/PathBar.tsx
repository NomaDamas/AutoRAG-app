import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type ReactElement,
	type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { HardDrive, Home, MoreHorizontal } from "lucide-react";
import { cn } from "../lib/cn";
import { FITS, fitPathBar, sameFit, type PathFit } from "../state/path-fit";
import { volumeLabel, windowsRootPath, type Crumb, type PathCompletion } from "../state/paths";
import { kindFromExtension } from "../state/kinds";
import { FileTile } from "./primitives/FileTile";

/**
 * v7 `.pathbar` (proto:.pathbar): macOS path bar at the foot of the Finder column.
 *
 * One line, always. The trail is measured against the bar and `fitPathBar`
 * decides which folders fold into a "…" button (Windows Explorer style): the
 * current folder and as many of its parents as fit stay on the bar in full, and
 * "…" opens a dropdown of the folded ones. Only when even "…" and the current
 * folder do not fit does the last label narrow behind a trailing fade.
 *
 * A click anywhere that is not a folder segment (the gaps, the trailing space,
 * the volume or file segment) turns the bar into a text field holding the full
 * path: type or paste a location and Enter goes there, Escape or leaving the
 * field puts the trail back. The trail stays mounted under the field so its
 * measurement never goes stale.
 */

interface PathSegment {
	readonly key: string;
	readonly label: string;
	/** Null marks the decorative volume prefix ("Macintosh HD" / "C:"). */
	readonly path: string | null;
	readonly icon: ReactNode;
}

/** Narrowest clipped label slot for the last segment (4px icon gap + a few glyphs). */
const MIN_LABEL = 32;

const SEGMENT_CLASS =
	"path-seg inline-flex h-20 flex-none items-center rounded-4 border-0 bg-transparent px-5 text-badge text-inherit";
const ICON_CLASS = "path-ic grid size-14 flex-none place-items-center text-ink-faint";
const SEPARATOR_CLASS = "path-sep flex-none px-1 text-meta text-ink-faint";
const MORE_CLASS =
	"path-more inline-flex h-20 flex-none cursor-pointer items-center rounded-4 border-0 bg-transparent px-5 text-badge text-ink-muted hover:bg-hover hover:text-ink";
/** The last `--fade-label` px of a clipped label fade out, so the word looks cut rather than elided. */
const FADE_END = "[mask-image:linear-gradient(to_right,#000_calc(100%_-_var(--fade-label)),transparent)]";
/** An overflowing icon-only trail is pinned to its end and fades out at the start edge. */
const FADE_START = "[mask-image:linear-gradient(to_left,#000_calc(100%_-_var(--fade-label)),transparent)]";

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1) : "";
}

export function PathBar({
	path,
	crumbs,
	selectedName,
	onNavigate,
	onGoToPath,
	completePath,
	openEditor,
	onEditorClosed,
}: {
	/** The folder in view; the editor opens holding it. */
	readonly path: string;
	readonly crumbs: readonly Crumb[];
	readonly selectedName: string | null;
	readonly onNavigate: (path: string) => void;
	/** Go to a typed location; resolves false (editor stays open) when it cannot be opened. */
	readonly onGoToPath: (input: string) => Promise<boolean>;
	/** Direct child folders whose names complete the draft's last segment. */
	readonly completePath: (input: string) => Promise<readonly PathCompletion[]>;
	/** ⌘L: the Finder keymap opened the editor; counted up on every press so a repeat press re-selects. */
	readonly openEditor: number;
	/** The editor reports that it closed (Enter, Escape, blur), so the keymap can open it again. */
	readonly onEditorClosed: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const first = crumbs[0];
	const local = first?.label === "Users";
	const driveRoot = windowsRootPath(path);
	const segments: PathSegment[] = [];
	if (driveRoot !== null) {
		// A Windows drive or share is the top folder of every location on it (D:\Data as well as C:\Users\me), and a place to go.
		segments.push({ key: "$disk", label: volumeLabel(path), path: driveRoot, icon: <HardDrive size={14} strokeWidth={1.8} /> });
	} else if (local && first !== undefined) {
		// The macOS boot volume is shown above a "Users"-rooted path as a plain label.
		segments.push({ key: "$disk", label: volumeLabel(first.path), path: null, icon: <HardDrive size={14} strokeWidth={1.8} /> });
	}
	crumbs.forEach((crumb, index) => {
		const home = local && index === 1;
		segments.push({
			key: crumb.path,
			label: crumb.label,
			path: crumb.path,
			icon: home ? <Home size={14} strokeWidth={1.8} /> : <FileTile kind="folder" size={16} />,
		});
	});
	if (selectedName !== null) {
		segments.push({
			key: "$file",
			label: selectedName,
			path: null,
			icon: <FileTile kind={kindFromExtension(extensionOf(selectedName))} size={16} />,
		});
	}

	const viewportRef = useRef<HTMLDivElement>(null);
	const measureRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<PathFit>(FITS);

	const refit = useCallback(() => {
		const viewport = viewportRef.current;
		const measure = measureRef.current;
		if (viewport === null || measure === null) return;
		// The measuring copy holds every segment in full, one separator and "…", so a fit never depends on what is showing.
		const widths = [...measure.querySelectorAll<HTMLElement>("[data-measure-segment]")].map((element) => element.getBoundingClientRect().width);
		const separator = measure.querySelector<HTMLElement>("[data-measure-separator]");
		const more = measure.querySelector<HTMLElement>("[data-measure-more]");
		const lastLabel = measure.querySelector<HTMLElement>("[data-measure-segment]:last-of-type .path-label");
		const gap = Number.parseFloat(getComputedStyle(measure).columnGap) || 0;
		const next = fitPathBar({
			available: viewport.getBoundingClientRect().width,
			segments: widths,
			// A separator sits in its item with the item's own gap before the segment.
			separator: (separator?.getBoundingClientRect().width ?? 0) + gap,
			gap,
			more: more?.getBoundingClientRect().width ?? 0,
			lastLabel: lastLabel?.getBoundingClientRect().width ?? 0,
			minLabel: MIN_LABEL,
		});
		setFit((current) => (sameFit(current, next) ? current : next));
	}, []);

	// Label widths depend only on the label text; width changes arrive through
	// the observer. Both paths settle before paint, so a stale fit never shows.
	const labelKey = segments.map((segment) => segment.label).join("\u0000");
	useLayoutEffect(refit, [refit, labelKey]);
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (viewport === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => flushSync(refit));
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [refit]);

	// The editor belongs to the folder it was opened on: navigating away by any
	// route (a sidebar click, a successful Enter) closes it, and coming back
	// later must not find it open again.
	const [editFor, setEditFor] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	const editorRef = useRef<HTMLInputElement>(null);
	const [candidates, setCandidates] = useState<readonly PathCompletion[]>([]);
	const [activeCandidate, setActiveCandidate] = useState(0);
	const [completionEnabled, setCompletionEnabled] = useState(false);
	const completionSequence = useRef(0);
	if (editFor !== null && editFor !== path) setEditFor(null);
	const editing = editFor === path;
	useEffect(() => {
		if (!editing || !completionEnabled) {
			setCandidates([]);
			return;
		}
		const sequence = ++completionSequence.current;
		void completePath(draft)
			.then((next) => {
				if (sequence !== completionSequence.current) return;
				setCandidates(next);
				setActiveCandidate(0);
			})
			.catch(() => {
				if (sequence === completionSequence.current) setCandidates([]);
			});
		return () => {
			completionSequence.current += 1;
		};
	}, [completePath, completionEnabled, draft, editing]);
	const openedByEditor = useRef(0);
	useLayoutEffect(() => {
		if (editing) editorRef.current?.select();
	}, [editing]);
	// ⌘L opens the editor from the keyboard; a press while it is already open
	// re-selects, and one after it closed reopens it.
	useEffect(() => {
		if (openEditor === openedByEditor.current) return;
		openedByEditor.current = openEditor;
		if (openEditor === 0) return;
		setDraft(path);
		setCompletionEnabled(false);
		setEditFor(path);
	}, [openEditor, path]);
	useEffect(() => {
		if (!editing) onEditorClosed();
	}, [editing, onEditorClosed]);

	// "…": the folded folders, in path order, as a dropdown above the bar (the bar sits at the foot of the window).
	const hiddenSet = new Set(fit.hidden);
	const hiddenSegments = segments.filter((_, index) => hiddenSet.has(index));
	const items: ({ readonly kind: "segment"; readonly segment: PathSegment; readonly index: number } | { readonly kind: "more" })[] = [];
	segments.forEach((segment, index) => {
		if (!hiddenSet.has(index)) items.push({ kind: "segment", segment, index });
		else if (items.at(-1)?.kind !== "more") items.push({ kind: "more" });
	});
	const moreRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const [moreOpen, setMoreOpen] = useState(false);
	const [moreAt, setMoreAt] = useState<{ readonly left: number; readonly bottom: number } | null>(null);
	const hasHidden = hiddenSegments.length > 0;
	// The menu belongs to this folder and this fold: a new location or a fit that folds nothing closes it.
	useEffect(() => {
		setMoreOpen(false);
	}, [path]);
	useEffect(() => {
		if (!hasHidden) setMoreOpen(false);
	}, [hasHidden]);
	const toggleMore = (): void => {
		const box = moreRef.current?.getBoundingClientRect();
		if (box === undefined) return;
		setMoreAt({ left: box.left, bottom: window.innerHeight - box.top + 4 });
		setMoreOpen((open) => !open);
	};
	useLayoutEffect(() => {
		if (moreOpen) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
	}, [moreOpen]);
	useEffect(() => {
		if (!moreOpen) return;
		const onPointer = (event: PointerEvent): void => {
			if (!(event.target instanceof Element) || event.target.closest("[data-path-more]") === null) setMoreOpen(false);
		};
		// Escape closes the menu and stays here: the Finder keymap would otherwise dismiss something else.
		const onKey = (event: globalThis.KeyboardEvent): void => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setMoreOpen(false);
			moreRef.current?.focus();
		};
		const onResize = (): void => setMoreOpen(false);
		document.addEventListener("pointerdown", onPointer, true);
		window.addEventListener("keydown", onKey, true);
		window.addEventListener("resize", onResize);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("resize", onResize);
		};
	}, [moreOpen]);
	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
		event.preventDefault();
		event.stopPropagation();
		const options = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
		if (options.length === 0) return;
		const at = options.indexOf(document.activeElement as HTMLButtonElement);
		const next =
			event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
		options[next]?.focus();
	};

	const startEditing = (event: MouseEvent<HTMLElement>): void => {
		if (editing || (event.target as Element).closest("[data-crumb-path], [data-path-more]") !== null) return;
		setDraft(path);
		setCompletionEnabled(false);
		setEditFor(path);
	};
	const selectedCandidate = candidates[activeCandidate] ?? candidates[0];
	const submitPath = (input: string, field: HTMLInputElement): void => {
		void onGoToPath(input).then((ok) => {
			if (ok) setEditFor(null);
			else field.select();
		});
	};
	const onEditorKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key === "Tab" && selectedCandidate !== undefined) {
			event.preventDefault();
			event.stopPropagation();
			setDraft(selectedCandidate.text);
			return;
		}
		if ((event.key === "ArrowDown" || event.key === "ArrowUp") && candidates.length > 0) {
			event.preventDefault();
			event.stopPropagation();
			const direction = event.key === "ArrowDown" ? 1 : -1;
			setActiveCandidate((current) => (current + direction + candidates.length) % candidates.length);
			return;
		}
		if (event.key !== "Enter" && event.key !== "Escape") return;
		// Both keys belong to the field, not the Finder keymap (Escape would dismiss, Enter open).
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			setEditFor(null);
			return;
		}
		submitPath(draft, event.currentTarget);
	};
	const ghostSuffix =
		selectedCandidate !== undefined && selectedCandidate.text.length > draft.length && selectedCandidate.text.slice(0, draft.length).toLocaleLowerCase() === draft.toLocaleLowerCase()
			? selectedCandidate.text.slice(draft.length)
			: "";

	return (
		// `pr-24` keeps a strip of empty bar after the trail even when the trail
		// fills the width, so the path can always be edited from the end.
		<nav
			className={cn("pathbar relative flex h-24 flex-none cursor-text items-center whitespace-nowrap border-t border-border bg-chrome pl-8 pr-24 text-badge text-ink-body", !editing && "overflow-hidden")}
			aria-label={t("finderComponents.pathBar")}
			onClick={startEditing}
		>
			<div
				ref={viewportRef}
				className={cn("flex min-w-0 flex-1 overflow-hidden", fit.overflow && ["justify-end", FADE_START], editing && "invisible")}
			>
				<div className="path-trail flex w-max flex-none items-center gap-1">
					{items.map((item, index) => {
						const separator = index > 0 && items[index - 1]?.kind !== "more" ? <span className={SEPARATOR_CLASS}>›</span> : null;
						if (item.kind === "more") {
							return (
								<span key="$more" className="flex flex-none items-center gap-1">
									{separator}
									<button
										ref={moreRef}
										type="button"
										className={cn(MORE_CLASS, moreOpen && "bg-hover text-ink")}
										data-path-more=""
										aria-haspopup="menu"
										aria-expanded={moreOpen}
										aria-label={t("finder.pathBar.more")}
										title={t("finder.pathBar.more")}
										onClick={toggleMore}
									>
										<MoreHorizontal size={14} strokeWidth={1.8} />
									</button>
								</span>
							);
						}
						const segment = item.segment;
						const clip = item.index === segments.length - 1 ? fit.lastClip : null;
						return (
							<span key={segment.key} className="flex flex-none items-center gap-1">
								{separator}
								<SegmentButton segment={segment} clip={clip} onNavigate={onNavigate} />
							</span>
						);
					})}
				</div>
			</div>
			{/* The measuring copy: every segment in full, one separator and "…", out of sight and out of reach. */}
			<div ref={measureRef} aria-hidden="true" inert className="path-measure pointer-events-none invisible absolute left-0 top-0 flex w-max items-center gap-1">
				{segments.map((segment) => (
					<SegmentButton key={segment.key} segment={segment} clip={null} onNavigate={onNavigate} measure />
				))}
				<span className={SEPARATOR_CLASS} data-measure-separator="">
					›
				</span>
				<span className={MORE_CLASS} data-measure-more="">
					<MoreHorizontal size={14} strokeWidth={1.8} />
				</span>
			</div>
			{moreOpen && moreAt !== null ? (
				<div
					ref={menuRef}
					role="menu"
					aria-label={t("finder.pathBar.more")}
					data-path-more=""
					className="path-more-menu fixed z-30 max-h-224 min-w-160 overflow-y-auto rounded-6 border border-border bg-window p-2 whitespace-nowrap shadow-lg"
					style={{ left: moreAt.left, bottom: moreAt.bottom }}
					onKeyDown={onMenuKeyDown}
				>
					{hiddenSegments.map((segment) => (
						<button
							key={segment.key}
							type="button"
							role="menuitem"
							disabled={segment.path === null}
							title={segment.path ?? segment.label}
							data-crumb-path={segment.path ?? undefined}
							className="flex h-28 w-full items-center gap-6 rounded-4 border-0 bg-transparent px-6 text-left text-badge text-ink-body enabled:cursor-pointer enabled:hover:bg-hover enabled:focus-visible:bg-hover disabled:text-ink-faint focus-visible:outline-none"
							onClick={() => {
								if (segment.path === null) return;
								setMoreOpen(false);
								onNavigate(segment.path);
							}}
						>
							<span className={ICON_CLASS}>{segment.icon}</span>
							<span className="min-w-0 flex-1 truncate">{segment.label}</span>
						</button>
					))}
				</div>
			) : null}
			{editing ? (
				<>
					<div className="absolute inset-x-4 top-1/2 h-20 -translate-y-1/2">
						<input
							ref={editorRef}
							// biome-ignore lint/a11y/noAutofocus: the click that opened the editor asks for the caret
							autoFocus
							className="path-edit relative size-full rounded-4 border border-accent bg-window px-5 text-badge text-ink outline-none"
							type="text"
							role="combobox"
							aria-autocomplete="list"
							aria-expanded={candidates.length > 0}
							spellCheck={false}
							autoComplete="off"
							aria-label={t("finder.pathBar.edit")}
							value={draft}
							onChange={(event) => {
								setDraft(event.target.value);
								setCompletionEnabled(true);
							}}
							onKeyDown={onEditorKeyDown}
							onBlur={() => setEditFor(null)}
						/>
						{ghostSuffix !== "" ? (
							<div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre rounded-4 border border-transparent px-5 text-badge">
								<span className="invisible">{draft}</span>
								<span className="text-ink-faint" data-path-ghost>{ghostSuffix}</span>
							</div>
						) : null}
					</div>
					{candidates.length > 0 ? (
						<div role="listbox" aria-label={t("finder.pathBar.suggestions")} className="absolute inset-x-4 bottom-full z-20 mb-4 max-h-224 overflow-y-auto rounded-6 border border-border bg-window p-2 whitespace-normal shadow-lg">
							{candidates.map((candidate, index) => (
								<button
									key={candidate.path}
									type="button"
									role="option"
									aria-selected={index === activeCandidate}
									title={candidate.path}
									className={cn("flex h-28 w-full cursor-pointer items-center gap-6 rounded-4 border-0 bg-transparent px-6 text-left text-badge text-ink-body", index === activeCandidate ? "bg-selection text-ink" : "hover:bg-hover")}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => {
										if (editorRef.current !== null) submitPath(candidate.text, editorRef.current);
									}}
								>
									<FileTile kind="folder" size={16} />
									<span className="min-w-0 flex-1 truncate">{candidate.name}</span>
								</button>
							))}
						</div>
					) : null}
				</>
			) : null}
		</nav>
	);
}

/** One folder (or the volume / selected file) on the bar. `measure` renders the measuring copy's version, without the `.path-*` names lanes read. */
function SegmentButton({
	segment,
	clip,
	onNavigate,
	measure = false,
}: {
	readonly segment: PathSegment;
	/** Width of the label slot when the last segment narrows; null shows the label in full. */
	readonly clip: number | null;
	readonly onNavigate: (path: string) => void;
	readonly measure?: boolean;
}): ReactElement {
	return (
		<button
			type="button"
			tabIndex={measure ? -1 : undefined}
			className={cn(measure ? SEGMENT_CLASS.replace("path-seg ", "") : SEGMENT_CLASS, !measure && segment.path !== null && "cursor-pointer hover:bg-hover hover:text-ink")}
			title={measure ? undefined : (segment.path ?? segment.label)}
			data-crumb-path={measure ? undefined : (segment.path ?? undefined)}
			data-measure-segment={measure ? "" : undefined}
			onClick={measure || segment.path === null ? undefined : () => onNavigate(segment.path ?? "")}
		>
			<span className={ICON_CLASS}>{segment.icon}</span>
			<span className={cn("path-label flex flex-none overflow-hidden", clip !== null && FADE_END)} style={clip !== null ? { width: clip } : undefined} data-fit={clip !== null ? "clip" : "full"}>
				<span className={cn(!measure && "path-name", "flex-none pl-4")}>{segment.label}</span>
			</span>
		</button>
	);
}
