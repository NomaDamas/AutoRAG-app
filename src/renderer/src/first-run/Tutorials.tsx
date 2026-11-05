/**
 * The contextual tutorial layer (DESIGN.md §3b): watches where the person goes
 * in the Finder and, the first time they reach automations, a file's
 * right-click menu, or Settings, walks them through it with the same coach
 * marks as the first-run tour. Automations and Magic Actions are taught by
 * making a real example and watching it work: an offer step runs an effect
 * (create the example, drop a file), and later steps wait for the real UI to
 * show the result. Clicks pass through to the real Finder; only the bubble
 * takes input.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { LocaleKey } from "../../../shared/i18n/core";
import { useTranslation } from "../../../shared/i18n";
import { cn } from "../lib/cn";
import { CursorGlyph } from "./cursor";
import { placeBubble, type Rect } from "./tour";
import {
	anchorSelectors,
	markTutorialSeen,
	nextStep,
	grayCopy,
	selectorOf,
	stepsAfter,
	tutorialSeen,
	TUTORIALS,
	type TutorialEffect,
	type TutorialFacts,
	type TutorialId,
	type TutorialStep,
} from "./tutorial-steps";

/** A step whose spotlight target stays gone this long ends the tutorial: the person moved on. */
const ANCHOR_GONE_MS = 4000;
/** A step waiting for something to appear or finish gives up after this long. */
const WAIT_MS = 45_000;
/** The AI writing a rule, or the person dragging a photo, takes longer than a spinner should be trusted for. */
const LONG_WAIT_MS = 180_000;

export interface TutorialTriggers {
	/** The focused pane shows the 자동화 view. */
	readonly automations: boolean;
	/** The right-click menu is open on a file or folder (not empty space). */
	readonly fileMenu: boolean;
	/** The focused pane shows Settings. */
	readonly settings: boolean;
}

interface Running {
	readonly id: TutorialId;
	readonly index: number;
	/** Steps already shown before this one: the "n" of "n / m". The "m" is this plus what the live Finder still has to show. */
	readonly shown: number;
	/** What the effects learned (the sample file's path, where the sorted file goes). */
	readonly facts: TutorialFacts;
}

const present = (selector: string): boolean => document.querySelector(selector) !== null;

function anchorElement(step: TutorialStep, facts: TutorialFacts): Element | null {
	for (const selector of anchorSelectors(step, facts)) {
		const element = document.querySelector(selector);
		if (element !== null) return element;
	}
	return null;
}

