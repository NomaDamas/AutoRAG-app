/**
 * The notification center (Figma 566:14075): what went wrong earlier, kept so a toast that has gone is not lost.
 *
 * "지난 알림" are the error notices the app showed (a failed file action, a preview that could not be made, …). They
 * outlive a relaunch in this browser's storage, newest first and at most {@link MAX_PAST}. A notice may carry a way
 * to try again; that callback lives only in this window, so a notice read back after a relaunch has no button.
 *
 * "해결 필요" are not stored here: they are the live problems the app already tracks (the index, a connection that
 * needs attention), read where the panel is drawn. Only the person's 숨기기 for one of them is kept, by its id and a
 * signature, so the same problem stays hidden and a different one shows again.
 */

import { useSyncExternalStore } from "react";
import { i18n, t } from "../../../shared/i18n/core";

export type NoticeTone = "error" | "warning";

export interface PastNotice {
	readonly id: string;
	readonly tone: NoticeTone;
	readonly title: string;
	readonly body: string | null;
	/** Epoch milliseconds. */
	readonly at: number;
}

export interface NoticeRetry {
	readonly label: string;
	readonly run: () => void;
}

export interface NotificationState {
	readonly past: readonly PastNotice[];
	/** Active problems the person hid: id → the signature it had when hidden. */
	readonly hidden: Readonly<Record<string, string>>;
	/** The newest notice the person has seen in the open panel (epoch ms); a newer one lights the bell's dot. */
	readonly seenAt: number;
	readonly open: boolean;
}

const STORE_KEY = "dazzi.notifications.v1";
export const MAX_PAST = 30;

function load(): NotificationState {
	try {
		const raw = localStorage.getItem(STORE_KEY);
		if (raw === null) return { past: [], hidden: {}, seenAt: 0, open: false };
		const parsed = JSON.parse(raw) as Partial<NotificationState>;
		const past = Array.isArray(parsed.past) ? parsed.past.filter((entry): entry is PastNotice => typeof entry?.id === "string" && typeof entry.title === "string").slice(0, MAX_PAST) : [];
		const hidden = parsed.hidden !== null && typeof parsed.hidden === "object" ? parsed.hidden : {};
		return { past, hidden, seenAt: typeof parsed.seenAt === "number" ? parsed.seenAt : 0, open: false };
	} catch {
		return { past: [], hidden: {}, seenAt: 0, open: false };
	}
}

let state: NotificationState = typeof localStorage === "undefined" ? { past: [], hidden: {}, seenAt: 0, open: false } : load();
const retries = new Map<string, NoticeRetry>();
const listeners = new Set<() => void>();

function publish(next: NotificationState): void {
	state = next;
	try {
		localStorage.setItem(STORE_KEY, JSON.stringify({ past: state.past, hidden: state.hidden, seenAt: state.seenAt }));
	} catch {
		// Storage can be full or blocked; the panel keeps working for this window.
	}
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useNotifications(): NotificationState {
	return useSyncExternalStore(subscribe, () => state, () => state);
}

export function notificationSnapshot(): NotificationState {
	return state;
}

/** Keeps an error the app just showed. The same title and body within a few seconds is one notice, not two. */
export function pushNotice(input: { readonly tone?: NoticeTone; readonly title: string; readonly body?: string | null; readonly retry?: NoticeRetry }, now: number = Date.now()): string {
	const body = input.body ?? null;
	const recent = state.past[0];
	if (recent !== undefined && recent.title === input.title && recent.body === body && now - recent.at < 5_000) {
		if (input.retry !== undefined) retries.set(recent.id, input.retry);
		return recent.id;
	}
	const id = `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	if (input.retry !== undefined) retries.set(id, input.retry);
	const past = [{ id, tone: input.tone ?? "error", title: input.title, body, at: now }, ...state.past];
	for (const dropped of past.slice(MAX_PAST)) retries.delete(dropped.id);
	publish({ ...state, past: past.slice(0, MAX_PAST), seenAt: state.open ? now : state.seenAt });
	return id;
}

export function noticeRetry(id: string): NoticeRetry | undefined {
	return retries.get(id);
}

export function dismissNotice(id: string): void {
	retries.delete(id);
	publish({ ...state, past: state.past.filter((entry) => entry.id !== id) });
}

/** 지난 알림 지우기: the past list empties; hidden active problems stay hidden. */
export function clearPastNotices(): void {
	retries.clear();
	publish({ ...state, past: [] });
}

export function hideActiveNotice(id: string, signature: string): void {
	publish({ ...state, hidden: { ...state.hidden, [id]: signature } });
}

export function isActiveHidden(hidden: NotificationState["hidden"], id: string, signature: string): boolean {
	return hidden[id] === signature;
}

export function setNotificationCenterOpen(open: boolean): void {
	if (open === state.open) return;
	publish({ ...state, open, seenAt: open ? Math.max(state.seenAt, state.past[0]?.at ?? 0) : state.seenAt });
}

export function hasUnseenNotice(current: NotificationState): boolean {
	return (current.past[0]?.at ?? 0) > current.seenAt;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "방금 전", "3분 전", "2시간 전", "어제", then the date, in the interface language. */
export function noticeAge(at: number, now: number = Date.now()): string {
	const age = Math.max(0, now - at);
	if (age < MINUTE_MS) return t("notifications.justNow");
	const format = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
	if (age < HOUR_MS) return format.format(-Math.floor(age / MINUTE_MS), "minute");
	if (age < DAY_MS) return format.format(-Math.floor(age / HOUR_MS), "hour");
	if (age < 7 * DAY_MS) return format.format(-Math.floor(age / DAY_MS), "day");
	return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(at);
}

export function resetNotificationsForTests(): void {
	retries.clear();
	state = { past: [], hidden: {}, seenAt: 0, open: false };
	for (const listener of listeners) listener();
}
