import { describe, expect, it } from "vitest";
import { resolveSystemLanguage } from "../src/shared/language-contract";

describe("resolveSystemLanguage", () => {
	it("maps the OS locale tags to the four interface languages", () => {
		expect(resolveSystemLanguage(["ko-KR"])).toBe("ko");
		expect(resolveSystemLanguage(["en-US"])).toBe("en");
		expect(resolveSystemLanguage(["ja-JP"])).toBe("ja");
		expect(resolveSystemLanguage(["zh-Hans-CN"])).toBe("zh");
		expect(resolveSystemLanguage(["zh-TW"])).toBe("zh");
	});

	it("takes the first preferred language the app ships, not the first listed", () => {
		expect(resolveSystemLanguage(["fr-FR", "ja-JP", "en-US"])).toBe("ja");
	});

	it("reads tags case-insensitively and with underscores", () => {
		expect(resolveSystemLanguage(["KO_kr"])).toBe("ko");
	});

	it("falls back to English when no preferred language is shipped", () => {
		expect(resolveSystemLanguage(["fr-FR", "de-DE"])).toBe("en");
		expect(resolveSystemLanguage([])).toBe("en");
		expect(resolveSystemLanguage(["", "x"])).toBe("en");
	});

	it("does not mistake a longer subtag for a shipped language", () => {
		expect(resolveSystemLanguage(["kok-IN"])).toBe("en");
	});
});
