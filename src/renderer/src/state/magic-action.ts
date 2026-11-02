import type { TFunction } from "i18next";
import type { MagicActionEvent, MagicActionResult } from "../../../shared/magic-actions-contract";

export type MagicActionRunState =
	| { readonly status: "idle" }
	| {
			readonly status: "running";
			readonly runId: string;
			readonly actionId: string;
			readonly actionLabel: string;
			readonly executionKind: "script" | "agent";
			readonly paths: readonly string[];
			readonly progress: string | null;
			readonly draft: string;
	  }
	| {
			readonly status: "done";
			readonly result: MagicActionResult;
	  }
	| {
			readonly status: "failed";
			readonly actionId: string;
			readonly actionLabel: string;
			readonly paths: readonly string[];
			readonly message: string;
			readonly stderr?: string;
	  }
	| {
			readonly status: "stopped";
			readonly actionId: string;
			readonly actionLabel: string;
			readonly paths: readonly string[];
	  };

export interface MagicActionSession {
	readonly dialogOpen: boolean;
	readonly run: MagicActionRunState;
}

export const initialMagicActionSession: MagicActionSession = {
	dialogOpen: false,
	run: { status: "idle" },
};

export function beginMagicActionSession(input: {
	readonly runId: string;
	readonly actionId: string;
	readonly actionLabel: string;
	readonly executionKind: "script" | "agent";
	readonly paths: readonly string[];
}): MagicActionSession {
	return {
		dialogOpen: true,
		run: {
			status: "running",
			runId: input.runId,
			actionId: input.actionId,
			actionLabel: input.actionLabel,
			executionKind: input.executionKind,
			paths: input.paths,
			progress: null,
			draft: "",
		},
	};
}

export function reduceMagicActionSession(session: MagicActionSession, event: MagicActionEvent): MagicActionSession {
	const { run } = session;
	if (run.status !== "running" || event.runId !== run.runId) return session;
	switch (event.type) {
		case "started":
			return {
				...session,
				run: {
					...run,
					actionId: event.actionId,
					actionLabel: event.actionLabel,
					executionKind: event.executionKind,
					paths: event.paths,
				},
			};
		case "progress":
			return { ...session, run: { ...run, progress: event.text } };
		case "draft":
			return { ...session, run: { ...run, draft: event.text } };
		case "done":
			return { ...session, run: { status: "done", result: event.result } };
		case "error":
			return {
				...session,
				run: {
					status: "failed",
					actionId: run.actionId,
					actionLabel: event.actionLabel || run.actionLabel,
					paths: run.paths,
					message: event.message,
					...(event.stderr === undefined ? {} : { stderr: event.stderr }),
				},
			};
		case "cancelled":
			return {
				...session,
				run: {
					status: "stopped",
					actionId: run.actionId,
					actionLabel: event.actionLabel || run.actionLabel,
					paths: run.paths,
				},
			};
	}
}

export function minimizeMagicActionSession(session: MagicActionSession): MagicActionSession {
	return session.dialogOpen ? { ...session, dialogOpen: false } : session;
}

export function openMagicActionSession(session: MagicActionSession): MagicActionSession {
	return session.run.status === "idle" || session.dialogOpen ? session : { ...session, dialogOpen: true };
}

export function dismissMagicActionSession(session: MagicActionSession): MagicActionSession {
	if (session.run.status === "running") return minimizeMagicActionSession(session);
	return initialMagicActionSession;
}

export interface SidebarMagicActionView {
	readonly tone: "run" | "ok" | "error";
	readonly percent: number | null;
	readonly headline: string;
	readonly detail: string | null;
}

export interface SidebarMagicActionEntry extends SidebarMagicActionView {
	readonly id: string;
}

