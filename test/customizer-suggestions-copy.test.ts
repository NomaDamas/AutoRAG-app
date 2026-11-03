import { describe, expect, it } from "vitest";
import en from "../src/shared/i18n/locales/en.json";
import ja from "../src/shared/i18n/locales/ja.json";
import ko from "../src/shared/i18n/locales/ko.json";
import zh from "../src/shared/i18n/locales/zh.json";

/**
 * The customization assistant's one-click suggestions are written for an office worker who is not a developer:
 * they name things the way the Finder shows them, never formats, hashes, archive tools, or file paths.
 */
const DEVELOPER_TERMS = /SHA|hash|해시|ハッシュ|哈希|Markdown|마크다운|7z|script|스크립트|スクリプト|脚本|\bpath\b|경로|パス|路径|Cmd|Ctrl|⌘/i;

const SURFACES = ["sidebar", "contextMenu", "shortcuts"] as const;

describe("customization assistant suggestions", () => {
	for (const [language, locale] of Object.entries({ ko, en, ja, zh })) {
		it(`speak to an office worker in ${language}`, () => {
			for (const surface of SURFACES) {
				const assistant: Record<string, string> = locale.settingsCore[surface].assistant;
				const suggestions = Object.entries(assistant).filter(([key]) => key.startsWith("prompt"));
				expect(suggestions.length, `${surface} suggestions`).toBe(4);
				for (const [key, text] of suggestions) expect(text, `${surface}.${key}`).not.toMatch(DEVELOPER_TERMS);
				// The input box carries no example of its own: the suggestions above it are the examples.
				expect(assistant.placeholder, `${surface}.placeholder`).toBeUndefined();
			}
		});
	}
});
