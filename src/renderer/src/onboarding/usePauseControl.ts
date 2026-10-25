import { useEffect, useRef, useState } from "react";
import type { IndexFailure, IndexFailureReason } from "../../../shared/index-failure";
import type { OnboardingCtx } from "./context";
import { pauseExits, pauseLine, pauseSpec, type PauseExit, type PauseHistory, type PauseLine, type PauseSpec } from "./pause";

export interface PauseControl {
	/** The design of the screen being shown; `null` when the run is not stopped (and no retry is starting). */
	readonly spec: PauseSpec | null;
	readonly failure: IndexFailure | null;
	/** The exits in display order; the first is the button. */
	readonly exits: readonly PauseExit[];
	readonly line: PauseLine;
	/** How far the run got before it stopped, 0-100; the bar is hidden at 0 (nothing was read yet). */
	readonly progress: number;
	run(exit: PauseExit): void;
}

const NONE: PauseHistory = { manualRepeats: 0, autoAttempts: 0 };

/**
 * The state behind the pause screen: what was tried from it, the automatic retry clock, and the
 * action each exit performs. The screen stays up while a retry that the screen started is still
 * connecting, so a run that fails again in a moment does not flicker through the running view.
 */
export function usePauseControl(ctx: OnboardingCtx): PauseControl {
	const status = ctx.indexStatus;
	const stopped = status?.state === "failed" && status.failure !== null;
	const failure = stopped ? status.failure : null;

	const [history, setHistory] = useState<PauseHistory>(NONE);
	const [inFlight, setInFlight] = useState<"manual" | "auto" | null>(null);
	const [countdown, setCountdown] = useState<number | null>(null);
	const counted = useRef<string | null>(null);
	const lastReason = useRef<IndexFailureReason | null>(null);
	const lastFailure = useRef<IndexFailure | null>(null);
	const lastProgress = useRef(0);
	const startIndexing = useRef(ctx.startIndexing);
	startIndexing.current = ctx.startIndexing;

	if (failure !== null) {
		lastFailure.current = failure;
		lastProgress.current = status?.progress ?? 0;
	}

	// A stop is counted once, and attributed to whoever started the run that ended in it.
	useEffect(() => {
		if (status?.state === "success") setInFlight(null);
		if (status?.state !== "failed" || status.failure === null || counted.current === status.finishedAt) return;
		counted.current = status.finishedAt;
		const reason = status.failure.reason;
		const previousReason = lastReason.current;
		lastReason.current = reason;
		setHistory((previous) => {
			// A different reason is a new situation, not the same thing stopping again.
			if (previousReason !== null && previousReason !== reason) return NONE;
			if (inFlight === "manual") return { ...previous, manualRepeats: previous.manualRepeats + 1 };
			if (inFlight === "auto") return { ...previous, autoAttempts: previous.autoAttempts + 1 };
			return previous;
		});
		setInFlight(null);
	}, [status, inFlight]);

	const shownFailure = failure ?? lastFailure.current;
	const spec = shownFailure === null ? null : pauseSpec(shownFailure);
	// Connecting: the retry was started here, the run is up, and nothing has been read yet.
	const connecting = inFlight !== null && status?.state === "running" && status.phase === null && ctx.modelDownload.status.state !== "downloading";
	const visible = stopped || connecting;

	const auto = spec?.auto ?? null;
	const exhausted = auto !== null && auto.max !== null && history.autoAttempts >= auto.max;
	useEffect(() => {
		if (!stopped || auto === null || exhausted) {
			setCountdown(null);
			return;
		}
		let left = auto.everySeconds;
		setCountdown(left);
		const timer = window.setInterval(() => {
			left -= 1;
			if (left > 0) {
				setCountdown(left);
				return;
			}
			window.clearInterval(timer);
			setCountdown(null);
			setInFlight("auto");
			startIndexing.current();
		}, 1000);
		return () => window.clearInterval(timer);
	}, [stopped, auto?.everySeconds, auto?.max, exhausted, status?.finishedAt]);

	const run = (exit: PauseExit): void => {
		switch (exit) {
			case "retry":
				setInFlight("manual");
				ctx.startIndexing();
				return;
			case "changeEmbedding":
				ctx.changeEmbedding();
				return;
			case "excludeFolders":
				ctx.excludeFolders(shownFailure?.folders ?? []);
				return;
			case "openAnyway":
				ctx.finishInBackground();
				return;
		}
	};

	if (!visible || spec === null) {
		return { spec: null, failure: null, exits: [], line: { key: "", tone: "plain" }, progress: 0, run };
	}
	return {
		spec,
		failure: shownFailure,
		exits: pauseExits(spec, history),
		line: pauseLine(spec, history, { countdown, retrying: connecting && !(spec.auto?.max === null && inFlight === "auto") }),
		progress: lastProgress.current,
		run,
	};
}
