/**
 * What the first-index pause screen shows and does for each reason a run stopped
 * (docs/prototypes/onboarding-failure). Pure on purpose: the screen only renders
 * this, so every reason's design is unit-tested without a DOM.
 *
 * The screen has five things at most: an icon, a title, one reason line, one
 * button, and up to two quiet links. `exits[0]` is the button; Enter presses it.
 * There is no exit that skips the index: the Finder is already open beside this
 * window, and closing the window on a stopped run ends onboarding.
 */

import type { IndexFailure, IndexFailureReason } from "../../../shared/index-failure";

export type PauseExit = "retry" | "changeEmbedding" | "excludeFolders";

/** A run that starts again by itself: every `everySeconds`, at most `max` times (`null`: for as long as the screen is open). */
export interface PauseAuto {
	readonly everySeconds: number;
	readonly max: number | null;
}

/** A translation key with the variables its text interpolates. */
export interface PauseText {
	readonly key: string;
	readonly vars?: Readonly<Record<string, string | number>>;
}

export interface PauseSpec {
	readonly icon: string;
	readonly title: PauseText;
	/** The one line under the title while nothing more specific is going on. */
	readonly line: PauseText;
	/** The label of the "retry" exit: it differs by what is being retried (a connection, a download, a folder). */
	readonly retryLabel: PauseText;
	/** The label of the "excludeFolders" exit; only set when a folder is the problem. */
	readonly excludeLabel?: PauseText;
	/** In design order: the first is the button, the rest are links. */
	readonly exits: readonly PauseExit[];
	readonly auto: PauseAuto | null;
}

/** What has already been tried from this screen since the reason appeared. */
export interface PauseHistory {
	/** Retries the user started that stopped again. */
	readonly manualRepeats: number;
	/** Automatic retries that stopped again. */
	readonly autoAttempts: number;
}

const ROOT = "onboarding.indexing.pause";
const text = (key: string, vars?: Readonly<Record<string, string | number>>): PauseText => (vars === undefined ? { key: `${ROOT}.${key}` } : { key: `${ROOT}.${key}`, vars });

/** The last segment of a path in either separator style; the whole path when it has none. */
function folderName(path: string): string {
	const segments = path.split(/[\\/]/u).filter((segment) => segment.length > 0);
	return segments.at(-1) ?? path;
}

type Design = Omit<PauseSpec, "title" | "excludeLabel">;

const DESIGNS: Readonly<Record<Exclude<IndexFailureReason, "folder-unreadable">, Design & { readonly title: PauseText }>> = {
	"embedder-config": {
		icon: "cloud",
		title: text("config.title"),
		line: text("config.line"),
		retryLabel: text("exit.retry"),
		exits: ["changeEmbedding", "retry"],
		auto: null,
	},
	"embedder-offline": {
		icon: "wifi-off",
		title: text("offline.title"),
		line: text("offline.line"),
		retryLabel: text("exit.retryNow"),
		exits: ["retry", "changeEmbedding"],
		auto: { everySeconds: 8, max: 6 },
	},
	"model-download": {
		icon: "download",
		title: text("model.title"),
		line: text("model.line"),
		retryLabel: text("exit.resume"),
		exits: ["retry", "changeEmbedding"],
		auto: { everySeconds: 8, max: 6 },
	},
	"disk-full": {
		icon: "hard-drive",
		title: text("disk.title"),
		line: text("disk.line"),
		retryLabel: text("exit.resumeDisk"),
		exits: ["retry", "changeEmbedding"],
		auto: null,
	},
	unknown: {
		icon: "circle-alert",
		title: text("unknown.title"),
		line: text("unknown.line"),
		retryLabel: text("exit.retry"),
		exits: ["retry", "changeEmbedding"],
		auto: null,
	},
};

export function pauseSpec(failure: IndexFailure): PauseSpec {
	if (failure.reason !== "folder-unreadable") return DESIGNS[failure.reason];
	const [first] = failure.folders;
	const many = failure.folders.length > 1;
	return {
		icon: "folder-x",
		title: many || first === undefined ? text("folder.titleMany", { count: failure.folders.length }) : text("folder.title", { folder: folderName(first) }),
		line: text("folder.line"),
		retryLabel: text("exit.recheck"),
		excludeLabel: many || first === undefined ? text("exit.excludeMany") : text("exit.exclude", { folder: folderName(first) }),
		exits: ["retry", "excludeFolders"],
		auto: { everySeconds: 3, max: null },
	};
}

function autoExhausted(spec: PauseSpec, history: PauseHistory): boolean {
	return spec.auto !== null && spec.auto.max !== null && history.autoAttempts >= spec.auto.max;
}

/**
 * The exits in the order to show them. Once a retry has failed again (or the automatic ones are used up),
 * pressing "retry" a further time is the wrong thing to offer as the button: the next exit takes its place.
 */
export function pauseExits(spec: PauseSpec, history: PauseHistory): readonly PauseExit[] {
	if (history.manualRepeats === 0 && !autoExhausted(spec, history)) return spec.exits;
	const other = spec.exits.find((exit) => exit !== "retry");
	return other === undefined ? spec.exits : [other, ...spec.exits.filter((exit) => exit !== other)];
}

export interface PauseLine extends PauseText {
	/** `again` draws the line in the warning colour. */
	readonly tone: "plain" | "again";
}

export interface PauseLiveState {
	/** Seconds until the next automatic try; `null` when none is scheduled. */
	readonly countdown: number | null;
	/** A retry the user started, or a bounded automatic one, is in flight. */
	readonly retrying: boolean;
}

/**
 * The one reason line. It is also the status line: countdown, repeat and "trying again" replace it.
 * A reason that is watched without end (an unplugged drive) keeps its own line: a countdown that
 * restarts every few seconds would only be noise.
 */
export function pauseLine(spec: PauseSpec, history: PauseHistory, live: PauseLiveState): PauseLine {
	const polling = spec.auto !== null && spec.auto.max === null;
	if (live.retrying) return { ...text("line.retrying"), tone: "plain" };
	if (live.countdown !== null && !polling) return { ...text("line.countdown", { seconds: live.countdown }), tone: "plain" };
	if (autoExhausted(spec, history)) return { ...text("line.exhausted"), tone: "again" };
	if (history.manualRepeats > 0) return { ...text("line.again"), tone: "again" };
	return { ...spec.line, tone: "plain" };
}
