/**
 * Contextual tutorials: short coach-mark walkthroughs that start the first
 * time a person reaches a feature on their own (the 자동화 sidebar item, a
 * file's right-click menu, Settings), never during the first run. Each one
 * shows once per profile. The React layer (`Tutorials.tsx`) renders them.
 */

import { AI_HOST } from "./tour";

export type TutorialId = "automations" | "contextMenu" | "remoteAccess";

/** What accepting an offer step does in the Finder before the tutorial goes on. */
export type TutorialEffect = "openContextMenuSettings" | "showRemoteSettings";

export interface TutorialStep {
	/** Copy lives under `tutorials.<id>.<key>.{title,body}`. */
	readonly key: string;
	/** What the spotlight frames: the first selector that matches, in order. */
	readonly anchors: readonly string[];
	/** The step is passed over when this selector matches nothing as it comes up. */
	readonly requires?: string;
	/** Click-required: the cursor taps this target, and clicking it moves on. */
	readonly tap?: string;
	/** Shown only right after a click-required step was actually clicked. */
	readonly followsTap?: boolean;
	/** An offer: "later" ends the tutorial, "learn" runs the effect and moves on. */
	readonly offer?: TutorialEffect;
}

const AUTOMATIONS_VIEW = "[data-automations-view]";
const AUTOMATION_ADD = '[data-action="automation-add"]';
const DAEMON_LINE = "footer[data-daemon]";
const CUSTOMIZER_BUTTON = '[data-action="open-context-menu-customizer"]';
const REMOTE_SECTION = '[data-settings-section="remote"]';

export const TUTORIALS: Readonly<Record<TutorialId, readonly TutorialStep[]>> = {
	automations: [
		{ key: "intro", anchors: [AUTOMATIONS_VIEW] },
		{ key: "background", anchors: [DAEMON_LINE], requires: DAEMON_LINE },
		{ key: "rules", anchors: ["[data-rules-body]"], requires: "[data-rule-id]" },
		{ key: "create", anchors: [AUTOMATION_ADD], requires: AUTOMATION_ADD, tap: AUTOMATION_ADD },
		{ key: "draft", anchors: [`${AI_HOST} form.composer`], followsTap: true },
	],
	contextMenu: [
		{ key: "offer", anchors: ['.menu[role="menu"]'], offer: "openContextMenuSettings" },
		{ key: "customize", anchors: [CUSTOMIZER_BUTTON], tap: CUSTOMIZER_BUTTON },
		{ key: "ask", anchors: ['[data-testid="app-customizer-input"]'], followsTap: true },
	],
	remoteAccess: [
		{ key: "offer", anchors: [REMOTE_SECTION, '[data-settings-nav="general"]'], offer: "showRemoteSettings" },
		{ key: "toggle", anchors: ['[data-settings-row="remote-access"]'] },
		{ key: "address", anchors: ['[data-settings-row="remote-address"]'] },
		{ key: "security", anchors: [REMOTE_SECTION] },
	],
};

/**
 * The step after `from` (-1 for the first one) that the live Finder supports,
 * or null when the tutorial is over. `tapped` says whether `from` was a
 * click-required step the person clicked.
 */
export function nextStep(steps: readonly TutorialStep[], from: number, tapped: boolean, present: (selector: string) => boolean): number | null {
	for (let index = from + 1; index < steps.length; index += 1) {
		const step = steps[index];
		if (step === undefined) break;
		if (step.followsTap === true && !(tapped && index === from + 1)) continue;
		if (step.requires !== undefined && !present(step.requires)) continue;
		return index;
	}
	return null;
}

const seenKey = (id: TutorialId): string => `autorag.tutorial.${id}.seen`;

/** The steps the live Finder would show, in order, for the "n / m" count (a click-required step counts as clicked). */
export function stepsInPlay(steps: readonly TutorialStep[], present: (selector: string) => boolean): readonly number[] {
	const shown: number[] = [];
	for (let index = nextStep(steps, -1, false, present); index !== null; index = nextStep(steps, index, steps[index]?.tap !== undefined, present)) shown.push(index);
	return shown;
}

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
