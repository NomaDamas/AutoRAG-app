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
	shortcuts: "settingsCore.nav.shortcuts",
	web: "settingsCore.nav.web",
	contextMenu: "settingsCore.nav.contextMenu" as LocaleKey,
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
	readonly tone: "run" | "queued" | "ok" | "error";
	readonly percent: number | null;
	readonly headline: string;
	readonly detail: string | null;
}

export interface SidebarErrorFixEntry extends SidebarErrorFixView {
	readonly id: string;
}

/**
 * Renders one error-fix session in the sidebar footer using the same visual
 * shape as `SidebarIndexActivity`: shown whenever a repair is running, or when
 * a minimized repair has finished in the background and has not been reviewed yet.
 */
export function describeSidebarErrorFix(session: ErrorFixSession, t: TFunction, queued = false): SidebarErrorFixView | null {
	const { run } = session;
	if (run.status === "idle") return null;
	if (run.status === "running") {
		if (queued && run.progress === null) {
			return {
				tone: "queued",
				percent: 0,
				headline: t("appError.fix.sidebar.queued"),
				detail: t("appError.fix.queued"),
			};
		}
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

/* -------------------------------- Multi-session background queue store --- */

export interface ErrorFixSessionItem {
	readonly id: string;
	readonly message: string;
	readonly run: ErrorFixRun;
}

export interface ErrorFixStore {
	readonly sessions: readonly ErrorFixSessionItem[];
	/** `id` of the session currently open in `ErrorFixDialog`, or `null` when minimized / closed. */
	readonly activeId: string | null;
}

export const initialErrorFixStore: ErrorFixStore = {
	sessions: [],
	activeId: null,
};

/**
 * Enqueues a repair session without cancelling or overwriting any minimized
 * background sessions. Reopens an existing running session when the exact same
 * error message is triggered again.
 */
export function enqueueErrorFixStore(store: ErrorFixStore, runId: string, message: string): ErrorFixStore {
	const existing = store.sessions.find((entry) => entry.run.status === "running" && entry.message === message);
	if (existing !== undefined) {
		return store.activeId === existing.id ? store : { ...store, activeId: existing.id };
	}
	return {
		sessions: [...store.sessions, { id: runId, message, run: startErrorFixRun(runId) }],
		activeId: runId,
	};
}

export function reduceErrorFixStore(store: ErrorFixStore, event: ErrorFixEvent): ErrorFixStore {
	let changed = false;
	const nextSessions: ErrorFixSessionItem[] = [];
	let nextActiveId = store.activeId;
	for (const entry of store.sessions) {
		const nextRun = reduceErrorFixRun(entry.run, event);
		if (nextRun !== entry.run) changed = true;
		// A background session that was cancelled leaves the queue immediately; an open dialog keeps showing "Stopped".
		if (nextRun.status === "stopped" && store.activeId !== entry.id) {
			changed = true;
			continue;
		}
		nextSessions.push(nextRun === entry.run ? entry : { ...entry, run: nextRun });
	}
	if (nextActiveId !== null && !nextSessions.some((entry) => entry.id === nextActiveId)) {
		nextActiveId = null;
		changed = true;
	}
	return changed ? { sessions: nextSessions, activeId: nextActiveId } : store;
}

export function minimizeErrorFixStore(store: ErrorFixStore): ErrorFixStore {
	return store.activeId === null ? store : { ...store, activeId: null };
}

export function openErrorFixStoreById(store: ErrorFixStore, id: string): ErrorFixStore {
	if (!store.sessions.some((entry) => entry.id === id)) return store;
	return store.activeId === id ? store : { ...store, activeId: id };
}

/**
 * Closes the currently open modal: if its repair is still running, minimizes it
 * to the background queue; once finished/failed/stopped, removes ONLY that
 * session while leaving every other background repair untouched.
 */
export function dismissErrorFixStore(store: ErrorFixStore): ErrorFixStore {
	if (store.activeId === null) return store;
	const active = store.sessions.find((entry) => entry.id === store.activeId);
	if (active === undefined) return { ...store, activeId: null };
	if (active.run.status === "running") return { ...store, activeId: null };
	return {
		sessions: store.sessions.filter((entry) => entry.id !== store.activeId),
		activeId: null,
	};
}

export function removeErrorFixSessionFromStore(store: ErrorFixStore, id: string): ErrorFixStore {
	if (!store.sessions.some((entry) => entry.id === id)) return store;
	return {
		sessions: store.sessions.filter((entry) => entry.id !== id),
		activeId: store.activeId === id ? null : store.activeId,
	};
}

/** Derives the active modal view (`ErrorFixSession`) for `ErrorFixDialog`. */
export function activeErrorFixSession(store: ErrorFixStore): ErrorFixSession {
	if (store.activeId !== null) {
		const open = store.sessions.find((entry) => entry.id === store.activeId);
		if (open !== undefined) return { message: open.message, dialogOpen: true, run: open.run };
	}
	const fallback = store.sessions[0];
	return fallback === undefined ? initialErrorFixSession : { message: fallback.message, dialogOpen: false, run: fallback.run };
}

/** Maps every active, queued, and unreviewed background-completed session into sidebar entries. */
export function describeSidebarErrorFixEntries(store: ErrorFixStore, t: TFunction): readonly SidebarErrorFixEntry[] {
	const firstRunningIndex = store.sessions.findIndex((entry) => entry.run.status === "running");
	const entries: SidebarErrorFixEntry[] = [];
	for (let index = 0; index < store.sessions.length; index += 1) {
		const item = store.sessions[index];
		if (item === undefined) continue;
		const queued = item.run.status === "running" && firstRunningIndex >= 0 && index > firstRunningIndex;
		const view = describeSidebarErrorFix(
			{ message: item.message, dialogOpen: store.activeId === item.id, run: item.run },
			t,
			queued,
		);
		if (view !== null) entries.push({ id: item.id, ...view });
	}
	return entries;
}
