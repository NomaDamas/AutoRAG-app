/**
 * The contextual tutorial layer (DESIGN.md §3b): watches where the person goes
 * in the Finder and, the first time they reach automations, a file's
 * right-click menu, or Settings, walks them through it with the same coach
 * marks as the first-run tour. Clicks pass through to the real Finder; only
 * the bubble takes input.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import type { LocaleKey } from "../../../shared/i18n/core";
import { useTranslation } from "../../../shared/i18n";
import { cn } from "../lib/cn";
import { CursorGlyph } from "./cursor";
import { placeBubble, type Rect } from "./tour";
import { markTutorialSeen, nextStep, stepsInPlay, tutorialSeen, TUTORIALS, type TutorialEffect, type TutorialId, type TutorialStep } from "./tutorial-steps";

/** A step whose spotlight target stays gone this long ends the tutorial: the person moved on. */
const ANCHOR_GONE_MS = 4000;

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
	/** The steps the Finder supported when it started: the "n / m" count stays steady as the view changes under it. */
	readonly plan: readonly number[];
}

const present = (selector: string): boolean => document.querySelector(selector) !== null;

function anchorElement(step: TutorialStep): Element | null {
	for (const selector of step.anchors) {
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
	readonly onEffect: (effect: TutorialEffect) => void;
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
			const plan = stepsInPlay(TUTORIALS[id], present);
			const first = plan[0];
			if (first === undefined) return false;
			markTutorialSeen(id);
			setRunning({ id, index: first, plan });
			return true;
		};
		if (triggers.fileMenu && !before.fileMenu && start("contextMenu")) return;
		if (triggers.automations && !before.automations && start("automations")) return;
		if (triggers.settings && !before.settings && typeof window.autorag.remote?.status === "function") start("remoteAccess");
	}, [enabled, triggers]);

	useEffect(() => {
		if (!enabled) setRunning(null);
	}, [enabled]);

	const advance = useCallback((tapped: boolean) => {
		setRunning((current) => {
			if (current === null) return null;
			const index = nextStep(TUTORIALS[current.id], current.index, tapped, present);
			return index === null ? null : { ...current, index };
		});
	}, []);
	const end = useCallback(() => setRunning(null), []);

	if (running === null) return null;
	const step = TUTORIALS[running.id][running.index];
	if (step === undefined) return null;
	const position = Math.max(0, running.plan.indexOf(running.index));
	return (
		<div className="fr-root" data-screen="tutorial" data-tutorial={running.id}>
			<TutorialCoach
				key={`${running.id}:${step.key}`}
				id={running.id}
				step={step}
				index={position}
				count={running.plan.length}
				last={nextStep(TUTORIALS[running.id], running.index, false, present) === null}
				onNext={() => advance(false)}
				onTapped={() => advance(true)}
				onAccept={(effect) => {
					onEffect(effect);
					advance(false);
				}}
				onEnd={end}
			/>
		</div>
	);
}

function TutorialCoach({
	id,
	step,
	index,
	count,
	last,
	onNext,
	onTapped,
	onAccept,
	onEnd,
}: {
	readonly id: TutorialId;
	readonly step: TutorialStep;
	readonly index: number;
	readonly count: number;
	readonly last: boolean;
	readonly onNext: () => void;
	readonly onTapped: () => void;
	readonly onAccept: (effect: TutorialEffect) => void;
	readonly onEnd: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [rect, setRect] = useState<Rect | null>(null);
	const [tapRect, setTapRect] = useState<Rect | null>(null);
	const [size, setSize] = useState({ width: 320, height: 160 });
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const bubbleRef = useRef<HTMLDivElement>(null);
	const latest = useRef({ onEnd, onTapped });
	latest.current = { onEnd, onTapped };

	// Follow the live Finder layout every frame; reveal the target once; give up when it stays gone.
	useEffect(() => {
		let frame = 0;
		let revealed = false;
		let goneSince: number | null = null;
		const tick = (now: number): void => {
			const anchor = anchorElement(step);
			if (anchor !== null && !revealed) {
				revealed = true;
				reveal(anchor);
			}
			const nextRect = measure(anchor);
			const nextTap = step.tap === undefined ? null : measure(document.querySelector(step.tap));
			setRect((prev) => (sameRect(prev, nextRect) ? prev : nextRect));
			setTapRect((prev) => (sameRect(prev, nextTap) ? prev : nextTap));
			setViewport((prev) => (prev.width === window.innerWidth && prev.height === window.innerHeight ? prev : { width: window.innerWidth, height: window.innerHeight }));
			// An offer keeps asking even after its menu closed; any other step ends once its target is gone for good.
			if (nextRect === null && step.offer === undefined) {
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
	}, [step]);

	// A click-required step moves on when the person clicks the real target (capture: before it re-renders away).
	useEffect(() => {
		const tap = step.tap;
		if (tap === undefined) return;
		const onClick = (event: MouseEvent): void => {
			if (event.target instanceof Element && event.target.closest(tap) !== null) latest.current.onTapped();
		};
		window.addEventListener("click", onClick, true);
		return () => window.removeEventListener("click", onClick, true);
	}, [step]);

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

	const place = placeBubble(rect, viewport, size);
	const pad = 6;
	const spot: CSSProperties =
		rect === null
			? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0, opacity: 0.55 }
			: { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
	const copy = `tutorials.${id}.${step.key}`;
	const offer = step.offer;
	return (
		<div className="fr-tour">
			<div className={cn("fr-spot", rect === null && "fr-spot--none")} style={spot} />
			{tapRect === null ? null : (
				<div className="fr-cursor" data-tutorial-tap={step.key} style={{ left: tapRect.left + tapRect.width * 0.52, top: tapRect.top + tapRect.height * 0.58 }} aria-hidden="true">
					<span className="fr-cursor-ring" />
					<CursorGlyph />
				</div>
			)}
			<div ref={bubbleRef} className="fr-coach" data-tutorial-step={step.key} data-side={place.side} style={{ left: place.left, top: place.top }} role="dialog" aria-label={t(`${copy}.title` as LocaleKey)}>
				<div className="fr-coach-card">
					<p className="fr-coach-count">{t("firstRun.tour.progress", { index: index + 1, count })}</p>
					<h2 className="fr-coach-title">{t(`${copy}.title` as LocaleKey)}</h2>
					<p className="fr-coach-body">{t(`${copy}.body` as LocaleKey)}</p>
					<div className="fr-coach-actions">
						{offer === undefined ? (
							<>
								<button type="button" className="fr-link" data-action="tutorial-skip" onClick={onEnd}>
									{t("firstRun.tour.skip")}
								</button>
								{step.tap === undefined ? (
									<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="tutorial-next" onClick={last ? onEnd : onNext}>
										{last ? t("firstRun.tour.finish") : t("firstRun.tour.next")}
									</button>
								) : (
									<span className="fr-coach-hint">
										<span className="fr-coach-hint-dot" aria-hidden="true" />
										{t("firstRun.tour.clickHint")}
									</span>
								)}
							</>
						) : (
							<>
								<button type="button" className="fr-link" data-action="tutorial-later" onClick={onEnd}>
									{t("tutorials.later")}
								</button>
								<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="tutorial-accept" onClick={() => onAccept(offer)}>
									{t("tutorials.learn")}
								</button>
							</>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
