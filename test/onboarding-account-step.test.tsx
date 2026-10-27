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

	it("passes the typed email to the hosted email-code flow", () => {
		const signIn = vi.fn();
		act(() => root.render(<AccountStep ctx={onboardingCtx({ signIn })} />));
		const input = host.querySelector<HTMLInputElement>("input[type=email]");
		if (input === null) throw new Error("Missing email input");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		if (setter === undefined) throw new Error("Missing input value setter");

		act(() => {
			setter.call(input, "  person@example.com  ");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("onboarding.account.continueEmail").click());

		expect(signIn).toHaveBeenCalledExactlyOnceWith({ provider: "email", email: "person@example.com" });
	});
});
