/**
 * Product-usage analytics contract shared by the main process, the preload
 * bridge and the renderer.
 *
 * Privacy is a property of this file: an event can only carry values from the
 * fixed lists below. There is no string, number or object property, so a file
 * name, a path, a query or a document excerpt has no slot to travel in. The main
 * process validates every event against this schema before it is queued
 * (`sanitizeAnalyticsEvent`), whichever process produced it.
 */

export const ANALYTICS_CHANNELS = {
	track: "analytics:track",
} as const;

/** Who may send an event: the main process (from its own services) or the renderer (over IPC). */
export type AnalyticsOrigin = "main" | "renderer";

const BOOLEAN = [true, false] as const;

/** Settings pages an event can name; `source:<alias>` pages collapse to `source` so a user-chosen alias is never sent. */
const SETTINGS_PAGES = ["account", "plan", "general", "ai", "web", "indexing", "scope", "reading", "duplicates", "apps", "source"] as const;
export const TRACKED_SETTINGS = [
	"appearance",
	"language",
	"launchAtLogin",
	"showInMenuBar",
	"autoInstallUpdates",
	"errorReporting",
	"usageAnalytics",
	"showHiddenFiles",
	"osMenuIntegration",
] as const;
const SETTING_VALUES = ["on", "off", "light", "dark", "ko", "en", "ja", "zh"] as const;
const DURATIONS = ["lt_1s", "1_10s", "10_60s", "1_10m", "gt_10m"] as const;

export const ANALYTICS_EVENTS = {
	app_opened: { origin: "main", properties: {} },
	settings_changed: { origin: "main", properties: { setting: TRACKED_SETTINGS, value: SETTING_VALUES } },
	onboarding_completed: { origin: "main", properties: {} },
	ai_search_started: { origin: "main", properties: { has_attachments: BOOLEAN, follow_up: BOOLEAN } },
	ai_search_finished: {
		origin: "main",
		properties: { outcome: ["answered", "failed", "stopped"], deepened: BOOLEAN, duration: DURATIONS },
	},
	settings_page_viewed: { origin: "renderer", properties: { page: SETTINGS_PAGES } },
} as const satisfies Record<string, AnalyticsEventSchema>;

export interface AnalyticsEventSchema {
	readonly origin: AnalyticsOrigin;
	/** Every declared property is required; each value must be one of its listed primitives. */
	readonly properties: Readonly<Record<string, readonly (string | boolean)[]>>;
}

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENTS;
export type AnalyticsProperties<E extends AnalyticsEventName> = {
	-readonly [K in keyof (typeof ANALYTICS_EVENTS)[E]["properties"]]: (typeof ANALYTICS_EVENTS)[E]["properties"][K] extends readonly (infer V)[] ? V : never;
};
export type RendererAnalyticsEvent = { [E in AnalyticsEventName]: (typeof ANALYTICS_EVENTS)[E]["origin"] extends "renderer" ? E : never }[AnalyticsEventName];
export type SettingsPage = (typeof SETTINGS_PAGES)[number];
export type TrackedSetting = (typeof TRACKED_SETTINGS)[number];
export type SettingValue = (typeof SETTING_VALUES)[number];
export type DurationBucket = (typeof DURATIONS)[number];

/** `window.autorag.analytics`: one-way, fire-and-forget; the main process decides whether anything is sent. */
export interface AnalyticsBridge {
	track<E extends RendererAnalyticsEvent>(event: E, properties: AnalyticsProperties<E>): void;
}
