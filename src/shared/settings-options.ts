/**
 * The closed choices Settings offers for config values, shared by the pages that render them and by the helper-agent
 * profiles that set them, so an assistant can never write a value the page would not offer.
 */

import type { LocaleKey } from "./i18n/core";

/** Document languages the parsers accept (`languages`). Labels are each language's own name, so they are not translated. */
export const DOC_LANGUAGES = [
	{ value: "ko", label: "한국어" },
	{ value: "en", label: "English" },
	{ value: "ja", label: "日本語" },
	{ value: "zh-hans", label: "简体中文" },
	{ value: "zh-hant", label: "繁體中文" },
	{ value: "fr", label: "Français" },
	{ value: "de", label: "Deutsch" },
	{ value: "es", label: "Español" },
	{ value: "ru", label: "Русский" },
	{ value: "it", label: "Italiano" },
	{ value: "pt", label: "Português" },
	{ value: "vi", label: "Tiếng Việt" },
	{ value: "th", label: "ไทย" },
	{ value: "ar", label: "العربية" },
	{ value: "hi", label: "हिन्दी" },
] as const;

export type DocLanguage = (typeof DOC_LANGUAGES)[number]["value"];

export function isDocLanguage(value: string): value is DocLanguage {
	return DOC_LANGUAGES.some((language) => language.value === value);
}

/** Web-search providers offered as the default provider (`webSearch.provider`); absent means automatic. */
export const WEBSEARCH_PROVIDERS = [
	{ id: "parallel", label: "Parallel" },
	{ id: "duckduckgo", label: "DuckDuckGo" },
	{ id: "gemini", label: "Gemini" },
	{ id: "anthropic", label: "Anthropic" },
	{ id: "codex", label: "OpenAI" },
	{ id: "xai", label: "xAI" },
	{ id: "perplexity", label: "Perplexity" },
	{ id: "searxng", label: "SearXNG" },
	{ id: "startpage", label: "Startpage" },
	{ id: "ecosia", label: "Ecosia" },
	{ id: "google", label: "Google" },
	{ id: "mojeek", label: "Mojeek" },
	{ id: "public", label: "Public Web" },
] as const;

/** Refresh cadences the config stores in milliseconds (`appIndexing.refreshIntervalMs`, `datasources.<id>.pollingIntervalMs`); 0 is manual. */
export const REFRESH_INTERVALS: readonly { readonly ms: number; readonly label: LocaleKey }[] = [
	{ ms: 5 * 60_000, label: "settingsSources.cadence.min5" },
	{ ms: 15 * 60_000, label: "settingsSources.cadence.min15" },
	{ ms: 30 * 60_000, label: "settingsSources.cadence.min30" },
	{ ms: 60 * 60_000, label: "settingsSources.cadence.hour1" },
	{ ms: 6 * 60 * 60_000, label: "settingsSources.cadence.hour6" },
	{ ms: 24 * 60 * 60_000, label: "settingsSources.cadence.day1" },
];

/** Human-readable English mapping for AI tool schemas/prompts so models never confuse 300000 (5m) with 1800000 (30m). */
export const REFRESH_INTERVAL_CHOICES: readonly { readonly ms: number; readonly duration: string }[] = [
	{ ms: 0, duration: "manual" },
	{ ms: 5 * 60_000, duration: "5 minutes" },
	{ ms: 15 * 60_000, duration: "15 minutes" },
	{ ms: 30 * 60_000, duration: "30 minutes" },
	{ ms: 60 * 60_000, duration: "1 hour" },
	{ ms: 6 * 60 * 60_000, duration: "6 hours" },
	{ ms: 24 * 60 * 60_000, duration: "24 hours" },
];

export function formatRefreshIntervalHint(): string {
	return REFRESH_INTERVAL_CHOICES.map((choice) => `${choice.ms} (${choice.duration})`).join(", ");
}

/** How often the app re-runs the version-family scan (`AppSettings.dupeyScanIntervalMinutes`). */
export const DUPEY_SCAN_INTERVALS: readonly { readonly value: number; readonly label: LocaleKey }[] = [
	{ value: 15, label: "settingsSources.duplicates.intervals.min15" },
	{ value: 30, label: "settingsSources.duplicates.intervals.min30" },
	{ value: 60, label: "settingsSources.duplicates.intervals.hour1" },
	{ value: 180, label: "settingsSources.duplicates.intervals.hour3" },
	{ value: 360, label: "settingsSources.duplicates.intervals.hour6" },
	{ value: 720, label: "settingsSources.duplicates.intervals.hour12" },
	{ value: 1440, label: "settingsSources.duplicates.intervals.day1" },
];

/** The answer model's thinking depth (`thinking.final`). */
export const THINKING_LEVELS = [
	{ value: "off", labelKey: "settingsCore.ai.thinking.off" },
	{ value: "low", labelKey: "settingsCore.ai.thinking.low" },
	{ value: "medium", labelKey: "settingsCore.ai.thinking.medium" },
	{ value: "high", labelKey: "settingsCore.ai.thinking.high" },
	{ value: "max", labelKey: "settingsCore.ai.thinking.max" },
] as const satisfies readonly { readonly value: string; readonly labelKey: LocaleKey }[];

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]["value"];
