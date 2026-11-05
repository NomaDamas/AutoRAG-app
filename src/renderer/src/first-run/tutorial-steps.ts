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
export type TutorialEffect = "askAiForRule" | "showAutomations" | "arrangePhotoPanes" | "createMagicAction" | "openContextMenuSettings" | "showRemoteSettings";

/** What the effects learned about the practice material; later steps point at it. */
export interface TutorialFacts {
	/** The sample file the Magic Action tutorial asks the person to right-click. */
	readonly sample?: string;
	/** The practice photo (under its placeholder name) and the Downloads folder it is to be dragged into. */
	readonly photo?: string;
	readonly downloads?: string;
	/** The path the photo ended up under once the rule renamed it. */
	readonly renamed?: string;
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
	/** Waits for the AI Search answer to finish (the rule is made by then); ends the tutorial if it fails. */
	readonly untilEvent?: "aiDone";
	/** Waits for the practice photo to show up under a new name in Downloads; moves on with what it learned. */
	readonly watch?: "photoRenamed";
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
const renamedRow = (facts: TutorialFacts): string => (facts.renamed === undefined ? "[data-path]:not([data-path])" : `[data-path="${attr(facts.renamed)}"]`);
const SEND_BUTTON = `${AI_HOST} form.composer button.send[type="submit"]`;

export const TUTORIALS: Readonly<Record<TutorialId, readonly TutorialStep[]>> = {
	automations: [
		{ key: "intro", anchors: [AUTOMATIONS_VIEW], offer: "askAiForRule" },
		{ key: "send", anchors: [`${AI_HOST} form.composer`], waitFor: SEND_BUTTON, tap: SEND_BUTTON },
		{ key: "asking", anchors: [`${AI_HOST} [role="alertdialog"]`, `${AI_HOST} .ai-body`], untilEvent: "aiDone" },
		{ key: "rule", anchors: [RULE_ROW], enter: "showAutomations", waitFor: RULE_ROW },
		{ key: "panes", anchors: [RULE_ROW], offer: "arrangePhotoPanes" },
		{ key: "drag", anchors: [photoRow], waitFor: photoRow, watch: "photoRenamed", hint: "drag" },
		{ key: "result", anchors: [renamedRow], waitFor: renamedRow },
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
		{ key: "toggle", anchors: ['[data-settings-row="remote-access"]'], waitFor: '[data-settings-row="remote-access"]' },
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

const PICTURE = /\.(jpe?g|png|heic|webp|gif)$/iu;

function basenameOf(path: string): string {
	return path.replaceAll("\\", "/").split("/").pop() ?? path;
}

/**
 * The photo's new path: a picture that appeared directly in Downloads since `baseline` (what the folder showed when the
 * step began) under any name but the placeholder it was dragged in with. Null while it still has the placeholder name
 * or has not arrived.
 */
export function renamedPhoto(paths: readonly string[], facts: TutorialFacts, baseline: ReadonlySet<string>): string | null {
	const { downloads, photo } = facts;
	if (downloads === undefined || photo === undefined) return null;
	const prefix = downloads.endsWith("/") || downloads.endsWith("\\") ? downloads : `${downloads}/`;
	const placeholder = basenameOf(photo);
	for (const path of paths) {
		if (baseline.has(path) || !path.startsWith(prefix)) continue;
		const rest = path.slice(prefix.length);
		if (/[\\/]/u.test(rest) || !PICTURE.test(rest) || rest === placeholder) continue;
		return path;
	}
	return null;
}
