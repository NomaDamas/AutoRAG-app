/**
 * The phone shell's sheets: 정보 (the desktop inspector's info half as a
 * bottom sheet), the folder picker for 이동 / 복사, the evidence sheet for an
 * AI answer, and the activity queue. Each reads the same state the desktop
 * panel does and only lays it out for a phone.
 */

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Download, Eye, FolderInput, FolderPlus, Sparkles } from "lucide-react";
import type { AutomationRule } from "../../../shared/automation-contract";
import type { FsFileDetails } from "../../../shared/fs-contract";
import type { IndexStatus } from "../../../shared/index-contract";
import type { CitationEvidence } from "../../../shared/search-contract";
import type { ImageActions } from "../components/AnswerImage";
import { EvidencePanel } from "../components/Inspector";
import type { FinderEntry } from "../data/entries";
import type { FinderSource } from "../data/source";
import { cn } from "../lib/cn";
import { ruleTitle, whenText } from "../state/automations";
import { buildInfoRows } from "../state/inspector-info";
import { basename } from "../state/paths";
import type { SidebarActivityEntry } from "../state/sidebar-activity-queue";
import { tagDotsOf, type TagColors } from "../state/tags";
import type { VersionFamilyView } from "../state/version-family";
import { ancestorPaths, previewKind } from "./model";
import { Crumbs, Sheet } from "./overlays";
import { Cell, FolderGlyph, ProgressRing, Section, Switch, Thumb } from "./parts";
import { tagCss } from "./screens";

/* ------------------------------------------------------------------ Info -- */

