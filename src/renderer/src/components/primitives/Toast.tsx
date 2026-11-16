import { X } from "lucide-react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { iconButtonClass } from "./icon-button";
import { NoticeBadge } from "./NoticeCard";

export type ToastTone = "ok" | "error";

/**
 * Bottom-center toast (Figma 554:7353): the status badge, one line, an optional blue link (the 자동화 tab's 실행 취소),
 * and a close button. A new message replaces the current one and it auto-hides after --time-toast; the live region is
 * the only way the message reaches a screen reader (DESIGN.md §8 constraint 6). Its owner decides how long it stays.
 */
export function Toast({
	message,
	tone = "ok",
	action,
	onClose,
}: {
	readonly message: string;
	readonly tone?: ToastTone;
	readonly action?: { readonly label: string; readonly onAction: () => void } | undefined;
	readonly onClose?: () => void;
}): ReactElement {
	const { t } = useTranslation();
	return (
		// The centring offset is an arbitrary `transform`, not `-translate-x-1/2`:
		// Tailwind's translate utilities emit the `translate` property, which would
		// *compose* with the `rise` keyframe's `transform`. The reference uses
		// `transform: translateX(-50%)`, where the running animation overrides it,
		// so the two must stay in the same property to behave identically.
		<output
			className={cn(
				"toast absolute left-1/2 bottom-24 z-30 flex max-w-[min(560px,calc(100%-32px))] items-center gap-10 py-10 pl-14 border border-border rounded-10 bg-window shadow-[var(--shadow-toast)] text-ink text-[13px] [transform:translateX(-50%)] animate-rise",
				onClose === undefined ? "pr-14" : "pr-10",
			)}
			aria-live="polite"
			data-tone={tone}
		>
			<NoticeBadge tone={tone} />
			<span className="min-w-0 truncate">{message}</span>
			{action === undefined ? null : (
				<button
					type="button"
					className="flex-none p-0 border-0 bg-transparent text-accent-text text-meta leading-[16px] underline cursor-pointer whitespace-nowrap"
					onClick={action.onAction}
				>
					{action.label}
				</button>
			)}
			{onClose === undefined ? null : (
				<button
					type="button"
					className={cn(iconButtonClass({ size: "size-icon-sm", tone: "text-ink-muted" }), "size-24 ml-6")}
					aria-label={t("common.close")}
					title={t("common.close")}
					onClick={onClose}
				>
					<X size={14} strokeWidth={1.8} />
				</button>
			)}
		</output>
	);
}
