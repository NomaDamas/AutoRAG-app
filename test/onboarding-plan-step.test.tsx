// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountPlanId, AccountStatus } from "../src/shared/account-contract";
import type { PlanId } from "../src/shared/onboarding-contract";
import type { OnboardingCtx } from "../src/renderer/src/onboarding/context";
import { PlanStep } from "../src/renderer/src/onboarding/steps/Plan";
import { BASE_DRAFT, onboardingCtx } from "./support/onboarding-ctx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

function account(plan: AccountPlanId, trialing = false): AccountStatus {
	return {
		state: "signedIn",
		offline: false,
		error: null,
		baseUrl: "https://api.example.test",
		account: {
			email: "user@example.com",
			plan,
			status: trialing ? "trialing" : "active",
			trialing,
			cancelScheduled: false,
			periodEnd: "2026-11-01T00:00:00.000Z",
			creditsUsedCents: 0,
			creditsLimitCents: 50,
			creditPeriod: "2026-W43",
			embeddings: true,
			requestsPerMinute: 10,
			billing: { air: true, pro: true, max: true, portal: false },
		},
	};
}

function render(overrides: Partial<OnboardingCtx> & { readonly plan?: PlanId } = {}): void {
	const { plan = "pro", ...rest } = overrides;
	act(() => root.render(<PlanStep ctx={onboardingCtx({ draft: { ...BASE_DRAFT, stepId: "plan", plan }, account: account("free"), ...rest })} />));
}

const cards = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".plan-card")];

describe("plan step", () => {
	it("lists Free, Air, Pro, Max and BYOK in that order", () => {
		render();

		expect(cards().map((card) => card.querySelector(".plan-name")?.firstChild?.textContent)).toEqual([
			"onboarding.plan.plan.free.name",
			"onboarding.plan.plan.air.name",
			"onboarding.plan.plan.pro.name",
			"onboarding.plan.plan.max.name",
			"onboarding.plan.plan.byok.name",
		]);
	});

	it("says on the Pro card that it starts with a free trial", () => {
		render();

		const pro = cards()[2];
		expect(pro?.textContent).toContain("onboarding.plan.plan.pro.trial");
		expect(cards().filter((card) => card.textContent?.includes("onboarding.plan.plan.pro.trial"))).toHaveLength(1);
	});

	it("marks only the chosen card, and picking a card chooses its plan", () => {
		const choosePlan = vi.fn();
		render({ plan: "max", choosePlan });

		expect(cards().map((card) => card.classList.contains("selected"))).toEqual([false, false, false, true, false]);
		act(() => cards()[1]?.click());
		expect(choosePlan).toHaveBeenCalledWith("air");
	});

	it("asks for a promo code for every paid plan the account does not hold yet", () => {
		for (const plan of ["air", "pro", "max"] as const) {
			render({ plan });
			expect(host.querySelector('input[name="promo-code"]'), plan).not.toBeNull();
		}
	});

	it("offers no promo code where nothing is bought", () => {
		for (const plan of ["free", "byok"] as const) {
			render({ plan });
			expect(host.querySelector('input[name="promo-code"]'), plan).toBeNull();
		}
		render({ plan: "pro", account: account("pro") });
		expect(host.querySelector('input[name="promo-code"]')).toBeNull();
		render({ plan: "air", account: account("max") });
		expect(host.querySelector('input[name="promo-code"]')).toBeNull();
	});

	it("hands what is typed to the controller", () => {
		const setPromoCode = vi.fn();
		render({ plan: "pro", setPromoCode });
		const input = host.querySelector<HTMLInputElement>('input[name="promo-code"]');

		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "WELCOME-7");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(setPromoCode).toHaveBeenCalledWith("WELCOME-7");
	});

	it("flags a malformed code before anything is sent", () => {
		render({ plan: "pro", promoCode: "two words" });
		expect(host.querySelector('input[name="promo-code"]')?.getAttribute("aria-invalid")).toBe("true");
		expect(host.querySelector(".promo-error")).not.toBeNull();

		render({ plan: "pro", promoCode: "WELCOME-7" });
		expect(host.querySelector('input[name="promo-code"]')?.getAttribute("aria-invalid")).toBe("false");
		expect(host.querySelector(".promo-error")).toBeNull();
	});

	it("narrows the choice to Pro and Max when remote embedding is chosen", () => {
		render({ plan: "pro", draft: { ...BASE_DRAFT, stepId: "plan", plan: "pro", embed: "cloud" } });

		expect(cards().map((card) => card.getAttribute("aria-disabled"))).toEqual(["true", "true", "false", "false", "true"]);
	});

	it("shows the trial a Pro account is in, and not the offer again", () => {
		render({ plan: "pro", account: account("pro", true) });

		expect(cards()[2]?.textContent).toContain("onboarding.plan.badgeTrial");
	});
});