export function describeSidebarMagicAction(session: MagicActionSession, t: TFunction): SidebarMagicActionView | null {
	const { run } = session;
	if (run.status === "idle") return null;
	if (run.status === "running") {
		return {
			tone: "run",
			percent: null,
			headline: run.actionLabel,
			detail: run.progress ?? t("magicAction.running"),
		};
	}
	if (session.dialogOpen || run.status === "stopped") return null;
	if (run.status === "done") {
		const firstLine = run.result.output.split("\n").find((line) => line.trim().length > 0)?.trim() ?? null;
		return {
			tone: "ok",
			percent: 100,
			headline: run.result.actionLabel,
			detail: firstLine ?? t("magicAction.completed"),
		};
	}
	return {
		tone: "error",
		percent: 100,
		headline: run.actionLabel,
		detail: run.message,
	};
}

/* -------------------------------- Multi-session background queue store --- */

export interface MagicActionSessionItem {
	readonly id: string;
	readonly run: MagicActionRunState;
}

export interface MagicActionStore {
	readonly sessions: readonly MagicActionSessionItem[];
	readonly activeId: string | null;
}

export const initialMagicActionStore: MagicActionStore = {
	sessions: [],
	activeId: null,
};

export function enqueueMagicActionStore(
	store: MagicActionStore,
	input: {
		readonly runId: string;
		readonly actionId: string;
		readonly actionLabel: string;
		readonly executionKind: "script" | "agent";
		readonly paths: readonly string[];
	},
): MagicActionStore {
	const begun = beginMagicActionSession(input);
	return {
		sessions: [...store.sessions, { id: input.runId, run: begun.run }],
		activeId: input.runId,
	};
}

export function reduceMagicActionStore(store: MagicActionStore, event: MagicActionEvent): MagicActionStore {
	let changed = false;
	const nextSessions: MagicActionSessionItem[] = [];
	let nextActiveId = store.activeId;
	for (const entry of store.sessions) {
		const nextSession = reduceMagicActionSession({ dialogOpen: store.activeId === entry.id, run: entry.run }, event);
		if (nextSession.run !== entry.run) changed = true;
		if (nextSession.run.status === "stopped" && store.activeId !== entry.id) {
			changed = true;
			continue;
		}
		nextSessions.push(nextSession.run === entry.run ? entry : { ...entry, run: nextSession.run });
	}
	if (nextActiveId !== null && !nextSessions.some((entry) => entry.id === nextActiveId)) {
		nextActiveId = null;
		changed = true;
	}
	return changed ? { sessions: nextSessions, activeId: nextActiveId } : store;
}

export function openMagicActionStoreById(store: MagicActionStore, id: string): MagicActionStore {
	if (!store.sessions.some((entry) => entry.id === id)) return store;
	return store.activeId === id ? store : { ...store, activeId: id };
}

export function dismissMagicActionStore(store: MagicActionStore): MagicActionStore {
	if (store.activeId === null) return store;
	const active = store.sessions.find((entry) => entry.id === store.activeId);
	if (active === undefined) return { ...store, activeId: null };
	if (active.run.status === "running") return { ...store, activeId: null };
	return {
		sessions: store.sessions.filter((entry) => entry.id !== store.activeId),
		activeId: null,
	};
}

export function activeMagicActionSession(store: MagicActionStore): MagicActionSession {
	if (store.activeId !== null) {
		const open = store.sessions.find((entry) => entry.id === store.activeId);
		if (open !== undefined) return { dialogOpen: true, run: open.run };
	}
	const fallback = store.sessions[0];
	return fallback === undefined ? initialMagicActionSession : { dialogOpen: false, run: fallback.run };
}

export function describeSidebarMagicActionEntries(store: MagicActionStore, t: TFunction): readonly SidebarMagicActionEntry[] {
	const entries: SidebarMagicActionEntry[] = [];
	for (const item of store.sessions) {
		const view = describeSidebarMagicAction({ dialogOpen: store.activeId === item.id, run: item.run }, t);
		if (view !== null) entries.push({ id: item.id, ...view });
	}
	return entries;
}
