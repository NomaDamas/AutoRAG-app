// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppsPage } from "../src/renderer/src/components/settings/AppsPages";
import type { AutoRagConfigSnapshot } from "../src/shared/settings-contract";

// AppsPages reads `window.autorag.settings` while it is being imported; hoisted code runs before the imports.
vi.hoisted(() => {
	Reflect.set(globalThis, "autorag", { platform: "darwin", settings: {} });
});

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
	Reflect.deleteProperty(globalThis, "autorag");
	vi.restoreAllMocks();
});

const snapshot: AutoRagConfigSnapshot = { configPath: "/x/config.json", configExists: true, error: null, config: {} };

function render(platform: string): void {
	Reflect.set(globalThis, "autorag", { platform, settings: {} });
	act(() => root.render(<AppsPage snapshot={snapshot} onSaved={vi.fn()} sources={null} sourcesPending={false} onOpenSource={vi.fn()} />));
}

const galleryRow = (title: string): HTMLElement | undefined =>
	[...host.querySelectorAll<HTMLElement>(".settings-list-row")].find((row) => row.querySelector(".settings-list-title")?.textContent === title);

describe("the Apple Calendar gallery row", () => {
	it.each(["win32", "linux"])("%s: Connect is disabled and the row says it needs macOS", (platform) => {
		render(platform);
		const row = galleryRow("Apple Calendar & Reminders");
		expect(row).toBeDefined();
		const connect = row?.querySelector("button");
		expect(connect?.disabled).toBe(true);
		expect(row?.querySelector(".settings-list-meta")?.textContent).toContain("macOS");
	});

	it("macOS: Connect works", () => {
		render("darwin");
		expect(galleryRow("Apple Calendar & Reminders")?.querySelector("button")?.disabled).toBe(false);
	});

	it("every other row stays connectable on Windows", () => {
		render("win32");
		expect(galleryRow("Hister")?.querySelector("button")?.disabled).toBe(false);
		expect(galleryRow("Slack")?.querySelector("button")?.disabled).toBe(false);
	});
});
