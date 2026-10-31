/**
 * Small presentational pieces shared by the onboarding steps. Each mirrors a
 * prototype helper (`split`, `sourceTile`, `brandChip`, `permissionRow`,
 * `renderFooter`'s dashes) so the emitted DOM matches `onboarding.css`.
 */

import type { ReactElement, ReactNode } from "react";
import type { SourceId } from "../../../shared/onboarding-contract";
import { cn } from "../lib/cn";
import { Icon, BrandMark, brandVars } from "./marks";
import { sourceTile, type TipArt as TipArtShape, type Translate } from "./flow";

interface MultilineProps {
	readonly text: string;
}

/** Renders a locale string whose "\n" stands for a line break (the prototype's `<br>`). */
export function Multiline({ text }: MultilineProps): ReactElement {
	const lines = text.split("\n");
	return (
		<>
			{lines.map((line, i) => (
				<span key={i}>
					{i > 0 ? <br /> : null}
					{line}
				</span>
			))}
		</>
	);
}

interface SplitScreenProps {
	readonly copy: ReactNode;
	readonly children: ReactNode;
}

/** The prototype's `split(copy, content)`. */
export function SplitScreen({ copy, children }: SplitScreenProps): ReactElement {
	return (
		<section className="screen split">
			<div className="screen-copy">{copy}</div>
			<div className="content-panel">{children}</div>
		</section>
	);
}

interface EyebrowProps {
	readonly icon: string;
	readonly warn?: boolean;
	readonly children: ReactNode;
}

/** `<span class="eyebrow">` with its leading glyph. */
export function Eyebrow({ icon, warn, children }: EyebrowProps): ReactElement {
	return (
		<span className={cn("eyebrow", warn && "warn")}>
			<Icon name={icon} size={12} /> {children}
		</span>
	);
}

/**
 * Opens a URL in the system browser through the fs bridge's `openUrl`
 * (`file:`/`javascript:` never reach it). A no-op until the bridge exists, so a
 * step still renders while the window is coming up.
 */
export function openExternal(url: string | null | undefined): void {
	if (typeof url !== "string" || url.length === 0) return;
	const open = window.autorag?.fs?.openUrl;
	if (typeof open === "function") void open(url);
}

interface SourceIconProps {
	readonly id: SourceId;
}

/** The prototype's `sourceTile(s)`: a brand mark or a colour-keyed glyph. */
export function SourceIcon({ id }: SourceIconProps): ReactElement {
	const tile = sourceTile(id);
	if (tile.brand !== undefined) {
		return (
			<span className="source-icon brand" style={brandVars(tile.brand)}>
				<BrandMark name={tile.brand} size={17} />
			</span>
		);
	}
	return (
		<span className={cn("source-icon", tile.color)}>
			<Icon name={tile.icon} size={16} />
		</span>
	);
}

interface BrandChipProps {
	readonly brand: string;
	readonly label: string;
}

/** The prototype's `brandChip(n, label)`. */
export function BrandChip({ brand, label }: BrandChipProps): ReactElement {
	return (
		<span className="brand-chip" style={brandVars(brand)}>
			<BrandMark name={brand} size={12} />
			{label}
		</span>
	);
}

interface SwitchProps {
	readonly on: boolean;
	readonly disabled?: boolean;
	readonly label: string;
	readonly onClick: () => void;
}

/** The prototype's `<button class="switch">` toggle. */
export function Switch({ on, disabled, label, onClick }: SwitchProps): ReactElement {
	return (
		<button
			type="button"
			className={cn("switch", on && "on")}
			disabled={disabled}
			aria-label={label}
			onClick={onClick}
		/>
	);
}

interface PermissionRowProps {
	readonly icon: string;
	readonly tone?: string;
	readonly name: string;
	readonly tag?: string;
	readonly tagTone?: string;
	readonly desc?: ReactNode;
	readonly action: ReactNode;
}

/** The prototype's `permissionRow(o)`. */
export function PermissionRow({ icon, tone, name, tag, tagTone, desc, action }: PermissionRowProps): ReactElement {
	return (
		<div className="permission-row">
			<div className={cn("permission-icon", tone)}>
				<Icon name={icon} size={17} />
			</div>
			<div className="permission-main">
				<div className="permission-name">
					{tag !== undefined ? <span className={cn("tag", tagTone ?? "opt")}>{tag}</span> : null}
					{name}
				</div>
				{desc !== undefined ? <div className="permission-desc">{desc}</div> : null}
			</div>
			<div className="row-action">{action}</div>
		</div>
	);
}

interface TipArtProps {
	readonly platform: string;
	readonly art: TipArtShape;
	readonly t: Translate;
}

/** Renders one tip's illustration, matching the prototype's `art` strings. */
export function TipArt({ platform, art, t }: TipArtProps): ReactElement {
	switch (art.kind) {
		case "shortcut": {
			const keys = art.mod ? [platform === "win32" ? "Ctrl" : "⌘", art.key] : [art.key];
			return (
				<div className="keys">
					{keys.map((key, i) => (
						<span key={i} className={cn("keycap", key.length > 4 && "wide")}>
							{key}
						</span>
					))}
				</div>
			);
		}
		case "space":
			return (
				<div className="keys">
					<span className="keycap wide">Space</span>
				</div>
			);
		case "bubble":
			return (
				<div className="ix-mini">
					<div className="ix-bubble">
						{t("onboarding.tips.2.bubble")}
						<span className="ix-cite hot">budget.xlsx · 4</span>
						<span className="ix-cite">{t("finderComponents.onboardingDemo.meetingNotes")} · 2</span>
					</div>
				</div>
			);
		case "drag":
			return (
				<div className="ix-drag">
					<span className="tile">PDF</span>
					<Icon name="arrow-right" size={14} />
					<span className="pill">{t("onboarding.tips.4.pill")}</span>
				</div>
			);
		case "versions":
			return (
				<div className="ix-mini">
					<div className="row">
						<span className="vtag latest">{t("onboarding.tips.5.latest")}</span>proposal-final.docx
					</div>
					<div className="row">
						<span className="vtag near">{t("onboarding.tips.5.near")}</span>proposal-v3.docx
					</div>
					<div className="row dim">
						<span className="vtag exact">{t("onboarding.tips.5.exact")}</span>proposal (1).docx
					</div>
				</div>
			);
		case "brands":
			return (
				<div className="ix-brands">
					{["slack", "github", "obsidian", "notion", "googledrive", "apple"].map((name) => (
						<span key={name} style={brandVars(name)}>
							<BrandMark name={name} size={16} />
						</span>
					))}
				</div>
			);
	}
}
