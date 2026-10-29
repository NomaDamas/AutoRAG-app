import { describe, expect, it } from "vitest";
import { NO_CAPABILITIES } from "../src/shared/actions-contract";
import { buildRemoteBootstrapScript } from "../src/main/remote/bootstrap";

/** A minimal browser the generated script can run against, so its shape is checked, not just its text. */
function runBootstrap(script: string): Record<string, unknown> {
	const documentElement = { dataset: {} as Record<string, string> };
	const window: Record<string, unknown> = {};
	const document = {
		documentElement,
		createElement: () => ({ click: () => {}, remove: () => {}, style: {} }),
		body: { append: () => {} },
	};
	const location = { href: "http://127.0.0.1:9999/?token=T" };
	const fetch = async () => new Response(JSON.stringify({ ok: true, value: null }), { status: 200 });
	class EventSource {
		onmessage: ((message: { data: string }) => void) | null = null;
		onerror: (() => void) | null = null;
	}
	const navigator = { clipboard: { writeText: async () => {} } };
	const run = new Function("window", "document", "location", "fetch", "EventSource", "navigator", "crypto", script);
	run(window, document, location, fetch, EventSource, navigator, { randomUUID: () => "session-1" });
	return window;
}

describe("remote bootstrap", () => {
	it("is valid JavaScript that defines window.autorag for a browser session", () => {
		// Given the generated script.
		const script = buildRemoteBootstrapScript({ token: "T", platform: "darwin", appearance: "light", language: "ko", version: "0.1.0" });

		// When it runs against a minimal browser.
		const window = runBootstrap(script);

		// Then the bridge surface the Finder reads exists.
		expect(window.autorag).toBeDefined();
		const autorag = window.autorag as Record<string, unknown>;
		expect(autorag.platform).toBe("darwin");
		expect(typeof autorag.pathForFile).toBe("function");
		for (const target of ["fs", "live", "settings", "search", "preview", "interaction", "onboarding", "errorFix"]) {
			expect(autorag[target], `${target} bridge`).toBeDefined();
		}
	});

	it("exposes the value-shaped members and browser-only behaviors the page reads", () => {
		// Given the generated script.
		const script = buildRemoteBootstrapScript({ token: "T", platform: "darwin", appearance: "dark", language: "en", version: "0.1.0" });

		// When it runs.
		const window = runBootstrap(script);
		const autorag = window.autorag as Record<string, Record<string, unknown>>;

		// Then onboarding reports no pending flow, the fs bridge can upload, and
		// the native-only gestures are functions a browser can actually perform.
		expect(autorag.onboarding?.pending).toBe(false);
		expect(typeof (autorag.remote as Record<string, unknown>)?.status).toBe("function");
		// A subscription must hand back an unsubscribe function, never a promise:
		// the Finder's effect cleanup calls it synchronously.
		const unsubscribe = (autorag.fs?.onLocationsChanged as (listener: () => void) => unknown)(() => {});
		expect(typeof unsubscribe).toBe("function");
		expect(typeof (autorag.fs?.onIndexRefreshed as (listener: () => void) => unknown)(() => {})).toBe("function");
		expect(typeof (autorag.live?.onMessage as (listener: () => void) => unknown)(() => {})).toBe("function");
		expect(window.autoragIsRemote).toBe(true);
		expect(typeof autorag.fs?.uploadFiles).toBe("function");
		expect(typeof autorag.fs?.startDrag).toBe("function");
		expect(typeof autorag.fs?.open).toBe("function");
		expect(typeof autorag.fs?.clipboardGet).toBe("function");
		expect(typeof autorag.fs?.quickLook).toBe("function");
	});

	it("publishes the preview URL mapping the shared helpers consult", () => {
		// Given the generated script.
		const script = buildRemoteBootstrapScript({ token: "T", platform: "darwin", appearance: "light", language: "ko", version: "0.1.0" });

		// When it runs.
		const window = runBootstrap(script);

		// Then a preview URL for a path resolves to the token-carrying HTTP route.
		const remote = window.__autoragRemote as { routes: { preview: string }; url: (route: string, params?: Record<string, unknown>) => string };
		const resolved = remote.url(remote.routes.preview, { path: "/tmp/a.png" });
		expect(resolved).toContain("/remote/preview");
		expect(resolved).toContain("path=%2Ftmp%2Fa.png");
		expect(resolved).toContain("token=T");
	});

	it("closes the preview state after opening a preview tab so selection clicks never spawn new tabs", async () => {
		// Given a bootstrap session with a window.open spy and an onClosed listener.
		const script = buildRemoteBootstrapScript({ token: "T", platform: "darwin", appearance: "light", language: "ko", version: "0.1.0" });
		const window = runBootstrap(script);
		const opened: string[] = [];
		window.open = (target: string) => {
			opened.push(target);
			return null;
		};
		const autorag = window.autorag as {
			fs: { quickLook: (path: string) => Promise<void> };
			preview: { show: (target: { path: string; name: string }) => Promise<void>; onClosed: (listener: () => void) => () => void };
			actions: { capabilities: () => Promise<{ archive: boolean; openWith: boolean; share: boolean }> };
		};
		let closedCount = 0;
		autorag.preview.onClosed(() => {
			closedCount += 1;
		});

		// When Quick Look runs (`presentQuickLook` calls both preview.show and fs.quickLook).
		await autorag.preview.show({ path: "/tmp/a.png", name: "a.png" });
		await autorag.fs.quickLook("/tmp/a.png");
		await Promise.resolve();

		// Then only one preview tab opened, and onClosed fired so single/right clicks stay focus-only.
		expect(opened).toHaveLength(1);
		expect(opened[0]).toContain("/remote/preview");
		expect(closedCount).toBe(1);
		expect(await autorag.actions.capabilities()).toEqual(NO_CAPABILITIES);
	});
});
