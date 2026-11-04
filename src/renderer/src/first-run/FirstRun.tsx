/**
 * The first-run layer over the Finder window (DESIGN.md §3a). It asks for
 * nothing: one progress bar while the main process sets everything up (macOS
 * prompts per folder as each default folder is read), then "모두 준비되었어요!"
 * and a guided tour over the real Finder, and the plans sheet last.
 *
 * The Finder is mounted (and usable) behind the layer the whole time; the
 * layer drives it only through {@link FirstRunHost}.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { isPaidPlanId, type AccountPlanId, type AccountStatus } from "../../../shared/account-contract";
import { APP_NAME } from "../../../shared/app-info";
import type { SetupStatus } from "../../../shared/onboarding-contract";
import { useTranslation } from "../../../shared/i18n";
import dazziLogo from "../assets/dazzi-logo.png";
import { cn } from "../lib/cn";
import { hostPlatform } from "../lib/shortcuts";
import type { VersionFamilyData } from "../state/version-family";
import { MineGame } from "./MineGame";
import { initialScreen, nextStep, pickTourFamily, placeBubble, tourSteps, type FirstRunScreen, type Rect, type TourStepId } from "./tour";

/** What the layer needs from the Finder window it sits on. */
export interface FirstRunHost {
	/** Split the window: the current folder on the left, AI Search on the right, inspector and sidebar shown. */
	arrange(): void;
	/** Put `text` in the AI Search composer and focus it. */
	typeDraft(text: string): void;
	/** Show the family's newest copy, selected, in the folder pane, and focus that pane. */
	showFamily(family: VersionFamilyData): void;
	versionFamilies(): Promise<readonly VersionFamilyData[]>;
	/** The folder the focused pane shows, or null. */
	folderPath(): string | null;
	/** True while the layer covers the Finder completely (the Finder is inert meanwhile). */
	setCovered(covered: boolean): void;
}

const onboarding = (): typeof window.autorag.onboarding => window.autorag.onboarding;

/** The visible AI Search panel (one AI host per tab; hidden ones carry `.hidden`). */
const AI_HOST = "[data-ai-tab]:not(.hidden)";

const DESK_MOTION_MS = 1100;
const CINEMA_IN_MS = 650;
const CINEMA_OUT_MS = 3700;
/** The title and the floating logo fade out this long before the board and the moved progress bar come in. */
const INTRO_FADE_MS = 340;

type DeskMode = "cover" | "rise" | null;

function setDeskMode(mode: DeskMode): void {
	if (mode === null) delete document.documentElement.dataset.firstRun;
	else document.documentElement.dataset.firstRun = mode;
}

function isTextTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.tagName === "SELECT";
}

