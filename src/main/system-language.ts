import type { AppSettings } from "../shared/settings-contract";
import { shippedLanguage } from "../shared/language-contract";

type AppLanguage = AppSettings["language"];

/** What {@link detectSystemLanguage} may ask the OS; injected so each platform's path is testable. */
export interface SystemLanguageSources {
	readonly platform: NodeJS.Platform;
	/** `app.getPreferredSystemLanguages()`: the user's language list on macOS and Windows; GLib's `LANGUAGE`/`LC_ALL`/`LC_MESSAGES`/`LANG` on Linux. */
	readonly preferred: () => readonly string[];
	/** `app.getSystemLocale()`: the OS regional locale. */
	readonly systemLocale: () => string;
	readonly home: string;
	/** The file's text, or null when it does not exist. */
	readonly readTextFile: (path: string) => string | null;
}

/** Variables that carry a Linux user's language, in the order GLib gives them precedence. */
const LOCALE_VARIABLES = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"] as const;

/**
 * Where a Linux login's locale is configured when the process itself was started
 * without one (a launcher, `systemd --user`, or a minimal session never sources
 * the shell profile): the user's systemd file, the system's, then Debian's.
 */
function localeFiles(home: string): readonly string[] {
	return [`${home}/.config/locale.conf`, "/etc/locale.conf", "/etc/default/locale"];
}

/** The locale values a `KEY=value` file sets (`LANG="ko_KR.UTF-8"`), in {@link LOCALE_VARIABLES} order. */
function localeValues(text: string): string[] {
	const found = new Map<string, string>();
	for (const line of text.split(/\r?\n/u)) {
		const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/u.exec(line);
		const value = match?.[2]?.replace(/^(["'])(.*)\1$/u, "$2");
		if (match?.[1] !== undefined && value !== undefined && value.length > 0) found.set(match[1], value);
	}
	return LOCALE_VARIABLES.flatMap((name) => found.get(name) ?? []);
}

/** `C` and `POSIX` mean "no language chosen", not a language. */
const isNeutral = (tag: string): boolean => /^(?:c|posix)(?:[.@].*)?$/iu.test(tag);

/**
 * The interface language a first run starts in: the OS language.
 *
 * macOS and Windows answer through `getPreferredSystemLanguages` (the user's
 * ordered language list). Linux answers from the process environment, which a
 * desktop launcher often leaves empty; then the locale files a login reads are
 * consulted. When the preference list holds no shipped language, the OS regional
 * locale decides, and English is the final fallback.
 */
export function detectSystemLanguage(sources: SystemLanguageSources): AppLanguage {
	const preferred = sources.preferred();
	const fromPreferred = shippedLanguage(preferred);
	if (fromPreferred !== null) return fromPreferred;

	if (sources.platform === "linux" && preferred.every(isNeutral)) {
		for (const path of localeFiles(sources.home)) {
			let tags: string[];
			try {
				const text = sources.readTextFile(path);
				tags = text === null ? [] : localeValues(text);
			} catch {
				continue;
			}
			const meaningful = tags.filter((tag) => !isNeutral(tag));
			if (meaningful.length > 0) return shippedLanguage(meaningful) ?? "en";
		}
	}
	return shippedLanguage([sources.systemLocale()]) ?? "en";
}
