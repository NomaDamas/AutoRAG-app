/**
 * Inspector — the right column (v7 Bloom). One full-height view at a time,
 * chosen by the focused tab (a folder tab shows Info, an AI Search tab Evidence):
 *
 *   Info     preview paper, name, kind·size·date, index/trash/copy chips, the
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
import type { ActionAnchor, ActionCapabilities, OpenWithApplication } from "../../../shared/actions-contract";
import type { AutomationRule } from "../../../shared/automation-contract";
import type { FsFileDetails } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import type { CitationEvidence } from "../../../shared/search-contract";
import { type FinderEntry, hasFileVersion } from "../data/entries";
import { cn } from "../lib/cn";
import { anchorOf } from "../lib/anchor";
import { rulesWatching } from "../state/automations";
import { dateLabelOf, fileKindOf, kindLabelOf, sizeLabelOf } from "../state/entry-values";
import { buildInfoRows, hasMoreInfoRows, visibleInfoRows } from "../state/inspector-info";
import { stackCards, summarizeSelection } from "../state/inspector-multi";
import { evidenceDetail, evidenceHeading, evidenceKind, evidenceSourceUrl, isLocalEvidenceSource } from "../state/evidence";
import {
	openWithItems,
	suggestedActions,
	type FileActionIcon,
	type FileActionItem,
	type FileActionTarget,
} from "../state/file-actions";
import { basename, dirname } from "../state/paths";
import { VERSION_TAG_KEYS } from "../state/version-family";
import { imageTarget } from "../state/answer-markdown";
import type { FileKind } from "../state/kinds";
import type { ImageActions } from "./AnswerImage";
import { AutomationRulesSection } from "./AutomationRulesSection";
import { EvidenceExcerpt, InlineWithImages } from "./EvidenceBlocks";
import {
	CheckIcon,
	CloseIcon,
	CompressIcon,
	CopyIcon,
	ExtractIcon,
	EyeIcon,
	FolderGlyph,
	ImageEditIcon,
	LinkIcon,
	OpenIcon,
	OpenWithIcon,
	ShareIcon,
	SparklesIcon,
	TrashIcon,
	VideoConvertIcon,
} from "./icons";
import { ActionMenu } from "./primitives/ActionMenu";
import { FileTile } from "./primitives/FileTile";

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
}

const HEAD_BUTTON =
	"flex flex-none items-center justify-center size-icon-sm p-0 border-0 rounded-6 bg-transparent text-ink-muted cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] enabled:hover:bg-hover-icon enabled:hover:text-ink disabled:text-border-strong disabled:cursor-default disabled:hover:bg-transparent";

/** Inspector action glyphs, 18px in the bar and 16px in the head. */
const ACTION_ICONS: Readonly<Record<FileActionIcon, (props: { readonly size?: number }) => ReactElement>> = {
	open: OpenIcon,
	openWith: OpenWithIcon,
	compress: CompressIcon,
	extract: ExtractIcon,
	share: ShareIcon,
	askAi: SparklesIcon,
	image: ImageEditIcon,
	video: VideoConvertIcon,
};

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
}: InspectorProps): ReactElement {
	const { t } = useTranslation();
	return (
		<aside
			className="inspector w-full min-w-0 h-full flex flex-col bg-subtle border-l border-border overflow-hidden"
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
			) : entries.length > 1 ? (
				<MultiInfoHalf entries={entries} focusPath={entry?.path ?? null} />
			) : (
				<InfoHalf
					entry={entry}
					indexStatus={indexStatus}
					family={family}
					onOpenMember={onOpenMember}
					onToggleIndex={onToggleIndex}
					onTrash={onTrash}
					onCopyPath={onCopyPath}
					onAskAi={onAskAi}
					actionCapabilities={actionCapabilities}
					onAction={onAction}
					loadOpenWithApplications={loadOpenWithApplications}
					automations={automations}
					folderInView={folderInView}
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
	onAskAi,
	actionCapabilities,
	onAction,
	loadOpenWithApplications,
	automations,
	folderInView,
}: {
	readonly entry: FinderEntry | null;
	readonly indexStatus: IndexStatus | null;
	readonly family: InspectorFamily | null;
	readonly onOpenMember: (path: string) => void;
	readonly onToggleIndex: (entry: FinderEntry) => void;
	readonly onTrash: (entry: FinderEntry) => void;
	readonly onCopyPath: (entry: FinderEntry) => void;
	readonly onAskAi: (entry: FinderEntry) => void;
	readonly actionCapabilities: ActionCapabilities;
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly loadOpenWithApplications: (entry: FinderEntry) => Promise<readonly OpenWithApplication[]>;
	readonly automations?: InspectorProps["automations"];
	readonly folderInView: boolean;
}): ReactElement {
	const [brief, setBrief] = useState(false);
	const [details, setDetails] = useState<FsFileDetails | null>(null);
	const focusedPath = entry?.path ?? null;
	// Rich metadata is per-file and read on focus; a stale answer for a path the
	// user already left must not overwrite the current one.
	useEffect(() => {
		setDetails(null);
		setBrief(false);
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
	}, [focusedPath]);
	const { t } = useTranslation();
	const included = indexStatus === null || !indexStatus.excluded;
	const infoRows = entry === null ? [] : buildInfoRows(details, entry);
	const shownRows = visibleInfoRows(infoRows, brief);
	const generalRows = shownRows.filter((row) => row.section === "general");
	const imageRows = shownRows.filter((row) => row.section === "image");
	const moreInfo = hasMoreInfoRows(infoRows);

	return (
		<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.title")}>

			{entry === null ? (
				<div className="flex-1 flex items-center justify-center px-10 text-center text-sm text-ink-muted leading-body whitespace-pre-line">
					{t("inspector.evidencePanel.emptyTitle")}
				</div>
			) : (
				<div className="inspector-body flex-1 min-h-0 overflow-auto px-16 pt-18 pb-24">
					<PreviewPaper entry={entry} />
					<div className="preview-title text-body font-semibold text-ink leading-[1.3] [overflow-wrap:anywhere]">{entry.name}</div>
					<div className="preview-sub mt-4 text-meta text-ink-muted">
						{folderInView ? kindLabelOf(entry) : `${kindLabelOf(entry)} · ${sizeLabelOf(entry)} · ${dateLabelOf(entry)}`}
					</div>

					<div className="chip-row flex flex-wrap gap-6 mt-12 mb-16">
						{entry.kind === "file" ? (
							<Chip onClick={() => onToggleIndex(entry)}>
								<CheckIcon size={12} />
								{included ? t("contextMenu.includeInIndex") : t("contextMenu.excludeFromIndex")}
							</Chip>
						) : null}
						{folderInView ? null : (
							<Chip onClick={() => onTrash(entry)}>
								<TrashIcon size={12} />{t("contextMenu.trashShort")}
							</Chip>
						)}
						<Chip onClick={() => onCopyPath(entry)}>
							<CopyIcon size={12} />{t("contextMenu.copyPath")}
						</Chip>
					</div>

					{entry.kind === "folder" && automations !== undefined ? (
						<AutomationRulesSection
							rules={rulesWatching(automations.rules, entry.path)}
							onEdit={automations.onEdit}
							onDelete={automations.onDelete}
							onMenu={automations.onMenu}
						/>
					) : null}

					{family === null ? null : <VersionsSection family={family} entry={entry} onOpenMember={onOpenMember} />}

					<div className="info-section border-t border-border pt-12 mt-12">
						<div className="section-title flex items-center justify-between mb-6">
							<span className="text-meta font-semibold text-ink">{t("inspector.generalInfo")}</span>
							{moreInfo ? (
								<button
									type="button"
									className="p-0 border-0 bg-transparent text-accent-text text-badge cursor-pointer"
									onClick={() => setBrief((current) => !current)}
								>
									{brief ? t("inspector.showMore") : t("inspector.showLess")}
								</button>
							) : null}
						</div>
						<dl className="m-0">
							{generalRows.map((row) => (
								<InfoRow key={row.label} label={row.label} value={row.value} />
							))}
						</dl>
					</div>

					{imageRows.length === 0 ? null : (
						<div className="info-section border-t border-border pt-12 mt-12">
							<div className="section-title mb-6">
								<span className="text-meta font-semibold text-ink">{t("inspector.imageInfo")}</span>
							</div>
							<dl className="m-0">
								{imageRows.map((row) => (
									<InfoRow key={row.label} label={row.label} value={row.value} />
								))}
							</dl>
						</div>
					)}
				</div>
			)}

			{entry === null ? null : (
				<ActionBar entry={entry} capabilities={actionCapabilities} onAction={onAction} onAskAi={onAskAi} loadOpenWithApplications={loadOpenWithApplications} />
			)}
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
		// The OS thumbnailers draw nothing for HWP without Hancom's plug-in; rhwp draws the first page here.
		// Windows has no PDF thumbnailer either: when the OS answers nothing, pdf.js draws page one.
		const hwp = /\.hwpx?$/i.test(path);
		const osPreview = window.autorag?.fs?.previewIcon;
		const load =
			hwp
				? hwpFirstPageUrl
				: osPreview !== undefined && /\.pdf$/i.test(path)
					? async (file: string, version: number): Promise<string | null> => (await osPreview(file, version)) ?? (await firstPageTile(file, version, PREVIEW_PAPER_WIDTH))
					: osPreview;
		if (load === undefined) return;
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
	if (entry.kind !== "file" || (state.resolved && state.url === null)) {
		return (
			<div className="preview-paper flex-none flex items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-raised h-152 mb-14">
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
			className="preview-paper relative flex-none w-full overflow-hidden rounded-6 border border-border bg-window shadow-raised transition-[aspect-ratio] duration-200 ease-out mb-14 max-h-[70vh]"
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
 * The fan's poses, front card first: each deeper paper rotates a little wider
 * and steps a little further out and down, so a five-file selection still
 * reads as five distinct sheets (the Finder multi-preview reference).
 */
const STACK_POSES: readonly string[] = [
	"z-30 -rotate-[1.5deg]",
	"z-20 translate-x-[16%] translate-y-[3%] rotate-[7deg] scale-[0.96]",
	"z-10 -translate-x-[17%] translate-y-[4%] -rotate-[8.5deg] scale-[0.96]",
	"z-[5] translate-x-[23%] translate-y-[6%] rotate-[14deg] scale-[0.92]",
	"z-0 -translate-x-[24%] translate-y-[7%] -rotate-[15deg] scale-[0.92]",
];

/**
 * The aggregate Info half for a multi-selection: a fan of the selection's own
 * previews (focused file in front), the count title, the per-kind breakdown
 * with the total size, and the created/modified date ranges. Per-file actions
 * (index chip, versions, the action bar) are single-selection concerns and
 * stay out.
 */
function MultiInfoHalf({
	entries,
	focusPath,
}: {
	readonly entries: readonly FinderEntry[];
	readonly focusPath: string | null;
}): ReactElement {
	const { t } = useTranslation();
	const summary = summarizeSelection(entries);
	const cards = stackCards(entries, focusPath);
	// DOM order paints back-to-front so the focused paper lands on top.
	const staged = [...cards].reverse();
	return (
		<div className="inspector-half flex-1 min-h-0 flex flex-col overflow-hidden relative" aria-label={t("inspector.title")}>
			<div className="inspector-body flex-1 min-h-0 overflow-auto px-16 pt-18 pb-24">
				<div className="preview-stack relative flex-none flex items-center justify-center h-240 mb-14">
					{staged.map((card, index) => {
						const depth = staged.length - 1 - index;
						const pose = STACK_POSES[Math.min(depth, STACK_POSES.length - 1)] ?? "";
						return (
							<div
								key={card.path}
								className={cn(
									"preview-stack-card absolute flex h-[84%] aspect-[3/4] items-center justify-center overflow-hidden rounded-6 border border-border bg-window shadow-drag",
									pose,
								)}
							>
								<PreviewCardImage entry={card} />
								{/* Dog-eared top-right corner: the folded triangle, its own soft shadow onto the sheet. */}
								<div
									aria-hidden="true"
									className="page-curl pointer-events-none absolute top-0 right-0 size-24 bg-[linear-gradient(225deg,rgba(20,20,40,0.16)_0%,rgba(20,20,40,0.04)_42%,var(--bg-window)_78%)] [clip-path:polygon(0_0,100%_0,100%_100%)] drop-shadow-[-1px_2px_2px_rgba(20,20,40,0.20)]"
								/>
							</div>
						);
					})}
				</div>
				<div className="preview-title text-body font-semibold text-ink leading-[1.3]">{summary.title}</div>
				<div className="preview-sub mt-4 text-meta text-ink-muted">
					{summary.kindSummary}
					{summary.sizeLabel === null ? "" : ` · ${summary.sizeLabel}`}
				</div>
				<div className="info-section border-t border-border pt-12 mt-12">
					<div className="section-title mb-6">
						<span className="text-meta font-semibold text-ink">{t("inspector.generalInfo")}</span>
					</div>
					<dl className="m-0">
						{summary.sizeLabel === null ? null : <InfoRow label={t("inspector.totalSize")} value={summary.sizeLabel} />}
						{summary.createdRange === null ? null : <InfoRow label={t("inspector.labels.dateCreated")} value={summary.createdRange} />}
						{summary.modifiedRange === null ? null : <InfoRow label={t("inspector.labels.dateModified")} value={summary.modifiedRange} />}
					</dl>
				</div>
			</div>
		</div>
	);
}

/**
 * The bottom action bar: every action the focused file's type suggests, in
 * priority order. A `menu` action (`이미지 편집`, `동영상 변환`) opens its
 * variants anchored to its button; a flat action runs at once.
 */
function ActionBar({
	entry,
	capabilities,
	onAction,
	onAskAi,
	loadOpenWithApplications,
}: {
	readonly entry: FinderEntry;
	readonly capabilities: ActionCapabilities;
	readonly onAction: (target: FileActionTarget, anchor: ActionAnchor | null) => void;
	readonly onAskAi: (entry: FinderEntry) => void;
	readonly loadOpenWithApplications: (entry: FinderEntry) => Promise<readonly OpenWithApplication[]>;
}): ReactElement {
	const { t } = useTranslation();
	const actions = suggestedActions(entry, capabilities);
	const [menu, setMenu] = useState<{ readonly items: readonly FileActionItem[]; readonly anchor: ActionAnchor } | null>(null);
	function run(target: FileActionTarget, anchor: ActionAnchor): void {
		// "AI 요약" is the App shell's concern (it owns the composer), not IPC.
		if (target.kind === "askAi") onAskAi(entry);
		else if (target.kind === "openWith") {
			// The OS's handlers for this file's type come first; "기타…" opens the full chooser.
			// A failed lookup still leaves "기타…" reachable.
			loadOpenWithApplications(entry)
				.catch((): readonly OpenWithApplication[] => [])
				.then((applications) => setMenu({ items: openWithItems(applications), anchor }));
		} else onAction(target, anchor);
	}

	return (
		<div className="inspector-actions flex-none border-t border-border bg-chrome px-10 pt-10 pb-12">
			<div className="grid grid-cols-4 gap-2 max-h-[45vh] overflow-y-auto">
				{actions.map((action) => {
					const Icon = ACTION_ICONS[action.icon];
					const localizedLabel = (id: string, def: string): string => {
						switch (id) {
							case "open": return t("inspector.actions.open", def);
							case "openWith": return t("inspector.actions.openWith", def);
							case "compress": return t("inspector.actions.compress", def);
							case "compress7z": return t("inspector.actions.compress7z", def);
							case "extract": return t("inspector.actions.extract", def);
							case "share": return t("inspector.actions.share", def);
							case "askAi": return t("inspector.actions.askAi", def);
							case "imageEdit": return t("inspector.actions.imageEdit", def);
							case "videoConvert": return t("inspector.actions.videoConvert", def);
							default: return def;
						}
					};
					return (
						<ActionButton
							key={action.id}
							actionId={action.id}
							icon={<Icon size={18} />}
							label={localizedLabel(action.id, action.label)}
							onClick={(event) => {
								const anchor = anchorOf(event.currentTarget);
								if (action.kind === "action") run(action.target, anchor);
								else setMenu({ items: action.items, anchor });
							}}
						/>
					);
				})}
			</div>
			{menu === null ? null : (
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
			)}
		</div>
	);
}

function Chip({ children, onClick }: { readonly children: ReactNode; readonly onClick: () => void }): ReactElement {
	return (
		<button
			type="button"
			className="inline-flex items-center gap-4 h-pill px-8 rounded-full border border-border bg-window text-badge font-semibold text-ink-body whitespace-nowrap cursor-pointer transition-[border-color] duration-(--dur-color) ease-[ease] hover:border-border-strong"
			onClick={onClick}
		>
			{children}
		</button>
	);
}

function InfoRow({ label, value }: { readonly label: string; readonly value: string }): ReactElement {
	return (
		<div className="flex justify-between gap-8 py-3 text-meta">
			<dt className="flex-none text-ink-muted">{label}</dt>
			<dd className="m-0 min-w-0 text-ink text-right [overflow-wrap:anywhere]">{value}</dd>
		</div>
	);
}

function ActionButton({
	icon,
	label,
	actionId,
	onClick,
}: {
	readonly icon: ReactElement;
	readonly label: string;
	readonly actionId?: string;
	readonly onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): ReactElement {
	return (
		<button
			type="button"
			data-action={actionId}
			className="inspector-action min-w-0 flex flex-col items-center gap-6 px-2 py-6 rounded-8 border-0 bg-transparent text-ink-muted text-tile leading-[1.25] text-center cursor-pointer transition-[background,color] duration-(--dur-color) ease-[ease] hover:bg-hover hover:text-ink"
			onClick={onClick}
		>
			{icon}
			<span className="max-w-full [word-break:keep-all]">{label}</span>
		</button>
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
		<div className="info-section border-t border-border pt-12 mt-12">
			<div className="section-title flex items-center justify-between mb-6">
				<span className="text-meta font-semibold text-ink">{t("inspector.versions")}</span>
				<span className="inline-flex items-center h-[19px] px-6 rounded-full bg-input text-tile font-semibold text-ink-body">{rows.length}</span>
			</div>
			<div className="flex flex-col">
				{rows.map((row) => (
					<button
						type="button"
						key={row.path}
						className={cn(
							"ver-row w-full min-h-26 flex items-center gap-7 px-5 py-3 rounded-5 border-0 bg-transparent text-left text-badge text-ink-body cursor-pointer transition-[background] duration-(--dur-color) ease-[ease] hover:bg-hover",
							row.path === entry.path && "bg-accent-wash",
						)}
						onClick={() => onOpenMember(row.path)}
					>
						<VersionTag relation={row.relation} />
						<span className="ver-name flex-1 min-w-0 truncate">{row.name}</span>
						<span className="vwhere flex-none max-w-[40%] truncate text-tile text-ink-muted">{basename(row.where)}</span>
					</button>
				))}
			</div>
		</div>
	);
}

function VersionTag({ relation }: { readonly relation: "latest" | "exact" | "near" | "contains" }): ReactElement {
	const { t } = useTranslation();
	const tone =
		relation === "latest"
			? "bg-vtag-latest-bg text-vtag-latest-text"
			: relation === "near"
				? "bg-vtag-near-bg text-vtag-near-text"
				: relation === "exact"
					? "bg-vtag-exact-bg text-vtag-exact-text"
					: "bg-input text-ink-muted";
	return (
		<span className={cn("vtag flex-none inline-flex items-center h-16 px-6 rounded-4 text-tile font-semibold whitespace-nowrap leading-none", tone)}>
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
				<div className="flex-1 flex items-center justify-center px-10 text-center text-sm text-ink-muted leading-body whitespace-pre-line">
					{t("inspector.evidencePanel.emptyTitle")}
				</div>
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
