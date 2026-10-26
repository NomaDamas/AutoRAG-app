/** Step 9 — the immersive first-index screen, driven by the real IndexingStatus. */

import { useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { cn } from "../lib/cn";
import { downloadPercent } from "../state/model-download";
import { TIPS, formatSize, indexingPhases, phaseIndex, resolveEmbed, canSelectCloudEmbedding, type TipArt } from "./flow";
import { BrandMark, brandVars, Icon } from "./marks";
import { TipArt as TipArtView } from "./parts";
import type { OnboardingCtx } from "./context";
import type { PauseExit } from "./pause";
import { usePauseControl, type PauseControl } from "./usePauseControl";

interface FloatSpec {
	readonly x: number;
	readonly y: number;
	readonly kind: "ghost" | "file" | "brand";
	readonly icon?: string;
	readonly text?: string;
	readonly color?: string;
	readonly brand?: string;
	readonly rotate?: number;
	readonly opacity?: number;
	readonly size?: number;
}

const IX_FLOATS: readonly FloatSpec[] = [
	{ x: 6, y: 15, kind: "ghost", icon: "scan-eye" },
	{ x: 24, y: 10, kind: "file", text: "MD", color: "#5b5b61", opacity: 0.5, size: 34 },
	{ x: 15, y: 38, kind: "file", text: "HWP", color: "#2b7de9", rotate: -7, opacity: 0.85 },
	{ x: 3, y: 58, kind: "ghost", icon: "folder", opacity: 0.8 },
	{ x: 11, y: 80, kind: "ghost", icon: "image", opacity: 0.7 },
	{ x: 22, y: 93, kind: "file", text: "DOC", color: "#2f5fd0", rotate: -9, opacity: 0.55, size: 36 },
	{ x: 76, y: 9, kind: "ghost", icon: "mail", opacity: 0.55, size: 36 },
	{ x: 94, y: 13, kind: "file", text: "PDF", color: "#e5533d", rotate: 9 },
	{ x: 99, y: 33, kind: "brand", brand: "slack", opacity: 0.8 },
	{ x: 86, y: 46, kind: "brand", brand: "obsidian" },
	{ x: 90, y: 72, kind: "file", text: "XLS", color: "#1f9d55", rotate: 10 },
	{ x: 77, y: 90, kind: "ghost", icon: "file-text", opacity: 0.6 },
	{ x: 97, y: 91, kind: "brand", brand: "github", opacity: 0.75, size: 38 },
];

/** The prototype's `ixLines()`: converging dotted paths on both sides. */
function IxLines(): ReactElement {
	const ys = [-60, 40, 130, 220, 300, 380, 470, 560, 660];
	return (
		<svg className="ix-lines" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">
			{ys.map((y, i) => {
				const mid = 300 + (y - 300) * 0.35;
				const end = 300 + (y - 300) * 0.12;
				return (
					<g key={i}>
						<path style={{ animationDelay: `-${i * 0.37}s` }} d={`M-20 ${y} C 260 ${y}, 300 ${mid}, 455 ${end}`} />
						<path style={{ animationDelay: `-${i * 0.29}s` }} d={`M1020 ${y} C 740 ${y}, 700 ${mid}, 545 ${end}`} />
					</g>
				);
			})}
		</svg>
	);
}

function IxFloats(): ReactElement {
	return (
		<>
			{IX_FLOATS.map((f, i) => {
				const style = {
					left: `${f.x}%`,
					top: `${f.y}%`,
					"--d": `-${i * 0.9}s`,
					"--t": `${6 + (i % 4)}s`,
					...(f.rotate !== undefined ? { "--r": `${f.rotate}deg` } : {}),
					...(f.opacity !== undefined ? { "--o": `${f.opacity}` } : {}),
					...(f.size !== undefined ? { "--s": `${f.size}px` } : {}),
					...(f.kind === "file" && f.color !== undefined ? { "--c": f.color } : {}),
				} as CSSProperties;
				if (f.kind === "file") {
					return (
						<span key={i} className="ix-float file" style={style} aria-hidden="true">
							{f.text}
						</span>
					);
				}
				if (f.kind === "brand" && f.brand !== undefined) {
					return (
						<span key={i} className="ix-float brand" style={{ ...style, ...brandVars(f.brand) }} aria-hidden="true">
							<BrandMark name={f.brand} size={20} />
						</span>
					);
				}
				return (
					<span key={i} className="ix-float ghost" style={style} aria-hidden="true">
						<Icon name={f.icon ?? "folder"} size={18} />
					</span>
				);
			})}
		</>
	);
}

function TipCard({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, platform, tipIndex } = ctx;
	const list = TIPS;
	const index = ((tipIndex % list.length) + list.length) % list.length;
	const tip = list[index] as TipArt;
	const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	const shortcut = tip.kind === "shortcut" ? (platform === "win32" ? `Ctrl+${tip.key}` : `⌘${tip.key}`) : "";
	return (
		<div className="ix-tip">
			<div className="ix-tip-art">
				<TipArtView platform={platform} art={tip} t={t} />
			</div>
			<div className="ix-tip-copy">
				<div className="ix-tip-head">
					<Icon name="sparkles" size={12} /> {t("onboarding.indexing.tip")}{" "}
					<em>
						{index + 1} / {list.length}
					</em>
					<span className="ix-nav">
						<button type="button" aria-label={t("onboarding.indexing.prevTip")} onClick={() => ctx.setTipIndex(index - 1)}>
							<Icon name="chevron-left" size={13} />
						</button>
						<button type="button" aria-label={t("onboarding.indexing.nextTip")} onClick={() => ctx.setTipIndex(index + 1)}>
							<Icon name="chevron-left" size={13} />
						</button>
					</span>
				</div>
				<h3>{t(`onboarding.tips.${index + 1}.title`, { shortcut })}</h3>
				<p>{t(`onboarding.tips.${index + 1}.body`, { shortcut })}</p>
				<div className="ix-dots">
					{list.map((_, i) => (
						<button
							key={i}
							type="button"
							className={i === index ? "on" : ""}
							aria-label={t("onboarding.indexing.tipDot", { index: i + 1 })}
							onClick={() => ctx.setTipIndex(i)}
						/>
					))}
				</div>
			</div>
			<div className="ix-timer">
				<span
					key={index}
					onAnimationEnd={(e) => {
						if (e.animationName === "onb-tipfill" && !reducedMotion) {
							ctx.setTipIndex(index + 1);
						}
					}}
				/>
			</div>
		</div>
	);
}

/** The run stopped: the scene held still, one reason, one button, and the other ways on as quiet links. */
function PauseView({ ctx, pause }: { readonly ctx: OnboardingCtx; readonly pause: PauseControl }): ReactElement | null {
	const { t } = ctx;
	const { spec } = pause;
	const [button, ...links] = pause.exits;
	const runRef = useRef(pause.run);
	runRef.current = pause.run;
	// Enter presses the button even when focus sits on the page rather than on a control.
	useEffect(() => {
		if (button === undefined) return;
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Enter" || event.defaultPrevented) return;
			const tag = (document.activeElement as HTMLElement | null)?.tagName;
			if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			runRef.current(button);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [button]);
	if (spec === null || button === undefined) return null;
	const labelOf = (exit: PauseExit): string => {
		if (exit === "retry") return t(spec.retryLabel.key, spec.retryLabel.vars);
		if (exit === "excludeFolders") return spec.excludeLabel === undefined ? "" : t(spec.excludeLabel.key, spec.excludeLabel.vars);
		return t(`onboarding.indexing.pause.exit.${exit}`);
	};
	const progress = Math.floor(pause.progress);
	return (
		<section className="ix paused">
			<IxLines />
			<IxFloats />
			<span className="ix-hero">
				<Icon name={spec.icon} size={26} />
			</span>
			<h1 className="ix-title">{t(spec.title.key, spec.title.vars)}</h1>
			<p className={cn("ix-sub", pause.line.tone === "again" && "again")} role="status" aria-live="polite">
				{t(pause.line.key, pause.line.vars)}
			</p>
			{progress > 0 ? (
				<div className="ix-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
					<span style={{ width: `${progress}%` }} />
					<i className="ix-stop" style={{ left: `${progress}%` }} />
				</div>
			) : null}
			<button key={button} type="button" className="ix-cta" autoFocus onClick={() => pause.run(button)}>
				{labelOf(button)} <span className="kbd">↵</span>
			</button>
			<div className="ix-links">
				{links.map((exit) => (
					<button key={exit} type="button" onClick={() => pause.run(exit)}>
						{labelOf(exit)}
					</button>
				))}
			</div>
		</section>
	);
}

export function IndexingScreen({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, indexStatus, platform } = ctx;
	const status = indexStatus;
	const pause = usePauseControl(ctx);
	if (pause.spec !== null) return <PauseView ctx={ctx} pause={pause} />;
	const success = status?.state === "success";
	const running = status?.state === "running";
	// The first index of on-device embedding waits for the model: while its download runs, that is the progress.
	const download = ctx.modelDownload.status;
	const downloading = running && download.state === "downloading";
	const progress = success ? 100 : downloading ? downloadPercent(download) : (status?.progress ?? 0);
	const phase = status?.phase ?? null;
	// The keyword-only path never embeds, so its strip has no embedding phase.
	const embed = resolveEmbed(ctx.draft.embed, canSelectCloudEmbedding(ctx.account));
	const phases = indexingPhases(embed);
	const activeIndex = phase === null ? -1 : phaseIndex(embed, phase);
	const totalFiles = status?.totalFiles ?? 0;
	const processed = status?.processedFiles ?? 0;
	const sources = status?.sources ?? [];
	// Files the run finished without are not "read"; the screen says how many they were instead of counting them.
	const skipped = success ? (status?.skipped ?? 0) : 0;
	const readFiles = Math.max(0, totalFiles - skipped);

	const phaseLabel = phase === null ? t("onboarding.indexing.phaseLabel.parsed") : t(`onboarding.indexing.phaseLabel.${phase}`);
	let statusDetail: string;
	if (phase === "finalizing") {
		statusDetail = t("onboarding.indexing.detailFinalizing");
	} else if (phase === "minsync") {
		statusDetail = t("onboarding.indexing.detailEmbedding");
	} else if (status?.recentFolder != null && status.recentFile != null) {
		statusDetail = `${status.recentFolder} · ${status.recentFile}`;
	} else {
		statusDetail = t("onboarding.indexing.detailParsing");
	}

	let statusPill: ReactElement;
	if (success) {
		statusPill = (
			<>
				<Icon name="circle-check" size={16} />
				<span>
					<strong>{t("onboarding.indexing.done")}</strong>
					<small>
						{t("onboarding.indexing.doneDetail", { files: readFiles.toLocaleString(), sources: sources.length })}
					</small>
				</span>
			</>
		);
	} else if (downloading) {
		statusPill = (
			<>
				<Icon name="loader-circle" size={16} className="spin" />
				<span>
					<strong>{t("modelDownload.indexingTitle")}</strong>
					<small>{t("modelDownload.indexingNote")}</small>
				</span>
			</>
		);
	} else if (running) {
		statusPill = (
			<>
				<Icon name="loader-circle" size={16} className="spin" />
				<span>
					<strong>{t("onboarding.indexing.running", { phase: phaseLabel })}</strong>
					<small>{statusDetail}</small>
				</span>
			</>
		);
	} else {
		statusPill = (
			<>
				<Icon name="circle-dashed" size={16} />
				<span>
					<strong>{t("onboarding.indexing.waiting")}</strong>
					<small>{t("onboarding.indexing.waitingNote")}</small>
				</span>
			</>
		);
	}

	const remaining = status?.remainingMinutes ?? null;
	let meta: ReactElement;
	if (downloading) {
		meta = (
			<>
				<b>{Math.floor(progress)}%</b>
				<span>·</span>
				<span>{t("modelDownload.amount", { done: formatSize(download.bytesDone), total: formatSize(download.bytesTotal) })}</span>
			</>
		);
	} else if (success) {
		const started = status?.startedAt != null ? Date.parse(status.startedAt) : null;
		const finished = status?.finishedAt != null ? Date.parse(status.finishedAt) : null;
		const totalMinutes = started !== null && finished !== null ? Math.max(1, Math.ceil((finished - started) / 60_000)) : null;
		meta = (
			<>
				<b>100%</b>
				<span>·</span>
				<span>{totalMinutes === null ? t("onboarding.indexing.metaDone") : t("onboarding.indexing.metaTotal", { minutes: totalMinutes })}</span>
				<span>·</span>
				<span>{t("onboarding.indexing.metaFiles", { count: readFiles.toLocaleString() })}</span>
			</>
		);
	} else {
		meta = (
			<>
				<b>{Math.floor(progress)}%</b>
				<span>·</span>
				<span>
					{remaining === null
						? t("onboarding.indexing.metaEstimating")
						: remaining <= 1
							? t("onboarding.indexing.metaUnderMinute")
							: t("onboarding.indexing.metaRemaining", { minutes: remaining })}
				</span>
				<span>·</span>
				<span>{t("onboarding.indexing.metaProgress", { processed: processed.toLocaleString(), total: totalFiles.toLocaleString() })}</span>
			</>
		);
	}

	return (
		<section className={cn("ix", success && "done")}>
			<IxLines />
			<IxFloats />
			<div className="ix-status" role="status">
				{statusPill}
			</div>
			<h1 className="ix-title">{success ? t("onboarding.indexing.titleDone") : t("onboarding.indexing.title")}</h1>
			<div className="ix-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(progress)}>
				<span style={{ width: `${progress}%` }} />
			</div>
			<div className="ix-meta">{meta}</div>
			<div className="ix-phases">
				{phases.map((id, i) => {
					const done = success || i < activeIndex;
					const active = !success && i === activeIndex && running;
					return (
						<span key={id} className={cn("ix-phase", done && "done", active && "active")}>
							<i />
							{t(`onboarding.indexing.phase.${id}`)}
						</span>
					);
				})}
			</div>
			<div className="ix-gate">
				{success ? (
					<div className="ix-notice ok">
						<Icon name="circle-check" size={18} />
						<span>
							<strong>{t("onboarding.indexing.gateOkTitle")}</strong>
							<small>{skipped > 0 ? t("onboarding.indexing.gateOkDetailPartial") : t("onboarding.indexing.gateOkDetail", { files: readFiles.toLocaleString() })}</small>
						</span>
					</div>
				) : (
					<div className="ix-notice">
						<Icon name="triangle-alert" size={18} />
						<span>
							<strong>{platform === "win32" ? t("onboarding.indexing.gateTitlePc") : t("onboarding.indexing.gateTitleMac")}</strong>
							<small>{platform === "win32" ? t("onboarding.indexing.gateDetailWindows") : t("onboarding.indexing.gateDetailMac")}</small>
						</span>
					</div>
				)}
			</div>
			{success && skipped > 0 ? (
				<div className="ix-skipline">
					<span className="ix-skippill">
						<Icon name="triangle-alert" size={13} /> {t("onboarding.indexing.skipped", { count: skipped.toLocaleString() })}
					</span>
				</div>
			) : (
				<TipCard ctx={ctx} />
			)}
		</section>
	);
}
