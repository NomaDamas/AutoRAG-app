/**
 * Contextual tutorials: short coach-mark walkthroughs that start the first
 * time a person reaches a feature on their own (the 자동화 sidebar item, a
 * file's right-click menu, Settings), never during the first run. Each one
 * shows once per profile. Automations and Magic Actions are taught by making
 * a real example with the person and watching it work (`shared/demo-contract.ts`);
 * the React layer (`Tutorials.tsx`) renders them.
 */

import { DEMO_MAGIC_ACTION_ID } from "../../../shared/demo-contract";
import { AI_HOST } from "./tour";

export type TutorialId = "automations" | "contextMenu" | "remoteAccess";

/** What an offer step's button does in the app before the tutorial goes on. */
export type TutorialEffect = "showNewRightClick" | "openSample" | "backToAutomations" | "showAutomations" | "createMagicAction" | "openContextMenuSettings" | "showRemoteSettings";

/** What the effects learned about the practice material; later steps point at it. */
export interface TutorialFacts {
	/** The sample file the Magic Action tutorial asks the person to right-click. */
	readonly sample?: string;
	/** The AI Search tab the tutorial opened: its chat, not another one that may be on screen. */
	readonly aiTab?: number;
	/** The practice photo, the Downloads folder it is to be dragged into, and the folder the rule saves black-and-white copies to. */
	readonly photo?: string;
	/** The practice-photo folder that holds `photo`. */
	readonly folder?: string;
	readonly downloads?: string;
	readonly gray?: string;
	/** The black-and-white copy the rule made. */
	readonly result?: string;
	/** The right-click automation the person added from the recommendations. */
	readonly action?: string;
}

type Selector = string | ((facts: TutorialFacts) => string);

export interface TutorialStep {
	/** Copy lives under `tutorials.<id>.<key>.{title,body}` (offers also `.action`). */
	readonly key: string;
	/** What the spotlight frames: the first selector that matches, in order. */
	readonly anchors: readonly Selector[];
	/** The step is passed over when this matches nothing as it comes up (a page that is not there). */
	readonly requires?: Selector;
	/** The step holds back until this appears (something an effect just made); the tutorial ends if it never does. */
	readonly waitFor?: Selector;
	/** The step brings a new page (a folder, a Settings page): its box opens anew instead of resizing from the last one. */
	readonly newPage?: boolean;
	/** Click-required: the cursor taps this target, and clicking it moves on. */
	readonly tap?: Selector;
	/** Shown only right after a click-required step was actually clicked. */
	readonly followsTap?: boolean;
	/** An offer: "later" ends the tutorial, the main button runs the effect and moves on. */
	readonly offer?: TutorialEffect;
	/** Waits for something to happen on its own (a run finishing, a menu opening): moves on when this matches. */
	readonly until?: Selector;
	/** Waits for the tutorial's own AI Search chat to finish answering (the rule is made by then). */
	readonly untilEvent?: "aiDone";
	/** Waits for a black-and-white copy of the practice photo to show up in the rule's output folder; moves on with what it learned. */
	readonly watch?: "grayCopy";
	/** An effect run once as the step comes up, with no button: the tutorial itself takes the person somewhere. */
	readonly enter?: TutorialEffect;
	/** For steps the person acts in: how the guide cursor and hint read. */
	readonly hint?: "click" | "rightClick" | "drag";
}

/** A value as a quoted CSS attribute selector operand (paths hold quotes and backslashes on some systems). */
const attr = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

const resolve = (selector: Selector, facts: TutorialFacts): string => (typeof selector === "string" ? selector : selector(facts));

/** The first anchor selector that is given for the step (for measuring and for the live cursor). */
export const anchorSelectors = (step: TutorialStep, facts: TutorialFacts): readonly string[] => step.anchors.map((anchor) => resolve(anchor, facts));
export const selectorOf = (selector: Selector | undefined, facts: TutorialFacts): string | undefined => (selector === undefined ? undefined : resolve(selector, facts));

