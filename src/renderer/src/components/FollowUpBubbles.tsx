import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "../../../shared/i18n";
import { cn } from "../lib/cn";
import type { SteerItem } from "../state/steering";
import { ArrowUpIcon, BubbleCloseIcon, CheckIcon, ClockIcon, CopyIcon, PencilIcon, TrashIcon } from "./icons";

/**
 * The bubbles of a chat's follow-ups, in the AI 에이전트 tab and in the sidebar chat. What a bubble is shows in how it
 * is drawn, and what can be done with it sits in icons right under it, each named by a tooltip:
 * - a correction being worked in is a dimmed bubble (미루기 and 취소 while it has not been sent yet);
 * - a question waiting for the answer to end is a dashed outline (지금 반영, 수정, 삭제);
 * - a sent bubble is solid, and shows 복사 under the pointer.
 */

const COPIED_MS = 1_500;

function BubbleAction({ label, onClick, children }: { readonly label: string; readonly onClick: () => void; readonly children: ReactNode }): ReactElement {
	return (
		<button
			type="button"
			className="group/action relative grid h-22 w-24 flex-none cursor-pointer place-items-center rounded-6 border-0 bg-transparent p-0 text-ink-muted hover:bg-hover-strong hover:text-ink"
			aria-label={label}
			onClick={onClick}
		>
			{children}
			{/* Right-aligned to its button, so the last icon's tip never runs off the chat's edge. */}
			<span
				role="tooltip"
				className="pointer-events-none absolute right-0 top-full z-20 mt-4 whitespace-nowrap rounded-8 bg-ink-body px-8 py-4 text-meta leading-[18px] text-window opacity-0 group-hover/action:opacity-100 group-focus-visible/action:opacity-100"
			>
				{label}
			</span>
		</button>
	);
}

function ActionRow({ children, className }: { readonly children: ReactNode; readonly className?: string }): ReactElement {
	return <div className={cn("bubble-actions -mr-4 flex justify-end", className)}>{children}</div>;
}

/**
 * The 복사 under a sent bubble. It shows while the pointer (or the keyboard) is on the bubble or the row, and always on
 * a touch screen; the row keeps its height, so nothing moves when it appears. The column around it is the `group/bubble`.
 */
export function SentActions({ text, className }: { readonly text: string; readonly className?: string }): ReactElement {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = (): void => {
		void navigator.clipboard.writeText(text).then(
			() => {
				setCopied(true);
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setCopied(false), COPIED_MS);
			},
			(error: unknown) => console.warn("copy failed", error),
		);
	};
	return (
		<ActionRow className={cn("opacity-0 group-hover/bubble:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100", className)}>
			<BubbleAction label={t(copied ? "aiSearch.followUp.copied" : "aiSearch.followUp.copy")} onClick={copy}>
				{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
			</BubbleAction>
		</ActionRow>
	);
}

/** A correction sent while the run streamed, right-aligned like the question. The run ended before taking it: struck through, and it says so. */
export function SteerBubble({
	steer,
	compact = false,
	onPostpone,
	onCancel,
}: {
	readonly steer: SteerItem;
	/** The sidebar chat's smaller bubble. */
	readonly compact?: boolean;
	/** While held: leave it for the next question instead. */
	readonly onPostpone?: ((id: string) => void) | undefined;
	/** While held: do not send it at all. */
	readonly onCancel?: ((id: string) => void) | undefined;
}): ReactElement {
	const { t } = useTranslation();
	const waiting = steer.status === "held" || steer.status === "pending";
	const label = waiting ? t("aiSearch.steerPending") : steer.status === "delivered" ? t("aiSearch.steerDelivered") : t("aiSearch.steerDropped");
	return (
		<div className="message steer-msg flex justify-end animate-rise" data-steer-status={steer.status}>
			<div className={cn("group/bubble flex flex-col items-end gap-2", compact ? "max-w-[90%]" : "max-w-bubble-max")}>
				<div
					className={cn(
						"bubble steer-bubble rounded-[16px] bg-ink-body text-window break-words whitespace-pre-wrap transition-opacity duration-(--dur-color) ease-out",
						compact ? "px-12 py-8 text-sm leading-[1.5]" : "px-16 py-10 text-body leading-[21px]",
						waiting && "opacity-50",
						steer.status === "dropped" && "line-through opacity-50",
					)}
				>
					{steer.text}
				</div>
				{steer.status === "held" && onPostpone !== undefined && onCancel !== undefined ? (
					<ActionRow>
						<BubbleAction label={t("aiSearch.followUp.postpone")} onClick={() => onPostpone(steer.id)}>
							<ClockIcon size={14} />
						</BubbleAction>
						<BubbleAction label={t("aiSearch.followUp.cancel")} onClick={() => onCancel(steer.id)}>
							<BubbleCloseIcon size={14} />
						</BubbleAction>
					</ActionRow>
				) : null}
				{steer.status === "delivered" ? <SentActions text={steer.text} /> : null}
				{/* The look says it; the words are for a screen reader, except for a correction that never reached the answer. */}
				<span className={cn("steer-status", steer.status === "dropped" ? "text-tile text-ink-muted" : "sr-only")} role="status">
					{label}
				</span>
			</div>
		</div>
	);
}

/** A question waiting for the answer in flight to end; it is asked then, or worked into that answer now. */
export function QueuedBubble({
	text,
	compact = false,
	onSendNow,
	onEdit,
	onRemove,
}: {
	readonly text: string;
	readonly compact?: boolean;
	/** Absent while no run can take it. */
	readonly onSendNow?: (() => void) | undefined;
	/** Back into the composer. */
	readonly onEdit: () => void;
	readonly onRemove: () => void;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className={cn("queued-question group/bubble flex flex-col items-end gap-2 self-end animate-rise", compact ? "max-w-[90%]" : "max-w-bubble-max")}>
			<div
				className={cn(
					"queued-bubble rounded-[16px] border border-dashed border-border-strong bg-window text-ink-body break-words whitespace-pre-wrap",
					compact ? "px-11 py-7 text-sm leading-[1.5]" : "px-15 py-9 text-body leading-[21px]",
				)}
			>
				<span className="sr-only">{t("aiSearch.queuedLabel")} </span>
				{text}
			</div>
			<ActionRow>
				{onSendNow === undefined ? null : (
					<BubbleAction label={t("aiSearch.followUp.now")} onClick={onSendNow}>
						<ArrowUpIcon size={14} />
					</BubbleAction>
				)}
				<BubbleAction label={t("aiSearch.followUp.edit")} onClick={onEdit}>
					<PencilIcon size={14} />
				</BubbleAction>
				<BubbleAction label={t("aiSearch.followUp.remove")} onClick={onRemove}>
					<TrashIcon size={14} />
				</BubbleAction>
			</ActionRow>
		</div>
	);
}
