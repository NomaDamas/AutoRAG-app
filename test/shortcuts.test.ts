import { describe, expect, it } from "vitest";
import { formatShortcut, hostPlatform } from "../src/renderer/src/lib/shortcuts";

describe("hostPlatform", () => {
	it("defaults to macOS when the bridge is absent (tests, fixtures)", () => {
		expect(hostPlatform()).toBe("darwin");
	});
});

describe("formatShortcut", () => {
	it("renders Apple glyphs on macOS", () => {
		expect(formatShortcut({ key: "F" }, "darwin")).toBe("⌘F");
		expect(formatShortcut({ key: "," }, "darwin")).toBe("⌘,");
		expect(formatShortcut({ key: "H", shift: true }, "darwin")).toBe("⌘⇧H");
		expect(formatShortcut({ key: "Enter", alt: true, primary: false }, "darwin")).toBe("⌥Enter");
	});

	it("renders Ctrl chords off macOS, following the meta || ctrl binding", () => {
		expect(formatShortcut({ key: "F" }, "win32")).toBe("Ctrl+F");
		expect(formatShortcut({ key: "," }, "win32")).toBe("Ctrl+,");
		expect(formatShortcut({ key: "H", shift: true }, "win32")).toBe("Ctrl+Shift+H");
		expect(formatShortcut({ key: "K" }, "linux")).toBe("Ctrl+K");
	});

	it("renders Alt-only chords without the primary modifier", () => {
		expect(formatShortcut({ key: "Enter", alt: true, primary: false }, "win32")).toBe("Alt+Enter");
	});

	it("never contains the Command glyph on Windows", () => {
		for (const key of ["F", "K", "T", "W", "N", "1", ","]) {
			expect(formatShortcut({ key }, "win32")).not.toContain("⌘");
		}
	});
});
