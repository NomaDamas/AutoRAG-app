// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { platformKey } from "../src/renderer/src/lib/platform-copy";
import { FoldersStep } from "../src/renderer/src/onboarding/steps/Folders";
import { resources, SUPPORTED_LANGUAGES, type LocaleKey } from "../src/shared/i18n";
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

/** The text on screen. */
const shown = (): string => host.innerHTML.replaceAll(/<[^>]*>/gu, " ");

/** The dictionary value at a dotted key. */
function lookup(language: (typeof SUPPORTED_LANGUAGES)[number], key: string): string {
	let node: unknown = resources[language].translation;
	for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
	return typeof node === "string" ? node : "";
}

describe("copy that names the machine", () => {
	it("picks the PC wording on Windows and keeps the Mac wording everywhere else", () => {
		expect(platformKey("settingsCore.embedding.apiKeyHint", "win32")).toBe("settingsCore.embedding.apiKeyHintPc");
		expect(platformKey("settingsCore.ai.server.bodyLocal", "win32")).toBe("settingsCore.ai.server.bodyLocalPc");
		expect(platformKey("settingsCore.embedding.apiKeyHint", "darwin")).toBe("settingsCore.embedding.apiKeyHint");
		expect(platformKey("settingsCore.ai.server.bodyLocal", "linux")).toBe("settingsCore.ai.server.bodyLocal");
	});

	const PC_KEYS: readonly LocaleKey[] = [
		"settingsCore.embedding.apiKeyHintPc",
		"settingsCore.ai.server.bodyLocalPc",
		"onboarding.account.leadPc",
	];

	it("has a PC sentence in every language that never calls the machine a Mac", () => {
		for (const language of SUPPORTED_LANGUAGES) {
			for (const key of PC_KEYS) {
				const text = lookup(language, key);
				expect(text, `${language} ${key}`).not.toBe("");
				expect(text, `${language} ${key}`).not.toMatch(/\bMac\b|macOS|맥/u);
			}
		}
	});

	it("keeps the Mac sentences naming the Mac", () => {
		for (const key of ["settingsCore.embedding.apiKeyHint", "settingsCore.ai.server.bodyLocal", "onboarding.account.lead"]) {
			expect(lookup("en", key), key).toMatch(/Mac/u);
		}
	});

	it("the folders step asks for a folder first, then totals the selection and shows one processing time", () => {
		const candidates = [{ path: "/docs", name: "Documents", displayPath: "~/Documents", kind: "documents" as const, defaultSelected: true, ocrOff: false }];
		const scans = new Map([["/docs", { path: "/docs", files: 1000, bytes: 1, onlineOnly: 0, done: true, error: null }]]);
		const none = { ...BASE_DRAFT, folders: [{ path: "/docs", selected: false }] };
		act(() => root.render(<FoldersStep ctx={onboardingCtx({ platform: "win32", candidates, scans, draft: none })} />));
		expect(shown()).toContain("onboarding.folders.summaryEmpty");
		act(() => root.render(<FoldersStep ctx={onboardingCtx({ platform: "win32", candidates, scans, draft: BASE_DRAFT })} />));
		expect(shown()).not.toContain("onboarding.folders.summaryEmpty");
		expect(shown()).toContain("onboarding.folders.summary ");
		expect(shown()).toContain("onboarding.folders.etaLabel");
	});
});
