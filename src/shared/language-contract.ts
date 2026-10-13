import type { AppSettings } from "./settings-contract";

/**
 * The interface language as main pushes it to windows that do not read the
 * settings themselves (Quick Look). The Finder window applies the language
 * from the settings it reads and ignores this channel.
 */

export const LANGUAGE_CHANNELS = {
	/** Main -> every window: the interface language changed. */
	changed: "language:changed",
} as const;

/** argv flag carrying the language a window starts in. */
export const LANGUAGE_FLAG = "--autorag-language=";

export const APP_LANGUAGES = ["ko", "en", "ja", "zh"] as const satisfies readonly AppSettings["language"][];

export function isAppLanguage(value: unknown): value is AppSettings["language"] {
	return typeof value === "string" && (APP_LANGUAGES as readonly string[]).includes(value);
}

/** The language a window's argv carries, else Korean (the settings default). */
export function languageFromArgv(argv: readonly string[]): AppSettings["language"] {
	const value = argv.find((arg) => arg.startsWith(LANGUAGE_FLAG))?.slice(LANGUAGE_FLAG.length);
	return isAppLanguage(value) ? value : "ko";
}