export function InfoSheet({ entry, details, status, family, rules, tagColors, previewUrl, onClose, onQuickLook, onDownload, onAsk, onMove, onToggleIndex, onOpenMember, onOpenRule }: {
	readonly entry: FinderEntry;
	readonly details: FsFileDetails | null;
	readonly status: IndexStatus | undefined;
	readonly family: VersionFamilyView | null;
	readonly rules: readonly AutomationRule[];
	readonly tagColors: TagColors;
	readonly previewUrl: string | null;
	readonly onClose: () => void;
	readonly onQuickLook: () => void;
	readonly onDownload: () => void;
	readonly onAsk: () => void;
	readonly onMove: () => void;
	readonly onToggleIndex: (included: boolean) => void;
	readonly onOpenMember: (path: string) => void;
	readonly onOpenRule: (rule: AutomationRule) => void;
}): ReactElement {
	const { t } = useTranslation();
	const folder = entry.kind === "folder";
	const rows = buildInfoRows(details, entry);
	const dots = tagDotsOf(entry.finder, tagColors);
	const included = status?.kind === "included" || status?.kind === "pending" ? !status.excluded : false;
	const toggleable = status?.toggleable === true;
	const subtitle = rows.find((row) => row.label === t("inspector.labels.kind"))?.value;
	return (
		<Sheet title={t("mobile.info.title")} closeLabel={t("common.close")} onClose={onClose} medium testId="phone-info">
			<div className="phone-info-head">
				<Thumb entry={entry} previewUrl={previewUrl} large />
				<div>
					<b className="phone-selectable">{entry.name}</b>
					{subtitle === undefined ? null : <small>{subtitle}</small>}
				</div>
			</div>
			<div className="phone-quick">
				{folder ? null : previewKind(entry) === null ? (
					<button type="button" onClick={onDownload}><Download size={22} strokeWidth={2} />{t("mobile.info.download")}</button>
				) : (
					<button type="button" onClick={onQuickLook}><Eye size={22} strokeWidth={2} />{t("mobile.info.quickLook")}</button>
				)}
				<button type="button" className="is-ai" onClick={onAsk}><Sparkles size={22} strokeWidth={2} />{folder ? t("mobile.info.askFolder") : t("mobile.info.ask")}</button>
				<button type="button" onClick={onMove}><FolderInput size={22} strokeWidth={2} />{t("mobile.info.move")}</button>
				{folder ? null : <button type="button" onClick={onDownload}><Download size={22} strokeWidth={2} />{t("mobile.info.download")}</button>}
			</div>
			{status === undefined || status.kind === "outside" ? null : (
				<Section foot={toggleable ? undefined : t("mobile.info.indexLocked")}>
					<Cell
						icon={<Sparkles size={20} strokeWidth={2.1} />}
						title={t("mobile.info.indexed")}
						subtitle={included ? t("mobile.info.indexedOn") : t("mobile.info.indexedOff")}
						tail={<Switch checked={included} label={t("mobile.info.indexed")} disabled={!toggleable} onChange={onToggleIndex} />}
					/>
				</Section>
			)}
			<Section>
				{rows.filter((row) => row.core).map((row) => (
					<div key={row.label} className="phone-kv"><span>{row.label}</span><b className="phone-selectable">{row.value}</b></div>
				))}
				<div className="phone-kv">
					<span>{t("mobile.info.tags")}</span>
					<b>{dots.length === 0 ? t("mobile.info.noTags") : dots.map((dot) => <span key={dot.name} style={{ display: "inline-flex", alignItems: "center", gap: 5, marginLeft: 8 }}><span className="phone-tagdot" style={{ background: tagCss(dot.color) }} />{dot.name}</span>)}</b>
				</div>
			</Section>
			{family === null ? null : (
				<Section title={t("mobile.info.versions")} foot={t("mobile.info.versionsFoot")}>
					<Cell title={family.headName} subtitle={t("mobile.info.latest")} onClick={() => onOpenMember(family.headPath)} />
					{family.members.filter((member) => member.path !== family.headPath).map((member) => (
						<Cell
							key={member.path}
							title={member.name}
							subtitle={member.where}
							tail={<span className={cn("phone-vtag", member.relation === "near" && "is-near")}>{member.relation === "exact" ? t("mobile.info.exact") : t("mobile.info.near")}</span>}
							onClick={() => onOpenMember(member.path)}
						/>
					))}
				</Section>
			)}
			{!folder || rules.length === 0 ? null : (
				<Section title={t("mobile.info.folderRules")}>
					{rules.map((rule) => (
						<Cell key={rule.id} title={ruleTitle(rule)} subtitle={whenText(rule)} onClick={() => onOpenRule(rule)} />
					))}
				</Section>
			)}
			{rows.some((row) => !row.core) ? (
				<Section>
					{rows.filter((row) => !row.core).map((row) => (
						<div key={row.label} className="phone-kv"><span>{row.label}</span><b className="phone-selectable">{row.value}</b></div>
					))}
				</Section>
			) : null}
		</Sheet>
	);
}

/* ---------------------------------------------------------------- Picker -- */

export interface PickerRoot {
	readonly path: string;
	readonly label: string;
}

/**
 * Choose a destination folder: start at the source's folder, walk down by tap
 * and up by the breadcrumbs, or jump to a place. ＋ makes a folder here.
 */
