// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunErrorNotice } from "../src/renderer/src/components/RunErrorNotice";
import { setAppLanguage, t } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const buttons = (): HTMLButtonElement[] => [...host.querySelectorAll("button")];

describe("RunErrorNotice", () => {
	it("shows the message alone for an error with nothing to do about it", () => {
		act(() => root.render(<RunErrorNotice message="Error: boom" action={null} onOpenPlan={vi.fn()} />));

		expect(host.textContent).toBe("Error: boom");
		expect(buttons()).toHaveLength(0);
	});

	it("offers a button that opens the subscription and usage page when the plan is the problem", () => {
		const onOpenPlan = vi.fn();
		act(() => root.render(<RunErrorNotice message="이번 주 Dazzi 크레딧을 모두 사용했습니다." action="open-plan" onOpenPlan={onOpenPlan} />));

		expect(host.textContent).toContain("이번 주 Dazzi 크레딧을 모두 사용했습니다.");
		expect(buttons()).toHaveLength(1);
		// The button is named for where it goes: the Settings page the person sees as "구독 및 사용량".
		expect(buttons()[0]?.textContent).toBe(t("aiSearch.openPlan"));
		expect(t("aiSearch.openPlan")).toContain(t("settingsCore.nav.plan"));

		act(() => buttons()[0]?.click());

		expect(onOpenPlan).toHaveBeenCalledTimes(1);
	});
});
