import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ANALYTICS_EVENTS,
	TRACKED_SETTINGS,
	type AnalyticsEventName,
	type AnalyticsEventSchema,
	type AnalyticsOrigin,
	type AnalyticsProperties,
	type DurationBucket,
	type SettingValue,
	type TrackedSetting,
} from "../shared/analytics-contract";
import type { AppSettings } from "../shared/settings-contract";

/**
 * Everything usage analytics decides without touching PostHog or Electron, so
 * the rules that keep it anonymous are unit-testable. The PostHog client lives
 * in `analytics.ts`; this file owns what may be sent and whether anything is.
 *
 * Opt-in, anonymous, content-free:
 *  - nothing is sent, and no id is created, until the user turns it on;
 *  - an event carries only values from the fixed lists in the contract;
 *  - the id is a random uuid with no link to an account, a machine or a person,
 *    and turning the setting off deletes it, so a later opt-in starts over.
 */

type Scalar = string | boolean;

export interface SanitizedEvent {
	readonly event: AnalyticsEventName;
	readonly properties: Readonly<Record<string, Scalar>>;
}

/**
 * Check an event against the contract schema. Returns a copy holding exactly the
 * declared properties, or null when the name is unknown, the sender does not own
 * the event, a property is missing, extra or outside its list, or `properties`
 * is not a plain object. Nothing is repaired: a malformed event is dropped whole.
 */
export function sanitizeAnalyticsEvent(origin: AnalyticsOrigin, event: unknown, properties: unknown): SanitizedEvent | null {
	if (typeof event !== "string" || !Object.hasOwn(ANALYTICS_EVENTS, event)) return null;
	const name = event as AnalyticsEventName;
	const schema: AnalyticsEventSchema = ANALYTICS_EVENTS[name];
	if (origin === "renderer" && schema.origin !== "renderer") return null;
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return null;
	const input = properties as Record<string, unknown>;
	const declared = Object.keys(schema.properties);
	if (Object.keys(input).length !== declared.length) return null;
	const clean: Record<string, Scalar> = {};
	for (const key of declared) {
		if (!Object.hasOwn(input, key)) return null;
		const value = input[key];
		if (typeof value !== "string" && typeof value !== "boolean") return null;
		if (!schema.properties[key]?.includes(value)) return null;
		clean[key] = value;
	}
	return { event: name, properties: clean };
}

export interface AnalyticsTarget {
	/** The PostHog project key (`phc_…`): public and write-only. */
	readonly apiKey: string;
	readonly host: string;
}

const DEFAULT_ANALYTICS_HOST = "https://eu.i.posthog.com";

/**
 * Where events go, or null for "nowhere". The build supplies the project key and
 * host (`MAIN_VITE_POSTHOG_*`); a build given none sends nothing. An unpackaged
 * run (development, the QA lanes) may aim at another project or a local capture
 * server through `AUTORAG_ANALYTICS_KEY` / `AUTORAG_ANALYTICS_HOST`. A packaged
 * app ignores the environment, so a user's shell cannot redirect what it sends.
 */
export function resolveAnalyticsTarget(input: {
	readonly packaged: boolean;
	readonly buildKey: string | undefined;
	readonly buildHost: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
}): AnalyticsTarget | null {
	const useEnv = !input.packaged;
	const apiKey = (useEnv ? input.env.AUTORAG_ANALYTICS_KEY : undefined) || input.buildKey;
	const host = (useEnv ? input.env.AUTORAG_ANALYTICS_HOST : undefined) || input.buildHost || DEFAULT_ANALYTICS_HOST;
	if (apiKey === undefined || apiKey === "" || !/^https?:\/\//u.test(host)) return null;
	return { apiKey, host };
}

/** Milliseconds to a coarse bucket: exact timings could single out a machine or a corpus size. */
export function durationBucket(ms: number): DurationBucket {
	if (!Number.isFinite(ms) || ms < 1_000) return "lt_1s";
	if (ms < 10_000) return "1_10s";
	if (ms < 60_000) return "10_60s";
	if (ms < 600_000) return "1_10m";
	return "gt_10m";
}

/** The `settings_changed` payloads for every tracked setting that differs between two snapshots. */
export function settingChangeEvents(previous: AppSettings, next: AppSettings): { readonly setting: TrackedSetting; readonly value: SettingValue }[] {
	const changes: { setting: TrackedSetting; value: SettingValue }[] = [];
	for (const setting of TRACKED_SETTINGS) {
		const before = previous[setting];
		const after = next[setting];
		if (before === after) continue;
		changes.push({ setting, value: typeof after === "boolean" ? (after ? "on" : "off") : after });
	}
	return changes;
}

/** Whether the user opted in, read before the app is ready (the settings store loads asynchronously). Anything but an explicit `true` is off. */
export function readUsageAnalyticsEnabled(userDataDir: string): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(userDataDir, "settings", "settings-state.json"), "utf8"));
		const settings = typeof parsed === "object" && parsed !== null && "settings" in parsed ? parsed.settings : null;
		return typeof settings === "object" && settings !== null && "usageAnalytics" in settings && settings.usageAnalytics === true;
	} catch {
		return false;
	}
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface InstallIdStore {
	/** The stored id, created on first use. */
	get(): string;
	/** Delete the id; the next `get` makes a new, unrelated one. */
	reset(): void;
}

