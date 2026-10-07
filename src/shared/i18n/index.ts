import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import type { AppSettings } from "../settings-contract";

import ko from "./locales/ko.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

export const SUPPORTED_LANGUAGES = ["ko", "en", "ja", "zh"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const resources = {
	ko: { translation: ko },
	en: { translation: en },
	ja: { translation: ja },
	zh: { translation: zh },
} as const;

export function isSupportedLanguage(lang: string): lang is SupportedLanguage {
	return (SUPPORTED_LANGUAGES as readonly string[]).includes(lang);
}

if (!i18n.isInitialized) {
	void i18n.use(initReactI18next).init({
		resources,
		lng: "ko",
		fallbackLng: "ko",
		interpolation: {
			escapeValue: false,
		},
		returnNull: false,
	});
}

export async function setAppLanguage(lang: AppSettings["language"]): Promise<void> {
	if (i18n.language !== lang) {
		await i18n.changeLanguage(lang);
	}
}

export { i18n, useTranslation };
export const t = i18n.t.bind(i18n);

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: {
			translation: typeof ko;
		};
	}
}