function measure(element: Element | null): Rect | null {
	const box = element?.getBoundingClientRect();
	return box === undefined || box.width === 0 || box.height === 0 ? null : { left: box.left, top: box.top, width: box.width, height: box.height };
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
	if (a === null || b === null) return a === b;
	return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** Bring a target that sits outside its scroller into view, once per step. */
function reveal(element: Element): void {
	const box = element.getBoundingClientRect();
	if (box.top >= 0 && box.bottom <= window.innerHeight) return;
	element.scrollIntoView({ block: box.height < window.innerHeight * 0.8 ? "center" : "start", behavior: "smooth" });
}

export function Tutorials({
	enabled,
	triggers,
	onEffect,
}: {
	/** False during the first run, and on profiles that opted out (QA lanes). */
	readonly enabled: boolean;
	readonly triggers: TutorialTriggers;
	/** Does what an offer step promises; resolves with what later steps need, or null when it failed (the tutorial then ends). */
	readonly onEffect: (effect: TutorialEffect, facts: TutorialFacts) => Promise<TutorialFacts | null>;
}): ReactElement | null {
	const [running, setRunning] = useState<Running | null>(null);
	const runningRef = useRef(running);
	runningRef.current = running;
	const previous = useRef<TutorialTriggers>({ automations: false, fileMenu: false, settings: false });

	// Start a tutorial on the rising edge of its trigger: one at a time, once per profile.
	useEffect(() => {
		const before = previous.current;
		previous.current = triggers;
		if (!enabled || runningRef.current !== null) return;
		const start = (id: TutorialId): boolean => {
			if (tutorialSeen(id)) return false;
			const first = nextStep(TUTORIALS[id], -1, false, present);
			if (first === null) return false;
			markTutorialSeen(id);
			setRunning({ id, index: first, shown: 0, facts: {} });
			return true;
		};
		if (triggers.fileMenu && !before.fileMenu && start("contextMenu")) return;
		if (triggers.automations && !before.automations && start("automations")) return;
		if (triggers.settings && !before.settings && typeof window.autorag.remote?.status === "function") start("remoteAccess");
	}, [enabled, triggers]);

	useEffect(() => {
		if (!enabled) setRunning(null);
	}, [enabled]);

	const advance = useCallback((tapped: boolean, learned?: TutorialFacts) => {
		setRunning((current) => {
			if (current === null) return null;
			const facts = learned === undefined ? current.facts : { ...current.facts, ...learned };
			const index = nextStep(TUTORIALS[current.id], current.index, tapped, present, facts);
			return index === null ? null : { ...current, index, shown: current.shown + 1, facts };
		});
	}, []);
	const end = useCallback(() => setRunning(null), []);

	if (running === null) return null;
	const step = TUTORIALS[running.id][running.index];
	if (step === undefined) return null;
	const remaining = stepsAfter(TUTORIALS[running.id], running.index, step.tap !== undefined, present, running.facts);
	return (
		<div className="fr-root" data-screen="tutorial" data-tutorial={running.id}>
			<TutorialCoach
				key={`${running.id}:${step.key}`}
				id={running.id}
				step={step}
				facts={running.facts}
				index={running.shown}
				count={running.shown + 1 + remaining}
				last={nextStep(TUTORIALS[running.id], running.index, false, () => true, running.facts) === null}
				onNext={() => advance(false)}
				onTapped={() => advance(true)}
				onAccept={async (effect) => {
					const learned = await onEffect(effect, running.facts);
					if (learned === null) end();
					else advance(false, learned);
				}}
				onLearned={(learned) => advance(false, learned)}
				onEnter={async (effect) => {
					const learned = await onEffect(effect, running.facts);
					if (learned === null) end();
					else setRunning((current) => (current === null ? null : { ...current, facts: { ...current.facts, ...learned } }));
				}}
				onEnd={end}
			/>
		</div>
	);
}

function TutorialCoach({
	id,
	step,
	facts,
	index,
	count,
	last,
	onNext,
	onTapped,
	onAccept,
	onLearned,
	onEnter,
	onEnd,
}: {
	readonly id: TutorialId;
	readonly step: TutorialStep;
	readonly facts: TutorialFacts;
	readonly index: number;
	readonly count: number;
	readonly last: boolean;
	readonly onNext: () => void;
	readonly onTapped: () => void;
	readonly onAccept: (effect: TutorialEffect) => Promise<void>;
	/** The step saw what it was waiting for and learned something (the black-and-white copy's path). */
	readonly onLearned: (facts: TutorialFacts) => void;
	/** The step brings the person somewhere itself, once, as it comes up. */
	readonly onEnter: (effect: TutorialEffect) => Promise<void>;
	readonly onEnd: () => void;
}): ReactElement | null {
	const { t } = useTranslation();
	const [rect, setRect] = useState<Rect | null>(null);
	const [cursorRect, setCursorRect] = useState<Rect | null>(null);
	const [ready, setReady] = useState(step.waitFor === undefined);
	const [busy, setBusy] = useState(false);
	const [size, setSize] = useState({ width: 320, height: 160 });
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const bubbleRef = useRef<HTMLDivElement>(null);
	const latest = useRef({ onEnd, onTapped, onNext, onLearned, onEnter });
	latest.current = { onEnd, onTapped, onNext, onLearned, onEnter };

	// A step with an `enter` effect takes the person there itself (back to the list the new rule shows in).
	useEffect(() => {
		if (step.enter !== undefined) void latest.current.onEnter(step.enter);
	}, [step]);

	// The AI answer: the step waits for the real search stream to finish; a failure or cancel ends the lesson.
	useEffect(() => {
		if (step.untilEvent !== "aiDone") return;
		const off = window.autorag.search.onEvent?.((event) => {
			if (event.type === "done") window.setTimeout(() => latest.current.onNext(), 600);
			else if (event.type === "error" || event.type === "cancelled") latest.current.onEnd();
		});
		return () => off?.();
	}, [step]);

	// The black-and-white copy: watch the rule's output folder itself (not the DOM, which may show another folder) for a new picture.
	useEffect(() => {
		if (step.watch !== "grayCopy" || facts.gray === undefined) return;
		let live = true;
		let baseline: ReadonlySet<string> | null = null;
		const poll = async (): Promise<void> => {
			let paths: readonly string[] = [];
			try {
				paths = (await window.autorag.fs.listDir(facts.gray as string)).entries.map((entry) => entry.path);
			} catch {
				// The folder does not exist until the rule makes it: that is an empty folder, not a failure.
			}
			if (!live) return;
			if (baseline === null) {
				baseline = new Set(paths);
				return;
			}
			const found = grayCopy(paths, baseline);
			if (found !== null) {
				live = false;
				latest.current.onLearned({ result: found });
			}
		};
		void poll();
		const timer = window.setInterval(() => void poll(), 1000);
		return () => {
			live = false;
			window.clearInterval(timer);
		};
	}, [step, facts]);

	// Follow the live Finder layout every frame: the spotlight, the guide cursor, a wait for something to appear, and a wait for something to finish.
	useEffect(() => {
		let frame = 0;
		let revealed = false;
		let goneSince: number | null = null;
		let started: number | null = null;
		let finished = false;
		const waitFor = selectorOf(step.waitFor, facts);
		const until = selectorOf(step.until, facts);
		const tap = selectorOf(step.tap, facts);
		const tick = (now: number): void => {
			started ??= now;
			const isReady = waitFor === undefined || present(waitFor);
			setReady(isReady);
			const anchor = isReady ? anchorElement(step, facts) : null;
			if (anchor !== null && !revealed) {
				revealed = true;
				reveal(anchor);
			}
			const nextRect = measure(anchor);
			const cursorTarget = tap !== undefined ? document.querySelector(tap) : step.hint !== undefined ? anchor : null;
			const nextCursor = measure(cursorTarget);
			setRect((prev) => (sameRect(prev, nextRect) ? prev : nextRect));
			setCursorRect((prev) => (sameRect(prev, nextCursor) ? prev : nextCursor));
			setViewport((prev) => (prev.width === window.innerWidth && prev.height === window.innerHeight ? prev : { width: window.innerWidth, height: window.innerHeight }));
			if (until !== undefined && isReady && present(until) && !finished) {
				finished = true;
				latest.current.onNext();
				return;
			}
			const waiting = !isReady || until !== undefined || step.untilEvent !== undefined || step.watch !== undefined;
			if (waiting && now - started > (step.watch !== undefined || step.untilEvent !== undefined ? LONG_WAIT_MS : WAIT_MS)) {
				latest.current.onEnd();
				return;
			}
			// An offer keeps asking even after its menu closed; any other step ends once its target is gone for good.
			if (isReady && nextRect === null && step.offer === undefined) {
				goneSince ??= now;
				if (now - goneSince > ANCHOR_GONE_MS) {
					latest.current.onEnd();
					return;
				}
			} else {
				goneSince = null;
			}
			frame = window.requestAnimationFrame(tick);
		};
		frame = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(frame);
	}, [step, facts]);

	// A click-required step moves on when the person clicks the real target (capture: before it re-renders away).
	useEffect(() => {
		const tap = selectorOf(step.tap, facts);
		if (tap === undefined) return;
		const onClick = (event: MouseEvent): void => {
			if (event.target instanceof Element && event.target.closest(tap) !== null) latest.current.onTapped();
		};
		window.addEventListener("click", onClick, true);
		return () => window.removeEventListener("click", onClick, true);
	}, [step, facts]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key === "Escape") latest.current.onEnd();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	useLayoutEffect(() => {
		const element = bubbleRef.current;
		if (element === null) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
	});

	if (!ready) return null;
	const place = placeBubble(rect, viewport, size);
	const pad = 6;
	const spot: CSSProperties =
		rect === null
			? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0, opacity: 0.55 }
			: { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
	const copy = `tutorials.${id}.${step.key}`;
	const offer = step.offer;
	const waiting = step.until !== undefined || step.untilEvent !== undefined || step.watch !== undefined;
	const hintKey: LocaleKey | null =
		step.hint === "rightClick" ? "tutorials.rightClickHint" : step.hint === "drag" ? "tutorials.dragHint" : step.tap !== undefined ? "firstRun.tour.clickHint" : waiting ? "tutorials.waitingHint" : null;
	const accept = (): void => {
		if (offer === undefined || busy) return;
		setBusy(true);
		void onAccept(offer);
	};
	return (
		<div className="fr-tour">
			<div className={cn("fr-spot", rect === null && "fr-spot--none")} style={spot} />
			{cursorRect === null ? null : (
				<div className="fr-cursor" data-tutorial-tap={step.key} style={{ left: cursorRect.left + Math.min(cursorRect.width * 0.34, 96), top: cursorRect.top + cursorRect.height * 0.58 }} aria-hidden="true">
					<span className="fr-cursor-ring" />
					<CursorGlyph />
				</div>
			)}
			<div ref={bubbleRef} className="fr-coach" data-tutorial-step={step.key} data-side={place.side} style={{ left: place.left, top: place.top }} role="dialog" aria-label={t(`${copy}.title` as LocaleKey)}>
				<div className="fr-coach-card">
					<p className="fr-coach-count">{t("firstRun.tour.progress", { index: index + 1, count })}</p>
					<h2 className="fr-coach-title">
						{waiting || busy ? <span className="fr-coach-spinner" aria-hidden="true" /> : null}
						{t(`${copy}.title` as LocaleKey)}
					</h2>
					<p className="fr-coach-body">{t(`${copy}.body` as LocaleKey)}</p>
					<div className="fr-coach-actions">
						{offer === undefined ? (
							<>
								<button type="button" className="fr-link" data-action="tutorial-skip" onClick={onEnd}>
									{t("firstRun.tour.skip")}
								</button>
								{hintKey !== null ? (
									<span className="fr-coach-hint">
										<span className="fr-coach-hint-dot" aria-hidden="true" />
										{t(hintKey)}
									</span>
								) : (
									<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="tutorial-next" onClick={last ? onEnd : onNext}>
										{last ? t("firstRun.tour.finish") : t("firstRun.tour.next")}
									</button>
								)}
							</>
						) : (
							<>
								<button type="button" className="fr-link" data-action="tutorial-later" onClick={onEnd}>
									{t("tutorials.later")}
								</button>
								<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="tutorial-accept" disabled={busy} onClick={accept}>
									{t(`${copy}.action` as LocaleKey)}
								</button>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
