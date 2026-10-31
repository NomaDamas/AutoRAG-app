/** Step 4 — pick the folders to look through and index; the AI scan that follows reads exactly these. */

import type { ReactElement } from "react";
import type { FolderCandidate, FolderKind } from "../../../../shared/onboarding-contract";
import { cn } from "../../lib/cn";
import { Icon } from "../marks";
import { Multiline } from "../parts";
import { canSelectCloudEmbedding, etaMinutes, formatSize, localEmbeddingAllowed, resolveEmbed } from "../flow";
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
	// The time shown is for the way the documents will be embedded, as chosen (or defaulted) on the embedding step.
	const mode = resolveEmbed(draft.embed, canSelectCloudEmbedding(ctx.account), localEmbeddingAllowed(ctx.embedding === null ? null : ctx.embedding.localSpec));
	const eta = files === 0 ? 0 : etaMinutes(files, mode);
	const localEta = etaMinutes(files, "local");

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
		<section className="screen center folders-screen">
			<div className="screen-copy">
				<h1>
					<Multiline text={t("onboarding.folders.title")} />
				</h1>
				<p>{t("onboarding.folders.lead")}</p>
			</div>
			<div className="folders-stack">
				<div className="folder-head">
					<span>{t("onboarding.folders.suggested")}</span>
					<label className="folder-all">
						<input type="checkbox" checked={allSelected} onChange={ctx.toggleAllFolders} />
						<span className="check-box">
							<Icon name="check" size={12} />
						</span>
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
							{selectedPaths.size === 0
								? t("onboarding.folders.summaryEmpty")
								: t("onboarding.folders.summary", {
										folders: selectedPaths.size,
										files: files.toLocaleString(),
										size: formatSize(bytes),
									})}
						</strong>
						<small>{t("onboarding.folders.summaryNote")}</small>
					</div>
					<div className="eta-row">
						<span>{t("onboarding.folders.etaLabel")}</span>
						<span className="eta-value">
							<span className="eta-about">{t("onboarding.embedding.about")}</span>
							<b>{t("onboarding.embedding.minutes", { minutes: eta })}</b>
						</span>
					</div>
				</div>
				<div className={cn("summary-warning", localEta <= 120 && "hidden")}>
					<Icon name="triangle-alert" size={12} /> {t("onboarding.folders.warning")}
				</div>
			</div>
		</section>
	);
}
