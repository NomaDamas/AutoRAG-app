/**
 * Where an "AI로 고치기" run stands, as the dialog shows it. Pure over the
 * main process's events, like the smart-indexing run in `onboarding/smart-scope.ts`.
 */

import type { TFunction } from "i18next";
import type { ErrorFixAction, ErrorFixEvent, ErrorFixResult, ErrorFixSettingsPage } from "../../../shared/error-fix-contract";
import type { LocaleKey } from "../../../shared/i18n";

export type ErrorFixRun =
	| { readonly status: "idle" }
	| { readonly status: "running"; readonly runId: string; readonly progress: string | null }
	| { readonly status: "done"; readonly result: ErrorFixResult }
	| { readonly status: "failed"; readonly message: string }
	| { readonly status: "stopped" };

export const initialErrorFixRun: ErrorFixRun = { status: "idle" };

export function startErrorFixRun(runId: string): ErrorFixRun {
	return { status: "running", runId, progress: null };
}

/** Applies one main-process event; events of another run, or arriving with no run going, change nothing. */
export function reduceErrorFixRun(state: ErrorFixRun, event: ErrorFixEvent): ErrorFixRun {
	if (state.status !== "running" || event.runId !== state.runId) return state;
	switch (event.type) {
		case "progress":
			return { ...state, progress: event.text };
		case "result":
			return { status: "done", result: event.result };
		case "error":
			return { status: "failed", message: event.message };
		case "cancelled":
			return { status: "stopped" };
	}
}

const PAGE_KEY: Readonly<Record<ErrorFixSettingsPage, LocaleKey>> = {
	ai: "settingsCore.nav.ai",
	account: "settingsCore.nav.account",
	plan: "settingsCore.nav.plan",
	general: "settingsCore.nav.general",
	sidebar: "settingsCore.nav.sidebar",
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

export interface ErrorFixSession {
	readonly message: string | null;
	readonly dialogOpen: boolean;
	readonly run: ErrorFixRun;
}

export const initialErrorFixSession: ErrorFixSession = {
	message: null,
	dialogOpen: false,
	run: initialErrorFixRun,
};

export function beginErrorFixSession(runId: string, message: string): ErrorFixSession {
	return { message, dialogOpen: true, run: startErrorFixRun(runId) };
}

export function reduceErrorFixSession(session: ErrorFixSession, event: ErrorFixEvent): ErrorFixSession {
	const next = reduceErrorFixRun(session.run, event);
	return next === session.run ? session : { ...session, run: next };
}

/** Hides the modal while keeping the repair running in the background. */
export function minimizeErrorFixSession(session: ErrorFixSession): ErrorFixSession {
	return session.dialogOpen ? { ...session, dialogOpen: false } : session;
}

/** Reopens a minimized or background-finished repair modal. */
export function openErrorFixSession(session: ErrorFixSession): ErrorFixSession {
	return session.run.status === "idle" || session.dialogOpen ? session : { ...session, dialogOpen: true };
}

/** Closes the modal: if still running, minimizes to background; once finished/stopped/failed, clears the session. */
export function dismissErrorFixSession(session: ErrorFixSession): ErrorFixSession {
	if (session.run.status === "running") return minimizeErrorFixSession(session);
	return initialErrorFixSession;
}

export interface SidebarErrorFixView {
	readonly tone: "run" | "ok" | "error";
	readonly percent: number | null;
	readonly headline: string;
	readonly detail: string | null;
}

/**
 * Renders the error-fix session in the sidebar footer using the same visual
 * shape as `SidebarIndexActivity`: shown whenever a repair is running, or when
 * a minimized repair has finished in the background and has not been reviewed yet.
 */
export function describeSidebarErrorFix(session: ErrorFixSession, t: TFunction): SidebarErrorFixView | null {
	const { run } = session;
	if (run.status === "idle") return null;
	if (run.status === "running") {
		return {
			tone: "run",
			percent: null,
			headline: t("appError.fix.sidebar.running"),
			detail: run.progress ?? t("appError.fix.running"),
		};
	}
	if (session.dialogOpen || run.status === "stopped") return null;
	if (run.status === "done") {
		const fixed = run.result.status === "fixed";
		return {
			tone: fixed ? "ok" : "error",
			percent: 100,
			headline: fixed
				? t("appError.fix.status.fixed")
				: run.result.status === "needs-user"
					? t("appError.fix.status.needsUser")
					: t("appError.fix.status.cannotFix"),
			detail: run.result.summary,
		};
	}
	return {
		tone: "error",
		percent: 100,
		headline: t("appError.fix.failedTitle"),
		detail: null,
	};
}
