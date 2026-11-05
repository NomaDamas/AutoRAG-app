/**
 * Contextual tutorials: short coach-mark walkthroughs that start the first
 * time a person reaches a feature on their own (the 자동화 sidebar item, a
 * file's right-click menu, Settings), never during the first run. Each one
 * shows once per profile. Automations and Magic Actions are taught by making
 * a real example with the person and watching it work (`shared/demo-contract.ts`);
 * the React layer (`Tutorials.tsx`) renders them.
 */

import { DEMO_AUTOMATION_ID, DEMO_MAGIC_ACTION_ID } from "../../../shared/demo-contract";

export type TutorialId = "automations" | "contextMenu" | "remoteAccess";

/** What an offer step's button does in the app before the tutorial goes on. */
export type TutorialEffect = "createAutomation" | "dropFile" | "openResult" | "createMagicAction" | "openContextMenuSettings" | "showRemoteSettings";

/** What the effects learned about the practice material; later steps point at it. */
export interface TutorialFacts {
	/** The sample file the Magic Action tutorial asks the person to right-click. */
	readonly sample?: string;
	/** The folder the example automation moves the dropped file into. */
	readonly destination?: string;
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
	/** Click-required: the cursor taps this target, and clicking it moves on. */
	readonly tap?: Selector;
	/** Shown only right after a click-required step was actually clicked. */
	readonly followsTap?: boolean;
	/** An offer: "later" ends the tutorial, the main button runs the effect and moves on. */
	readonly offer?: TutorialEffect;
	/** Waits for something to happen on its own (a run finishing, a menu opening): moves on when this matches. */
	readonly until?: Selector;
	/** For `until` steps the person causes: how the guide cursor and hint read. */
	readonly hint?: "click" | "rightClick";
}

const resolve = (selector: Selector, facts: TutorialFacts): string => (typeof selector === "string" ? selector : selector(facts));

/** The first anchor selector that is given for the step (for measuring and for the live cursor). */
export const anchorSelectors = (step: TutorialStep, facts: TutorialFacts): readonly string[] => step.anchors.map((anchor) => resolve(anchor, facts));
export const selectorOf = (selector: Selector | undefined, facts: TutorialFacts): string | undefined => (selector === undefined ? undefined : resolve(selector, facts));

const byPath = (path: string | undefined): string => (path === undefined ? "[data-path]:not([data-path])" : `[data-path="${CSS.escape(path)}"]`);

const AUTOMATIONS_VIEW = "[data-automations-view]";
const DEMO_ROW = `[data-rule-id="${DEMO_AUTOMATION_ID}"]`;
const DEMO_RAN = `${DEMO_ROW} [data-run-tone="ok"], ${DEMO_ROW} [data-run-tone="fail"]`;
const DEMO_MAGIC_ITEM = `.menu [data-magic-action-id="${DEMO_MAGIC_ACTION_ID}"]`;

export const TUTORIALS: Readonly<Record<TutorialId, readonly TutorialStep[]>> = {
	automations: [
		{ key: "intro", anchors: [AUTOMATIONS_VIEW], offer: "createAutomation" },
		{ key: "rule", anchors: [DEMO_ROW], waitFor: DEMO_ROW },
		{ key: "drop", anchors: [DEMO_ROW], offer: "dropFile" },
		{ key: "running", anchors: [DEMO_ROW], until: DEMO_RAN },
		{ key: "result", anchors: [DEMO_ROW], offer: "openResult" },
	],
	contextMenu: [
		{ key: "intro", anchors: ['.menu[role="menu"]'], offer: "createMagicAction" },
		{ key: "sample", anchors: [(facts) => byPath(facts.sample)], waitFor: (facts) => byPath(facts.sample), until: DEMO_MAGIC_ITEM, hint: "rightClick" },
		{ key: "pick", anchors: [DEMO_MAGIC_ITEM], tap: DEMO_MAGIC_ITEM },
		{ key: "result", anchors: ['[data-testid="magic-action-dialog"]'], followsTap: true },
		{ key: "more", anchors: ['[data-testid="magic-action-dialog"]'], offer: "openContextMenuSettings" },
	],
	remoteAccess: [
		{ key: "offer", anchors: ['[data-settings-nav="remote"]'], offer: "showRemoteSettings" },
		{ key: "toggle", anchors: ['[data-settings-row="remote-access"]'], requires: '[data-settings-row="remote-access"]' },
		{ key: "security", anchors: ['[data-settings-section="remote-access"]'], requires: '[data-settings-section="remote-access"]' },
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

/** The steps the live Finder would show, in order, for the "n / m" count (a click-required step counts as clicked). */
export function stepsInPlay(steps: readonly TutorialStep[], present: (selector: string) => boolean, facts: TutorialFacts = {}): readonly number[] {
	const shown: number[] = [];
	for (let index = nextStep(steps, -1, false, present, facts); index !== null; index = nextStep(steps, index, steps[index]?.tap !== undefined, present, facts)) shown.push(index);
	return shown;
}

const seenKey = (id: TutorialId): string => `autorag.tutorial.${id}.seen`;

export function tutorialSeen(id: TutorialId): boolean {
	try {
		return window.localStorage.getItem(seenKey(id)) === "1";
	} catch {
		return false;
	}
}

export function markTutorialSeen(id: TutorialId): void {
	try {
		window.localStorage.setItem(seenKey(id), "1");
	} catch {
		// Storage unavailable: the tutorial may show again next session, which is harmless.
	}
}