export function FirstRun({ host, onDone }: { readonly host: FirstRunHost; readonly onDone: () => void }): ReactElement | null {
	const [screen, setScreen] = useState<FirstRunScreen | null>(null);
	const [status, setStatus] = useState<SetupStatus | null>(null);
	const [platform] = useState(hostPlatform);
	const [leaving, setLeaving] = useState(false);
	/** The person tapped the logo: the setup screen is a game board until they start the app. */
	const [playing, setPlaying] = useState(false);
	const hostRef = useRef(host);
	hostRef.current = host;

	useEffect(() => {
		let live = true;
		void onboarding()
			.load()
			.then(async (snapshot) => {
				if (!live) return;
				if (!snapshot.pending) {
					onDone();
					return;
				}
				const current = await onboarding().status();
				if (!live) return;
				setStatus(current);
				setScreen(initialScreen(current));
			})
			.catch((error: unknown) => console.error("[first-run] load failed", error));
		const off = onboarding().onProgress((next) => {
			if (live) setStatus(next);
		});
		return () => {
			live = false;
			off();
		};
	}, [onDone]);

	const covering = screen === "setup" || screen === "ready";
	useEffect(() => {
		hostRef.current.setCovered(covering);
		if (covering) setDeskMode("cover");
	}, [covering]);
	useEffect(() => () => setDeskMode(null), []);

	// Setup starts by itself; the run survives a reload because main owns it.
	useEffect(() => {
		if (screen !== "setup") return;
		void onboarding()
			.start()
			.then(setStatus)
			.catch((error: unknown) => console.error("[first-run] start failed", error));
	}, [screen]);
	// A finished run goes to the ready screen, unless a game is on: then the same "ready" call is offered under the board.
	useEffect(() => {
		if (screen === "setup" && status?.stage === "ready" && !playing) setScreen("ready");
	}, [screen, status?.stage, playing]);
	// A failed run shows its retry panel; once it recovers the screen starts over from the logo.
	useEffect(() => {
		if (status?.stage === "failed") setPlaying(false);
	}, [status?.stage]);
	const startGame = useCallback(() => setPlaying(true), []);

	const begin = useCallback(() => {
		if (leaving) return;
		setLeaving(true);
		hostRef.current.arrange();
		hostRef.current.setCovered(false);
		setDeskMode("rise");
		window.setTimeout(() => {
			setScreen("tour");
			setLeaving(false);
		}, 520);
		window.setTimeout(() => setDeskMode(null), DESK_MOTION_MS + 80);
	}, [leaving]);

	const finish = useCallback(() => {
		void onboarding()
			.complete()
			.catch((error: unknown) => console.error("[first-run] complete failed", error))
			.finally(onDone);
	}, [onDone]);

	if (screen === null) return <div className="fr-root" data-screen="loading"><div className="fr-stage" /></div>;
	return (
		<div className="fr-root" data-screen={screen}>
			{covering ? (
				<div className={cn("fr-stage", leaving && "fr-stage--leaving")}>
					<div className="fr-drag" />
					{screen === "setup" ? <SetupScreen status={status} playing={playing} onPlay={startGame} onStart={begin} /> : null}
					{screen === "ready" ? <ReadyScreen status={status} onStart={begin} /> : null}
				</div>
			) : null}
			{screen === "tour" ? <Tour host={host} demo={status?.demo ?? null} platform={platform} onEnd={() => setScreen("plans")} /> : null}
			{screen === "plans" ? <PlansSheet onFinish={finish} /> : null}
		</div>
	);
}

function Logo({ className }: { readonly className?: string }): ReactElement {
	return <img className={cn("fr-logo", className)} src={dazziLogo} alt="" draggable={false} />;
}

/* ------------------------------------------------------------------ setup */

