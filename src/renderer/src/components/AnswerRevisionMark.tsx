import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { AnswerChange } from "../../../shared/answer-revision";
import { cn } from "../lib/cn";

/**
 * Motion of one correction (design preview `ai-search-staged-loading.html`, "답이 고쳐질 때"). Three kinds, three looks:
 *
 * - replace: the new words arrive marked in the sun colour with the struck words beside them; after `SETTLE_MS` the mark
 *   fades to an underline and the struck words collapse away.
 * - retract: nothing replaces the claim, so it stays struck: the person should still see what was withdrawn.
 * - add: no claim of the first answer changes, so nothing is struck and the sun colour (which says "this was
 *   changed") is not used. The finding rises in as its own block on an accent rail; after `SETTLE_MS` the wash fades and
 *   the rail stays, so the added part stays findable.
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
	const rootRef = useRef<HTMLSpanElement>(null);
	const struckRef = useRef<HTMLModElement>(null);
	// How the struck words and the new ones share the line, decided once from what really fits (a text reflow cannot be
	// animated, so the layout must not change between two different line counts while the motion runs):
	//   "line"  the struck words and the new ones fit on one line together: the struck words' measured width runs out to
	//           0 and nothing below moves;
	//   "block" they do not: the struck words sit on a line above the new ones. Their measured height grows from what keeps
	//           the row as tall as the claim was when the correction arrives, then runs to 0 when it settles, so the lines
	//           below glide instead of jumping.
	const [mode, setMode] = useState<"line" | "block" | null>(null);
	const [px, setPx] = useState<number | null>(null);
	const [entered, setEntered] = useState(false);
	const [from, setFrom] = useState(0);
	useLayoutEffect(() => {
		const root = rootRef.current;
		const struckEl = struckRef.current;
		if (root === null || struckEl === null || !moves || change.kind !== "replace") return;
		const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight);
		const wraps = lineHeight > 0 && root.getBoundingClientRect().height > lineHeight * 1.5;
		const width = Math.ceil(struckEl.getBoundingClientRect().width);
		setMode(wraps ? "block" : "line");
		setPx(wraps || width <= 0 ? null : width);
	}, [moves, change.kind, change.deleted]);
	useLayoutEffect(() => {
		const struckEl = struckRef.current;
		if (mode !== "block" || px !== null || struckEl === null) return;
		const height = Math.ceil(struckEl.getBoundingClientRect().height);
		const lineHeight = Number.parseFloat(getComputedStyle(struckEl).lineHeight);
		if (height <= 0) return;
		setPx(height);
		// The claim the person was reading took `height`; the new words add one line below the struck ones, so the struck
		// ones start one line shorter and the row keeps the height it had when the correction arrives.
		setFrom(lineHeight > 0 ? Math.max(0, Math.round(height - lineHeight)) : 0);
	}, [mode, px]);
	useEffect(() => {
		if (!moves) return;
		const id = setTimeout(() => setEntered(true), 30);
		return () => clearTimeout(id);
	}, [moves]);
	const current: Stage = moves ? stage : "gone";
	if (change.kind === "add") {
		return (
			<span
				data-revision="add"
				title={change.reason}
				className={cn(
					"block rounded-r-4 border-l-2 py-2 pl-8 transition-[background,border-color] duration-(--dur-revision-mark) ease-out",
					current === "fresh" ? "border-accent bg-accent-chat-mark" : "border-accent-soft bg-transparent",
					moves && "animate-[rise_var(--dur-revision-strike)_var(--ease-out)]",
				)}
			>
				<ins data-settled={current === "fresh" ? "false" : "true"} className="no-underline">
					{children}
				</ins>
			</span>
		);
	}
	const replaced = change.kind === "replace";
	const struck = struckWords(change.deleted);
	const showStruck = struck !== "" && (change.kind === "retract" || (replaced && current !== "gone"));
	const leaving = replaced && current === "settled";
	const block = replaced && mode === "block";
	const line = replaced && mode === "line" && px !== null;
	const hidden = leaving || (block && !entered);
	let style: { maxWidth: number } | { maxHeight: number } | undefined;
	if (line) style = { maxWidth: hidden ? 0 : px };
	else if (block && px !== null) style = { maxHeight: leaving ? 0 : entered ? px : from };
	return (
		<span ref={rootRef} data-revision={change.kind} title={change.reason}>
			{showStruck ? (
				<del
					ref={struckRef}
					data-fading={leaving ? "true" : "false"}
					style={style}
					className={cn(
						"align-bottom text-ink-muted decoration-[1.5px] transition-[max-width,max-height,opacity,margin] duration-(--dur-revision-strike) ease-in-out",
						block ? "block overflow-hidden" : "mr-4 inline-block",
						line && "whitespace-nowrap overflow-hidden",
						hidden && "opacity-0",
						hidden && line && "mr-0",
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
