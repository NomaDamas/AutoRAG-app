// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { i18n, setAppLanguage, t } from "../src/shared/i18n";
import { applyInterfaceLanguage } from "../src/renderer/src/lib/interface-language";

afterEach(async () => {
	await setAppLanguage("ko");
});

describe("applyInterfaceLanguage", () => {
	it("switches the translations and the document language to the stored setting before first paint", async () => {
		await applyInterfaceLanguage({ get: async () => ({ language: "ja" }) });

		expect(i18n.language).toBe("ja");
		expect(t("onboarding.step.welcome")).not.toBe("");
		expect(t("common.save")).toBe("保存");
		expect(document.documentElement.lang).toBe("ja");
	});

	it("keeps the default language when the settings cannot be read", async () => {
		await applyInterfaceLanguage({ get: async () => Promise.reject(new Error("no bridge")) });

		expect(i18n.language).toBe("ko");
	});
});
