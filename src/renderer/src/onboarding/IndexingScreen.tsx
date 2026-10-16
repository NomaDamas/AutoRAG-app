/** Step 9 — the immersive first-index screen, driven by the real IndexingStatus. */

import type { CSSProperties, ReactElement } from "react";
import type { IndexingPhase } from "../../../shared/onboarding-contract";
import { cn } from "../lib/cn";
import { TIPS, phaseIndex, type TipArt } from "./flow";
import { BrandMark, brandVars, Icon } from "./marks";
import { TipArt as TipArtView } from "./parts";
import type { OnboardingCtx } from "./context";

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

const PHASES: readonly { readonly id: IndexingPhase; readonly key: string }[] = [
	{ id: "parsed", key: "parsed" },
	{ id: "minsync", key: "minsync" },
	{ id: "finalizing", key: "finalizing" },
];

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

export function IndexingScreen({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, indexStatus, platform } = ctx;
	const status = indexStatus;
	const success = status?.state === "success";
	const failed = status?.state === "failed";
	const running = status?.state === "running";
	const progress = success ? 100 : (status?.progress ?? 0);
	const phase = status?.phase ?? null;
	const activeIndex = phase === null ? -1 : phaseIndex(phase);
	const totalFiles = status?.totalFiles ?? 0;
	const processed = status?.processedFiles ?? 0;
	const sources = status?.sources ?? [];

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
						{t("onboarding.indexing.doneDetail", { files: totalFiles.toLocaleString(), sources: sources.length })}
					</small>
				</span>
			</>
		);
	} else if (failed) {
		statusPill = (
			<>
				<Icon name="triangle-alert" size={16} />
				<span>
					<strong>{t("onboarding.indexing.failedTitle")}</strong>
					<small>{status?.error ?? t("onboarding.indexing.failedDetail")}</small>
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
	if (success) {
		const started = status?.startedAt != null ? Date.parse(status.startedAt) : null;
		const finished = status?.finishedAt != null ? Date.parse(status.finishedAt) : null;
		const totalMinutes = started !== null && finished !== null ? Math.max(1, Math.ceil((finished - started) / 60_000)) : null;
		meta = (
			<>
				<b>100%</b>
				<span>·</span>
				<span>{totalMinutes === null ? t("onboarding.indexing.metaDone") : t("onboarding.indexing.metaTotal", { minutes: totalMinutes })}</span>
				<span>·</span>
				<span>{t("onboarding.indexing.metaFiles", { count: totalFiles.toLocaleString() })}</span>
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
				{PHASES.map((item, i) => {
					const done = success || i < activeIndex;
					const active = !success && i === activeIndex && running;
					return (
						<span key={item.id} className={cn("ix-phase", done && "done", active && "active")}>
							<i />
							{t(`onboarding.indexing.phase.${item.key}`)}
						</span>
					);
				})}
			</div>
			<div className="ix-gate">
				{success ? (
					<>
						<div className="ix-notice ok">
							<Icon name="circle-check" size={18} />
							<span>
								<strong>{t("onboarding.indexing.gateOkTitle")}</strong>
								<small>{t("onboarding.indexing.gateOkDetail", { files: totalFiles.toLocaleString() })}</small>
							</span>
						</div>
						<button type="button" className="ix-open-btn" onClick={ctx.finish}>
							{t("onboarding.indexing.open")} <span className="kbd">↵</span>
						</button>
					</>
				) : failed ? (
					<>
						<div className="ix-notice warn">
							<Icon name="triangle-alert" size={18} />
							<span>
								<strong>{t("onboarding.indexing.gateFailTitle")}</strong>
								<small>{status?.error ?? t("onboarding.indexing.gateFailDetail")}</small>
							</span>
						</div>
						<button type="button" className="ix-open-btn" onClick={ctx.startIndexing}>
							<Icon name="refresh-cw" size={13} /> {t("onboarding.indexing.retry")}
						</button>
					</>
				) : (
					<>
						<div className="ix-notice">
							<Icon name="triangle-alert" size={18} />
							<span>
								<strong>
									{platform === "win32" ? t("onboarding.indexing.gateTitlePc") : t("onboarding.indexing.gateTitleMac")}
								</strong>
								<small>
									{platform === "win32" ? t("onboarding.indexing.gateDetailWindows") : t("onboarding.indexing.gateDetailMac")}
								</small>
							</span>
						</div>
						<button type="button" className="ix-open-btn" disabled>
							<Icon name="lock" size={13} /> {t("onboarding.indexing.gateLocked")}
						</button>
					</>
				)}
			</div>
			<TipCard ctx={ctx} />
			{!success && !failed ? (
				<button type="button" className="ix-bg-start" onClick={ctx.finishInBackground}>
					{t("onboarding.indexing.startInBackground")}
				</button>
			) : null}
		</section>
	);
}
