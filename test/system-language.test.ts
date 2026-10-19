import { describe, expect, it } from "vitest";
import { detectSystemLanguage, type SystemLanguageSources } from "../src/main/system-language";
import { resolveSystemLanguage } from "../src/shared/language-contract";

/** The OS as Electron reports it; every file read answers null unless the test supplies it. */
function sources(overrides: Partial<SystemLanguageSources> = {}): SystemLanguageSources {
	return { platform: "linux", preferred: () => [], systemLocale: () => "en-US", home: "/home/me", readTextFile: () => null, ...overrides };
}

describe("resolveSystemLanguage with POSIX locale names", () => {
	it("reads the language out of LANG-style values", () => {
		expect(resolveSystemLanguage(["ko_KR.UTF-8"])).toBe("ko");
		expect(resolveSystemLanguage(["ja_JP.eucJP"])).toBe("ja");
		expect(resolveSystemLanguage(["zh_CN.GB2312"])).toBe("zh");
		expect(resolveSystemLanguage(["zh_TW@euro"])).toBe("zh");
		expect(resolveSystemLanguage(["ko.UTF-8"])).toBe("ko");
	});

	it("treats the C and POSIX locales as no language", () => {
		expect(resolveSystemLanguage(["C", "POSIX", "C.UTF-8"])).toBe("en");
		expect(resolveSystemLanguage(["C", "ja_JP"])).toBe("ja");
	});

	it("reads a colon-separated LANGUAGE list in order", () => {
		expect(resolveSystemLanguage(["fr:ja:en"])).toBe("ja");
	});
});

describe("detectSystemLanguage", () => {
	it("follows the preferred system languages Electron reports (macOS, Windows, Linux with a locale set)", () => {
		expect(detectSystemLanguage(sources({ platform: "darwin", preferred: () => ["ja-JP", "en-US"] }))).toBe("ja");
		expect(detectSystemLanguage(sources({ platform: "win32", preferred: () => ["zh-Hans-CN", "en-US"] }))).toBe("zh");
		expect(detectSystemLanguage(sources({ preferred: () => ["ko-KR", "ko"] }))).toBe("ko");
	});

	it("honors the order of the preference list, not the first shipped language it finds later", () => {
		expect(detectSystemLanguage(sources({ platform: "win32", preferred: () => ["en-US", "ko-KR"] }))).toBe("en");
	});

	it("uses the OS locale when no preferred language is a shipped one", () => {
		expect(detectSystemLanguage(sources({ platform: "win32", preferred: () => ["fr-FR"], systemLocale: () => "ko-KR" }))).toBe("ko");
		expect(detectSystemLanguage(sources({ platform: "win32", preferred: () => [], systemLocale: () => "ja-JP" }))).toBe("ja");
	});

	it("falls back to English for a language the app does not ship", () => {
		expect(detectSystemLanguage(sources({ platform: "darwin", preferred: () => ["fr-FR", "de-DE"], systemLocale: () => "fr-FR" }))).toBe("en");
	});

	it("on Linux with no locale in the environment, reads the user's then the system's locale file", () => {
		const files: Record<string, string> = {
			"/etc/locale.conf": "LANG=en_US.UTF-8\n",
			"/home/me/.config/locale.conf": "# set by the user\nLANG=ko_KR.UTF-8\n",
		};
		expect(detectSystemLanguage(sources({ readTextFile: (path) => files[path] ?? null }))).toBe("ko");
		delete files["/home/me/.config/locale.conf"];
		expect(detectSystemLanguage(sources({ readTextFile: (path) => files[path] ?? null }))).toBe("en");
	});

	it("reads Debian's /etc/default/locale and quoted values, with LANGUAGE winning over LANG", () => {
		const files: Record<string, string> = { "/etc/default/locale": 'LANG="en_US.UTF-8"\nLANGUAGE="ja_JP:ja"\n' };
		expect(detectSystemLanguage(sources({ readTextFile: (path) => files[path] ?? null }))).toBe("ja");
	});

	it("does not read locale files when Electron already reported a language, or off Linux", () => {
		const read = (): string => "LANG=ko_KR.UTF-8\n";
		expect(detectSystemLanguage(sources({ preferred: () => ["ja-JP"], readTextFile: read }))).toBe("ja");
		expect(detectSystemLanguage(sources({ platform: "win32", preferred: () => [], readTextFile: read }))).toBe("en");
		expect(detectSystemLanguage(sources({ platform: "darwin", preferred: () => [], readTextFile: read }))).toBe("en");
	});

	it("survives a locale file that cannot be read", () => {
		expect(detectSystemLanguage(sources({ readTextFile: () => { throw new Error("EACCES"); } }))).toBe("en");
	});
});
