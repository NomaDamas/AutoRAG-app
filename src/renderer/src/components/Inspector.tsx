/**
 * Inspector — the right column (v7 Bloom). One full-height view at a time,
 * chosen by the focused tab (a folder tab shows Info, an AI Search tab Evidence):
 *
 *   Info     preview paper, name, kind·size·date, the file's actions as one row of
 *            icon buttons (index, trash, copy path, then what its type suggests), the
 *            dupey Versions family, the metadata rows, and the suggested-action
 *            bar. The bar is data-driven: `state/file-actions.ts` decides which
 *            actions the focused file's own type implies, the machine's
 *            capabilities decide which of those are real, and a multi-variant
 *            action (image edit, video conversion) opens a menu instead of a
 *            row of near-identical buttons. The paper shows the file's real
 *            content: the 640px Quick Look tier from `fs:previewIcon` rendered
 *            at the panel's full width (no fixed frame), with the listing icon
 *            and then the letter tile as fallbacks. A multi-selection replaces
 *            all of it with the aggregate view — a fan of up to five of the
 *            selection's own preview papers (focused file in front, each sheet
 *            dog-eared and shadowed), the count title, the per-kind breakdown
 *            with total size, and created/modified date ranges.
 *   Evidence the AI Search tab's cited sources: numbered tabs, preview, title
 *            (a file reveals in the Finder, a web page opens in the OS browser),
 *            and excerpts.
 *
 * All callbacks are real IPC-backed actions supplied by App; this component
 * renders no fabricated data. Esc handling stays in App's keymap.
 */

import { useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { previewStreamUrl } from "../../../preview/shared/contract";
import { hwpFirstPageUrl } from "../../../preview/ui/rhwp";
import { firstPageTile } from "../lib/first-page-tile";
import { previewLoaderFor } from "../lib/preview-loader";
import { hostPlatform } from "../lib/shortcuts";
import type { ActionAnchor, ActionCapabilities, OpenWithApplication } from "../../../shared/actions-contract";
import type { AutomationRule } from "../../../shared/automation-contract";
import type { FsFileDetails } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import type { CitationEvidence } from "../../../shared/search-contract";
import { type FinderEntry, hasFileVersion } from "../data/entries";
import { cn } from "../lib/cn";
import { anchorOf } from "../lib/anchor";
import { rulesWatching } from "../state/automations";
import { dateLabelOf, fileKindOf, kindLabelOf } from "../state/entry-values";
import { buildInfoRows, hasMoreInfoRows, visibleInfoRows, type InfoRow as InfoRowData, type InfoSection } from "../state/inspector-info";
import { selectionInfoRows, stackCards, summarizeSelection } from "../state/inspector-multi";
import { evidenceDetail, evidenceHeading, evidenceKind, evidenceSourceUrl, isLocalEvidenceSource } from "../state/evidence";
import {
	openWithItems,
	selectionActions,
	suggestedActions,
	type FileAction,
	type FileActionIcon,
	type FileActionItem,
	type FileActionTarget,
} from "../state/file-actions";
import { dirname } from "../state/paths";
import { VERSION_TAG_KEYS } from "../state/version-family";
import { imageTarget } from "../state/answer-markdown";
import type { FileKind } from "../state/kinds";
import type { ImageActions } from "./AnswerImage";
import { AutomationRulesSection } from "./AutomationRulesSection";
import { EvidenceExcerpt, InlineWithImages } from "./EvidenceBlocks";
import {
	CloseIcon,
	ZipIcon,
	CopyIcon,
	DatabaseIcon,
	ExtractIcon,
	EyeIcon,
	FolderGlyph,
	ImageConvertIcon,
	ImageResizeIcon,
	LinkIcon,
	OpenIcon,
	OpenWithIcon,
	ShareIcon,
	SparklesIcon,
	TrashIcon,
	VideoConvertIcon,
	ReduceSizeIcon,
} from "./icons";
import dazziMarkMono from "../assets/dazzi-mark-mono.png";
import dazziMarkMonoDark from "../assets/dazzi-mark-mono-dark.png";
import { ActionMenu } from "./primitives/ActionMenu";
import { FileTile } from "./primitives/FileTile";
import dazziMark from "../assets/dazzi-mark.png";

export interface InspectorFamilyMember {
	readonly path: string;
	readonly name: string;
	readonly relation: "exact" | "near" | "contains";
	readonly where: string;
}

export interface InspectorFamily {
	readonly headPath: string;
	readonly headName: string;
	readonly members: readonly InspectorFamilyMember[];
}

export interface InspectorProps {
	/** Focused/selected entry; null renders the empty-state placeholder. */
	readonly entry: FinderEntry | null;
	/** Every selected entry in visual order; more than one switches the Info half to the aggregate paper-stack view. */
	readonly entries: readonly FinderEntry[];
	readonly indexStatus: IndexStatus | null;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly onAskAi: (entry: FinderEntry) => void;
	/** What this machine can actually run (probed in main, cached by the controller). */
	readonly actionCapabilities: ActionCapabilities;
	/** Run a suggested action; `anchor` is the clicked button's rect (share sheet). */
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	/** The applications the OS registers for `entry`'s type, default first. */
	readonly loadOpenWithApplications: (entry: FinderEntry) => Promise<readonly OpenWithApplication[]>;
	/** Dupey family of `entry`; null when it has no versions. */
	readonly family: InspectorFamily | null;
	readonly onOpenMember: (path: string) => void;
	/** "evidence" while an AI Search tab is focused: the whole panel is the cited sources. */
	readonly view: "info" | "evidence";
	readonly evidence: readonly CitationEvidence[];
	readonly evidenceSelected: number;
	readonly onSelectEvidence: (n: number) => void;
	/** Number of local files gathered across the current AI Search session for the Evidence Folder. */
	readonly evidenceFolderCount?: number;
	/** Create and open the temporary Evidence Folder tab for the current session. */
	readonly onOpenEvidenceFolder?: () => void;
	/** Show the source: a local file in Quick Look at the cited passage, a web page in the OS browser. */
	readonly onRevealPath: (path: string, excerpts?: readonly string[]) => void;
	readonly onToast: (msg: string) => void;
	/** Images in evidence: a local picture opens in Quick Look, a web image's page in the OS browser. */
	readonly imageActions: ImageActions;
	/**
	 * The file automations, for the folder inspector's "이 폴더의 자동화" section:
	 * the rules that watch the shown folder, and what a row does. Absent (or a
	 * folder nothing watches) leaves the section out.
	 */
	readonly automations?: {
		readonly rules: readonly AutomationRule[];
		readonly onEdit: (rule: AutomationRule) => void;
		readonly onDelete: (rule: AutomationRule) => void;
		/** Right click on a rule row: its menu, at the pointer. Absent leaves the browser's menu alone. */
		readonly onMenu?: (rule: AutomationRule, at: { readonly x: number; readonly y: number }) => void;
	};
	/**
	 * `entry` is the folder the pane shows, standing in because nothing is selected (see
	 * state/inspector-target.ts), not a row the person picked: its size and times are not
	 * known here, and it is not offered for the Trash.
	 */
	readonly folderInView?: boolean;
	/** The AI chat's foot of the Info view (resume link, 요약, composer); see InspectorChat.tsx. */
	readonly chatDock?: ReactNode;
	/**
	 * A multi-selection's index button: whether every selected entry is in the index, or null when some entry cannot
	 * be toggled (the button is left out). Absent leaves it out too.
	 */
	readonly selectionIndex?: { readonly included: boolean } | null;
	/** Include every selected entry in the index, or leave every one out. */
	readonly onSetSelectionIndexed?: (include: boolean) => void;
	/** Trash every selected entry. */
	readonly onTrashSelection?: () => void;
	/** The AI chat itself, shown instead of the Info view while the person is in it. */
	readonly chatView?: ReactNode;
}

const HEAD_BUTTON =
	"flex flex-none items-center justify-center size-icon-sm p-0 border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-border-strong disabled:cursor-default disabled:hover:bg-transparent";

/** Inspector action glyphs, 18px in the bar and 16px in the head. */
const ACTION_ICONS: Readonly<Record<FileActionIcon, (props: { readonly size?: number }) => ReactElement>> = {
	open: OpenIcon,
	openWith: OpenWithIcon,
	compress: ZipIcon,
	extract: ExtractIcon,
	share: ShareIcon,
	askAi: SparklesIcon,
	imageConvert: ImageConvertIcon,
	imageResize: ImageResizeIcon,
	video: VideoConvertIcon,
	reduce: ReduceSizeIcon,
};

/** What the right sidebar shows when it has nothing to say yet: the Dazzi mark, centred, with no caption. */
function EmptyInspectorMark(): ReactElement {
	return (
		<div className="flex flex-1 items-center justify-center">
			<img src={dazziMark} alt="" draggable={false} style={{ width: 52, height: 52, objectFit: "contain" }} />
		</div>
	);
}

export function Inspector({
	entry,
	entries,
	indexStatus,
	onToggleIndex,
	onTrash,
	onCopyPath,
	onAskAi,
	actionCapabilities,
	onAction,
	loadOpenWithApplications,
	family,
	onOpenMember,
	view,
	evidence,
	evidenceSelected,
	onSelectEvidence,
	onRevealPath,
	evidenceFolderCount = 0,
	onOpenEvidenceFolder,
	onToast,
	imageActions,
	automations,
	folderInView = false,
	chatDock,
	chatView,
	selectionIndex = null,
	onSetSelectionIndexed,
	onTrashSelection,
}: InspectorProps): ReactElement {
	const { t } = useTranslation();
	// A path in the info card: straight to the system clipboard, then the window's toast.
	const copyValue = (value: string): void => {
		void window.autorag.fs
			.copyPathsToClipboard([value])
			.then(() => onToast(t("toasts.copiedPath")))
			.catch(() => {});
	};
	return (
		<aside
			className="inspector w-full min-w-0 flex-1 min-h-0 flex flex-col bg-subtle overflow-hidden"
			aria-label={t("finderComponents.inspectorAside")}
		>
			{view === "evidence" ? (
				<EvidencePanel
					evidence={evidence}
					selected={evidenceSelected}
					onSelect={onSelectEvidence}
					onReveal={onRevealPath}
					onToast={onToast}
					imageActions={imageActions}
					evidenceFolderCount={evidenceFolderCount}
					onOpenEvidenceFolder={onOpenEvidenceFolder}
				/>
			) : chatView !== undefined && chatView !== null ? (
				chatView
			) : entries.length > 1 ? (
				<MultiInfoHalf
					entries={entries}
					focusPath={entry?.path ?? null}
					actionCapabilities={actionCapabilities}
					onAction={onAction}
					selectionIndex={selectionIndex}
					onSetSelectionIndexed={onSetSelectionIndexed}
					onTrashSelection={onTrashSelection}
					chatDock={chatDock}
					onCopyValue={copyValue}
				/>
			) : (
				<InfoHalf
					entry={entry}
					indexStatus={indexStatus}
					family={family}
					onOpenMember={onOpenMember}
					onToggleIndex={onToggleIndex}
					onTrash={onTrash}
					onCopyPath={onCopyPath}
					actionCapabilities={actionCapabilities}
					onAction={onAction}
					loadOpenWithApplications={loadOpenWithApplications}
					automations={automations}
					folderInView={folderInView}
					chatDock={chatDock}
					onCopyValue={copyValue}
				/>
			)}
		</aside>
	);
}

function InfoHalf({
	entry,
	indexStatus,
	family,
	onOpenMember,
	onToggleIndex,
	onTrash,
	onCopyPath,
	actionCapabilities,
	onAction,
	loadOpenWithApplications,
	automations,
	folderInView,
	chatDock,
	onCopyValue,
}: {
	readonly entry: FinderEntry | null;
	readonly indexStatus: IndexStatus | null;
	readonly family: InspectorFamily | null;
	readonly onOpenMember: (path: string) => void;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly actionCapabilities: ActionCapabilities;
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly loadOpenWithApplications: (entry: FinderEntry) => Promise<readonly OpenWithApplication[]>;
	readonly automations?: InspectorProps["automations"];
	readonly folderInView: boolean;
	readonly chatDock?: ReactNode;
	readonly onCopyValue: (value: string) => void;
}): ReactElement {
	// 간략히 / 자세히 per section; the choice holds while the person moves between files.
	const [brief, setBrief] = useState<Readonly<Record<InfoSection, boolean>>>({ general: false, image: false });
	const [details, setDetails] = useState<FsFileDetails | null>(null);
	const focusedPath = entry?.path ?? null;
	const focusedMtime = entry?.mtimeMs ?? null;
	const focusedSize = entry?.size ?? null;
	// Rich metadata is per-file and re-read when an in-place action (such as Reduce Size)
	// replaces the file with a new size/mtime; stale answers are dropped on cleanup.
	useEffect(() => {
		setDetails(null);
		if (focusedPath === null) return;
		let cancelled = false;
		const load = window.autorag?.fs?.details;
		if (load === undefined) return;
		void load(focusedPath)
			.then((next) => {
				if (!cancelled) setDetails(next);
			})
			.catch(() => {
				if (!cancelled) setDetails(null);
			});
		return () => {
			cancelled = true;
		};
	}, [focusedPath, focusedMtime, focusedSize]);
	const { t } = useTranslation();
	const included = indexStatus === null || !indexStatus.excluded;
	const infoRows = entry === null ? [] : buildInfoRows(details, entry);
	const sectionOf = (section: InfoSection): readonly InfoRowData[] => infoRows.filter((row) => row.section === section);
	const toggle = (section: InfoSection): void => setBrief((current) => ({ ...current, [section]: !current[section] }));

	return (
		<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.title")}>
			{entry === null ? (
				<>
					{/* Nothing selected: the Dazzi mark, faded, over a composer that asks about anything. */}
					<div className="inspector-empty flex flex-1 min-h-0 items-center justify-center">
						<img className="size-67 object-contain opacity-50 dark:hidden" src={dazziMarkMono} alt="" aria-hidden="true" draggable={false} />
						{/* Dark mode has its own lighter mark, with its fade already in the image. */}
						<img className="hidden size-67 object-contain dark:block" src={dazziMarkMonoDark} alt="" aria-hidden="true" draggable={false} />
					</div>
					{chatDock}
				</>
			) : (
				// One scroll for the whole panel; the chat dock follows the content and stays pinned at the bottom.
				<div className="inspector-body flex-1 min-h-0 overflow-auto flex flex-col">
					<div className="flex flex-col gap-8 px-12 pt-4 pb-12">
						<div className="preview-card flex flex-col gap-12 rounded-12 border border-divider bg-window p-14">
							<PreviewPaper entry={entry} />
							<div className="flex items-center gap-8">
								<FileTile kind={fileKindOf(entry)} size={22} />
								<div className="flex min-w-0 flex-1 flex-col gap-3">
									<div className="preview-title text-meta font-medium text-ink leading-[16px] [overflow-wrap:anywhere]">{entry.name}</div>
									<div className="preview-sub text-badge font-medium leading-[14px] text-ink-faint truncate">
										{folderInView ? kindLabelOf(entry) : `${kindLabelOf(entry)} · ${dateLabelOf(entry)}`}
									</div>
								</div>
							</div>
						</div>

						<FileActionGroup
							entry={entry}
							included={included}
							indexToggleable={indexStatus === null ? entry.kind === "file" : indexStatus.toggleable}
							folderInView={folderInView}
							onToggleIndex={onToggleIndex}
							onTrash={onTrash}
							onCopyPath={onCopyPath}
							actions={suggestedActions(entry, actionCapabilities).filter((action) => action.id !== "open" && action.id !== "askAi")}
							onAction={onAction}
							loadOpenWithApplications={() => loadOpenWithApplications(entry)}
						/>

						{entry.kind === "folder" && automations !== undefined ? (
							<AutomationRulesSection
								rules={rulesWatching(automations.rules, entry.path)}
								onEdit={automations.onEdit}
								onDelete={automations.onDelete}
								onMenu={automations.onMenu}
							/>
						) : null}

						{family === null ? null : <VersionsSection family={family} entry={entry} onOpenMember={onOpenMember} />}

						<InfoSectionCard title={t("inspector.generalInfo")} rows={sectionOf("general")} brief={brief.general} onToggle={() => toggle("general")} onCopy={onCopyValue} />
						<InfoSectionCard title={t("inspector.imageInfo")} rows={sectionOf("image")} brief={brief.image} onToggle={() => toggle("image")} onCopy={onCopyValue} />
					</div>
					{chatDock === undefined || chatDock === null ? null : (
						<div className="inspector-dock-slot sticky bottom-0 z-10 mt-auto bg-subtle">{chatDock}</div>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * One titled block of metadata rows (일반 정보, 사진 정보) in its card, with its own
 * 간략히 / 자세히 link when collapsing would hide anything. A section with no rows is left out.
 */
function InfoSectionCard({
	title,
	rows,
	brief,
	onToggle,
	onCopy,
}: {
	readonly title: string;
	readonly rows: readonly InfoRowData[];
	readonly brief: boolean;
	readonly onToggle: () => void;
	/** Copy a path row's value; rows marked `copyable` are clickable. */
	readonly onCopy: (value: string) => void;
}): ReactElement | null {
	const { t } = useTranslation();
	if (rows.length === 0) return null;
	const shown = visibleInfoRows(rows, brief);
	return (
		<div className="info-section flex flex-col gap-8 border-t border-divider pt-8">
			<div className="section-title flex h-22 items-center justify-between">
				<span className="text-meta font-medium leading-[16px] text-ink">{title}</span>
				{hasMoreInfoRows(rows) ? (
					<button type="button" className="p-0 border-0 bg-transparent text-badge font-medium leading-[14px] text-accent-text cursor-pointer hover:underline" onClick={onToggle}>
						{brief ? t("inspector.showMore") : t("inspector.showLess")}
					</button>
				) : null}
			</div>
			<dl className="m-0 flex flex-col gap-4">
				{shown.map((row) => (
					<InfoRow key={row.label} label={row.label} value={row.value} onCopy={row.copyable === true ? () => onCopy(row.value) : undefined} />
				))}
			</dl>
		</div>
	);
}

interface PreviewState {
	readonly url: string | null;
	/** width / height of the decoded preview; remembered so revisits reserve the exact height. */
	readonly aspect: number | null;
	/** The OS answer (or "not fetchable") arrived — null url then means "no preview, use the tile". */
	readonly resolved: boolean;
}

/**
 * Process-local identity (path + mtime) → preview answer and decoded aspect.
 * Re-selecting a file the panel already previewed renders the final
 * full-width layout on the very first frame — no loading state, no layout
 * shift, no repeat IPC. Entries are a string and a number; the map stays
 * session-scoped and unbounded on purpose.
 */
const previewCache = new Map<string, PreviewState>();

/**
 * HWP/HWPX previews are first-page SVG data URLs (often 100KB+), not short
 * protocol URLs, so only the most recent ones stay in `previewCache`.
 */
const HWP_PREVIEW_KEEP = 24;
/** The Info panel paper is drawn at the OS preview tier: 640px. */
const PREVIEW_PAPER_WIDTH = 640;
const hwpIdentities: string[] = [];

function rememberHwp(identity: string): void {
	hwpIdentities.push(identity);
	while (hwpIdentities.length > HWP_PREVIEW_KEEP) previewCache.delete(hwpIdentities.shift() ?? "");
}

/** The loading skeleton's aspect before the first decode says otherwise. */
const DEFAULT_PAPER_ASPECT = 4 / 3;

function usePreviewState(entry: FinderEntry): {
	readonly state: PreviewState;
	readonly loaded: boolean;
	readonly onLoad: (img: HTMLImageElement) => void;
	readonly onError: () => void;
} {
	const identity = `${entry.path} ${hasFileVersion(entry) ? entry.mtimeMs : ""}`;
	const [state, setState] = useState<PreviewState>(
		() => previewCache.get(identity) ?? { url: null, aspect: null, resolved: false },
	);
	const [loaded, setLoaded] = useState(false);
	const fetchable = entry.kind === "file" && hasFileVersion(entry);
	useEffect(() => {
		setLoaded(false);
		const cached = previewCache.get(identity);
		if (cached !== undefined) {
			setState(cached);
			return;
		}
		// Keep the previous paper's aspect while the next file loads, so
		// file-to-file navigation never snaps the height twice.
		setState((prev) => ({ url: null, resolved: false, aspect: prev.aspect }));
		const mtimeMs = entry.mtimeMs;
		if (!fetchable) return;
		const path = entry.path;
		// The OS thumbnailers draw nothing for HWP without Hancom's plug-in, and Windows answers a PDF with a generic
		// icon: rhwp and pdf.js draw the first page here (`preview-loader.ts`).
		const osPreview = window.autorag?.fs?.previewIcon;
		if (osPreview === undefined) return;
		const load = previewLoaderFor(path, {
			platform: hostPlatform(),
			os: osPreview,
			page: (file, version) => firstPageTile(file, version, PREVIEW_PAPER_WIDTH),
			hwp: hwpFirstPageUrl,
		});
		let cancelled = false;
		const settle = (next: PreviewState): void => {
			previewCache.set(identity, next);
			// A drawn page is a data URL of tens of KB: only the most recent stay cached.
			if (next.url?.startsWith("data:") === true) rememberHwp(identity);
			if (!cancelled) setState(next);
		};
		void load(path, mtimeMs)
			.then((url) => settle({ url, aspect: null, resolved: true }))
			.catch(() => settle({ url: null, aspect: null, resolved: true }));
		return () => {
			cancelled = true;
		};
	}, [identity, fetchable, entry.path, entry.mtimeMs]);
	return {
		state,
		loaded,
		onLoad: (img) => {
			setLoaded(true);
			setState((prev) => {
				const next: PreviewState = { ...prev, aspect: img.naturalWidth / img.naturalHeight };
				previewCache.set(identity, next);
				return next;
			});
		},
		onError: () => {
			previewCache.delete(identity);
			setState((prev) => ({ ...prev, url: null, resolved: true }));
		},
	};
}

/**
 * The single-file preview is always the full-width paper: while the 640px
 * tier loads it is a blank sheet at the last known aspect (the exact one on
 * any revisit), then the content fades in and the aspect-ratio transition
 * settles the height — the compact bordered box only ever appears for
 * folders and files the OS provably has no preview for.
 */
function PreviewPaper({ entry }: { readonly entry: FinderEntry }): ReactElement {
	const { state, loaded, onLoad, onError } = usePreviewState(entry);
	if (entry.kind === "folder") {
		return (
			<div className="preview-paper flex h-91 flex-none items-center justify-center">
				{entry.iconUrl === undefined ? (
					<FileTile kind="folder" large />
				) : (
					<img className="size-77 object-contain" src={entry.iconUrl} alt="" aria-hidden="true" draggable={false} />
				)}
			</div>
		);
	}
	if (entry.kind !== "file" || (state.resolved && state.url === null)) {
		return (
			<div className="preview-paper flex-none flex items-center justify-center overflow-hidden rounded-10 border border-border bg-window h-152">
				{entry.iconUrl === undefined ? (
					<FileTile kind={fileKindOf(entry)} large />
				) : (
					<img className="max-w-full max-h-full object-contain" src={entry.iconUrl} alt="" aria-hidden="true" draggable={false} />
				)}
			</div>
		);
	}
	return (
		<div
			className="preview-paper relative flex-none w-full overflow-hidden rounded-10 border border-border bg-window transition-[aspect-ratio] duration-200 ease-out max-h-[70vh]"
			style={{ aspectRatio: String(state.aspect ?? DEFAULT_PAPER_ASPECT) }}
		>
			{state.url === null ? null : (
				// crossOrigin pairs with the protocol's ACAO:* so QA can read pixels back.
				<img
					key={state.url}
					className={cn(
						"absolute inset-0 h-full w-full object-contain transition-opacity duration-150",
						loaded ? "opacity-100" : "opacity-0",
					)}
					src={state.url}
					alt=""
					aria-hidden="true"
					draggable={false}
					crossOrigin="anonymous"
					onLoad={(event) => onLoad(event.currentTarget)}
					onError={onError}
				/>
			)}
		</div>
	);
}

/** One paper in the stack: the file's preview cropped to fill the sheet, or the letter tile while it loads. */
function PreviewCardImage({ entry }: { readonly entry: FinderEntry }): ReactElement {
	const { state, loaded, onLoad, onError } = usePreviewState(entry);
	if (state.url === null) return <FileTile kind={fileKindOf(entry)} large />;
	return (
		<img
			className={cn(
				"absolute inset-0 h-full w-full object-cover transition-opacity duration-150",
				loaded ? "opacity-100" : "opacity-0",
			)}
			src={state.url}
			alt=""
			aria-hidden="true"
			draggable={false}
			crossOrigin="anonymous"
			onLoad={(event) => onLoad(event.currentTarget)}
			onError={onError}
		/>
	);
}

/**
 * The stack's poses, front card first: the second paper leans out to the right behind it and the third to the left,
 * each offset from the front card's centre (Figma "preview-stack").
 */
const STACK_POSES: readonly string[] = [
	"z-30 -translate-x-1/2 -translate-y-1/2",
	"z-20 translate-x-[calc(-50%+28px)] translate-y-[calc(-50%-7px)] -rotate-6",
	"z-10 translate-x-[calc(-50%-36px)] translate-y-[calc(-50%+8px)] rotate-8",
];

/** The newest entry of the selection, whose date stands for the whole set in the header. */
function newestOf(entries: readonly FinderEntry[]): FinderEntry | undefined {
	return entries.reduce<FinderEntry | undefined>((newest, entry) => (newest === undefined || entry.mtimeMs > newest.mtimeMs ? entry : newest), undefined);
}

/**
 * The aggregate Info half for a multi-selection, in the single file's card idiom: a stack of the selection's own
 * previews (focused file in front) over the count and the per-kind breakdown, the action group (index, Trash, then
 * Compress and Share), and 일반 정보 for the whole set with its own 간략히 / 자세히. Versions and per-file metadata are
 * single-selection concerns and stay out.
 */
function MultiInfoHalf({
	entries,
	focusPath,
	actionCapabilities,
	onAction,
	selectionIndex,
	onSetSelectionIndexed,
	onTrashSelection,
	chatDock,
	onCopyValue,
}: {
	readonly entries: readonly FinderEntry[];
	readonly focusPath: string | null;
	readonly actionCapabilities: ActionCapabilities;
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly selectionIndex: { readonly included: boolean } | null;
	readonly onSetSelectionIndexed: ((include: boolean) => void) | undefined;
	readonly onTrashSelection: (() => void) | undefined;
	readonly chatDock: ReactNode;
	readonly onCopyValue: (value: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [brief, setBrief] = useState(false);
	const runner = useActionRunner({ onAction });
	const summary = summarizeSelection(entries);
	const cards = stackCards(entries, focusPath, STACK_POSES.length);
	const front = cards[0];
	const newest = newestOf(entries);
	const rows = selectionInfoRows(entries, summary);
	// DOM order paints back-to-front so the focused paper lands on top.
	const staged = cards.map((card, depth) => ({ card, depth })).reverse();
	const buttons: GroupButton[] = [];
	if (selectionIndex !== null && onSetSelectionIndexed !== undefined) {
		const included = selectionIndex.included;
		buttons.push({
			id: "index",
			label: included ? t("contextMenu.includeInIndex") : t("contextMenu.excludeFromIndex"),
			icon: <DatabaseIcon size={16} />,
			pressed: included,
			onClick: () => onSetSelectionIndexed(!included),
		});
	}
	if (onTrashSelection !== undefined) buttons.push({ id: "trash", label: t("contextMenu.trashShort"), icon: <TrashIcon size={16} />, onClick: onTrashSelection });
	for (const action of selectionActions(actionCapabilities)) {
		const Icon = ACTION_ICONS[action.icon];
		buttons.push({
			id: action.id,
			label: actionLabel(t, action.id, action.label),
			icon: <Icon size={16} />,
			onClick: (event) => runner.activate(action, anchorOf(event.currentTarget)),
		});
	}
	return (
		<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.title")}>
			<div className="inspector-body flex-1 min-h-0 overflow-auto flex flex-col">
				<div className="flex flex-col gap-8 px-12 pt-4 pb-12">
					<div className="preview-card flex flex-col gap-12 rounded-12 border border-divider bg-window p-14">
						<div className="preview-stack relative h-201 flex-none overflow-hidden">
							{staged.map(({ card, depth }) => (
								<div
									key={card.path}
									className={cn(
										"preview-stack-card absolute left-1/2 top-1/2 flex h-160 w-120 items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-[0_3px_10px_rgba(0,0,0,0.14)]",
										STACK_POSES[depth],
									)}
								>
									<PreviewCardImage entry={card} />
								</div>
							))}
						</div>
						<div className="flex items-center gap-8">
							{front === undefined ? null : <FileTile kind={fileKindOf(front)} size={22} />}
							<div className="flex min-w-0 flex-1 flex-col gap-3">
								<div className="preview-title text-meta font-medium text-ink leading-[16px]">{summary.title}</div>
								<div className="preview-sub text-badge font-medium leading-[14px] text-ink-faint truncate">
									{newest === undefined ? summary.kindSummary : `${summary.kindSummary} · ${dateLabelOf(newest)}`}
								</div>
							</div>
						</div>
					</div>

					{buttons.length === 0 ? null : <ActionIconGroup buttons={buttons} menu={runner.menu} />}

					<InfoSectionCard title={t("inspector.generalInfo")} rows={rows} brief={brief} onToggle={() => setBrief((current) => !current)} onCopy={onCopyValue} />
				</div>
				{chatDock === undefined || chatDock === null ? null : (
					<div className="inspector-dock-slot sticky bottom-0 z-10 mt-auto bg-subtle">{chatDock}</div>
				)}
			</div>
		</div>
	);
}

/** A suggested action's label in the interface language (the action carries a Korean default). */
function actionLabel(t: (key: string, fallback: string) => string, id: string, fallback: string): string {
	switch (id) {
		case "open": return t("inspector.actions.open", fallback);
		case "openWith": return t("inspector.actions.openWith", fallback);
		case "compress": return t("inspector.actions.compress", fallback);
		case "extract": return t("inspector.actions.extract", fallback);
		case "share": return t("inspector.actions.share", fallback);
		case "askAi": return t("inspector.actions.askAi", fallback);
		case "imageConvert": return t("inspector.actions.imageConvert", fallback);
		case "imageResize": return t("inspector.actions.imageResize", fallback);
		case "videoConvert": return t("inspector.actions.videoConvert", fallback);
		case "reduceSize": return t("inspector.actions.reduceSize", fallback);
		default: return fallback;
	}
}

/**
 * Running a suggested action: a `menu` action (`확장자 변환`, `해상도 줄이기`, `동영상 변환`, `압축`) and "다른 앱으로 열기" open their
 * variants anchored to the clicked button; a flat action runs at once. Returns the menu to render.
 */
function useActionRunner({
	onAction,
	onAskAi,
	loadOpenWithApplications,
}: {
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly onAskAi?: (() => void) | undefined;
	readonly loadOpenWithApplications?: (() => Promise<readonly OpenWithApplication[]>) | undefined;
}): {
	readonly activate: (action: FileAction, anchor: ActionAnchor) => void;
	readonly menu: ReactElement | null;
} {
	const [menu, setMenu] = useState<{ readonly items: readonly FileActionItem[]; readonly anchor: ActionAnchor } | null>(null);
	function run(target: FileActionTarget, anchor: ActionAnchor): void {
		// "AI 요약" is the App shell's concern (it owns the composer), not IPC.
		if (target.kind === "askAi") onAskAi?.();
		else if (target.kind === "openWith") {
			// The OS's handlers for this file's type come first; "기타…" opens the full chooser.
			// A failed lookup still leaves "기타…" reachable.
			(loadOpenWithApplications?.() ?? Promise.resolve([]))
				.catch((): readonly OpenWithApplication[] => [])
				.then((applications) => setMenu({ items: openWithItems(applications), anchor }));
		} else onAction(target, anchor);
	}
	return {
		activate: (action, anchor) => {
			if (action.kind === "action") run(action.target, anchor);
			else setMenu({ items: action.items, anchor });
		},
		menu:
			menu === null ? null : (
				<ActionMenu
					items={menu.items}
					anchor={menu.anchor}
					onSelect={(target) => {
						const anchor = menu.anchor;
						setMenu(null);
						run(target, anchor);
					}}
					onClose={() => setMenu(null)}
				/>
			),
	};
}

interface GroupButton {
	readonly id: string;
	readonly label: string;
	readonly icon: ReactElement;
	readonly pressed?: boolean;
	readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/**
 * A single file's actions as one row of icon buttons: index, Trash, copy path, then what the file's type suggests
 * (open with, compress, extract, share, image edit, video conversion, reduce size). Each name shows as a tooltip on
 * hover and keyboard focus, and is the button's accessible name. Opening the file is a double click in the list,
 * and "AI 요약" sits with the chat composer, so neither is here.
 */
function FileActionGroup({
	entry,
	included,
	indexToggleable,
	folderInView,
	onToggleIndex,
	onTrash,
	onCopyPath,
	actions,
	onAction,
	loadOpenWithApplications,
}: {
	readonly entry: FinderEntry;
	readonly included: boolean;
	/** The index can take or drop this entry (a file, or a folder the index status says it can toggle). */
	readonly indexToggleable: boolean;
	readonly folderInView: boolean;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly actions: readonly FileAction[];
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly loadOpenWithApplications: () => Promise<readonly OpenWithApplication[]>;
}): ReactElement {
	const { t } = useTranslation();
	const runner = useActionRunner({ onAction, loadOpenWithApplications });
	const buttons: GroupButton[] = [];
	if (indexToggleable) {
		buttons.push({
			id: "index",
			label: included ? t("contextMenu.includeInIndex") : t("contextMenu.excludeFromIndex"),
			icon: <DatabaseIcon size={16} />,
			pressed: included,
			onClick: () => onToggleIndex(entry),
		});
	}
	if (!folderInView) buttons.push({ id: "trash", label: t("contextMenu.trashShort"), icon: <TrashIcon size={16} />, onClick: () => onTrash(entry) });
	buttons.push({ id: "copyPath", label: t("contextMenu.copyPath"), icon: <CopyIcon size={16} />, onClick: () => onCopyPath(entry) });
	for (const action of actions) {
		const Icon = ACTION_ICONS[action.icon];
		buttons.push({
			id: action.id,
			label: actionLabel(t, action.id, action.label),
			icon: <Icon size={16} />,
			onClick: (event) => runner.activate(action, anchorOf(event.currentTarget)),
		});
	}
	return <ActionIconGroup buttons={buttons} menu={runner.menu} />;
}

/** The action group's row of icon buttons with dividers; each name shows as a tooltip and is the accessible name. */
function ActionIconGroup({ buttons, menu }: { readonly buttons: readonly GroupButton[]; readonly menu: ReactElement | null }): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="inspector-file-actions flex">
			<div className="inline-flex max-w-full flex-wrap items-center gap-4 rounded-8 border border-divider bg-window px-4 py-2" role="toolbar" aria-label={t("inspector.fileActions")}>
				{buttons.map((button, index) => (
					<span key={button.id} className="flex items-center gap-4">
						{index === 0 ? null : <span className="block h-32 w-px bg-divider" aria-hidden="true" />}
						<button
							type="button"
							data-action={button.id}
							aria-label={button.label}
							aria-pressed={button.pressed}
							className={cn(
								"group relative flex h-32 w-28 items-center justify-center rounded-6 border-0 bg-transparent p-0 cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:bg-hover",
								button.pressed === true ? "text-accent-text" : "text-ink-body",
							)}
							onClick={button.onClick}
						>
							{button.icon}
							<span
								className="pointer-events-none absolute left-1/2 top-full z-20 mt-6 block -translate-x-1/2 whitespace-nowrap rounded-6 bg-ink px-7 py-3 text-badge font-medium leading-[14px] text-window opacity-0 transition-opacity duration-(--dur-color) group-hover:opacity-100 group-focus-visible:opacity-100"
								aria-hidden="true"
							>
								{button.label}
							</span>
						</button>
					</span>
				))}
			</div>
			{menu}
		</div>
	);
}

function InfoRow({ label, value, onCopy }: { readonly label: string; readonly value: string; readonly onCopy?: (() => void) | undefined }): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="flex justify-between gap-8 border-b-[0.7px] border-divider py-4 text-badge leading-[16px] last:border-b-0">
			<dt className="flex-none text-ink-muted">{label}</dt>
			{onCopy === undefined ? (
				<dd className="m-0 min-w-0 text-ink text-right [overflow-wrap:anywhere]">{value}</dd>
			) : (
				<dd className="m-0 min-w-0 text-right">
					<button
						type="button"
						className="m-0 max-w-full cursor-pointer border-0 bg-transparent p-0 text-right text-badge leading-[16px] text-ink [overflow-wrap:anywhere] hover:text-accent-text"
						title={t("inspector.clickToCopy")}
						onClick={onCopy}
					>
						{value}
					</button>
				</dd>
			)}
		</div>
	);
}

function VersionsSection({
	family,
	entry,
	onOpenMember,
}: {
	readonly family: InspectorFamily;
	readonly entry: FinderEntry;
	readonly onOpenMember: (path: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const rows = [
		{ path: family.headPath, name: family.headName, relation: "latest" as const, where: dirname(family.headPath) },
		...family.members.map((member) => ({ path: member.path, name: member.name, relation: member.relation, where: member.where })),
	];
	return (
		<div className="versions-section flex flex-col gap-8 border-t border-divider pt-8">
			<div className="section-title flex h-22 items-center justify-between">
				<span className="text-meta font-medium leading-[16px] text-ink">{t("inspector.versions")}</span>
				<span className="inline-flex items-center rounded-8 border border-divider bg-window px-6 py-1 text-badge font-medium leading-[14px] text-ink">{rows.length}</span>
			</div>
			<div className="flex flex-col gap-2">
				{rows.map((row) => (
					<button
						type="button"
						key={row.path}
						className={cn(
							"ver-row w-full min-h-39 flex items-center gap-8 px-7 py-5 rounded-8 border-0 bg-transparent text-left cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover",
							row.path === entry.path && "bg-input hover:bg-input",
						)}
						onClick={() => onOpenMember(row.path)}
					>
						<VersionTag relation={row.relation} />
						<span className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="ver-name truncate text-meta font-medium leading-[16px] text-ink">{row.name}</span>
							<span className="vwhere truncate text-badge font-medium leading-[14px] text-ink-faint">{row.where}</span>
						</span>
					</button>
				))}
			</div>
		</div>
	);
}

function VersionTag({ relation }: { readonly relation: "latest" | "exact" | "near" | "contains" }): ReactElement {
	const { t } = useTranslation();
	// The inspector's own tones (Figma 231:2588): the newest copy in the accent, a similar one in amber.
	const tone =
		relation === "latest"
			? "bg-accent-chip text-accent-text"
			: relation === "near"
				? "bg-vtag-similar-bg text-vtag-similar-text"
				: relation === "exact"
					? "bg-vtag-exact-bg text-vtag-exact-text"
					: "bg-input text-ink-muted";
	return (
		<span className={cn("vtag flex-none inline-flex items-center px-6 py-2 rounded-7 text-tile-xs font-bold whitespace-nowrap leading-[12px]", tone)}>
			{t(VERSION_TAG_KEYS[relation])}
		</span>
	);
}

/**
 * The whole inspector while an AI Search tab is focused: the cited sources of
 * that tab's answer. A local source's title reveals the file in the Finder; a
 * web source's title opens the page in the OS browser.
 */
function EvidencePanel({
	evidence,
	selected,
	onSelect,
	onReveal,
	onToast,
	imageActions,
	evidenceFolderCount,
	onOpenEvidenceFolder,
}: {
	readonly evidence: readonly CitationEvidence[];
	readonly selected: number;
	readonly onSelect: (n: number) => void;
	readonly onReveal: (path: string, excerpts?: readonly string[]) => void;
	readonly onToast: (msg: string) => void;
	readonly imageActions: ImageActions;
	readonly evidenceFolderCount: number;
	readonly onOpenEvidenceFolder?: (() => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const canOpenFolder = onOpenEvidenceFolder !== undefined && evidenceFolderCount > 0;
	const folderButton =
		onOpenEvidenceFolder === undefined ? null : (
			<button
				type="button"
				data-action="evidence-folder"
				disabled={!canOpenFolder}
				aria-label={t("inspector.evidencePanel.evidenceFolder")}
				title={t("inspector.evidencePanel.evidenceFolderTooltip")}
				className="evidence-folder-btn flex-none inline-flex items-center gap-5 h-22 px-8 rounded-6 border border-border bg-window text-badge font-semibold text-ink-body whitespace-nowrap cursor-pointer transition-[background,border-color,color] duration-(--dur-color) ease-[ease] enabled:hover:border-border-strong enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-45 disabled:cursor-default"
				onClick={onOpenEvidenceFolder}
			>
				<FolderGlyph size={13} />
				<span>{t("inspector.evidencePanel.evidenceFolder")}</span>
			</button>
		);
	// Only the selected number renders: falling back to `evidence[0]` here would
	// silently show unrelated evidence for a citation the run never produced.
	const item = evidence.find((entry) => entry.number === selected);
	if (item === undefined) {
		return (
			<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.evidence")}>
				{canOpenFolder ? (
					<div className="flex items-center justify-end px-16 pt-18">
						{folderButton}
					</div>
				) : null}
				<EmptyInspectorMark />
			</div>
		);
	}
	const source = item.source;
	const detail = evidenceDetail(item.confidence);
	const heading = evidenceHeading(item.title, item.source);
	const url = source === null ? null : evidenceSourceUrl(source);
	// A datasource virtual id is not a file or folder on disk; only a local
	// file previews in Quick Look and resolves relative image links.
	const local = isLocalEvidenceSource(source);
	const excerptImages = { folder: local ? dirname(source) : null, actions: imageActions };
	const sourceImage = local ? imageTarget(source, null) : null;
	return (
		<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.evidence")}>
			<div className="inspector-body flex-1 min-h-0 overflow-auto px-16 pt-18 pb-24">
				<div className="evidence-header flex items-center justify-between gap-8 mb-12">
					<div className="evidence-tabs flex min-w-0 flex-1 gap-3 overflow-auto">
						{evidence.map((entry) => (
							<button
								type="button"
								key={entry.number}
								className={cn(
									"evidence-tab flex-none inline-flex items-center justify-center size-22 rounded-6 border text-badge font-semibold cursor-pointer transition-[background,color,border-color] duration-(--dur-color) ease-[ease]",
									entry.number === item.number ? "bg-accent border-accent text-on-accent" : "bg-window border-border text-ink-muted hover:text-ink",
								)}
								onClick={() => onSelect(entry.number)}
							>
								{entry.number}
							</button>
						))}
					</div>
					{folderButton}
				</div>

				{sourceImage?.kind === "local" && sourceImage.renderable ? (
					<EvidenceImagePaper key={sourceImage.path} path={sourceImage.path} name={sourceImage.name} kind={evidenceKind(item.title)} onOpen={imageActions.onOpenImage} />
				) : (
					<div className="preview-paper flex-none h-152 flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised mb-14">
						{url === null ? <FileTile kind={evidenceKind(item.title)} large /> : <LinkIcon size={36} className="text-ink-muted" />}
					</div>
				)}
				{!local && url === null ? (
					<div className="preview-title text-body font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere]">
						{item.number}. {heading}
					</div>
				) : (
					<button
						type="button"
						className="preview-title text-left text-body font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere] cursor-pointer border-0 bg-transparent p-0 transition-colors duration-(--dur-color) ease-[ease] hover:text-accent-text"
						title={url === null ? t("inspector.evidencePanel.openPreview") : t("inspector.evidencePanel.openInBrowser")}
						onClick={() => onReveal(source!, local ? [...item.excerpts, ...(item.summary.length > 0 ? [item.summary] : [])] : undefined)}
					>
						{item.number}. {heading}
					</button>
				)}
				{url === null ? null : (
					<div className="evidence-url mt-4 text-badge text-accent-text truncate" title={url}>
						{url}
					</div>
				)}
				{detail === null ? null : <div className="preview-sub mt-4 text-badge text-ink-muted">{detail}</div>}

				<div className="text-badge font-semibold text-ink-muted">{t("inspector.evidencePanel.excerpts")}</div>
				<div className="flex flex-col gap-8 mt-4">
					{item.summary.length === 0 ? null : (
						<InlineWithImages
							text={item.summary}
							images={excerptImages}
							className="evidence__block evidence__block--paragraph text-caption leading-read text-ink-body text-pretty [&_strong]:text-ink [&_strong]:font-semibold"
						/>
					)}
					{item.excerpts.map((excerpt, index) => (
						<EvidenceExcerpt key={`${index}`} text={excerpt} images={excerptImages} />
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * An image evidence source shows the picture itself in the paper (streamed
 * through the preview protocol); clicking it opens Quick Look. A file that
 * cannot be read falls back to the kind tile.
 */
function EvidenceImagePaper({
	path,
	name,
	kind,
	onOpen,
}: {
	readonly path: string;
	readonly name: string;
	readonly kind: FileKind;
	readonly onOpen: ImageActions["onOpenImage"];
}): ReactElement {
	const { t } = useTranslation();
	const [failed, setFailed] = useState(false);
	if (failed) {
		return (
			<div className="preview-paper flex-none h-152 flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised mb-14">
				<FileTile kind={kind} large />
			</div>
		);
	}
	return (
		<button
			type="button"
			data-image-path={path}
			aria-label={t("finderComponents.quickLookLabel", { name })}
			className="preview-paper flex-none flex w-full items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised mb-14 p-0 cursor-zoom-in max-h-[50vh]"
			onClick={() => onOpen({ path, name })}
		>
			<img className="block max-w-full max-h-[50vh] object-contain" src={previewStreamUrl(path)} alt="" decoding="async" draggable={false} onError={() => setFailed(true)} />
		</button>
	);
}
