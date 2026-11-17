// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenter } from "../src/renderer/src/components/NotificationCenter";
import {
	MAX_PAST,
	clearPastNotices,
	hasUnseenNotice,
	hideActiveNotice,
	isActiveHidden,
	notificationSnapshot,
	pushNotice,
	resetNotificationsForTests,
	setNotificationCenterOpen,
} from "../src/renderer/src/state/notifications";
import { setAppLanguage, t } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	resetNotificationsForTests();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	document.body.innerHTML = "";
	Reflect.deleteProperty(window, "autorag");
});

describe("the notification store", () => {
	it("keeps the newest first, folds a repeat within seconds into one, and keeps at most MAX_PAST", () => {
		pushNotice({ title: "A" }, 1_000);
		pushNotice({ title: "A" }, 2_000);
		pushNotice({ title: "B", body: "why" }, 10_000);
		expect(notificationSnapshot().past.map((entry) => entry.title)).toEqual(["B", "A"]);
		for (let index = 0; index < MAX_PAST + 5; index += 1) pushNotice({ title: `n${index}` }, 20_000 + index * 10_000);
		expect(notificationSnapshot().past).toHaveLength(MAX_PAST);
		clearPastNotices();
		expect(notificationSnapshot().past).toHaveLength(0);
	});

	it("lights the bell for a notice the open panel has not shown yet", () => {
		pushNotice({ title: "A" }, 1_000);
		expect(hasUnseenNotice(notificationSnapshot())).toBe(true);
		setNotificationCenterOpen(true);
		expect(hasUnseenNotice(notificationSnapshot())).toBe(false);
	});

	it("hides an active problem until it changes", () => {
		hideActiveNotice("index", "2026-11-17T01:00:00Z");
		const hidden = notificationSnapshot().hidden;
		expect(isActiveHidden(hidden, "index", "2026-11-17T01:00:00Z")).toBe(true);
		expect(isActiveHidden(hidden, "index", "2026-11-17T02:00:00Z")).toBe(false);
	});
});

describe("the notification center", () => {
	const render = (): void => {
		act(() => root.render(<NotificationCenter />));
	};
	const bell = (): HTMLButtonElement => host.querySelector<HTMLButtonElement>('[data-action="open-notifications"]') as HTMLButtonElement;
	const panel = (): HTMLElement | null => document.body.querySelector(".notification-center");

	it("opens from the bell with the earlier notices, a retry where one was given, and closes on Escape", () => {
		const retry = vi.fn();
		pushNotice({ title: "이미지 처리에 실패했습니다", body: "report.pdf", retry: { label: t("common.retry"), run: retry } });
		render();
		expect(bell().getAttribute("aria-label")).toBe(t("notifications.openUnread"));
		act(() => bell().click());
		expect(panel()?.textContent).toContain(t("notifications.past"));
		expect(panel()?.textContent).toContain("이미지 처리에 실패했습니다");
		const retryButton = [...(panel()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === t("common.retry"));
		act(() => retryButton?.click());
		expect(retry).toHaveBeenCalledTimes(1);
		expect(notificationSnapshot().past).toHaveLength(0);
		act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(panel()).toBeNull();
	});

	it("shows a connection that needs attention under 해결 필요, and 숨기기 hides it", async () => {
		Reflect.set(window, "autorag", {
			settings: {
				sourcesList: async () => ({
					sources: [
						{ id: "gmail", type: "gmail", description: "", enabled: true, status: "attention", install: { detail: "다시 로그인해야 합니다." }, agent: { detail: "" }, index: { detail: "" } },
					],
				}),
			},
		});
		render();
		await act(async () => {
			bell().click();
			await Promise.resolve();
		});
		await act(async () => Promise.resolve());
		expect(panel()?.textContent).toContain(t("notifications.needsAction"));
		expect(panel()?.textContent).toContain("다시 로그인해야 합니다.");
		const hide = [...(panel()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === t("notifications.hide"));
		act(() => hide?.click());
		expect(panel()?.textContent).not.toContain("다시 로그인해야 합니다.");
		expect(panel()?.textContent).toContain(t("notifications.empty"));
	});
});