export function createInstallIdStore(path: string): InstallIdStore {
	let cached: string | null = null;
	return {
		get: () => {
			if (cached !== null) return cached;
			try {
				const stored = readFileSync(path, "utf8").trim();
				if (UUID_V4.test(stored)) {
					cached = stored;
					return stored;
				}
			} catch {
				// Missing or unreadable: a new id below.
			}
			const created = randomUUID();
			try {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, `${created}\n`, "utf8");
			} catch {
				// An id that cannot be persisted still works for this run.
			}
			cached = created;
			return created;
		},
		reset: () => {
			cached = null;
			rmSync(path, { force: true });
		},
	};
}

export interface SinkMessage {
	readonly distinctId: string;
	readonly event: string;
	readonly properties: Readonly<Record<string, Scalar>>;
}

/** Where validated events go: PostHog in the app, a recorder in tests. */
export interface AnalyticsSink {
	capture(message: SinkMessage): void;
	/** Drop everything queued and not yet sent (the user opted out). */
	discard(): void;
	/** Send what is queued, then stop. */
	shutdown(): Promise<void>;
}

export interface AnalyticsDeps {
	/** Null in a build with no PostHog project key: tracking is then a no-op. */
	readonly sink: AnalyticsSink | null;
	readonly installId: InstallIdStore;
	/** Coarse facts about the app on every event; read at send time so a changed language is current. */
	readonly context: () => Readonly<Record<string, Scalar>>;
	readonly enabled: boolean;
}

export interface Analytics {
	/** An event the main process raises itself. */
	track<E extends AnalyticsEventName>(event: E, properties: AnalyticsProperties<E>): void;
	/** An event that arrived over IPC: untrusted, so only renderer-owned events pass. */
	ingest(event: unknown, properties: unknown): void;
	/** The Settings toggle. Turning it off drops queued events and deletes the id. */
	setEnabled(next: boolean): void;
	shutdown(): Promise<void>;
}

export function createAnalytics(deps: AnalyticsDeps): Analytics {
	let enabled = deps.enabled;
	const send = (origin: AnalyticsOrigin, event: unknown, properties: unknown): void => {
		if (!enabled || deps.sink === null) return;
		const clean = sanitizeAnalyticsEvent(origin, event, properties);
		if (clean === null) return;
		try {
			deps.sink.capture({
				distinctId: deps.installId.get(),
				event: clean.event,
				// `$process_person_profile: false` keeps PostHog from building a person record: events only.
				properties: { ...clean.properties, ...deps.context(), $process_person_profile: false },
			});
		} catch {
			// Analytics never affects the app.
		}
	};
	return {
		track: (event, properties) => send("main", event, properties),
		ingest: (event, properties) => send("renderer", event, properties),
		setEnabled: (next) => {
			if (enabled && !next) {
				try {
					deps.sink?.discard();
				} catch {
					// Nothing to recover: the id is deleted below either way.
				}
				deps.installId.reset();
			}
			enabled = next;
		},
		shutdown: async () => {
			try {
				await deps.sink?.shutdown();
			} catch {
				// Quitting must not wait on or fail because of analytics.
			}
		},
	};
}
