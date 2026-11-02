/**
 * Small building blocks the phone shell's screens share: glass buttons, the
 * large title, inset list cells, a switch, thumbnails, and the progress ring.
 * Pure presentation; every string arrives translated from the caller.
 */

import type { ReactElement, ReactNode } from "react";
import { ChevronRight, Music, Play } from "lucide-react";
import type { FinderEntry } from "../data/entries";
import { fileKindOf } from "../state/entry-values";
import { kindMeta } from "../state/kinds";
import { cn } from "../lib/cn";
import { previewKind, splitName } from "./model";

export function GlassButton({ label, onClick, children, prominent = false, disabled = false, className }: {
	readonly label: string;
	readonly onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
	readonly children: ReactNode;
	readonly prominent?: boolean;
	readonly disabled?: boolean;
	readonly className?: string;
}): ReactElement {
	return (
		<button type="button" className={cn("phone-gbtn phone-glass", prominent && "is-prominent", className)} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);
}

export function GlassText({ children, onClick, prominent = false, disabled = false }: { readonly children: ReactNode; readonly onClick: () => void; readonly prominent?: boolean; readonly disabled?: boolean }): ReactElement {
	return (
		<button type="button" className={cn("phone-gtext phone-glass", prominent && "is-prominent")} disabled={disabled} onClick={onClick}>
			{children}
		</button>
	);
}

/** The centered compact title that fades in once the large title scrolls under the bar. */
export function NavTitle({ title, subtitle, always = false, onClick }: { readonly title: string; readonly subtitle?: string; readonly always?: boolean; readonly onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void }): ReactElement {
	const inner = (
		<>
			<b><span>{title}</span></b>
			{subtitle === undefined ? null : <small>{subtitle}</small>}
		</>
	);
	return onClick === undefined ? (
		<div className={cn("phone-nav-title", always && "is-always")}>{inner}</div>
	) : (
		<button type="button" className={cn("phone-nav-title", always && "is-always")} onClick={onClick}>{inner}</button>
	);
}

export function LargeTitle({ title, subtitle, onTitle, titleLabel }: { readonly title: string; readonly subtitle?: ReactNode; readonly onTitle?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined; readonly titleLabel?: string | undefined }): ReactElement {
	return (
		<div className="phone-large">
			<h1>
				{onTitle === undefined ? (
					<span className="phone-h1-text">{title}</span>
				) : (
					<button type="button" onClick={onTitle} aria-label={titleLabel}>
						<span className="phone-h1-text">{title}</span>
						<svg className="phone-chev" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
					</button>
				)}
			</h1>
			{subtitle === undefined ? null : <div className="phone-sub">{subtitle}</div>}
		</div>
	);
}

export function Cell({ icon, title, subtitle, value, tail, chevron = true, onClick, tone, testId }: {
	readonly icon?: ReactNode;
	readonly title: ReactNode;
	readonly subtitle?: ReactNode | undefined;
	readonly value?: ReactNode;
	readonly tail?: ReactNode;
	readonly chevron?: boolean;
	readonly onClick?: (() => void) | undefined;
	readonly tone?: "accent" | "danger" | undefined;
	readonly testId?: string | undefined;
}): ReactElement {
	const body = (
		<>
			{icon === undefined ? null : <span className="phone-cell-icon">{icon}</span>}
			<span className="phone-cell-main">
				<b>{title}</b>
				{subtitle === undefined ? null : <small>{subtitle}</small>}
			</span>
			{value === undefined ? null : <span className="phone-cell-value">{value}</span>}
			{tail}
			{chevron && onClick !== undefined ? <ChevronRight className="phone-chev-r" size={18} strokeWidth={2.4} aria-hidden="true" /> : null}
		</>
	);
	const className = cn("phone-cell", tone === "accent" && "is-accent", tone === "danger" && "is-danger");
	return onClick === undefined ? (
		<div className={className} data-testid={testId}>{body}</div>
	) : (
		<button type="button" className={className} onClick={onClick} data-testid={testId}>{body}</button>
	);
}

export function Section({ title, children, foot, collapsed, onToggle, toggleLabel }: {
	readonly title?: string;
	readonly children: ReactNode;
	readonly foot?: ReactNode;
	readonly collapsed?: boolean;
	readonly onToggle?: () => void;
	readonly toggleLabel?: string;
}): ReactElement {
	return (
		<section className={cn("phone-section", collapsed === true && "is-collapsed")}>
			{title === undefined ? null : (
				<div className="phone-section-head">
					<span>{title}</span>
					{onToggle === undefined ? null : (
						<button type="button" aria-label={toggleLabel} aria-expanded={collapsed !== true} onClick={onToggle}>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
						</button>
					)}
				</div>
			)}
			<div className="phone-group">{children}</div>
			{foot === undefined ? null : <div className="phone-section-foot">{foot}</div>}
		</section>
	);
}

