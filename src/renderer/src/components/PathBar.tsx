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
import { HardDrive, Home } from "lucide-react";
import { cn } from "../lib/cn";
import { fitPathBar, sameFit, type PathFit, type SegmentFit } from "../state/path-fit";
import { volumeLabel, windowsRootPath, type Crumb } from "../state/paths";
import { kindFromExtension } from "../state/kinds";
import { FileTile } from "./primitives/FileTile";

/**
 * v7 `.pathbar` (proto:.pathbar): macOS path bar at the foot of the Finder column.
 *
 * One line, always. The trail is measured against the bar and `fitPathBar`
 * decides, per segment, whether the label shows in full, is clipped behind a
 * trailing fade (never an ellipsis), or is dropped so only the icon remains.
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

/** Narrowest clipped label slot (4px icon gap + a few glyphs); below it the segment shows its icon only. */
const MIN_LABEL = 32;
const NO_FIT: PathFit = { segments: [], overflow: false };
const FULL: SegmentFit = { mode: "full" };

const SEGMENT_CLASS =
	"path-seg inline-flex h-20 flex-none items-center rounded-4 border-0 bg-transparent px-5 text-badge text-inherit";
const ICON_CLASS = "path-ic grid size-14 flex-none place-items-center text-ink-faint";
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
	const trailRef = useRef<HTMLDivElement>(null);
	const [fit, setFit] = useState<PathFit>(NO_FIT);

	const refit = useCallback(() => {
		const viewport = viewportRef.current;
		const trail = trailRef.current;
		if (viewport === null || trail === null) return;
		// Each `.path-label` slot holds one unconstrained `.path-name`, so the
		// name's box is the label's natural width whatever the slot is showing.
		const labels: number[] = [];
		let slots = 0;
		for (const slot of trail.querySelectorAll<HTMLElement>(".path-label")) {
			slots += slot.getBoundingClientRect().width;
			labels.push(slot.firstElementChild?.getBoundingClientRect().width ?? 0);
		}
		const next = fitPathBar({
			available: viewport.getBoundingClientRect().width,
			fixed: trail.getBoundingClientRect().width - slots,
			labels,
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
	if (editFor !== null && editFor !== path) setEditFor(null);
	const editing = editFor === path;
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
		setEditFor(path);
	}, [openEditor, path]);
	useEffect(() => {
		if (!editing) onEditorClosed();
	}, [editing, onEditorClosed]);

	const startEditing = (event: MouseEvent<HTMLElement>): void => {
		if (editing || (event.target as Element).closest("[data-crumb-path]") !== null) return;
		setDraft(path);
		setEditFor(path);
	};
	const onEditorKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
		if (event.key !== "Enter" && event.key !== "Escape") return;
		// Both keys belong to the field, not the Finder keymap (Escape would dismiss, Enter open).
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			setEditFor(null);
			return;
		}
		const input = event.currentTarget;
		void onGoToPath(draft).then((ok) => {
			if (ok) setEditFor(null);
			else input.select();
		});
	};

	return (
		// `pr-24` keeps a strip of empty bar after the trail even when the trail
		// fills the width, so the path can always be edited from the end.
		<nav
			className="pathbar relative flex h-24 flex-none cursor-text items-center overflow-hidden whitespace-nowrap border-t border-border bg-chrome pl-8 pr-24 text-badge text-ink-body"
			aria-label={t("finderComponents.pathBar")}
			onClick={startEditing}
		>
			<div
				ref={viewportRef}
				className={cn("flex min-w-0 flex-1 overflow-hidden", fit.overflow && ["justify-end", FADE_START], editing && "invisible")}
			>
				<div ref={trailRef} className="path-trail flex w-max flex-none items-center gap-1">
					{segments.map((segment, index) => {
						const segmentFit = fit.segments[index] ?? FULL;
						return (
							<span key={segment.key} className="flex flex-none items-center gap-1">
								{index > 0 ? <span className="path-sep flex-none px-1 text-meta text-ink-faint">›</span> : null}
								<button
									type="button"
									className={cn(SEGMENT_CLASS, segment.path !== null && "cursor-pointer hover:bg-hover hover:text-ink")}
									title={segment.path ?? segment.label}
									data-crumb-path={segment.path ?? undefined}
									onClick={segment.path === null ? undefined : () => onNavigate(segment.path ?? "")}
								>
									<span className={ICON_CLASS}>{segment.icon}</span>
									<span
										className={cn(
											"path-label flex flex-none overflow-hidden",
											segmentFit.mode === "clip" && FADE_END,
											segmentFit.mode === "icon" && "w-0",
										)}
										style={segmentFit.mode === "clip" ? { width: segmentFit.width } : undefined}
										data-fit={segmentFit.mode}
									>
										<span className="path-name flex-none pl-4">{segment.label}</span>
									</span>
								</button>
							</span>
						);
					})}
				</div>
			</div>
			{editing ? (
				<input
					ref={editorRef}
					// biome-ignore lint/a11y/noAutofocus: the click that opened the editor asks for the caret
					autoFocus
					className="path-edit absolute inset-x-4 top-1/2 h-20 -translate-y-1/2 rounded-4 border border-accent bg-window px-5 text-badge text-ink outline-none"
					type="text"
					spellCheck={false}
					autoComplete="off"
					aria-label={t("finder.pathBar.edit")}
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={onEditorKeyDown}
					onBlur={() => setEditFor(null)}
				/>
			) : null}
		</nav>
	);
}