function SetupScreen({
	status,
	playing,
	onPlay,
	onStart,
}: {
	readonly status: SetupStatus | null;
	readonly playing: boolean;
	readonly onPlay: () => void;
	readonly onStart: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const stage = status?.stage ?? "idle";
	const progress = Math.max(0, Math.min(100, Math.round(status?.progress ?? 0)));
	const [fading, setFading] = useState(false);
	const dockRef = useRef<HTMLDivElement>(null);
	/** Where the progress bar was when the logo was tapped, so it can glide down to its place under the board. */
	const dockFrom = useRef<number | null>(null);
	const done = playing && stage === "ready";
	useEnterToStart(onStart, done);

	// A failed run drops the game; once it recovers the screen starts over from the floating logo.
	useEffect(() => {
		if (stage === "failed") setFading(false);
	}, [stage]);

	useEffect(() => {
		if (!fading) return;
		const timer = window.setTimeout(() => {
			dockFrom.current = dockRef.current?.getBoundingClientRect().top ?? null;
			onPlay();
		}, INTRO_FADE_MS);
		return () => window.clearTimeout(timer);
	}, [fading, onPlay]);

	useLayoutEffect(() => {
		const dock = dockRef.current;
		const from = dockFrom.current;
		dockFrom.current = null;
		if (!playing || dock === null || from === null) return;
		const dy = from - dock.getBoundingClientRect().top;
		if (dy === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		const easing = getComputedStyle(document.documentElement).getPropertyValue("--fr-spring-rise").trim() || "ease-out";
		dock.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 900, easing });
	}, [playing]);

	if (stage === "failed") {
		return (
			<section className="fr-panel fr-setup" data-state="failed">
				<Logo className="fr-logo--sm fr-logo--still" />
				<h1 className="fr-title">{t("firstRun.setup.failedTitle")}</h1>
				<p className="fr-lead">{t("firstRun.setup.failedLead")}</p>
				<div className="fr-actions">
					<button type="button" className="fr-btn fr-btn--primary" data-action="setup-retry" autoFocus onClick={() => void onboarding().start()}>
						{t("firstRun.setup.retry")}
					</button>
				</div>
			</section>
		);
	}
	const total = status?.totalFiles ?? 0;
	const processed = Math.min(status?.processedFiles ?? 0, total);
	const remaining = status?.remainingMinutes ?? null;
	const readyCount = status?.processedFiles ?? status?.totalFiles ?? 0;
	return (
		<section className="fr-panel fr-setup" data-mode={playing ? "game" : "intro"}>
			{playing ? null : (
				<div className={cn("fr-intro", fading && "fr-intro--fading")}>
					<button type="button" className="fr-logo-btn" data-action="game-start" aria-label={t("firstRun.game.invite")} disabled={fading} onClick={() => setFading(true)}>
						<span className="fr-logo-ring" />
						<Logo className="fr-logo--breathe" />
						<span className="fr-invite">{t("firstRun.game.invite")}</span>
					</button>
					<h1 className="fr-title">{t("firstRun.setup.title")}</h1>
					<p className="fr-lead">{t("firstRun.setup.lead")}</p>
				</div>
			)}
			{playing ? <MineGame /> : null}
			<div className="fr-dock" ref={dockRef}>
				{done ? (
					<div className="fr-dock-ready" data-role="dock-ready">
						<Logo className="fr-logo--xs" />
						<div className="fr-dock-copy">
							<h1 className="fr-title fr-title--dock">{t("firstRun.ready.title")}</h1>
							<p className="fr-dock-lead">{readyCount > 0 ? t("firstRun.ready.lead", { count: readyCount.toLocaleString() }) : t("firstRun.ready.leadNone")}</p>
						</div>
						<button type="button" className="fr-btn fr-btn--primary" data-action="first-run-start" onClick={onStart}>
							{t("firstRun.ready.start")}
							<kbd className="fr-kbd">↵</kbd>
						</button>
					</div>
				) : (
					<>
						<div className="fr-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} aria-label={t("firstRun.setup.title")}>
							<div className="fr-progress-fill" style={{ transform: `scaleX(${progress / 100})` }} />
						</div>
						<div className="fr-progress-meta">
							<span className="fr-stage-label" key={stage}>{t(`firstRun.setup.stage.${stage}`)}</span>
							<span>
								{stage === "indexing" && total > 0 ? t("firstRun.setup.files", { processed: processed.toLocaleString(), total: total.toLocaleString() }) : null}
								{stage === "indexing" && total > 0 && remaining !== null ? " · " : null}
								{remaining !== null ? t("firstRun.setup.remaining", { minutes: Math.max(1, remaining) }) : null}
							</span>
						</div>
						<p className="fr-recent" title={status?.recentFile ?? undefined}>{stage === "indexing" ? (status?.recentFile ?? "") : ""}</p>
					</>
				)}
			</div>
		</section>
	);
}

