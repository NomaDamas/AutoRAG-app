/**
 * Platform-aware keyboard-shortcut labels.
 *
 * The bindings accept Command on macOS and Control elsewhere (`state/keymap.ts`
 * resolves `meta || ctrl`), so hints and `title` attributes must follow the same
 * rule: `⌘F` on macOS, `Ctrl+F` on Windows/Linux. The host platform comes from
 * the preload bridge (`window.autorag.platform`); tests and fixtures render with
 * the macOS default.
 */

/** The host `process.platform` from the preload bridge; macOS when it is absent. */
export function hostPlatform(): string {
	// Boundary read of the preload-injected global; narrowed with `in`/`typeof`.
	const host: unknown = globalThis;
	if (typeof host !== "object" || host === null || !("autorag" in host)) return "darwin";
	const bridge = host.autorag;
	if (typeof bridge !== "object" || bridge === null || !("platform" in bridge)) return "darwin";
	const platform = bridge.platform;
	return typeof platform === "string" && platform.length > 0 ? platform : "darwin";
}

export interface ShortcutSpec {
	/** The key, spelled for display (`F`, `,`, `1`, `Enter`, …). */
	readonly key: string;
	readonly shift?: boolean;
	readonly alt?: boolean;
	/** Include the primary modifier (⌘ / Ctrl). Default true; false for Alt-only chords. */
	readonly primary?: boolean;
}

/**
 * A shortcut hint: `⌘⇧H` on macOS, `Ctrl+Shift+H` elsewhere. Alt-only chords
 * omit the primary modifier on both platforms (`⌥Enter` / `Alt+Enter`).
 */
export function formatShortcut(spec: ShortcutSpec, platform: string = hostPlatform()): string {
	const primary = spec.primary !== false;
	if (platform === "darwin") {
		return `${primary ? "⌘" : ""}${spec.alt === true ? "⌥" : ""}${spec.shift === true ? "⇧" : ""}${spec.key}`;
	}
	return [
		primary ? "Ctrl" : null,
		spec.alt === true ? "Alt" : null,
		spec.shift === true ? "Shift" : null,
		spec.key,
	]
		.filter((part): part is string => part !== null)
		.join("+");
}
