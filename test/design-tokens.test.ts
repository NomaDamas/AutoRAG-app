import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `tokens.css` is the single source of design values and `tailwind.css` bridges
 * it into Tailwind theme namespaces. These tests fail when the two drift: a
 * token with no bridge entry silently produces no utility, and a bridge entry
 * pointing at a token that no longer exists produces a utility that resolves to
 * nothing.
 */

const read = (file: string): string => readFileSync(new URL(`../src/renderer/styles/${file}`, import.meta.url), "utf8");

const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "");

/** Names of the custom properties declared inside `:root`. */
function tokenNames(): string[] {
	const source = stripComments(read("tokens.css"));
	const root = /:root\s*\{([\s\S]*?)\n\}/.exec(source);
	if (root === null) throw new Error("tokens.css has no :root block");
	return [...(root[1] ?? "").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1] as string);
}

/** `@theme inline` entries as bridge name → forwarded token name. */
function bridgeEntries(): Map<string, string> {
	const source = stripComments(read("tailwind.css"));
	const entries = new Map<string, string>();
	for (const match of source.matchAll(/(--[a-z0-9-]+)\s*:\s*var\((--[a-z0-9-]+)\)\s*;/g)) {
		entries.set(match[1] as string, match[2] as string);
	}
	if (entries.size === 0) throw new Error("tailwind.css has no `var(--token)` bridge entries");
	return entries;
}

/**
 * Tokens that deliberately have no bridge entry.
 *
 * `theme-key` — the token name already is a Tailwind theme key, so a bridge
 * entry would be `var(--x): var(--x)`, a CSS cycle. tokens.css is unlayered and
 * Tailwind's defaults are not, so the token value wins at runtime.
 *
 * `arbitrary` — Tailwind has no namespace for the property, so components use
 * `(--token)` arbitrary syntax instead of a named utility.
 */
const THEME_KEY_TOKENS = ["--font-sans", "--font-mono", "--radius-full", "--ease-out"];
const ARBITRARY_ONLY_TOKENS = [
	"--backdrop-quicklook",
	"--highlight-marker",
	"--shimmer-gradient",
	"--index-dot-excluded-ring",
	"--grid-main",
	"--grid-file-row",
	"--grid-source-row",
	"--grid-sheet",
	"--h-settings",
	"--scrollbar-size",
	"--scrollbar-radius",
	"--scrollbar-inset",
];
const ARBITRARY_ONLY_PATTERNS = [/^--dur-/, /^--time-/];

describe("design token bridge", () => {
	it("declares the layer order that lets utilities beat legacy rules", () => {
		const statement = /@layer\s+([a-z0-9,\s]+);/.exec(stripComments(read("tailwind.css")));
		expect(statement).not.toBeNull();
		const layers = (statement?.[1] ?? "").split(",").map((layer) => layer.trim());
		expect(layers).toContain("legacy");
		expect(layers).toContain("utilities");
		expect(layers.indexOf("legacy")).toBeLessThan(layers.indexOf("utilities"));
	});

	it("forwards every bridge entry to a token that exists", () => {
		const tokens = new Set(tokenNames());
		const dangling = [...bridgeEntries()].filter(([, token]) => !tokens.has(token));
		expect(dangling).toEqual([]);
	});

	it("inlines the bridge instead of emitting it", () => {
		// Tokens whose name is already the Tailwind key (`--radius-2`,
		// `--shadow-raised`) can only be bridged as `var(--radius-2)` — a
		// self-reference. That is safe *only* under `inline`, where Tailwind
		// substitutes the value into each utility and emits no custom property.
		// A bare `@theme` would emit `--radius-2: var(--radius-2)` and break every
		// radius at computed-value time.
		const source = stripComments(read("tailwind.css"));
		expect(source).toContain("@theme inline {");
		expect(/@theme\s*\{/.test(source)).toBe(false);
	});

	it("covers every token in tokens.css", () => {
		const bridged = new Set(bridgeEntries().values());
		const uncovered = tokenNames().filter((token) => {
			if (bridged.has(token)) return false;
			if (THEME_KEY_TOKENS.includes(token)) return false;
			return !ARBITRARY_ONLY_PATTERNS.some((pattern) => pattern.test(token));
		});
		// A token here needs either a bridge entry or an entry in one of the two
		// allowlists above; anything else means its value is unreachable from a
		// component.
		expect(uncovered.filter((token) => !ARBITRARY_ONLY_TOKENS.includes(token))).toEqual([]);
	});

	it("keeps every token name reachable from a component", () => {
		// Guards the allowlists themselves: a token listed as arbitrary-only must
		// still be a real token, or the allowlist has rotted.
		const tokens = new Set(tokenNames());
		const stale = [...THEME_KEY_TOKENS, ...ARBITRARY_ONLY_TOKENS].filter((token) => !tokens.has(token));
		expect(stale).toEqual([]);
	});
});