const byPath = (path: string | undefined): string => (path === undefined ? "[data-path]:not([data-path])" : `[data-path="${attr(path)}"]`);

const AUTOMATIONS_VIEW = "[data-automations-view]";
const RULE_ROW = "[data-rule-id]";
const DEMO_MAGIC_ITEM = `.menu [data-magic-action-id="${DEMO_MAGIC_ACTION_ID}"]`;

const photoRow = (facts: TutorialFacts): string => (facts.photo === undefined ? "[data-path]:not([data-path])" : `[data-path="${attr(facts.photo)}"]`);
const resultRow = (facts: TutorialFacts): string => (facts.result === undefined ? "[data-path]:not([data-path])" : `[data-path="${attr(facts.result)}"]`);
/** The chat the tutorial opened; any visible chat until it is known. */
const aiHost = (facts: TutorialFacts): string => (facts.aiTab === undefined ? AI_HOST : `[data-ai-tab="${facts.aiTab}"]`);
const aiComposer = (facts: TutorialFacts): string => `${aiHost(facts)} form.composer`;
const sendButton = (facts: TutorialFacts): string => `${aiComposer(facts)} button.send[type="submit"]`;
/** The recommendations a page with no automations opens on (Figma 672:3718). */
const RECOMMENDATIONS = `${AUTOMATIONS_VIEW} [data-automation-recommendations]`;
/** The right-click recommendation the tutorial adds (문서 세 줄 요약), and its 추가하기. */
const SUMMARY_CARD = `${AUTOMATIONS_VIEW} [data-template="summary"]`;
const SUMMARY_ADD = `${SUMMARY_CARD} [data-action="automation-template-add"]`;
/** 새 자동화, which opens the chat that makes any other automation. */
const NEW_AUTOMATION = `${AUTOMATIONS_VIEW} [data-action="automation-composer-open"]`;
/** The right-click automation the person just added: its row in 내 자동화, and its item in a file's right-click menu. */
const newRow = (facts: TutorialFacts): string => (facts.action === undefined ? "[data-magic-action-row]:not([data-magic-action-row])" : `${AUTOMATIONS_VIEW} [data-magic-action-row="${attr(facts.action)}"]`);
const newMenuItem = (facts: TutorialFacts): string => (facts.action === undefined ? "[data-magic-action-id]:not([data-magic-action-id])" : `.menu[role="menu"] [data-magic-action-id="${attr(facts.action)}"]`);

export const TUTORIALS: Readonly<Record<TutorialId, readonly TutorialStep[]>> = {
	// Figma 672:3637: an automation is picked from the recommendations. The tutorial has the person add the right-click
	// one (문서 세 줄 요약), right-click a practice file and run it from the menu, then points at 새 자동화 for the rest.
	automations: [
		{ key: "intro", anchors: [RECOMMENDATIONS, AUTOMATIONS_VIEW] },
		{ key: "add", anchors: [SUMMARY_CARD], requires: SUMMARY_CARD, tap: SUMMARY_ADD },
		{ key: "made", anchors: [newRow], enter: "showNewRightClick", waitFor: newRow },
		{ key: "sample", anchors: [(facts) => byPath(facts.sample)], newPage: true, enter: "openSample", waitFor: (facts) => byPath(facts.sample), until: newMenuItem, hint: "rightClick" },
		{ key: "pick", anchors: [newMenuItem], tap: newMenuItem },
		{ key: "result", anchors: ['[data-testid="magic-action-dialog"]'], followsTap: true },
		{ key: "chat", anchors: [NEW_AUTOMATION], newPage: true, enter: "backToAutomations", waitFor: NEW_AUTOMATION },
	],
	contextMenu: [
		{ key: "intro", anchors: ['.menu[role="menu"]'], offer: "createMagicAction" },
		{ key: "sample", anchors: [(facts) => byPath(facts.sample)], newPage: true, waitFor: (facts) => byPath(facts.sample), until: DEMO_MAGIC_ITEM, hint: "rightClick" },
		{ key: "pick", anchors: [DEMO_MAGIC_ITEM], tap: DEMO_MAGIC_ITEM },
		{ key: "result", anchors: ['[data-testid="magic-action-dialog"]'], followsTap: true },
		{ key: "more", anchors: ['[data-testid="magic-action-dialog"]'], offer: "openContextMenuSettings" },
	],
	remoteAccess: [
		{ key: "offer", anchors: ['[data-settings-nav="remote"]'], offer: "showRemoteSettings" },
		{ key: "toggle", anchors: ['[data-settings-row="remote-access"]'], newPage: true, waitFor: '[data-settings-row="remote-access"]' },
		{ key: "security", anchors: ['[data-settings-section="remote-access"]'], waitFor: '[data-settings-section="remote-access"]' },
		{ key: "connect", anchors: ['[data-settings-section="remote-connect"]'], requires: '[data-settings-section="remote-connect"]' },
	],
};

