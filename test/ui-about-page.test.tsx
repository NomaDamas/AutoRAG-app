// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAppLanguage } from "../src/shared/i18n";
import type { RestartDaemonResponse, ToolVersionsSnapshot } from "../src/shared/tool-versions-contract";
import { AboutPage } from "../src/renderer/src/components/settings/AboutPage";
import { OutdatedDaemonBanner } from "../src/renderer/src/components/OutdatedDaemonBanner";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

function makeSnapshot(overrides: Partial<ToolVersionsSnapshot> = {}): ToolVersionsSnapshot {
	return {
		appVersion: "0.9.0",
		librarianRef: "04cef434cb9bbd3cc3623f929946efca82299d05",
		manifestPresent: true,
		manifestDrift: [],
		daemon: {
			owner: "minsync serve",
			engine: "inl",
			pinnedVersion: "0.3.4",
			running: true,
			version: "0.3.1",
			instance: "Qwen-Qwen3-Embedding-0.6B-test",
			port: 54133,
			pid: 1234,
			owned: true,
			outdated: true,
			canRestart: true,
		},
		components: [
			{ id: "app", name: "Dazzi", pinned: "0.9.0", bundled: "0.9.0", pathVersion: null, pathLocation: null, pathMismatch: false, manifestMismatch: false },
			{ id: "librarian", name: "@autorag/librarian", pinned: "2.14.0", bundled: "2.14.0", pathVersion: null, pathLocation: null, pathMismatch: false, manifestMismatch: false },
			{ id: "minsync", name: "minsync", pinned: "0.7.6", bundled: "0.7.6", pathVersion: "0.7.3", pathLocation: "/usr/local/bin/minsync", pathMismatch: true, manifestMismatch: false },
			{ id: "inl", name: "inl", pinned: "0.3.4", bundled: "0.3.1", pathVersion: "0.3.4", pathLocation: "/usr/local/bin/inl", pathMismatch: false, manifestMismatch: false },
			{ id: "mailcrawl", name: "mailcrawl", pinned: "0.3.2", bundled: "0.3.2", pathVersion: null, pathLocation: null, pathMismatch: false, manifestMismatch: false },
			{ id: "lazykatok", name: "lazykatok", pinned: "0.3.4", bundled: "0.3.4", pathVersion: null, pathLocation: null, pathMismatch: false, manifestMismatch: false },
		],
		...overrides,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	host.remove();
	Reflect.deleteProperty(window, "autorag");
});

describe("AboutPage", () => {
	it("displays all resolved component versions, flags PATH mismatch, and restarts an owned outdated daemon", async () => {
		const before = makeSnapshot();
		const after = makeSnapshot({
			daemon: { ...before.daemon, version: "0.3.4", outdated: false, canRestart: false, pid: 5678 },
		});
		const restartDaemon = vi.fn(async (): Promise<RestartDaemonResponse> => ({ ok: true, snapshot: after }));
		Reflect.set(window, "autorag", {
			toolVersions: { get: vi.fn(async () => before), restartDaemon },
		});

		await act(async () => {
			root.render(<AboutPage />);
		});

		expect(host.textContent).toContain("Dazzi");
		expect(host.textContent).toContain("@autorag/librarian");
		expect(host.textContent).toContain("minsync");
		expect(host.textContent).toContain("inl");
		expect(host.textContent).toContain("mailcrawl");
		expect(host.textContent).toContain("lazykatok");
		expect(host.textContent).toContain("PATH copy is 0.7.3");

		const minsyncBadge = host.querySelector('[data-tool-version="minsync"]');
		expect(minsyncBadge?.getAttribute("data-path-mismatch")).toBe("true");

		const restartButton = host.querySelector<HTMLButtonElement>('[data-testid="about-restart-daemon"]');
		expect(restartButton).not.toBeNull();

		await act(async () => {
			restartButton?.click();
		});

		expect(restartDaemon).toHaveBeenCalledOnce();
		expect(host.querySelector('[data-testid="about-restart-daemon"]')).toBeNull();
		expect(host.textContent).toContain("0.3.4");
	});

	it("does not show a restart button when the outdated daemon was started outside Dazzi", async () => {
		const before = makeSnapshot({
			daemon: { ...makeSnapshot().daemon, owned: false, canRestart: false },
		});
		Reflect.set(window, "autorag", {
			toolVersions: { get: vi.fn(async () => before), restartDaemon: vi.fn() },
		});

		await act(async () => {
			root.render(<AboutPage />);
		});

		expect(host.querySelector('[data-testid="about-restart-daemon"]')).toBeNull();
		expect(host.textContent).toContain("started outside Dazzi");
	});
});

describe("OutdatedDaemonBanner", () => {
	it("renders a restart offer when an owned daemon is outdated and clears after restart", async () => {
		const before = makeSnapshot();
		const after = makeSnapshot({
			daemon: { ...before.daemon, version: "0.3.4", outdated: false, canRestart: false },
		});
		const restartDaemon = vi.fn(async (): Promise<RestartDaemonResponse> => ({ ok: true, snapshot: after }));
		Reflect.set(window, "autorag", {
			toolVersions: { get: vi.fn(async () => before), restartDaemon },
		});

		await act(async () => {
			root.render(<OutdatedDaemonBanner onOpenAbout={vi.fn()} />);
		});

		expect(host.textContent).toContain("Embedding daemon update available");
		const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Restart daemon");
		expect(button).toBeDefined();

		await act(async () => {
			button?.click();
		});

		expect(restartDaemon).toHaveBeenCalledOnce();
		expect(host.textContent).toBe("");
	});

	it("renders nothing when the daemon matches the pinned version", async () => {
		const upToDate = makeSnapshot({
			daemon: { ...makeSnapshot().daemon, version: "0.3.4", outdated: false, canRestart: false },
		});
		Reflect.set(window, "autorag", {
			toolVersions: { get: vi.fn(async () => upToDate), restartDaemon: vi.fn() },
		});

		await act(async () => {
			root.render(<OutdatedDaemonBanner onOpenAbout={vi.fn()} />);
		});

		expect(host.textContent).toBe("");
	});
});
