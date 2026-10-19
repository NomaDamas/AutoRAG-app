/**
 * Step 6 — smart-indexing scope (prototype's "스마트 인덱싱 범위"): a policy bar, a blue
 * panel of the folders that are included and a red panel of the sub-folders left
 * out. Pills are removable and ghost pills bring a folder back; the folders
 * themselves were chosen in the step before the scan.
 */

import { useState, type ReactElement } from "react";
import type { FolderCandidate, FolderKind } from "../../../../shared/onboarding-contract";
import type { SmartExclusion } from "../../../../shared/smart-indexing-contract";
import { Icon } from "../marks";
import { formatSize, scanTotals } from "../flow";
import { etaSaving, excludedTotals, visibleScope } from "../smart-scope";
import type { OnboardingCtx } from "../context";

/** Ghost pills shown before the rest are summarised; the prototype lists three. */
const MAX_GHOSTS = 3;

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

/** The part of a left-out folder's path below the folder it lies under. */
function insidePath(item: SmartExclusion): string {
	return item.path.slice(item.root.length).replace(/^[\\/]+/u, "");
}

/** How the AI decides, in words: what it looked at, what it keeps and leaves out, and that the person has the last word. */
function Criteria({ t }: { readonly t: OnboardingCtx["t"] }): ReactElement {
	const keys = ["looked", "keep", "leave", "code", "doubt", "you"] as const;
	return (
		<ol className="si-criteria">
			{keys.map((key) => (
				<li key={key}>{t(`onboarding.smartScope.criteria.${key}`)}</li>
			))}
		</ol>
	);
}

