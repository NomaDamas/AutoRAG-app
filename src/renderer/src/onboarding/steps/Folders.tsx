/** Step 4 — index scope: pick folders, watch the pre-scan totals. */

import type { ReactElement } from "react";
import type { FolderCandidate, FolderKind } from "../../../../shared/onboarding-contract";
import type { SmartExclusion } from "../../../../shared/smart-indexing-contract";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline } from "../parts";
import { etaMinutes, formatSize } from "../flow";
import { excludedTotals, visibleScope } from "../smart-scope";
import type { OnboardingCtx } from "../context";

function folderIcon(kind: FolderKind): string {
	switch (kind) {
		case "desktop":
			return "monitor";
		case "documents":
			return "file-text";
		case "icloud":
		case "cloud":
			return "cloud";
		case "downloads":
			return "download";
		case "pictures":
			return "image";
		case "custom":
			return "folder";
	}
}

export function FoldersStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, candidates, draft, scans } = ctx;

	const selectedPaths = new Set(draft.folders.filter((f) => f.selected).map((f) => f.path));
	const allSelected = candidates.length > 0 && candidates.every((c) => selectedPaths.has(c.path));

	let files = 0;
	let bytes = 0;
	for (const path of selectedPaths) {
		const scan = scans.get(path);
		if (scan !== undefined) {
			files += scan.files;
			bytes += scan.bytes;
		}
	}
	const selectedList = [...selectedPaths];
	const smartItems = visibleScope(draft.smartScope, selectedList);
	const smartTotals = excludedTotals(draft.smartScope, selectedList);
	files = Math.max(0, files - smartTotals.files);
	bytes = Math.max(0, bytes - smartTotals.bytes);
	const localEta = etaMinutes(files, "local");
	const cloudEta = etaMinutes(files, "cloud");
	const running = ctx.smartRun.status === "running";
	const analyzed = draft.smartScope !== undefined;

	const pill = (item: SmartExclusion): ReactElement => {
		const root = candidates.find((candidate) => candidate.path === item.root)?.name ?? item.root.split(/[\\/]/u).filter(Boolean).pop() ?? item.root;
		const inside = item.path.slice(item.root.length).replace(/^[\\/]+/u, "");
		return (
			<button
				key={item.path}
				type="button"
				className={cn("si-pill", item.excluded ? "red" : "blue")}
				aria-pressed={item.excluded}
				title={`${item.reason}\n${item.excluded ? t("onboarding.folders.smart.excludeHint") : t("onboarding.folders.smart.includeHint")}`}
				onClick={() => ctx.setSmartExcluded(item.path, !item.excluded)}
			>
				<span className="si-pill-ico">
					<Icon name={item.excluded ? "eye-off" : "check"} size={11} />
				</span>
				<span className="si-pill-label">
					<em>{root} /</em> {inside}
				</span>
				<span className="si-pill-size">
					{item.files.toLocaleString()} · {formatSize(item.bytes)}
				</span>
			</button>
		);
	};

	const card = (candidate: FolderCandidate): ReactElement => {
		const selected = selectedPaths.has(candidate.path);
		const scan = scans.get(candidate.path);
		let stats: string;
		if (scan === undefined) {
			stats = t("onboarding.folders.scanning");
		} else if (scan.error !== null) {
			stats = t("onboarding.folders.scanError");
		} else {
			stats = t("onboarding.folders.stats", {
				files: scan.files.toLocaleString(),
				size: formatSize(scan.bytes),
				minutes: etaMinutes(scan.files, "local"),
			});
		}
		return (
			<div
				key={candidate.path}
				className={cn("folder-card", selected && "selected")}
				onClick={() => ctx.setFolderSelected(candidate.path, !selected)}
			>
				<span className="check-box">
					<Icon name="check" size={12} />
				</span>
				<span className="folder-art">
					<Icon name={folderIcon(candidate.kind)} size={16} />
				</span>
				<div className="folder-info">
					<div className="folder-name">{candidate.name}</div>
					<div className="folder-path">{candidate.displayPath}</div>
					<div className="folder-stats">{stats}</div>
				</div>
			</div>
		);
	};

	return (
		<section className="screen center">
			<div className="screen-copy">
				<Eyebrow icon="folder-search">{t("onboarding.folders.eyebrow")}</Eyebrow>
				<h1>
					<Multiline text={t("onboarding.folders.title")} />
				</h1>
				<p>{t("onboarding.folders.lead")}</p>
			</div>
			<div style={{ width: "100%", maxWidth: 760, marginTop: 19 }}>
				<div className="folder-head">
					<strong>{t("onboarding.folders.suggested")}</strong>
					<label>
						<input type="checkbox" checked={allSelected} onChange={ctx.toggleAllFolders} />{" "}
						{t("onboarding.folders.selectAll")}
					</label>
				</div>
				<div className="folder-grid">
					{candidates.map(card)}
					<div className="folder-card add" onClick={ctx.addFolders}>
						<Icon name="plus" size={15} />
						<span>{t("onboarding.folders.add")}</span>
					</div>
				</div>
				<div className="si-panel">
					<div className="si-bar">
						<div className="si-copy">
							<strong>
								<Icon name="sparkles" size={13} /> {t("onboarding.folders.smart.title")}
								{analyzed && !running ? <span className="tag rec">{t("onboarding.folders.smart.tag")}</span> : null}
							</strong>
							<p>{t("onboarding.folders.smart.lead")}</p>
						</div>
						{running ? (
							<button type="button" className="si-btn" onClick={ctx.cancelSmartScan}>
								{t("onboarding.folders.smart.cancel")}
							</button>
						) : (
							<button
								type="button"
								className="si-btn accent"
								disabled={selectedPaths.size === 0}
								title={selectedPaths.size === 0 ? t("onboarding.folders.smart.needFolder") : undefined}
								onClick={ctx.startSmartScan}
							>
								<Icon name={analyzed ? "refresh-cw" : "wand-sparkles"} size={12} />{" "}
								{analyzed ? t("onboarding.folders.smart.restart") : t("onboarding.folders.smart.start")}
							</button>
						)}
					</div>
					{ctx.smartRun.status === "running" ? (
						<div className="si-status">
							<Icon name="loader-circle" size={12} className="spin" />
							<span>
								{ctx.smartRun.current === null
									? t("onboarding.folders.smart.running")
									: t("onboarding.folders.smart.looking", { path: ctx.smartRun.current })}
							</span>
						</div>
					) : null}
					{ctx.smartRun.status === "error" ? (
						<div className="si-status error">
							<Icon name="triangle-alert" size={12} />
							<span>
								{t("onboarding.folders.smart.failed")} <small>{ctx.smartRun.message}</small>
							</span>
						</div>
					) : null}
					{analyzed && !running && smartItems.length === 0 && ctx.smartRun.status !== "error" ? (
						<div className="si-status">
							<Icon name="circle-check" size={12} />
							<span>{t("onboarding.folders.smart.none")}</span>
						</div>
					) : null}
					{smartItems.length > 0 ? <div className="si-pills">{smartItems.map(pill)}</div> : null}
					{smartTotals.folders > 0 ? (
						<div className="si-saved">
							{t("onboarding.folders.smart.saved", {
								folders: smartTotals.folders,
								files: smartTotals.files.toLocaleString(),
								size: formatSize(smartTotals.bytes),
							})}
						</div>
					) : null}
				</div>
				<div className="folder-summary">
					<div className="summary-main">
						<strong>
							{t("onboarding.folders.summary", {
								folders: selectedPaths.size,
								files: files.toLocaleString(),
								size: formatSize(bytes),
							})}
						</strong>
						<small>{t("onboarding.folders.summaryNote")}</small>
					</div>
					<div>
						<div className="eta-row">
							<span>
								{t("onboarding.folders.localEta", { minutes: localEta })}
							</span>
							<span>
								{t("onboarding.folders.cloudEta", { minutes: cloudEta })}
							</span>
						</div>
					</div>
				</div>
				<div className={cn("summary-warning", localEta <= 120 && "hidden")}>
					<Icon name="triangle-alert" size={12} /> {t("onboarding.folders.warning")}
				</div>
			</div>
		</section>
	);
}