/** Enter starts the app: captured, so it never reaches the Finder's own shortcuts behind the layer. */
function useEnterToStart(onStart: () => void, active: boolean): void {
	const startRef = useRef(onStart);
	startRef.current = onStart;
	useEffect(() => {
		if (!active) return;
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Enter" || event.isComposing) return;
			event.preventDefault();
			event.stopPropagation();
			startRef.current();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [active]);
}

/* ------------------------------------------------------------------ ready */

function ReadyScreen({ status, onStart }: { readonly status: SetupStatus | null; readonly onStart: () => void }): ReactElement {
	const { t } = useTranslation();
	useEnterToStart(onStart, true);
	const count = status?.processedFiles ?? status?.totalFiles ?? 0;
	return (
		<section className="fr-panel fr-ready">
			<div className="fr-hero">
				<span className="fr-halo" />
				<Logo className="fr-logo--pop" />
				<span className="fr-spark fr-spark--a" />
				<span className="fr-spark fr-spark--b" />
				<span className="fr-spark fr-spark--c" />
			</div>
			<h1 className="fr-title fr-title--ready">{t("firstRun.ready.title")}</h1>
			<p className="fr-lead">{count > 0 ? t("firstRun.ready.lead", { count: count.toLocaleString() }) : t("firstRun.ready.leadNone")}</p>
			<button type="button" className="fr-btn fr-btn--primary fr-btn--hero" data-action="first-run-start" autoFocus onClick={onStart}>
				{t("firstRun.ready.start")}
				<kbd className="fr-kbd">↵</kbd>
			</button>
		</section>
	);
}

/* ------------------------------------------------------------------- tour */

type AnswerState = "idle" | "running" | "done" | "failed";

/** Where each step's coach mark points. */
function anchorFor(step: TourStepId, family: VersionFamilyData | null): string | null {
	switch (step) {
		case "welcome":
			return null;
		case "question":
		case "ask":
			return `${AI_HOST} form.composer`;
		case "answer":
			return `${AI_HOST} .ai-body`;
		case "cite":
			return `${AI_HOST} .cite`;
		case "evidence":
			return ".inspector-column";
		case "evidenceFolder":
			return '.inspector-column [data-action="evidence-folder"]';
		case "duplicates":
			return family === null ? null : `.workspace-pane [data-path="${CSS.escape(family.head)}"]`;
		case "versions":
			return '[data-section="versions"]';
	}
}

/** Click a real control of the Finder, as the person would (the bubble's button just does it for them). */
function clickReal(selector: string): void {
	const element = document.querySelector<HTMLElement>(selector);
	element?.click();
}

function Tour({
	host,
	demo,
	platform,
	onEnd,
}: {
	readonly host: FirstRunHost;
	readonly demo: SetupStatus["demo"];
	readonly platform: string;
	readonly onEnd: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [cinema, setCinema] = useState<"off" | "on" | "out">("off");
	const [family, setFamily] = useState<VersionFamilyData | null | undefined>(undefined);
	const [step, setStep] = useState<TourStepId | null>(null);
	const [typed, setTyped] = useState(0);
	const [answer, setAnswer] = useState<AnswerState>("idle");
	const [cited, setCited] = useState(false);
	const hostRef = useRef(host);
	hostRef.current = host;
	const question = demo?.question ?? "";

	useEffect(() => {
		let live = true;
		hostRef.current
			.versionFamilies()
			.then((families) => {
				if (live) setFamily(pickTourFamily(families, hostRef.current.folderPath()));
			})
			.catch(() => {
				if (live) setFamily(null);
			});
		const on = window.setTimeout(() => setCinema("on"), CINEMA_IN_MS);
		const out = window.setTimeout(() => setCinema("out"), CINEMA_OUT_MS - 600);
		const off = window.setTimeout(() => {
			setCinema("off");
			setStep("welcome");
		}, CINEMA_OUT_MS);
		return () => {
			live = false;
			window.clearTimeout(on);
			window.clearTimeout(out);
			window.clearTimeout(off);
		};
	}, []);

	const steps = tourSteps({ demo: question.length > 0, family: family !== null && family !== undefined });
	const stepRef = useRef(step);
	stepRef.current = step;

	// The answer's progress, from the search stream the panel itself listens to.
	useEffect(() => {
		const off = window.autorag.search.onEvent?.((event) => {
			const current = stepRef.current;
			if (current !== "ask" && current !== "answer") return;
			if (event.type === "done" || event.type === "error" || event.type === "cancelled") {
				// The citation chips render with the final answer; look once it has painted.
				window.setTimeout(() => {
					setCited(document.querySelector(`${AI_HOST} .cite`) !== null);
					setAnswer(event.type === "done" ? "done" : "failed");
				}, 250);
			} else {
				setAnswer((state) => (state === "idle" ? "running" : state));
			}
			if (current === "ask") setStep("answer");
		});
		return () => off?.();
	}, []);

	// The question types itself into the composer, key by key.
	useEffect(() => {
		if (step !== "question" || question.length === 0) return;
		let index = 0;
		let timer = 0;
		const type = (): void => {
			index += 1;
			hostRef.current.typeDraft(question.slice(0, index));
			setTyped(index);
			if (index < question.length) timer = window.setTimeout(type, 26 + Math.random() * 46);
		};
		timer = window.setTimeout(type, 420);
		return () => window.clearTimeout(timer);
	}, [step, question]);

	useEffect(() => {
		if (step === "ask") hostRef.current.typeDraft(question);
		if (step === "duplicates" && family !== null && family !== undefined) hostRef.current.showFamily(family);
	}, [step, question, family]);

	const advance = useCallback(() => {
		const current = stepRef.current;
		if (current === null) return;
		if (current === "cite") clickReal(`${AI_HOST} .cite`);
		if (current === "evidenceFolder") clickReal('.inspector-column [data-action="evidence-folder"]');
		const next = nextStep(steps, current, { cited });
		if (next === null) onEnd();
		else setStep(next);
	}, [steps, cited, onEnd]);

	const nextBlocked =
		step === "ask" ||
		(step === "question" && typed < question.length) ||
		(step === "answer" && (answer === "idle" || answer === "running")) ||
		(step === "welcome" && family === undefined);

	// Enter moves on, unless it belongs to a text field (the composer's Enter asks the question).
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key !== "Enter" || event.isComposing || isTextTarget(event.target) || nextBlocked || stepRef.current === null) return;
			event.preventDefault();
			event.stopPropagation();
			advance();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [advance, nextBlocked]);

	const subtitle = platform === "win32" ? t("firstRun.cinema.subtitleWindows") : t("firstRun.cinema.subtitleMac");
	const index = step === null ? 0 : steps.indexOf(step);
	const waiting = step === "answer" && (answer === "idle" || answer === "running");
	const failed = step === "answer" && answer === "failed";
	const title =
		step === null ? "" : waiting ? t("firstRun.tour.answer.waitingTitle") : failed ? t("firstRun.tour.answer.failedTitle") : t(`firstRun.tour.${step}.title`);
	const body =
		step === null ? "" : waiting ? t("firstRun.tour.answer.waitingBody") : failed ? t("firstRun.tour.answer.failedBody") : t(`firstRun.tour.${step}.body`);
	const last = step !== null && nextStep(steps, step, { cited }) === null;

	return (
		<>
			{cinema === "off" ? null : (
				<div className={cn("fr-cinema", cinema === "out" && "fr-cinema--out")} aria-live="polite">
					<div className="fr-cinema-bars" />
					<div className="fr-cinema-copy">
						<Logo className="fr-logo--cinema" />
						<h1 className="fr-cinema-title">{t("firstRun.cinema.title", { name: APP_NAME })}</h1>
						<p className="fr-cinema-sub">{subtitle}</p>
					</div>
				</div>
			)}
			{step === null ? null : (
				<Coach
					step={step}
					selector={anchorFor(step, family ?? null)}
					index={index}
					count={steps.length}
					title={title}
					body={body}
					waiting={waiting}
					showNext={step !== "ask"}
					nextDisabled={nextBlocked}
					nextLabel={last ? t("firstRun.tour.finish") : t("firstRun.tour.next")}
					onNext={advance}
					onSkip={onEnd}
				/>
			)}
		</>
	);
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
	if (a === null || b === null) return a === b;
	return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

/** A spotlight on the anchor and a bubble beside it. Everything but the bubble lets clicks through to the Finder. */
function Coach({
	step,
	selector,
	index,
	count,
	title,
	body,
	waiting,
	showNext,
	nextDisabled,
	nextLabel,
	onNext,
	onSkip,
}: {
	readonly step: TourStepId;
	readonly selector: string | null;
	readonly index: number;
	readonly count: number;
	readonly title: string;
	readonly body: string;
	readonly waiting: boolean;
	readonly showNext: boolean;
	readonly nextDisabled: boolean;
	readonly nextLabel: string;
	readonly onNext: () => void;
	readonly onSkip: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [rect, setRect] = useState<Rect | null>(null);
	const [size, setSize] = useState({ width: 320, height: 160 });
	const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
	const bubbleRef = useRef<HTMLDivElement>(null);

	// The anchor moves with the Finder (a pane opening, an answer streaming), so it is followed every frame.
	useEffect(() => {
		let frame = 0;
		const tick = (): void => {
			const element = selector === null ? null : document.querySelector(selector);
			const box = element?.getBoundingClientRect();
			const next = box === undefined || box.width === 0 || box.height === 0 ? null : { left: box.left, top: box.top, width: box.width, height: box.height };
			setRect((previous) => (sameRect(previous, next) ? previous : next));
			setViewport((previous) => (previous.width === window.innerWidth && previous.height === window.innerHeight ? previous : { width: window.innerWidth, height: window.innerHeight }));
			frame = window.requestAnimationFrame(tick);
		};
		tick();
		return () => window.cancelAnimationFrame(frame);
	}, [selector]);

	useLayoutEffect(() => {
		const element = bubbleRef.current;
		if (element === null) return;
		const width = element.offsetWidth;
		const height = element.offsetHeight;
		setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
	});

	const place = placeBubble(rect, viewport, size);
	const pad = 6;
	const spot: CSSProperties =
		rect === null
			? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0, opacity: 0.55 }
			: { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
	return (
		<div className="fr-tour">
			<div className={cn("fr-spot", rect === null && "fr-spot--none")} style={spot} />
			<div ref={bubbleRef} className="fr-coach" data-step={step} data-side={place.side} style={{ left: place.left, top: place.top }} role="dialog" aria-label={title}>
				<div className="fr-coach-card" key={step}>
					<p className="fr-coach-count">{t("firstRun.tour.progress", { index: index + 1, count })}</p>
					<h2 className="fr-coach-title">
						{waiting ? <span className="fr-coach-spinner" aria-hidden="true" /> : null}
						{title}
					</h2>
					<p className="fr-coach-body">{body}</p>
					<div className="fr-coach-actions">
						<button type="button" className="fr-link" data-action="tour-skip" onClick={onSkip}>
							{t("firstRun.tour.skip")}
						</button>
						{showNext ? (
							<button type="button" className="fr-btn fr-btn--primary fr-btn--sm" data-action="tour-next" disabled={nextDisabled} onClick={onNext}>
								{nextLabel}
							</button>
						) : (
							<span className="fr-coach-hint"><kbd className="fr-kbd">↵</kbd></span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ plans */

const PLANS: readonly AccountPlanId[] = ["free", "air", "pro", "max"];

function PlansSheet({ onFinish }: { readonly onFinish: () => void }): ReactElement {
	const { t } = useTranslation();
	const [account, setAccount] = useState<AccountStatus | null>(null);
	const [plan, setPlan] = useState<AccountPlanId>("free");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let live = true;
		void window.autorag.account
			.status()
			.then((next) => {
				if (live) setAccount(next);
			})
			.catch(() => undefined);
		const off = window.autorag.account.onChanged((next) => {
			if (live) setAccount(next);
		});
		return () => {
			live = false;
			off();
		};
	}, []);
	const signedIn = account?.state === "signedIn";
	const signingIn = account?.state === "signingIn";
	const signIn = (provider: "google" | "github"): void => {
		void window.autorag.account
			.signIn({ provider })
			.then(setAccount)
			.catch((error: unknown) => console.error("[first-run] sign-in failed", error));
	};
	const proceed = (): void => {
		if (!isPaidPlanId(plan)) {
			onFinish();
			return;
		}
		setBusy(true);
		void window.autorag.account
			.checkout(plan)
			.then(onFinish)
			.catch((error: unknown) => console.error("[first-run] checkout failed", error))
			.finally(() => setBusy(false));
	};
	return (
		<div className="fr-sheet-scrim">
			<section className="fr-plans" role="dialog" aria-label={t("firstRun.plans.title")}>
				<div className="fr-plans-head">
					<Logo className="fr-logo--xs" />
					<div>
						<p className="fr-eyebrow">{t("firstRun.plans.eyebrow")}</p>
						<h2 className="fr-title fr-title--sheet">{t("firstRun.plans.title")}</h2>
					</div>
				</div>
				<p className="fr-lead fr-lead--sheet">{t("firstRun.plans.lead")}</p>
				<div className="fr-plan-grid">
					{PLANS.map((id) => (
						<button
							type="button"
							key={id}
							data-plan={id}
							aria-pressed={plan === id}
							className={cn("fr-plan", plan === id && "fr-plan--on", id === "pro" && "fr-plan--featured")}
							onClick={() => setPlan(id)}
						>
							<span className="fr-plan-name">{t(`firstRun.plans.plan.${id}.name`)}</span>
							<span className="fr-plan-price">
								{t(`firstRun.plans.plan.${id}.price`)}
								{id === "free" ? null : <small>{t("firstRun.plans.perMonth")}</small>}
							</span>
							<span className="fr-plan-tag">{t(`firstRun.plans.plan.${id}.tag`)}</span>
							{id === "pro" ? <span className="fr-plan-badge">{t("firstRun.plans.plan.pro.trial")}</span> : null}
						</button>
					))}
				</div>
				<div className="fr-signin">
					{signedIn ? (
						<p className="fr-signed">{t("firstRun.plans.signedIn", { email: account?.account?.email ?? "" })}</p>
					) : (
						<>
							<button type="button" className="fr-btn fr-btn--secondary fr-btn--brand" data-signin="google" disabled={signingIn} onClick={() => signIn("google")}>
								<GoogleMark />
								{t("firstRun.plans.google")}
							</button>
							<button type="button" className="fr-btn fr-btn--secondary fr-btn--brand" data-signin="github" disabled={signingIn} onClick={() => signIn("github")}>
								<GithubMark />
								{t("firstRun.plans.github")}
							</button>
						</>
					)}
				</div>
				{signingIn ? <p className="fr-waiting"><span className="fr-dot" />{t("firstRun.plans.signingIn")}</p> : null}
				<div className="fr-actions fr-actions--sheet">
					<button type="button" className="fr-link" data-action="plans-later" onClick={onFinish}>
						{t("firstRun.plans.later")}
					</button>
					<button
						type="button"
						className="fr-btn fr-btn--primary"
						data-action="plans-continue"
						disabled={busy || (isPaidPlanId(plan) && !signedIn)}
						onClick={proceed}
					>
						{isPaidPlanId(plan) ? t("firstRun.plans.checkout") : t("firstRun.plans.continue")}
					</button>
				</div>
			</section>
		</div>
	);
}

function GoogleMark(): ReactElement {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
			<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
			<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
			<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
			<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
		</svg>
	);
}

function GithubMark(): ReactElement {
	return (
		<svg width={16} height={16} viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
			<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
		</svg>
	);
}