export function SmartScopeStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, candidates, draft, scans } = ctx;
	const [showCriteria, setShowCriteria] = useState(false);

	const selectedPaths = draft.folders.filter((folder) => folder.selected).map((folder) => folder.path);
	const selected = selectedPaths.map((path) => candidates.find((candidate) => candidate.path === path)).filter((candidate): candidate is FolderCandidate => candidate !== undefined);
	// A folder can only be put back here if the AI looked through it; choosing folders is the step before the scan.
	const analysed = draft.smartScopeRoots ?? [];
	const putBack = candidates.filter((candidate) => analysed.includes(candidate.path) && !selectedPaths.includes(candidate.path));

	const items = visibleScope(draft.smartScope, selectedPaths);
	const leftOut = items.filter((item) => item.excluded);
	const kept = items.filter((item) => !item.excluded);
	const totals = excludedTotals(draft.smartScope, selectedPaths);
	const included = scanTotals(selectedPaths, scans);
	const eta = etaSaving(included.files, totals.files, "local");
	const rootName = (item: SmartExclusion): string => candidates.find((candidate) => candidate.path === item.root)?.name ?? item.root;

	return (
		<section className="si-screen">
			<div className="si-policy-bar">
				<div className="si-policy-copy">
					<strong>
						{t("onboarding.smartScope.policy.title")}
						{draft.smartScope !== undefined ? <span className="tag rec">{t("onboarding.smartScope.policy.tag")}</span> : null}
					</strong>
					<p>
						{t("onboarding.smartScope.policy.lead")}{" "}
						<button type="button" className="si-criteria-toggle" aria-expanded={showCriteria} onClick={() => setShowCriteria((shown) => !shown)}>
							{t(showCriteria ? "onboarding.smartScope.criteria.hide" : "onboarding.smartScope.criteria.show")}
						</button>
					</p>
					{showCriteria ? <Criteria t={t} /> : null}
				</div>
				<div className="si-policy-right">
					<div className="si-eta-pill">
						{eta.percent > 0 ? <del>{t("onboarding.smartScope.policy.eta", { minutes: eta.before })}</del> : null}
						<b>{t("onboarding.smartScope.policy.eta", { minutes: eta.after })}</b>
						{eta.percent > 0 ? <em>{t("onboarding.smartScope.policy.etaSaved", { percent: eta.percent })}</em> : null}
					</div>
					<button type="button" className="secondary si-rescan" onClick={ctx.rescanSmart}>
						<Icon name="search" size={12} /> {t("onboarding.smartScope.policy.rescan")}
					</button>
				</div>
			</div>
			<div className="si-dual-panels">
				<div className="si-panel blue">
					<div className="si-panel-head">
						<div className="si-panel-title">
							<i className="si-panel-dot" />
							{t("onboarding.smartScope.include.title")}
						</div>
						<span className="si-panel-meta">
							{t("onboarding.smartScope.include.meta", {
								folders: selected.length,
								files: Math.max(0, included.files - totals.files).toLocaleString(),
								size: formatSize(Math.max(0, included.bytes - totals.bytes)),
							})}
						</span>
					</div>
					<div className="si-pills">
						{selected.map((candidate) => {
							const scan = scans.get(candidate.path);
							return (
								<span key={candidate.path} className="si-pill blue" title={candidate.displayPath}>
									<span className="si-pill-ico">
										<Icon name={folderIcon(candidate.kind)} size={12} />
									</span>
									<span className="si-pill-label">{candidate.name}</span>
									<span className="si-pill-size">{scan === undefined || scan.error !== null ? "…" : formatSize(scan.bytes)}</span>
									<button
										type="button"
										className="si-pill-x"
										title={t("onboarding.smartScope.include.remove")}
										onClick={() => ctx.setFolderSelected(candidate.path, false)}
									>
										<Icon name="x" size={11} />
									</button>
								</span>
							);
						})}
					</div>
					<div className="si-panel-foot">
						<div className="si-ghost-row">
							{putBack.length > 0 ? (
								<>
									<span>{t("onboarding.smartScope.include.addable")}</span>
									{putBack.map((candidate) => (
										<button key={candidate.path} type="button" className="si-ghost-pill" onClick={() => ctx.setFolderSelected(candidate.path, true)}>
											+ {candidate.name}
										</button>
									))}
								</>
							) : (
								<span>{t("onboarding.smartScope.include.allIn")}</span>
							)}
						</div>
					</div>
				</div>
				<div className="si-panel red">
					<div className="si-panel-head">
						<div className="si-panel-title">
							<i className="si-panel-dot" />
							{t("onboarding.smartScope.exclude.title")}
						</div>
						<span className="si-panel-meta">{t("onboarding.smartScope.exclude.meta", { count: leftOut.length, size: formatSize(totals.bytes) })}</span>
					</div>
					<div className="si-pills">
						<button type="button" className="si-add-pill red" onClick={ctx.addExclusion} disabled={selectedPaths.length === 0}>
							<Icon name="plus" size={12} /> {t("onboarding.smartScope.exclude.add")}
						</button>
						{leftOut.map((item) => (
							<span key={item.path} className="si-pill red" title={item.reason === "" ? item.path : `${item.reason}\n${item.path}`}>
								<span className="si-pill-ico">
									<Icon name="eye-off" size={11} />
								</span>
								<span className="si-pill-label">
									<em>{rootName(item)} / </em>
									<b>{insidePath(item)}</b>
								</span>
								<span className="si-pill-size">{item.files === 0 ? t("onboarding.smartScope.exclude.noDocs") : `−${formatSize(item.bytes)}`}</span>
								<button
									type="button"
									className="si-pill-x"
									title={t("onboarding.smartScope.exclude.restore")}
									onClick={() => ctx.setSmartExcluded(item.path, false)}
								>
									<Icon name="x" size={11} />
								</button>
							</span>
						))}
					</div>
					<div className="si-panel-foot">
						<div className="si-ghost-row">
							{kept.length > 0 ? (
								<>
									<span>{t("onboarding.smartScope.exclude.restored")}</span>
									{kept.slice(0, MAX_GHOSTS).map((item) => (
										<button key={item.path} type="button" className="si-ghost-pill" onClick={() => ctx.setSmartExcluded(item.path, true)}>
											+ {insidePath(item)}
										</button>
									))}
								</>
							) : (
								<span>
									<Icon name="lock" size={11} /> {t("onboarding.smartScope.policy.auto")}
								</span>
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}