export function Switch({ checked, label, onChange, disabled = false }: { readonly checked: boolean; readonly label: string; readonly onChange: (next: boolean) => void; readonly disabled?: boolean }): ReactElement {
	return <button type="button" role="switch" className="phone-switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

/** The ring around an activity glyph: the percent when known, a spinning arc while it is not. */
export function ProgressRing({ percent, tone, children }: { readonly percent: number | null; readonly tone?: "error" | undefined; readonly children: ReactNode }): ReactElement {
	const circumference = 2 * Math.PI * 13;
	const offset = percent === null ? circumference * 0.7 : circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);
	return (
		<span className={cn("phone-ring", tone === "error" && "is-error", percent === null && tone !== "error" && "is-spin")}>
			<svg className="phone-ring-svg" width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">
				<circle className="phone-ring-track" cx="16" cy="16" r="13" fill="none" strokeWidth="3" />
				{tone === "error" ? null : <circle className="phone-ring-val" cx="16" cy="16" r="13" fill="none" strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference.toFixed(2)} strokeDashoffset={offset.toFixed(2)} />}
			</svg>
			{children}
		</span>
	);
}

/** Folder glyph: filled, two layers, in `--folder` (or a tag colour). */
export function FolderGlyph({ size = 40, color }: { readonly size?: number; readonly color?: string | undefined }): ReactElement {
	const front = color ?? "var(--folder)";
	const back = color === undefined ? "var(--folder-stroke)" : `color-mix(in srgb, ${color} 82%, black)`;
	return (
		<svg width={size} height={Math.round(size * 0.8)} viewBox="0 0 50 40" aria-hidden="true">
			<path d="M2 6a4 4 0 0 1 4-4h11.6a4 4 0 0 1 2.8 1.2L23.2 6H44a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill={back} />
			<path d="M2 13a4 4 0 0 1 4-4h38a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill={front} />
		</svg>
	);
}

/** A document page with the extension badge in the kind's tile colour. */
function DocGlyph({ entry, width = 34 }: { readonly entry: FinderEntry; readonly width?: number }): ReactElement {
	const meta = kindMeta(fileKindOf(entry));
	const height = Math.round((width * 44) / 34);
	const badge = (entry.ext || "?").toUpperCase().slice(0, 4);
	return (
		<span className="phone-doc" style={{ width, height }} aria-hidden="true">
			<svg width={width} height={height} viewBox="0 0 34 44">
				<path d="M2.5 3.5A2.5 2.5 0 0 1 5 1h17.5L32 10.5v30A2.5 2.5 0 0 1 29.5 43h-24.5A2.5 2.5 0 0 1 2.5 40.5z" fill="var(--phone-doc)" stroke="var(--phone-doc-edge)" strokeWidth="1" />
				<path d="M22.5 1v7a2.5 2.5 0 0 0 2.5 2.5h7" fill="none" stroke="var(--phone-doc-edge)" strokeWidth="1" />
				<path d="M8 17h18M8 21h18M8 25h12" stroke="var(--phone-doc-edge)" strokeWidth="1.6" strokeLinecap="round" />
			</svg>
			<span className="phone-badge" style={{ background: `var(${meta.tileToken})` }}>{badge}</span>
		</span>
	);
}

/**
 * A row's thumbnail: the OS icon or Quick Look thumbnail once the sidecar has
 * one (the remote bootstrap rewrites it to the thumbnail endpoint), an image's
 * own bytes from the preview endpoint, else a drawn glyph for the kind.
 */
export function Thumb({ entry, previewUrl, tagColor, large = false }: { readonly entry: FinderEntry; readonly previewUrl: string | null; readonly tagColor?: string | undefined; readonly large?: boolean }): ReactElement {
	if (entry.kind === "folder") return <span className="phone-thumb"><FolderGlyph size={large ? 60 : 40} color={tagColor} /></span>;
	const kind = previewKind(entry);
	if (kind === "image" && previewUrl !== null) return <span className="phone-thumb"><img src={previewUrl} alt="" loading="lazy" decoding="async" draggable={false} /></span>;
	if (entry.iconUrl !== undefined) return <span className="phone-thumb"><img className="is-icon" src={entry.iconUrl} alt="" loading="lazy" decoding="async" draggable={false} /></span>;
	if (kind === "audio" || kind === "video") {
		return (
			<span className="phone-thumb">
				<span className="phone-tile-icon" style={{ width: large ? 64 : 44, height: large ? 64 : 44, borderRadius: large ? 13 : 9, background: kind === "audio" ? "linear-gradient(140deg, #FF7FA8, #B23A8A)" : "linear-gradient(140deg, #5B6B8C, #20283C)" }}>
					{kind === "audio" ? <Music size={20} strokeWidth={2.2} /> : <Play size={16} fill="currentColor" strokeWidth={0} />}
				</span>
			</span>
		);
	}
	return <span className="phone-thumb"><DocGlyph entry={entry} width={large ? 48 : 34} /></span>;
}

/** The name with middle truncation: the end before the extension always shows. */
export function EntryName({ entry }: { readonly entry: FinderEntry }): ReactElement {
	const { head, tail } = splitName(entry.name, entry.kind === "folder");
	return (
		<span className="phone-name" title={entry.name}>
			<span className="phone-head">{head}</span>
			{tail === "" ? null : <span className="phone-tail">{tail}</span>}
		</span>
	);
}

export function Check({ on }: { readonly on: boolean }): ReactElement {
	return (
		<span className={cn("phone-check", on && "is-on")} aria-hidden="true">
			{on ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg> : null}
		</span>
	);
}
