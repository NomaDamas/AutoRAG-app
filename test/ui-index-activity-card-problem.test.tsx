// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexActivityCard } from "../src/renderer/src/components/settings/IndexActivityCard";
import { setAppLanguage } from "../src/shared/i18n";
import { IDLE_INDEX_ACTIVITY, type IndexActivitySnapshot } from "../src/shared/index-activity-contract";
import type { IndexProblem } from "../src/shared/index-problem-contract";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const retry = vi.fn(async (): Promise<void> => undefined);
let problem: IndexProblem = { failure: null, skipped: 0, at: null, retrying: false };

Reflect.set(globalThis, "autorag", {
	indexProblem: { get: async (): Promise<IndexProblem> => problem, onChange: (): (() => void) => () => undefined, retry, dismiss: async () => undefined },
});

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	retry.mockClear();
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

const RAW = "http://127.0.0.1:49158 fetch failed";
const activity = (state: IndexActivitySnapshot["state"]): IndexActivitySnapshot => ({
	state,
	origin: "app",
	startedAt: "2026-10-24T05:00:00.000Z",
	finishedAt: state === "running" ? null : "2026-10-24T05:00:05.000Z",
	items: [{ key: "local", kind: "local", id: null, state: state === "failed" ? "failed" : state === "done" ? "done" : "running", phase: state === "running" ? "parsed" : null, counts: null, error: state === "failed" ? RAW : null }],
	fraction: state === "running" ? 0.3 : 1,
	error: state === "failed" ? RAW : null,
});

async function render(snapshot: IndexActivitySnapshot, next: IndexProblem): Promise<void> {
	problem = next;
	act(() => root.render(<IndexActivityCard snapshot={snapshot} />));
	await act(async () => {
		await Promise.resolve();
	});
}

const offline: IndexProblem = { failure: { reason: "embedder-offline", folders: [], code: null }, skipped: 0, at: "2026-10-24T05:00:05.000Z", retrying: false };

describe("IndexActivityCard with a problem the last run left behind", () => {
	it("shows the problem instead of the failed run's own echo, so the raw error never reaches Settings", async () => {
		await render(activity("failed"), offline);
		expect(host.textContent).toContain("인덱싱 멈춤");
		expect(host.textContent).not.toContain("fetch failed");
		expect(host.textContent).toContain("지금 다시 시도");
	});

	it("shows the problem when nothing has run for a while", async () => {
		await render(IDLE_INDEX_ACTIVITY, offline);
		expect(host.textContent).toContain("인덱싱 멈춤");
	});

	it("keeps showing the run while one is in flight, whatever is recorded", async () => {
		await render(activity("running"), offline);
		expect(host.textContent).not.toContain("인덱싱 멈춤");
		expect(host.querySelector('[data-tone="run"]')).not.toBeNull();
	});

	it("retries from the card's button", async () => {
		await render(IDLE_INDEX_ACTIVITY, offline);
		const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "지금 다시 시도");
		act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(retry).toHaveBeenCalledTimes(1);
	});
});
