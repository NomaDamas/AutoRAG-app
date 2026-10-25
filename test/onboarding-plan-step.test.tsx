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
			creditsResetsAt: null,
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

	it("puts the free trial on the Pro card as its own call-out, once", () => {
		render();

		const ribbons = [...host.querySelectorAll(".plan-trial")];
		expect(ribbons).toHaveLength(1);
		expect(cards()[2]?.contains(ribbons[0] ?? null)).toBe(true);
		expect(ribbons[0]?.textContent).toBe("onboarding.plan.plan.pro.trial");
	});

	it("stops offering the trial once the account holds Pro, and says what it is in", () => {
		render({ plan: "pro", account: account("pro", true) });

		expect(host.querySelector(".plan-trial")).toBeNull();
		expect(cards()[2]?.textContent).toContain("onboarding.plan.badgeTrial");
	});

	it("marks only the chosen card, and picking a card chooses its plan", () => {
		const choosePlan = vi.fn();
		render({ plan: "max", choosePlan });

		expect(cards().map((card) => card.classList.contains("selected"))).toEqual([false, false, false, true, false]);
		act(() => cards()[1]?.click());
		expect(choosePlan).toHaveBeenCalledWith("air");
	});

	const promoToggle = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>("button.promo-toggle");
	const promoInput = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>('input[name="promo-code"]');

	it("keeps the promo code out of the way until asked, for every paid plan not held yet", () => {
		for (const plan of ["air", "pro", "max"] as const) {
			render({ plan });
			expect(promoToggle(), plan).not.toBeNull();
			expect(promoInput(), plan).toBeNull();
		}
	});

	it("opens the promo field on request", () => {
		render({ plan: "pro" });

		act(() => promoToggle()?.click());

		expect(promoInput()).not.toBeNull();
		expect(promoToggle()).toBeNull();
	});

	it("shows a code that is already typed, so it is never hidden from the person who typed it", () => {
		render({ plan: "max", promoCode: "WELCOME-7" });

		expect(promoInput()?.value).toBe("WELCOME-7");
	});

	it("offers no promo code where nothing is bought", () => {
		for (const plan of ["free", "byok"] as const) {
			render({ plan });
			expect(promoToggle(), plan).toBeNull();
			expect(promoInput(), plan).toBeNull();
		}
		render({ plan: "pro", account: account("pro") });
		expect(promoToggle()).toBeNull();
		render({ plan: "air", account: account("max") });
		expect(promoToggle()).toBeNull();
	});

	it("hands what is typed to the controller", () => {
		const setPromoCode = vi.fn();
		render({ plan: "pro", promoCode: "W", setPromoCode });
		const input = promoInput();

		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "WELCOME-7");
			input?.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(setPromoCode).toHaveBeenCalledWith("WELCOME-7");
	});

	it("flags a malformed code before anything is sent", () => {
		render({ plan: "pro", promoCode: "two words" });
		expect(promoInput()?.getAttribute("aria-invalid")).toBe("true");
		expect(host.querySelector(".promo-error")).not.toBeNull();

		render({ plan: "pro", promoCode: "WELCOME-7" });
		expect(promoInput()?.getAttribute("aria-invalid")).toBe("false");
		expect(host.querySelector(".promo-error")).toBeNull();
	});

	it("asks a signed-out visitor to sign in for a paid plan, in the slot below the cards, and only then", () => {
		render({ plan: "pro", account: null });
		expect(host.querySelector(".promo .auth-note")).not.toBeNull();
		expect(promoToggle()).toBeNull();

		render({ plan: "free", account: null });
		expect(host.querySelector(".auth-note")).toBeNull();

		render({ plan: "pro", account: account("free") });
		expect(host.querySelector(".auth-note")).toBeNull();
		expect(promoToggle()).not.toBeNull();
	});

	it("sends a signed-out visitor to the account step", () => {
		const setStep = vi.fn();
		render({ plan: "max", account: null, setStep });

		act(() => host.querySelector<HTMLButtonElement>(".auth-note button")?.click());

		expect(setStep).toHaveBeenCalledWith("account");
	});

	it("keeps the slot below the cards whatever the plan, so the screen never jumps", () => {
		for (const plan of ["free", "air", "pro", "max", "byok"] as const) {
			render({ plan, account: null });
			expect(host.querySelector(".promo"), plan).not.toBeNull();
		}
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
