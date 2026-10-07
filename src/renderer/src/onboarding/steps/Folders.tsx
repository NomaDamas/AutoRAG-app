/** Step 4 — index scope: pick folders, watch the pre-scan totals. */

import type { ReactElement } from "react";
import type { FolderCandidate, FolderKind } from "../../../../shared/onboarding-contract";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Eyebrow, Multiline } from "../parts";
import { etaMinutes, formatSize } from "../flow";
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
	const localEta = etaMinutes(files, "local");
	const cloudEta = etaMinutes(files, "cloud");

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
