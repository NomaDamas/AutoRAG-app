// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelDownloadPanel } from "../src/renderer/src/components/ModelDownloadPanel";
import { downloadPercent, localModelNeeded } from "../src/renderer/src/state/model-download";
import type { ModelDownloadStatus } from "../src/shared/model-download-contract";
import { stubTranslate } from "./support/onboarding-ctx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const TOTAL = 1_200_000_000;
const status = (patch: Partial<ModelDownloadStatus>): ModelDownloadStatus => ({ state: "absent", bytesDone: 0, bytesTotal: TOTAL, file: null, error: null, ...patch });

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

function render(value: ModelDownloadStatus, handlers: { start?: () => void; cancel?: () => void } = {}): void {
	act(() => root.render(<ModelDownloadPanel status={value} t={stubTranslate} onStart={handlers.start ?? vi.fn()} onCancel={handlers.cancel ?? vi.fn()} />));
}

const button = (label: string): HTMLButtonElement | undefined =>
	[...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(label));

describe("downloadPercent", () => {
	it("is whole percent of the total, never 100 before it is ready and never above", () => {
		expect(downloadPercent(status({ bytesDone: 0 }))).toBe(0);
		expect(downloadPercent(status({ bytesDone: TOTAL / 2 }))).toBe(50);
		expect(downloadPercent(status({ state: "downloading", bytesDone: TOTAL - 1 }))).toBe(99);
		expect(downloadPercent(status({ state: "ready", bytesDone: TOTAL }))).toBe(100);
		expect(downloadPercent(status({ bytesDone: TOTAL * 2 }))).toBe(99);
		expect(downloadPercent(status({ bytesTotal: 0 }))).toBe(0);
	});
});

describe("localModelNeeded", () => {
	it("is true only for the on-device profile while its model is not ready", () => {
		expect(localModelNeeded("local", status({}))).toBe(true);
		expect(localModelNeeded("local", status({ state: "downloading", bytesDone: 5 }))).toBe(true);
		expect(localModelNeeded("local", status({ state: "failed", error: "x" }))).toBe(true);
		expect(localModelNeeded("local", status({ state: "ready", bytesDone: TOTAL }))).toBe(false);
		for (const profile of ["none", "dazzi", "byok", ""]) expect(localModelNeeded(profile, status({}))).toBe(false);
	});
});

describe("ModelDownloadPanel", () => {
	it("offers the download with the size when nothing is on disk, and starts it on click", () => {
		const start = vi.fn();
		render(status({}), { start });

		expect(host.textContent).toContain("modelDownload.needed");
		expect(host.textContent).toContain("size=1.2 GB");
		expect(host.querySelector('[role="progressbar"]')).toBeNull();
		act(() => button("modelDownload.download")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("offers to resume when a partial download is on disk", () => {
		render(status({ bytesDone: 300_000_000 }));

		expect(host.textContent).toContain("modelDownload.partial");
		expect(button("modelDownload.resume")).toBeDefined();
		expect(button("modelDownload.download")).toBeUndefined();
	});

	it("shows live progress with the file name and cancels on click", () => {
		const cancel = vi.fn();
		render(status({ state: "downloading", bytesDone: 600_000_000, file: "model.safetensors" }), { cancel });

		const bar = host.querySelector('[role="progressbar"]');
		expect(bar?.getAttribute("aria-valuenow")).toBe("50");
		expect(host.textContent).toContain("done=600 MB");
		expect(host.textContent).toContain("total=1.2 GB");
		expect(host.textContent).toContain("file=model.safetensors");
		expect(button("modelDownload.download")).toBeUndefined();
		act(() => button("modelDownload.cancel")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("shows an empty bar, not a missing one, before the first byte arrives", () => {
		render(status({ state: "downloading", bytesDone: 0 }));

		expect(host.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
	});

	it("shows the reason a download stopped and retries from where it stopped", () => {
		const start = vi.fn();
		render(status({ state: "failed", bytesDone: 400_000_000, error: "no network" }), { start });

		expect(host.querySelector('[role="alert"]')?.textContent).toContain("no network");
		act(() => button("modelDownload.retry")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("says it is ready and offers no action once the model is here", () => {
		render(status({ state: "ready", bytesDone: TOTAL }));

		expect(host.textContent).toContain("modelDownload.ready");
		expect(host.querySelectorAll("button")).toHaveLength(0);
	});
});
