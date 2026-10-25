import { describe, expect, it } from "vitest";
import { hasInWindowMenuBar, mainWindowChrome, windowControlsOverlay } from "../src/main/window-chrome";

describe("mainWindowChrome", () => {
	it("keeps the macOS traffic lights over the page and adds no overlay", () => {
		expect(mainWindowChrome("darwin", "light", "finder")).toEqual({ titleBarStyle: "hiddenInset" });
	});

	it("removes the native title strip on Windows and Linux and draws only the window buttons", () => {
		for (const platform of ["win32", "linux"] as const) {
			const chrome = mainWindowChrome(platform, "light", "finder");
			expect(chrome.titleBarStyle).toBe("hidden");
			expect(chrome.titleBarOverlay).toEqual({ color: "#00000000", symbolColor: "#1D1D1F", height: 52 });
		}
	});

	it("is as tall as the page's own top bar: the onboarding band, then the Finder toolbar", () => {
		expect(windowControlsOverlay("light", "onboarding").height).toBe(42);
		expect(windowControlsOverlay("light", "finder").height).toBe(52);
	});

	it("tints the button symbols so they stay visible on a dark page", () => {
		expect(windowControlsOverlay("dark", "finder").symbolColor).toBe("#F5F5F7");
		expect(windowControlsOverlay("light", "finder").symbolColor).toBe("#1D1D1F");
	});
});

describe("hasInWindowMenuBar", () => {
	it("is true only where the OS puts a menu bar inside the window", () => {
		expect(hasInWindowMenuBar("win32")).toBe(true);
		expect(hasInWindowMenuBar("linux")).toBe(true);
		expect(hasInWindowMenuBar("darwin")).toBe(false);
	});
});
