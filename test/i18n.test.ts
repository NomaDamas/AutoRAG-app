import { describe, expect, it } from "vitest";
import { resources, setAppLanguage, SUPPORTED_LANGUAGES, t } from "../src/shared/i18n";

describe("i18n configuration and locale keys", () => {
	it("supports ko, en, ja, zh languages", () => {
		expect(SUPPORTED_LANGUAGES).toEqual(["ko", "en", "ja", "zh"]);
		expect(Object.keys(resources)).toEqual(["ko", "en", "ja", "zh"]);
	});

	it("has complete top-level sections in all 4 language dictionaries", () => {
		const koKeys = Object.keys(resources.ko.translation).sort();
		for (const lang of ["en", "ja", "zh"] as const) {
			const langKeys = Object.keys(resources[lang].translation).sort();
			expect(langKeys).toEqual(koKeys);
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
