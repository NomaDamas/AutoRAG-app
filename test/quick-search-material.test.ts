import { describe, expect, it, vi } from "vitest";
import { applyLauncherMaterial, launcherWindowOptions } from "../src/main/quick-search-material";
import { launcherBounds, QUICK_SEARCH_HEIGHT, QUICK_SEARCH_WIDTH } from "../src/main/quick-search-window";

const workArea = { x: 0, y: 0, width: 1440, height: 900 };

describe("launcher geometry", () => {
	it("is Tinycast's palette size, centred, a fifth of the way down", () => {
		expect([QUICK_SEARCH_WIDTH, QUICK_SEARCH_HEIGHT]).toEqual([750, 475]);
		expect(launcherBounds(workArea)).toEqual({ x: 345, y: 180, width: 750, height: 475 });
	});

	it("never outgrows a small work area", () => {
		expect(launcherBounds({ x: 0, y: 0, width: 600, height: 400 })).toEqual({ x: 0, y: 0, width: 600, height: 400 });
	});
});

describe("launcherWindowOptions", () => {
	it("macOS: a transparent panel with no built-in vibrancy, because the material is attached natively", () => {
		const options = launcherWindowOptions("darwin", false);
		expect(options).toMatchObject({ type: "panel", transparent: true, backgroundColor: "#00000000" });
		expect(options).not.toHaveProperty("vibrancy");
		// The system's own corners (≈26pt on macOS 26) are what the window's shadow and hairline follow; squaring them traced a frame past the glass.
		expect(options).not.toHaveProperty("roundedCorners");
	});

	it("elsewhere: an opaque window in the system's colour", () => {
		expect(launcherWindowOptions("win32", true)).toEqual({ backgroundColor: "#1E1E20" });
		expect(launcherWindowOptions("linux", false)).toEqual({ backgroundColor: "#FFFFFF" });
	});
});

describe("applyLauncherMaterial", () => {
	const radius = 26;
	const handle = Buffer.from([1, 2, 3]);

	it("uses native Liquid Glass when the addon attaches it", () => {
		const attach = vi.fn(() => "glass" as const);
		const setVibrancy = vi.fn();
		expect(applyLauncherMaterial({ platform: "darwin", handle, setVibrancy }, { attach }, radius)).toBe("glass");
		expect(attach).toHaveBeenCalledWith(handle, radius);
		expect(setVibrancy).not.toHaveBeenCalled();
	});

	it("takes the addon's rounded vibrancy when the OS has no glass", () => {
		const setVibrancy = vi.fn();
		expect(applyLauncherMaterial({ platform: "darwin", handle, setVibrancy }, { attach: () => "vibrancy" }, radius)).toBe("vibrancy");
		expect(setVibrancy).not.toHaveBeenCalled();
	});

	it("falls back to the window's own vibrancy when the addon is missing or throws", () => {
		const setVibrancy = vi.fn();
		expect(applyLauncherMaterial({ platform: "darwin", handle, setVibrancy }, null, radius)).toBe("vibrancy");
		expect(setVibrancy).toHaveBeenCalledWith("under-window");
		const again = vi.fn();
		expect(
			applyLauncherMaterial(
				{ platform: "darwin", handle, setVibrancy: again },
				{
					attach: () => {
						throw new Error("boom");
					},
				},
				radius,
			),
		).toBe("vibrancy");
		expect(again).toHaveBeenCalledWith("under-window");
	});

	it("is solid off macOS and never touches the window", () => {
		const setVibrancy = vi.fn();
		const attach = vi.fn();
		expect(applyLauncherMaterial({ platform: "win32", handle, setVibrancy }, { attach }, radius)).toBe("solid");
		expect(attach).not.toHaveBeenCalled();
		expect(setVibrancy).not.toHaveBeenCalled();
	});
});
