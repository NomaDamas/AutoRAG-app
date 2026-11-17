import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AnswerChange } from "../../../shared/answer-revision";
import { cn } from "../lib/cn";

/**
 * Motion of one correction (design preview `ai-search-staged-loading.html`, "답이 고쳐질 때"): the new words arrive
 * marked in the sun colour with the struck words beside them; after `SETTLE_MS` the mark fades to an underline and the
 * struck words collapse away. A retracted claim has no new words, so it stays struck: the person should still see what
 * was withdrawn.
 */
const SETTLE_MS = 2_600;
/** The struck words' collapse (`--dur-revision-strike`); they leave the DOM when it is over. */
const STRIKE_MS = 500;

/** `prefers-reduced-motion: reduce` is read when the motion would start, so the OS setting applies live. */
function reducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Stage = "fresh" | "settled" | "gone";

/** The struck words without the `[n]` markers the claim carried: the person sees what was said, not its sources. */
export function struckWords(deleted: string): string {
	return deleted.replace(/\s*\[\d+\]/gu, "").trim();
}

export function AnswerRevisionMark({
	change,
	animate,
	children,
}: {
	readonly change: AnswerChange;
	/** A correction that has just arrived moves; one read back from history is already settled. */
	readonly animate: boolean;
	/** The new words, drawn by the caller with its own citation chips. */
	readonly children: ReactNode;
}): ReactElement {
	const [stage, setStage] = useState<Stage>("fresh");
	const moves = animate && !reducedMotion();
	useEffect(() => {
		if (!moves) return;
		const settle = setTimeout(() => setStage("settled"), SETTLE_MS);
		const leave = setTimeout(() => setStage("gone"), SETTLE_MS + STRIKE_MS);
		return () => {
			clearTimeout(settle);
			clearTimeout(leave);
		};
	}, [moves]);
	const current: Stage = moves ? stage : "gone";
	const replaced = change.kind === "replace";
	const struck = struckWords(change.deleted);
	const showStruck = struck !== "" && (change.kind === "retract" || (replaced && current !== "gone"));
	return (
		<span data-revision={change.kind} title={change.reason}>
			{showStruck ? (
				<del
					data-fading={replaced && current === "settled" ? "true" : "false"}
					className={cn(
						"mr-4 inline-block align-bottom text-ink-muted decoration-[1.5px] transition-[max-width,opacity,margin] duration-(--dur-revision-strike) ease-(--ease-disclosure)",
						replaced && current === "settled" ? "mr-0 max-w-0 overflow-hidden opacity-0" : "max-w-full",
					)}
				>
					{struck}
				</del>
			) : null}
			{change.kind === "retract" ? null : (
				<ins
					data-settled={current === "fresh" ? "false" : "true"}
					className={cn(
						"rounded-3 px-2 no-underline transition-[background,box-shadow] duration-(--dur-revision-mark) ease-out",
						current === "fresh" ? "bg-ql-evidence-mark" : "bg-transparent shadow-[inset_0_-2px_0_var(--ql-evidence-mark)]",
					)}
				>
					{children}
				</ins>
			)}
		</span>
	);
}

/** The line over a corrected Quick answer: the librarian changed what the person already read. */
export function RevisionHead(): ReactElement {
	const { t } = useTranslation();
	return <div className="text-body leading-[1.55] font-semibold text-ink">{t("aiSearch.revised")}</div>;
}
