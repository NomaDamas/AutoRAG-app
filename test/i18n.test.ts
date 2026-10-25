import { describe, expect, it } from "vitest";
import { resources, setAppLanguage, SUPPORTED_LANGUAGES, t } from "../src/shared/i18n";

describe("i18n configuration and locale keys", () => {
	it("supports ko, en, ja, zh languages", () => {
		expect(SUPPORTED_LANGUAGES).toEqual(["ko", "en", "ja", "zh"]);
		expect(Object.keys(resources)).toEqual(["ko", "en", "ja", "zh"]);
	});

	/** Every leaf key with its value: a missing or extra key in one language is a string that never translates. */
	function leaves(tree: object, prefix = ""): Map<string, string> {
		const out = new Map<string, string>();
		for (const [key, value] of Object.entries(tree)) {
			if (typeof value === "string") out.set(`${prefix}${key}`, value);
			else for (const [leaf, text] of leaves(value as object, `${prefix}${key}.`)) out.set(leaf, text);
		}
		return out;
	}
	const variables = (text: string): string[] => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1] ?? "").sort();
	const ko = leaves(resources.ko.translation);

	it("has the same keys and interpolation variables in all 4 language dictionaries", () => {
		for (const lang of ["en", "ja", "zh"] as const) {
			const other = leaves(resources[lang].translation);
			expect([...other.keys()].sort()).toEqual([...ko.keys()].sort());
			for (const [key, text] of ko) expect(variables(other.get(key) ?? ""), `${lang} ${key}`).toEqual(variables(text));
		}
	});

	it("has no Korean left in the en, ja, and zh dictionaries", () => {
		for (const lang of ["en", "ja", "zh"] as const) {
			const korean = [...leaves(resources[lang].translation)].filter(([, text]) => /[\uac00-\ud7a3]/.test(text)).map(([key]) => key);
			expect(korean, lang).toEqual([]);
		}
	});

	/** Names that read the same in every language: products, brands, plan tiers, URLs, and bare placeholders. */
	const NAME_ONLY = /^(?:[\s\W\d]|KakaoTalk|Slack|Discord|Telegram|WhatsApp|GitHub|Obsidian|Anthropic|OpenAI|OpenRouter|Google|Ollama|Free|Air|Pro|Max|BYOK|https?:\/\/\S+|\{\{\w+\}\})*$/u;

	it("translates every onboarding string in ja and zh instead of leaving English or Korean copy behind", () => {
		const english = leaves(resources.en.translation);
		for (const lang of ["ja", "zh"] as const) {
			const other = leaves(resources[lang].translation);
			const untranslated = [...other]
				.filter(([key, text]) => key.startsWith("onboarding.") && text === english.get(key) && !NAME_ONLY.test(text))
				.map(([key]) => key);
			expect(untranslated, lang).toEqual([]);
		}
	});

	it("keeps English prose words out of the Korean onboarding copy", () => {
		const prose = [...ko].filter(([key, text]) => key.startsWith("onboarding.") && /\b(?:Settings|System Settings|Budget summary|operating cost|provider|runtime|workspace)\b/u.test(text));
		expect(prose.map(([key]) => key)).toEqual([]);
	});

	it("keeps English prose words out of the ja and zh onboarding copy", () => {
		for (const lang of ["ja", "zh"] as const) {
			const prose = [...leaves(resources[lang].translation)].filter(([key, text]) => key.startsWith("onboarding.") && /\b(?:Settings|provider|runtime|workspace|Budget summary|operating cost)\b/iu.test(text));
			expect(prose.map(([key]) => key), lang).toEqual([]);
		}
	});

	it("translates common keys in each language", async () => {
		await setAppLanguage("ko");
		expect(t("common.save")).toBe("저장");
		expect(t("places.aiSearch")).toBe("AI 검색");
		expect(t("places.favorites")).toBe("즐겨찾기");
		expect(t("places.settings")).toBe("설정");
		expect(t("contextMenu.rename")).toBe("이름 변경");
		await setAppLanguage("en");
		expect(t("common.save")).toBe("Save");
		expect(t("contextMenu.rename")).toBe("Rename");
		expect(t("inspector.actions.askAi")).toBe("AI Summary");

		await setAppLanguage("ja");
		expect(t("common.save")).toBe("保存");
		expect(t("contextMenu.rename")).toBe("名前の変更");
		expect(t("inspector.actions.askAi")).toBe("AI 要約");

		await setAppLanguage("zh");
		expect(t("common.save")).toBe("保存");
		expect(t("contextMenu.rename")).toBe("重命名");
		expect(t("inspector.actions.askAi")).toBe("AI 总结");

		// Reset to default
		await setAppLanguage("ko");
		expect(t("common.save")).toBe("저장");
	});

	it("interpolates parameters correctly", async () => {
		await setAppLanguage("ko");
		expect(t("toolbar.viewAs", { label: "목록", shortcut: "⌘2" })).toBe("목록 보기 (⌘2)");

		await setAppLanguage("en");
		expect(t("toolbar.viewAs", { label: "List", shortcut: "⌘2" })).toBe("as List (⌘2)");

		await setAppLanguage("ja");
		expect(t("toolbar.viewAs", { label: "リスト", shortcut: "⌘2" })).toBe("リストで表示 (⌘2)");

		await setAppLanguage("zh");
		expect(t("toolbar.viewAs", { label: "列表", shortcut: "⌘2" })).toBe("以列表显示 (⌘2)");

		await setAppLanguage("ko");
	});
});
