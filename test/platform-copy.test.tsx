import { describe, expect, it } from "vitest";
import { platformKey } from "../src/renderer/src/lib/platform-copy";
import { resources, SUPPORTED_LANGUAGES, type LocaleKey } from "../src/shared/i18n";

/** The dictionary value at a dotted key. */
function lookup(language: (typeof SUPPORTED_LANGUAGES)[number], key: string): string {
	let node: unknown = resources[language].translation;
	for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
	return typeof node === "string" ? node : "";
}

describe("copy that names the machine", () => {
	it("picks the PC wording on Windows and keeps the Mac wording everywhere else", () => {
		expect(platformKey("settingsCore.embedding.apiKeyHint", "win32")).toBe("settingsCore.embedding.apiKeyHintPc");
		expect(platformKey("settingsCore.ai.server.bodyLocal", "win32")).toBe("settingsCore.ai.server.bodyLocalPc");
		expect(platformKey("settingsCore.embedding.apiKeyHint", "darwin")).toBe("settingsCore.embedding.apiKeyHint");
		expect(platformKey("settingsCore.ai.server.bodyLocal", "linux")).toBe("settingsCore.ai.server.bodyLocal");
	});

	const PC_KEYS: readonly LocaleKey[] = [
		"settingsCore.embedding.apiKeyHintPc",
		"settingsCore.ai.server.bodyLocalPc",
	];

	it("has a PC sentence in every language that never calls the machine a Mac", () => {
		for (const language of SUPPORTED_LANGUAGES) {
			for (const key of PC_KEYS) {
				const text = lookup(language, key);
				expect(text, `${language} ${key}`).not.toBe("");
				expect(text, `${language} ${key}`).not.toMatch(/\bMac\b|macOS|맥/u);
			}
		}
	});

	it("keeps the Mac sentences naming the Mac", () => {
		for (const key of ["settingsCore.embedding.apiKeyHint", "settingsCore.ai.server.bodyLocal"]) {
			expect(lookup("en", key), key).toMatch(/Mac/u);
		}
	});

});
