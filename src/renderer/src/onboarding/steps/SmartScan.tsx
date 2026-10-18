/** Step 4 — smart scan: the AI looks through the chosen folders (prototype's "폴더 탐색 중…" screen). */

import type { ReactElement } from "react";
import { visibleScope } from "../smart-scope";
import type { OnboardingCtx } from "../context";

/** The prototype's drawn folder with two sheets in it. */
function FolderArt(): ReactElement {
	return (
		<div className="si-folder-art">
			<div className="si-folder-back" />
			<div className="si-folder-sheet s1">
				<span className="si-sheet-bar w40" />
				<span className="si-sheet-bar w75" />
			</div>
			<div className="si-folder-sheet s2">
				<span className="si-sheet-bar w40" />
				<span className="si-sheet-bar w75" />
				<span className="si-sheet-bar w55" />
			</div>
			<div className="si-folder-front" />
		</div>
	);
}

/** The prototype's magnifying glass; it roams over the folder while the agent works. */
function Loupe(): ReactElement {
	return (
		<div className="si-roaming-loupe">
			<svg className="si-loupe-svg" viewBox="0 0 120 120" fill="none" aria-hidden="true">
				<defs>
					<radialGradient id="siLens" cx="35%" cy="30%" r="70%">
						<stop offset="0%" stopColor="#ffffff" stopOpacity=".82" />
						<stop offset="65%" stopColor="#e8f2ff" stopOpacity=".42" />
						<stop offset="100%" stopColor="#9ec5ff" stopOpacity=".35" />
					</radialGradient>
				</defs>
				<line x1="44" y1="76" x2="12" y2="108" stroke="var(--onb-ink)" strokeWidth="11" strokeLinecap="round" />
				<line x1="46" y1="74" x2="36" y2="84" stroke="var(--onb-muted)" strokeWidth="11" strokeLinecap="butt" />
				<circle cx="70" cy="50" r="34" fill="url(#siLens)" stroke="var(--onb-ink)" strokeWidth="5.5" />
				<circle cx="70" cy="50" r="30" stroke="#ffffff" strokeOpacity=".65" strokeWidth="1.5" />
				<path d="M50 34 C58 24, 74 22, 86 28" stroke="#ffffff" strokeOpacity=".75" strokeWidth="4" strokeLinecap="round" />
			</svg>
		</div>
	);
}

export function SmartScanStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, draft, smartRun } = ctx;
	const roots = draft.folders.filter((folder) => folder.selected).map((folder) => folder.path);
	const running = smartRun.status === "running";
	const failed = smartRun.status === "error";
	// A saved draft resumes with its proposals while the run state is fresh: that is "done" too.
	const done = smartRun.status === "done" || (smartRun.status === "idle" && draft.smartScope !== undefined);
	const proposals = visibleScope(draft.smartScope, roots).length;

	return (
		<section className="si-minimal-scan">
			<h1>{t(running ? "onboarding.smartScan.title" : done ? "onboarding.smartScan.done" : failed ? "onboarding.smartScan.failedTitle" : "onboarding.smartScan.idle")}</h1>
			<div className="si-folder-scene">
				<div className="si-folder-glow" />
				<FolderArt />
				{running ? <Loupe /> : null}
			</div>
			{running ? (
				<>
					<p className="si-scan-path">
						{smartRun.current === null ? t("onboarding.smartScan.lead") : t("onboarding.smartScan.looking", { path: smartRun.current })}
					</p>
					<button type="button" className="quiet si-scan-cancel" onClick={ctx.cancelSmartScan}>
						{t("onboarding.smartScan.cancel")}
					</button>
				</>
			) : null}
			{done ? (
				<p className="si-scan-note">
					{proposals > 0 ? t("onboarding.smartScan.note", { count: proposals }) : t("onboarding.smartScan.noteNone")}
				</p>
			) : null}
			{failed ? (
				<>
					<p className="si-scan-error">
						{t("onboarding.smartScan.failed")} <small>{smartRun.message}</small>
					</p>
					<button type="button" className="secondary si-scan-retry" onClick={ctx.startSmartScan}>
						{t("onboarding.smartScan.retry")}
					</button>
				</>
			) : null}
			{!running && !done && !failed ? (
				<>
					<p className="si-scan-note">{t("onboarding.smartScan.skipped")}</p>
					<button type="button" className="secondary si-scan-retry" disabled={ctx.candidates.length === 0 && draft.folders.length === 0} onClick={ctx.startSmartScan}>
						{t("onboarding.smartScan.start")}
					</button>
				</>
			) : null}
		</section>
	);
}
