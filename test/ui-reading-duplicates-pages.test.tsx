// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuplicatesPage, ReadingPage } from "../src/renderer/src/components/settings/ConfigPages";
import { setAppLanguage } from "../src/shared/i18n";
import type { AutoRagConfigSnapshot, JsonObject } from "../src/shared/settings-contract";

// `settings-runtime` captures `window.autorag.settings` on import; hoisted code runs before the imports.
const bridge = vi.hoisted(() => {
	const settings = { configPatch: vi.fn() };
	Reflect.set(globalThis, "autorag", { settings });
	return { settings };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let host: HTMLDivElement;
let root: Root;

const snapshotOf = (config: Record<string, unknown>): AutoRagConfigSnapshot => ({ configPath: "/x/config.json", configExists: true, error: null, config: config as JsonObject });
const chips = (): string[] => [...host.querySelectorAll(".language-combobox__chip")].map((chip) => chip.textContent ?? "");
const button = (name: string): HTMLButtonElement | null => [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === name) ?? null;

beforeEach(async () => {
	await setAppLanguage("en");
	bridge.settings.configPatch.mockReset();
	bridge.settings.configPatch.mockImplementation(async () => snapshotOf({}));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

describe("Settings → 문서 읽기 (Figma 403:8347 / 403:8920)", () => {
	it("starts from Korean and English, with no 기본값으로 변경 while nothing is stored", async () => {
		await act(async () => root.render(<ReadingPage snapshot={snapshotOf({})} onSaved={() => undefined} />));
		expect(chips()).toEqual(["한국어", "English"]);
		expect(host.querySelector(".language-combobox__field input")?.getAttribute("placeholder")).toBe("Select a language…");
		expect(button("Reset to default")).toBeNull();
	});

	it("offers 기본값으로 변경 once the list is stored, and it removes the stored list", async () => {
		await act(async () => root.render(<ReadingPage snapshot={snapshotOf({ languages: ["ko", "en", "ja"] })} onSaved={() => undefined} />));
		expect(chips()).toEqual(["한국어", "English", "日本語"]);
		await act(async () => button("Reset to default")?.click());
		expect(bridge.settings.configPatch).toHaveBeenCalledWith([{ path: ["languages"], remove: true }]);
	});
});

describe("Settings → 중복 파일 정리 (Figma 403:8746)", () => {
	it("draws three plain rows and names each check interval as a cadence", async () => {
		await act(async () => root.render(<DuplicatesPage snapshot={snapshotOf({})} onSaved={() => undefined} dupeyInterval={60} onDupeyInterval={() => undefined} />));
		expect([...host.querySelectorAll(".settings-plain-name")].map((name) => name.textContent)).toEqual(["Show identical files once", "Group similar versions", "Duplicate check interval"]);
		const select = host.querySelector<HTMLSelectElement>(".settings-plain-select");
		expect(select?.selectedOptions[0]?.textContent).toBe("Every hour");
	});
});