/**
 * The step after `from` (-1 for the first one) that the live Finder supports,
 * or null when the tutorial is over. `tapped` says whether `from` was a
 * click-required step the person clicked.
 */
export function nextStep(
	steps: readonly TutorialStep[],
	from: number,
	tapped: boolean,
	present: (selector: string) => boolean,
	facts: TutorialFacts = {},
): number | null {
	for (let index = from + 1; index < steps.length; index += 1) {
		const step = steps[index];
		if (step === undefined) break;
		if (step.followsTap === true && !(tapped && index === from + 1)) continue;
		if (step.requires !== undefined && !present(resolve(step.requires, facts))) continue;
		return index;
	}
	return null;
}

/** How many steps would still come after `from`, as the live Finder stands (a page not yet open counts through `waitFor`, never `requires`). */
export function stepsAfter(
	steps: readonly TutorialStep[],
	from: number,
	tapped: boolean,
	present: (selector: string) => boolean,
	facts: TutorialFacts = {},
): number {
	let count = 0;
	for (let index = nextStep(steps, from, tapped, present, facts); index !== null; index = nextStep(steps, index, steps[index]?.tap !== undefined, present, facts)) count += 1;
	return count;
}

/** The steps the live Finder would show, in order, for the "n / m" count (a click-required step counts as clicked). */
export function stepsInPlay(steps: readonly TutorialStep[], present: (selector: string) => boolean, facts: TutorialFacts = {}): readonly number[] {
	const shown: number[] = [];
	for (let index = nextStep(steps, -1, false, present, facts); index !== null; index = nextStep(steps, index, steps[index]?.tap !== undefined, present, facts)) shown.push(index);
	return shown;
}

const seenKey = (id: TutorialId): string => `autorag.tutorial.${id}.seen`;

export function tutorialSeen(id: TutorialId): boolean {
	try {
		return globalThis.localStorage.getItem(seenKey(id)) === "1";
	} catch {
		return false;
	}
}

export function markTutorialSeen(id: TutorialId): void {
	try {
		globalThis.localStorage.setItem(seenKey(id), "1");
	} catch {
		// Storage unavailable: the tutorial may show again next session, which is harmless.
	}
}

const PICTURE = /\.(jpe?g|png|heic|webp|gif|tiff?|bmp|avif)$/iu;

function basenameOf(path: string): string {
	return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/**
 * The black-and-white copy: a picture among `listed` (the direct contents of the rule's output folder) that was not there
 * when the step began. Null while nothing new is there. The folder may not exist yet; that is the same as empty.
 * Paths are taken as the listing spells them (a symlinked folder lists under its real path), never compared to the
 * folder's own path.
 */
export function grayCopy(listed: readonly string[], baseline: ReadonlySet<string>): string | null {
	for (const path of listed) {
		if (!baseline.has(path) && PICTURE.test(basenameOf(path))) return path;
	}
	return null;
}
