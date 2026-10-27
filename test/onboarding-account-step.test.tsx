// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountStep } from "../src/renderer/src/onboarding/steps/Account";
import { onboardingCtx } from "./support/onboarding-ctx";

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

function button(label: string): HTMLButtonElement {
	const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
	if (found === undefined) throw new Error(`Missing button: ${label}`);
	return found;
}

describe("onboarding account providers", () => {
	it("starts the selected social provider instead of a generic sign-in", () => {
		const signIn = vi.fn();
		act(() => root.render(<AccountStep ctx={onboardingCtx({ signIn })} />));

		act(() => button("onboarding.account.continueGoogle").click());
		act(() => button("onboarding.account.continueGithub").click());

		expect(signIn).toHaveBeenNthCalledWith(1, { provider: "google" });
		expect(signIn).toHaveBeenNthCalledWith(2, { provider: "github" });
		expect(host.textContent).not.toContain("onboarding.account.continueApple");
	});

	it("runs email OTP verification directly inside the onboarding card without opening the browser", async () => {
		const signIn = vi.fn();
		const sendEmailOtp = vi.fn().mockResolvedValue({ ok: true, email: "person@example.com", expiresInSeconds: 600 });
		const verifyEmailOtp = vi.fn().mockResolvedValue(null);
		act(() => root.render(<AccountStep ctx={onboardingCtx({ signIn, sendEmailOtp, verifyEmailOtp })} />));
		const emailInput = host.querySelector<HTMLInputElement>("input[type=email]");
		if (emailInput === null) throw new Error("Missing email input");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		if (setter === undefined) throw new Error("Missing input value setter");

		act(() => {
			setter.call(emailInput, "  person@example.com  ");
			emailInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			button("onboarding.account.continueEmail").click();
		});

		expect(signIn).not.toHaveBeenCalled();
		expect(sendEmailOtp).toHaveBeenCalledExactlyOnceWith("person@example.com");

		const otpInput = host.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
		if (otpInput === null) throw new Error("Missing in-app 6-digit OTP input");
		act(() => {
			setter.call(otpInput, "054810");
			otpInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			button("onboarding.account.verifyCode").click();
		});

		expect(verifyEmailOtp).toHaveBeenCalledExactlyOnceWith("person@example.com", "054810");

		act(() => button("onboarding.account.useDifferentEmail").click());
		expect(host.querySelector('input[type="email"]')).not.toBeNull();
	});
});
