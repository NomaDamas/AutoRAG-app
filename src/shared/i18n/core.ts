/**
 * The one i18next instance every process shares: the Finder and Quick Look
 * renderers (through `./index.ts`, which binds it to React), the main process,
 * and the fs worker. It imports nothing from React, so main and the worker can
 * translate the messages they hand to the UI in the interface language.
 *
 * Each process sets its own language with {@link setAppLanguage}: renderers
 * from the settings they read, main from the settings service, the worker from
 * main's `setLanguage` call.
 */

import i18n, { type ParseKeys } from "i18next";
import { APP_LANGUAGES, isAppLanguage } from "../language-contract";
import type { AppSettings } from "../settings-contract";

import ko from "./locales/ko.json";
import en from "./locales/en.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";

export type AppLanguage = AppSettings["language"];

export const SUPPORTED_LANGUAGES = APP_LANGUAGES;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const resources = {
	ko: { translation: ko },
	en: { translation: en },
	ja: { translation: ja },
	zh: { translation: zh },
} as const;

export const isSupportedLanguage = isAppLanguage;

if (!i18n.isInitialized) {
	// Synchronous: the resources are bundled, so `t` answers on the first call.
	void i18n.init({
		resources,
		lng: "ko",
		fallbackLng: "ko",
		initAsync: false,
		interpolation: {
			escapeValue: false,
		},
		returnNull: false,
	});
}

export async function setAppLanguage(lang: AppLanguage): Promise<void> {
	if (i18n.language !== lang) {
		await i18n.changeLanguage(lang);
	}
}

export { i18n };
export const t = i18n.t.bind(i18n);

/**
 * `t` for code that holds the key as a plain string (keys chosen by a shared pure module,
 * e.g. `localSpecMessage`). The key is still looked up in the locale files at run time.
 */
export const tByName = (key: string, options?: Record<string, unknown>): string => (options === undefined ? i18n.t(key as LocaleKey) : i18n.t(key as LocaleKey, options));

/** Any key of the locale files: type data fields that hold a key to translate later with this. */
export type LocaleKey = ParseKeys;

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: "translation";
		resources: {
			translation: typeof ko;
		};
	}
}
