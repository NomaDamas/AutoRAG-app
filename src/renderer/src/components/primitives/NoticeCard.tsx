import { X } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { iconButtonClass } from "./icon-button";

export type NoticeTone = "warning" | "error" | "ok";

/**
 * The 16px status badge every notice leads with (Figma Icon/warning, Icon/error): a filled circle with the mark in
 * it, so the colour sits in the badge and the card itself stays neutral.
 */
export function NoticeBadge({ tone, size = 16 }: { readonly tone: NoticeTone; readonly size?: number }): ReactElement {
	const fill = tone === "warning" ? "var(--notice-warn-badge)" : tone === "error" ? "var(--danger-dot)" : "var(--ok-dot)";
	const mark = tone === "warning" ? "#1D1D1F" : "#FFFFFF";
	return (
		<svg className="notice-badge flex-none" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" data-tone={tone}>
			<circle cx="8" cy="8" r="8" fill={fill} />
			{tone === "warning" ? (
				<>
					<path d="M8 4.2v4.6" stroke={mark} strokeWidth="1.6" strokeLinecap="round" />
					<circle cx="8" cy="11.4" r="0.95" fill={mark} />
				</>
			) : tone === "error" ? (
				<path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke={mark} strokeWidth="1.6" strokeLinecap="round" />
			) : (
				<path d="M5 8.2l2 2 4-4.2" fill="none" stroke={mark} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
			)}
		</svg>
	);
}

export interface NoticeAction {
	readonly label: ReactNode;
	readonly onClick: () => void;
	readonly primary?: boolean;
	readonly icon?: ReactNode;
	readonly disabled?: boolean;
}

/** Figma Button, size 32 (28 on the compact card): the secondary is white with the border, the primary the accent fill. */
export function noticeButtonClass(primary: boolean, compact = false): string {
	return cn(
		"notice-btn inline-flex flex-none items-center justify-center gap-6 rounded-6 border text-meta font-medium leading-[16px] whitespace-nowrap cursor-pointer transition-opacity duration-(--dur-color) ease-out hover:opacity-80",
		compact ? "h-28 px-10" : "h-32 px-12",
		primary ? "border-transparent bg-accent text-on-accent" : "border-border bg-window text-ink-body",
	);
}

/**
 * The one notice card every error and notice uses (Figma 548:14204): a status badge and a bold title, the plain-words
 * explanation under it, and the actions at the bottom right. `floating` lifts it with the dialog shadow (a notice
 * over the content); without it the card sits in the flow, like a run's error in the conversation. `footer` takes
 * the bottom-left slot (자세히 보기).
 */
export function NoticeCard({
	tone,
	title,
	children,
	actions = [],
	footer,
	onClose,
	floating = false,
	compact = false,
	role = "alert",
	className,
}: {
	readonly tone: NoticeTone;
	readonly title: ReactNode;
	readonly children?: ReactNode;
	readonly actions?: readonly NoticeAction[];
	readonly footer?: ReactNode;
	readonly onClose?: () => void;
	readonly floating?: boolean;
	/**
	 * The one-line notice (Figma 641:13722, the index notice): 12px radius and vertical padding, the badge, a 13px
	 * medium line and the × centred on one 28px row, and 28px buttons.
	 */
	readonly compact?: boolean;
	readonly role?: "alert" | "status";
	readonly className?: string;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div
			className={cn(
				"notice-card flex flex-col gap-12 px-16 border border-border bg-window text-ink",
				compact ? "py-12 rounded-12" : "py-14 rounded-14",
				floating && "shadow-[var(--shadow-notice)]",
				className,
			)}
			role={role}
			data-tone={tone}
		>
			{/* Figma 548:14204: the badge and the close button stay on the title's first line when the title wraps. */}
			<div className={cn("notice-card__head flex gap-12", compact ? "min-h-28 items-center" : "items-start")}>
				<span className={cn("flex flex-none", !compact && "mt-2")}>
					<NoticeBadge tone={tone} />
				</span>
				<strong className={cn("min-w-0 flex-1 leading-[20px] text-ink break-keep", compact ? "text-[13px] font-medium" : "text-[14px] font-bold")}>{title}</strong>
				{onClose === undefined ? null : (
					<button
						type="button"
						className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "size-24 -mr-4 flex-none", !compact && "-mt-2")}
						aria-label={t("common.close")}
						title={t("common.close")}
						onClick={onClose}
					>
						<X size={14} strokeWidth={1.8} />
					</button>
				)}
			</div>
			{children === undefined || children === null ? null : (
				<div className="notice-card__copy min-w-0 select-text text-meta leading-[1.5] text-ink-muted break-words">{children}</div>
			)}
			{actions.length === 0 && footer === undefined ? null : (
				<div className="notice-card__actions flex flex-wrap items-end gap-8">
					{footer === undefined ? null : <div className="min-w-0 self-end">{footer}</div>}
					<span className="flex-1" />
					{actions.map((action, index) => (
						<button key={index} type="button" className={cn(noticeButtonClass(action.primary === true, compact), "disabled:cursor-default disabled:opacity-50")} disabled={action.disabled === true} onClick={action.onClick}>
							{action.icon}
							{action.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
