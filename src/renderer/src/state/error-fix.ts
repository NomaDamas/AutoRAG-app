/**
 * Where an "AI로 고치기" run stands, as the dialog shows it. Pure over the
 * main process's events, like the smart-indexing run in `onboarding/smart-scope.ts`.
 */

import type { TFunction } from "i18next";
import type { ErrorFixAction, ErrorFixChange, ErrorFixEvent, ErrorFixResult, ErrorFixSettingsPage, ErrorFixStep } from "../../../shared/error-fix-contract";
import type { LocaleKey } from "../../../shared/i18n";

/** The dialog lists what the agent did; a runaway run keeps only the latest. */
const MAX_STEPS = 30;

export type ErrorFixRun =
	| { readonly status: "idle" }
	| { readonly status: "running"; readonly runId: string; readonly steps: readonly ErrorFixStep[] }
	| { readonly status: "done"; readonly result: ErrorFixResult; readonly steps: readonly ErrorFixStep[] }
	| { readonly status: "failed"; readonly message: string; readonly steps: readonly ErrorFixStep[]; readonly changes: readonly ErrorFixChange[]; readonly backupPath: string | null; readonly commands: readonly string[] }
	| { readonly status: "stopped"; readonly steps: readonly ErrorFixStep[]; readonly changes: readonly ErrorFixChange[]; readonly backupPath: string | null; readonly commands: readonly string[] };

export const initialErrorFixRun: ErrorFixRun = { status: "idle" };

export function startErrorFixRun(runId: string): ErrorFixRun {
	return { status: "running", runId, steps: [] };
}

/** Applies one main-process event; events of another run, or arriving with no run going, change nothing. */
export function reduceErrorFixRun(state: ErrorFixRun, event: ErrorFixEvent): ErrorFixRun {
	if (state.status !== "running" || event.runId !== state.runId) return state;
	switch (event.type) {
		case "step":
			return { ...state, steps: [...state.steps, event.step].slice(-MAX_STEPS) };
		case "result":
			return { status: "done", result: event.result, steps: state.steps };
		case "error":
			return { status: "failed", message: event.message, steps: state.steps, changes: event.changes, backupPath: event.backupPath, commands: event.commands ?? [] };
		case "cancelled":
			return { status: "stopped", steps: state.steps, changes: event.changes, backupPath: event.backupPath, commands: event.commands ?? [] };
	}
}

const STEP_KEY: Readonly<Record<ErrorFixStep["tool"], LocaleKey>> = {
	diagnose: "appError.fix.steps.diagnose",
	read: "appError.fix.steps.read",
	ls: "appError.fix.steps.ls",
	find: "appError.fix.steps.find",
	grep: "appError.fix.steps.grep",
	edit: "appError.fix.steps.edit",
	write: "appError.fix.steps.write",
	bash: "appError.fix.steps.bash",
	refresh_index: "appError.fix.steps.refreshIndex",
};

/** One line of the activity list: the action in the interface language, then the path or key it works on as it is. */
export function describeFixStep(step: ErrorFixStep, t: TFunction): string {
	const action = t(STEP_KEY[step.tool]);
	return step.detail === null ? action : `${action}: ${step.detail}`;
}

const PAGE_KEY: Readonly<Record<ErrorFixSettingsPage, LocaleKey>> = {
	ai: "settingsCore.nav.ai",
	account: "settingsCore.nav.account",
	plan: "settingsCore.nav.plan",
	general: "settingsCore.nav.general",
	web: "settingsCore.nav.web",
	mcp: "settingsCore.nav.mcp",
	indexing: "settingsCore.nav.indexing",
	scope: "settingsCore.nav.scope",
	reading: "settingsCore.nav.reading",
	duplicates: "settingsCore.nav.duplicates",
	apps: "settingsCore.nav.apps",
};

/** The Settings page's own name, as the sidebar of Settings shows it. */
export function settingsPageLabel(page: ErrorFixSettingsPage, t: TFunction): string {
	return t(PAGE_KEY[page]);
}

/**
 * What a button of the AI's answer says: the AI's own label (written in the interface language, as what the button
 * does), or, when it gave none, a name made from where it goes, so a button is never blank.
 */
export function actionLabel(action: ErrorFixAction, t: TFunction): string {
	if (action.label !== "") return action.label;
	return action.kind === "settings" ? t("appError.fix.openSettings", { page: settingsPageLabel(action.target, t) }) : t("appError.fix.openSource", { name: action.target });
}
