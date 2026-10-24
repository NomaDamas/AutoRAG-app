import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = resolve(import.meta.dirname, "../src/renderer/styles");

function read(file: string): string {
	return readFileSync(resolve(STYLES, file), "utf8");
}

/** First family of a font stack, unquoted. */
function firstFamily(stack: string): string {
	const first = stack.split(",")[0]?.trim() ?? "";
	return first.replace(/^["']|["']$/g, "");
}

/**
 * The app draws the same typeface on every OS only if the first family of
 * `--font-sans` is one the app itself ships. A family that is merely named in
 * the stack resolves to whatever the machine has installed (SF on macOS,
 * Segoe UI on Windows), which is the drift this contract prevents.
 */
describe("bundled UI font", () => {
	const tokens = read("tokens.css");
	const sans = /--font-sans:\s*([^;]+);/.exec(tokens)?.[1];

	it("puts a family the app ships first in --font-sans", () => {
		expect(sans).toBeDefined();
		const family = firstFamily(sans ?? "");
		const faces = [...read("fonts.css").matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
		const declared = faces.some((face) => new RegExp(`font-family:\\s*["']?${family}["']?\\s*;`).test(face));
		expect(declared, `--font-sans starts with "${family}" but fonts.css declares no @font-face for it`).toBe(true);
	});

	it("points every @font-face at a real woff2 file that covers the weights the UI uses", () => {
		const css = read("fonts.css");
		const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "");
		expect(faces.length).toBeGreaterThan(0);
		for (const face of faces) {
			const url = /url\(["']?([^"')]+)["']?\)/.exec(face)?.[1];
			expect(url).toBeDefined();
			const file = resolve(STYLES, url ?? "");
			expect(existsSync(file), `${url} is missing`).toBe(true);
			expect(readFileSync(file).subarray(0, 4).toString("latin1")).toBe("wOF2");
			const range = /font-weight:\s*(\d+)\s+(\d+)/.exec(face);
			expect(range, "a variable face declares a weight range").not.toBeNull();
			expect(Number(range?.[1])).toBeLessThanOrEqual(400);
			expect(Number(range?.[2])).toBeGreaterThanOrEqual(700);
		}
	});

	it("keeps a system fallback after the bundled family for glyphs it lacks", () => {
		const families = (sans ?? "").split(",").map((entry) => entry.trim());
		expect(families.length).toBeGreaterThan(1);
		expect(families[families.length - 1]).toBe("sans-serif");
	});

	// Pretendard rewrites `1x2` to `1×2` through contextual substitution, so a
	// file named `shot_1920x1080.png` would be drawn as a different name. The
	// document surface must switch substitution off for every descendant.
	it("draws file names literally by disabling contextual and ligature substitution on the body", () => {
		const base = read("base.css");
		const body = [...base.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "").join("\n");
		expect(body).toMatch(/font-variant-ligatures:\s*none\s*;/);
	});
});
