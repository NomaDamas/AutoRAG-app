/** Step 5 — smart scan (Figma 04c/e/f): the AI recommends a scope from the folders chosen before. It has no footer: a finished run moves on by itself. */

import type { ReactElement } from "react";
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
	const failed = smartRun.status === "error";
	// A saved draft resumes with its proposals while the run state is fresh: that is "done" too.
	const done = smartRun.status === "done" || (smartRun.status === "idle" && draft.smartScope !== undefined);
	const running = !failed && !done;
	const backToFolders = (): void => {
		ctx.cancelSmartScan();
		ctx.setStep("folders");
	};

	return (
		<section className="si-minimal-scan">
			<h1>{t(failed ? "onboarding.smartScan.failedTitle" : done ? "onboarding.smartScan.done" : "onboarding.smartScan.title")}</h1>
			<div className="si-folder-scene">
				<div className="si-folder-glow" />
				<FolderArt />
				{running ? <Loupe /> : null}
			</div>
			<div className="si-scan-below">
				{smartRun.status === "running" ? (
					<p className="si-scan-path" role="status">
						<span className="shimmer">
							{smartRun.progress ?? (smartRun.current === null ? t("onboarding.smartScan.lead") : t("onboarding.smartScan.looking", { path: smartRun.current }))}
						</span>
					</p>
				) : null}
				{running ? (
					<button type="button" className="si-scan-link si-scan-cancel" onClick={backToFolders}>
						{t("onboarding.smartScan.back")}
					</button>
				) : null}
				{failed ? (
					<div className="si-scan-failed" role="alert">
						<button type="button" className="si-scan-retry" title={smartRun.message} onClick={ctx.startSmartScan}>
							{t("onboarding.smartScan.retry")}
						</button>
						<button type="button" className="si-scan-link faint si-scan-back" onClick={backToFolders}>
							{t("onboarding.smartScan.back")}
						</button>
						{/* Without this a model that keeps failing would leave no way past this screen. */}
						<button type="button" className="si-scan-link faint si-scan-manual" onClick={() => ctx.setStep("smartScope")}>
							{t("onboarding.smartScan.manual")}
						</button>
					</div>
				) : null}
			</div>
		</section>
	);
}