export function FolderPicker({ source, roots, start, verb, count, onClose, onPick, onError }: {
	readonly source: FinderSource;
	readonly roots: readonly PickerRoot[];
	readonly start: string | null;
	readonly verb: "move" | "copy";
	readonly count: number;
	readonly onClose: () => void;
	readonly onPick: (folder: string) => void;
	readonly onError: (message: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [path, setPath] = useState<string | null>(start);
	const [folders, setFolders] = useState<readonly FinderEntry[] | null>(null);
	const [tick, setTick] = useState(0);
	useEffect(() => {
		if (path === null) return;
		let live = true;
		setFolders(null);
		source.list(path).then(
			(entries) => {
				if (live) setFolders(entries.filter((entry) => entry.kind === "folder" && !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
			},
			(cause: unknown) => {
				if (live) setFolders([]);
				onError(cause instanceof Error ? cause.message : String(cause));
			},
		);
		return () => {
			live = false;
		};
	}, [onError, path, source, tick]);
	const trail = useMemo(() => (path === null ? [] : [...ancestorPaths(path), path].map((item) => ({ path: item, label: roots.find((root) => root.path === item)?.label ?? (basename(item) || item) }))), [path, roots]);
	const name = path === null ? "" : (trail.at(-1)?.label ?? path);
	return (
		<Sheet
			title={verb === "move" ? t("mobile.picker.move", { count }) : t("mobile.picker.copy", { count })}
			subtitle={t("mobile.picker.subtitle")}
			closeLabel={t("common.cancel")}
			onClose={onClose}
			solid
			full
			testId="phone-picker"
			right={
				<button
					type="button"
					className="phone-gbtn phone-glass"
					aria-label={t("mobile.newFolder.title")}
					disabled={path === null}
					onClick={() => {
						if (path === null) return;
						source.createFolder(path).then(() => setTick((value) => value + 1), (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
					}}
				>
					<FolderPlus size={20} strokeWidth={2.1} />
				</button>
			}
			foot={
				<div className="phone-sheet-foot">
					<button type="button" className="is-main" disabled={path === null} onClick={() => path !== null && onPick(path)}>
						{path === null ? t("mobile.picker.choose") : verb === "move" ? t("mobile.picker.moveHere", { folder: name }) : t("mobile.picker.copyHere", { folder: name })}
					</button>
				</div>
			}
		>
			<Crumbs trail={trail} onPick={setPath} homeLabel={t("mobile.picker.places")} />
			{path === null ? (
				<Section title={t("mobile.picker.places")}>
					{roots.map((root) => <Cell key={root.path} icon={<FolderGlyph size={26} />} title={root.label} onClick={() => setPath(root.path)} />)}
				</Section>
			) : folders === null ? (
				<div className="phone-empty">{t("mobile.loading")}</div>
			) : folders.length === 0 ? (
				<div className="phone-empty">{t("mobile.picker.noSubfolders")}</div>
			) : (
				<Section>
					{folders.map((folder) => <Cell key={folder.path} icon={<FolderGlyph size={26} />} title={folder.name} onClick={() => setPath(folder.path)} testId="phone-picker-folder" />)}
				</Section>
			)}
		</Sheet>
	);
}

/* -------------------------------------------------------------- Evidence -- */

export function EvidenceSheet({ evidence, selected, onSelect, onReveal, onToast, imageActions, onClose }: {
	readonly evidence: readonly CitationEvidence[];
	readonly selected: number;
	readonly onSelect: (number: number) => void;
	readonly onReveal: (path: string, excerpts?: readonly string[]) => void;
	readonly onToast: (message: string) => void;
	readonly imageActions: ImageActions;
	readonly onClose: () => void;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<Sheet title={t("inspector.evidence")} closeLabel={t("common.close")} onClose={onClose} medium testId="phone-evidence">
			<div className="phone-hosted-evidence inspector">
				<EvidencePanel evidence={evidence} selected={selected} onSelect={onSelect} onReveal={onReveal} onToast={onToast} imageActions={imageActions} evidenceFolderCount={0} />
			</div>
		</Sheet>
	);
}

/* -------------------------------------------------------------- Activity -- */

export function ActivitySheet({ entries, onClose }: { readonly entries: readonly SidebarActivityEntry[]; readonly onClose: () => void }): ReactElement {
	const { t } = useTranslation();
	return (
		<Sheet title={t("mobile.activity.title")} subtitle={t("mobile.activity.count", { count: entries.length })} closeLabel={t("common.close")} onClose={onClose} medium testId="phone-activity">
			{entries.length === 0 ? (
				<div className="phone-empty">{t("mobile.activity.empty")}</div>
			) : (
				<Section>
					{entries.map((entry) => (
						<Cell
							key={entry.id}
							icon={<ProgressRing percent={entry.tone === "queued" ? 0 : entry.percent} tone={entry.tone === "error" ? "error" : undefined}>{entry.sparkle === true ? <Sparkles size={13} strokeWidth={2.4} /> : <Copy size={12} strokeWidth={2.4} />}</ProgressRing>}
							title={entry.headline}
							subtitle={entry.title}
							onClick={entry.onSelect === undefined ? undefined : () => { onClose(); entry.onSelect?.(); }}
						/>
					))}
				</Section>
			)}
		</Sheet>
	);
}
