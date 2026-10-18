import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAnalytics,
	createInstallIdStore,
	durationBucket,
	readUsageAnalyticsEnabled,
	resolveAnalyticsTarget,
	sanitizeAnalyticsEvent,
	settingChangeEvents,
	type AnalyticsSink,
	type SinkMessage,
} from "../src/main/analytics-core";
import { createPostHogSink, type PostHogFetch } from "../src/main/analytics";
import { DEFAULT_SETTINGS } from "../src/shared/settings-contract";

const directories: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "analytics-"));
	directories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sanitizeAnalyticsEvent", () => {
	it("keeps a declared event with declared values", () => {
		expect(sanitizeAnalyticsEvent("main", "ai_search_finished", { outcome: "answered", deepened: true, duration: "1_10s" })).toEqual({
			event: "ai_search_finished",
			properties: { outcome: "answered", deepened: true, duration: "1_10s" },
		});
	});

	it("rejects an event name that is not declared", () => {
		expect(sanitizeAnalyticsEvent("main", "file_opened", {})).toBeNull();
		expect(sanitizeAnalyticsEvent("main", 42, {})).toBeNull();
	});

	it("rejects a property that is not declared, so a path or query cannot ride along", () => {
		expect(sanitizeAnalyticsEvent("main", "ai_search_started", { has_attachments: false, follow_up: false, query: "분기 매출 계약서" })).toBeNull();
		expect(sanitizeAnalyticsEvent("main", "app_opened", { path: "/Users/jeff/Documents/secret.pdf" })).toBeNull();
	});

	it("rejects free text where only a fixed set of values is allowed", () => {
		expect(sanitizeAnalyticsEvent("renderer", "settings_page_viewed", { page: "/Users/jeff/Documents" })).toBeNull();
		expect(sanitizeAnalyticsEvent("main", "ai_search_finished", { outcome: "answered", deepened: "yes", duration: "1_10s" })).toBeNull();
	});

	it("rejects a declared property that is missing", () => {
		expect(sanitizeAnalyticsEvent("main", "ai_search_started", { has_attachments: true })).toBeNull();
	});

	it("rejects properties that are not a plain object", () => {
		expect(sanitizeAnalyticsEvent("main", "app_opened", null)).toBeNull();
		expect(sanitizeAnalyticsEvent("main", "app_opened", ["x"])).toBeNull();
		expect(sanitizeAnalyticsEvent("main", "app_opened", "x")).toBeNull();
	});

	it("rejects an own __proto__ key", () => {
		expect(sanitizeAnalyticsEvent("main", "app_opened", JSON.parse('{"__proto__": {"x": 1}}'))).toBeNull();
	});

	it("lets the renderer send only the events the renderer owns", () => {
		expect(sanitizeAnalyticsEvent("renderer", "settings_page_viewed", { page: "general" })).not.toBeNull();
		expect(sanitizeAnalyticsEvent("renderer", "app_opened", {})).toBeNull();
		expect(sanitizeAnalyticsEvent("renderer", "ai_search_finished", { outcome: "answered", deepened: true, duration: "lt_1s" })).toBeNull();
	});
});

describe("durationBucket", () => {
	it("maps milliseconds to coarse buckets", () => {
		expect(durationBucket(0)).toBe("lt_1s");
		expect(durationBucket(999)).toBe("lt_1s");
		expect(durationBucket(1_000)).toBe("1_10s");
		expect(durationBucket(9_999)).toBe("1_10s");
		expect(durationBucket(10_000)).toBe("10_60s");
		expect(durationBucket(60_000)).toBe("1_10m");
		expect(durationBucket(600_000)).toBe("gt_10m");
	});

	it("treats a negative or non-finite duration as the shortest bucket", () => {
		expect(durationBucket(-5)).toBe("lt_1s");
		expect(durationBucket(Number.NaN)).toBe("lt_1s");
	});
});

describe("readUsageAnalyticsEnabled", () => {
	async function userDataWith(settings: unknown): Promise<string> {
		const directory = await tempDir();
		await mkdir(join(directory, "settings"));
		if (settings !== undefined) await writeFile(join(directory, "settings", "settings-state.json"), JSON.stringify({ settings }));
		return directory;
	}

	it("is off when nothing is stored yet", async () => {
		expect(readUsageAnalyticsEnabled(await userDataWith(undefined))).toBe(false);
	});

	it("is off for settings saved before the toggle existed", async () => {
		expect(readUsageAnalyticsEnabled(await userDataWith({ language: "ko", errorReporting: true }))).toBe(false);
	});

	it("is on only when the user turned it on", async () => {
		expect(readUsageAnalyticsEnabled(await userDataWith({ usageAnalytics: true }))).toBe(true);
		expect(readUsageAnalyticsEnabled(await userDataWith({ usageAnalytics: "true" }))).toBe(false);
	});

	it("is off when the settings file is unreadable", async () => {
		const directory = await tempDir();
		await mkdir(join(directory, "settings"));
		await writeFile(join(directory, "settings", "settings-state.json"), "{ not json");
		expect(readUsageAnalyticsEnabled(directory)).toBe(false);
	});
});

describe("settingChangeEvents", () => {
	it("reports only tracked settings that changed, as on/off or the enum value", () => {
		const next = { ...DEFAULT_SETTINGS, showHiddenFiles: true, language: "en" as const, appearance: "dark" as const, dupeyScanIntervalMinutes: 5 };
		expect(settingChangeEvents(DEFAULT_SETTINGS, next)).toEqual([
			{ setting: "appearance", value: "dark" },
			{ setting: "language", value: "en" },
			{ setting: "showHiddenFiles", value: "on" },
		]);
	});

	it("reports nothing when nothing tracked changed", () => {
		expect(settingChangeEvents(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, dupeyScanIntervalMinutes: 5 })).toEqual([]);
	});

	it("reports the analytics toggle itself", () => {
		expect(settingChangeEvents(DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, usageAnalytics: true })).toEqual([{ setting: "usageAnalytics", value: "on" }]);
	});
});

describe("install id", () => {
	it("is a random uuid that stays the same across reads and restarts", async () => {
		const path = join(await tempDir(), "analytics", "install-id");
		const first = createInstallIdStore(path).get();
		expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
		expect(createInstallIdStore(path).get()).toBe(first);
	});

	it("is replaced when the stored value is not a uuid", async () => {
		const directory = await tempDir();
		const path = join(directory, "install-id");
		await writeFile(path, "jeff@example.com");
		const id = createInstallIdStore(path).get();
		expect(id).not.toContain("@");
		expect(readFileSync(path, "utf8").trim()).toBe(id);
	});

	it("is forgotten on reset, so the next id is a different one", async () => {
		const path = join(await tempDir(), "install-id");
		const store = createInstallIdStore(path);
		const before = store.get();
		store.reset();
		expect(existsSync(path)).toBe(false);
		expect(store.get()).not.toBe(before);
	});
});

function recordingSink(): { sink: AnalyticsSink; messages: SinkMessage[]; discards: () => number } {
	const messages: SinkMessage[] = [];
	let discarded = 0;
	return {
		messages,
		discards: () => discarded,
		sink: {
			capture: (message) => void messages.push(message),
			discard: () => void (discarded += 1),
			shutdown: async () => undefined,
		},
	};
}

async function analyticsWith(options: { enabled: boolean; sink?: AnalyticsSink | null; language?: () => string }) {
	const directory = await tempDir();
	const idPath = join(directory, "analytics", "install-id");
	const recorded = recordingSink();
	const analytics = createAnalytics({
		sink: options.sink === undefined ? recorded.sink : options.sink,
		installId: createInstallIdStore(idPath),
		context: () => ({ app_version: "1.2.3", platform: "darwin", arch: "arm64", packaged: true, language: options.language?.() ?? "ko" }),
		enabled: options.enabled,
	});
	return { analytics, messages: recorded.messages, idPath, discards: recorded.discards };
}

describe("createAnalytics", () => {
	it("sends nothing and creates no id while disabled", async () => {
		const { analytics, messages, idPath } = await analyticsWith({ enabled: false });
		analytics.track("app_opened", {});
		analytics.ingest("settings_page_viewed", { page: "general" });
		expect(messages).toEqual([]);
		expect(existsSync(idPath)).toBe(false);
	});

	it("sends one anonymous event with app context and no person profile", async () => {
		const { analytics, messages } = await analyticsWith({ enabled: true });
		analytics.track("ai_search_started", { has_attachments: true, follow_up: false });
		expect(messages).toHaveLength(1);
		expect(messages[0]).toEqual({
			distinctId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
			event: "ai_search_started",
			properties: {
				has_attachments: true,
				follow_up: false,
				app_version: "1.2.3",
				platform: "darwin",
				arch: "arm64",
				packaged: true,
				language: "ko",
				$process_person_profile: false,
			},
		});
	});

	it("reads the context at send time, so a language change shows up on the next event", async () => {
		let language = "ko";
		const { analytics, messages } = await analyticsWith({ enabled: true, language: () => language });
		analytics.track("app_opened", {});
		language = "en";
		analytics.track("app_opened", {});
		expect(messages.map((message) => message.properties.language)).toEqual(["ko", "en"]);
	});

	it("uses the same id for every event of an install", async () => {
		const { analytics, messages } = await analyticsWith({ enabled: true });
		analytics.track("app_opened", {});
		analytics.track("app_opened", {});
		expect(new Set(messages.map((message) => message.distinctId)).size).toBe(1);
	});

	it("stops at once when turned off, and a later opt-in is a new identity", async () => {
		const { analytics, messages, idPath, discards } = await analyticsWith({ enabled: true });
		analytics.track("app_opened", {});
		const first = messages[0]?.distinctId;
		analytics.setEnabled(false);
		expect(discards()).toBe(1);
		expect(existsSync(idPath)).toBe(false);
		analytics.track("app_opened", {});
		expect(messages).toHaveLength(1);
		analytics.setEnabled(true);
		analytics.track("app_opened", {});
		expect(messages).toHaveLength(2);
		expect(messages[1]?.distinctId).not.toBe(first);
	});

	it("drops an event that fails the allowlist instead of sending a partial one", async () => {
		const { analytics, messages } = await analyticsWith({ enabled: true });
		analytics.ingest("settings_page_viewed", { page: "general", path: "/Users/jeff" });
		analytics.ingest("app_opened", {});
		analytics.ingest("not_an_event", {});
		expect(messages).toEqual([]);
	});

	it("accepts a renderer event that the renderer owns", async () => {
		const { analytics, messages } = await analyticsWith({ enabled: true });
		analytics.ingest("settings_page_viewed", { page: "ai" });
		expect(messages.map((message) => message.event)).toEqual(["settings_page_viewed"]);
	});

	it("never throws when the sink fails", async () => {
		const fail = (): never => {
			throw new Error("network down");
		};
		const sink: AnalyticsSink = { capture: fail, discard: fail, shutdown: async () => fail() };
		const { analytics } = await analyticsWith({ enabled: true, sink });
		expect(() => analytics.track("app_opened", {})).not.toThrow();
		expect(() => analytics.setEnabled(false)).not.toThrow();
		await expect(analytics.shutdown()).resolves.toBeUndefined();
	});

	it("is a no-op without a sink (a build with no project key) and writes no id", async () => {
		const { analytics, idPath } = await analyticsWith({ enabled: true, sink: null });
		expect(() => analytics.track("app_opened", {})).not.toThrow();
		expect(existsSync(idPath)).toBe(false);
	});
});

interface WireRequest {
	readonly url: string;
	readonly body: string;
}

/** A fetch that records each request; the client gzips its batches, so the body is decoded for reading. */
function recordingFetch(): { requests: WireRequest[]; fetch: PostHogFetch } {
	const requests: WireRequest[] = [];
	const fetch: PostHogFetch = async (url, init) => {
		const raw = init.body;
		const bytes = typeof raw === "string" ? Buffer.from(raw) : raw === undefined ? Buffer.alloc(0) : Buffer.from(await new Response(raw).arrayBuffer());
		const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
		requests.push({ url, body: (gzipped ? gunzipSync(bytes) : bytes).toString("utf8") });
		return { status: 200, text: async () => "{}", json: async () => ({}) };
	};
	return { requests, fetch };
}

interface WireEvent {
	readonly event: string;
	readonly distinct_id: string;
	readonly properties: Record<string, unknown>;
}

function sentEvents(requests: readonly WireRequest[]): WireEvent[] {
	return requests
		.filter((request) => request.url.endsWith("/batch/"))
		.flatMap((request) => {
			const parsed: unknown = JSON.parse(request.body);
			if (typeof parsed !== "object" || parsed === null || !("batch" in parsed) || !Array.isArray(parsed.batch)) throw new Error("not a batch request");
			const batch: WireEvent[] = parsed.batch;
			return batch;
		});
}

describe("what leaves the machine through the PostHog client", () => {
	it("is one event to the configured host that holds only the allowlisted fields", async () => {
		const { requests, fetch } = recordingFetch();
		const sink = createPostHogSink({ apiKey: "phc_test", host: "https://eu.i.posthog.com", fetch });
		const { analytics } = await analyticsWith({ enabled: true, sink });
		analytics.track("ai_search_started", { has_attachments: false, follow_up: true });
		await analytics.shutdown();

		expect(requests.length).toBeGreaterThan(0);
		expect(requests.every((request) => request.url.startsWith("https://eu.i.posthog.com/"))).toBe(true);
		const events = sentEvents(requests);
		expect(events).toHaveLength(1);
		const [event] = events;
		expect(event?.event).toBe("ai_search_started");
		expect(event?.properties).toMatchObject({ has_attachments: false, follow_up: true, $process_person_profile: false, $geoip_disable: true });
		for (const key of Object.keys(event?.properties ?? {})) {
			expect(key).toMatch(/^(has_attachments|follow_up|app_version|platform|arch|packaged|language|\$lib|\$lib_version|\$is_server|\$process_person_profile|\$geoip_disable)$/u);
		}
		expect(requests.map((request) => request.body).join("\n")).not.toMatch(/\$ip|\$current_url|\$pathname|\$screen|email/u);
	});

	it("never starts a client for a user who does not opt in", async () => {
		const { requests, fetch } = recordingFetch();
		const sink = createPostHogSink({ apiKey: "phc_test", host: "https://eu.i.posthog.com", fetch });
		const { analytics } = await analyticsWith({ enabled: false, sink });
		analytics.track("app_opened", {});
		await analytics.shutdown();
		expect(requests).toEqual([]);
	});

	it("sends nothing that was still queued when the user opted out", async () => {
		const { requests, fetch } = recordingFetch();
		const sink = createPostHogSink({ apiKey: "phc_test", host: "https://eu.i.posthog.com", fetch });
		const { analytics } = await analyticsWith({ enabled: true, sink });
		analytics.track("app_opened", {});
		analytics.setEnabled(false);
		// Shutdown waits for the dropped queue to drain, so a request that was going to leave would be in `requests` by now.
		await analytics.shutdown();
		expect(sentEvents(requests)).toEqual([]);
	});
});

describe("resolveAnalyticsTarget", () => {
	const NO_ENV = {};

	it("has no target in a build without a project key, so nothing can be sent", () => {
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: undefined, buildHost: undefined, env: NO_ENV })).toBeNull();
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: "", buildHost: undefined, env: NO_ENV })).toBeNull();
	});

	it("uses the build's key and defaults the host to the EU cloud", () => {
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: "phc_build", buildHost: undefined, env: NO_ENV })).toEqual({ apiKey: "phc_build", host: "https://eu.i.posthog.com" });
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: "phc_build", buildHost: "https://ph.example.com", env: NO_ENV })).toEqual({ apiKey: "phc_build", host: "https://ph.example.com" });
	});

	it("lets an unpackaged run (dev, QA) aim at another project or a local capture server through the environment", () => {
		const env = { AUTORAG_ANALYTICS_KEY: "phc_local", AUTORAG_ANALYTICS_HOST: "http://127.0.0.1:18765" };
		expect(resolveAnalyticsTarget({ packaged: false, buildKey: undefined, buildHost: undefined, env })).toEqual({ apiKey: "phc_local", host: "http://127.0.0.1:18765" });
		expect(resolveAnalyticsTarget({ packaged: false, buildKey: "phc_build", buildHost: undefined, env })).toEqual({ apiKey: "phc_local", host: "http://127.0.0.1:18765" });
	});

	it("ignores the environment in a packaged app, so a user's shell cannot redirect what the app sends", () => {
		const env = { AUTORAG_ANALYTICS_KEY: "phc_local", AUTORAG_ANALYTICS_HOST: "http://127.0.0.1:18765" };
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: "phc_build", buildHost: undefined, env })).toEqual({ apiKey: "phc_build", host: "https://eu.i.posthog.com" });
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: undefined, buildHost: undefined, env })).toBeNull();
	});

	it("has no target when the host is not an http(s) URL", () => {
		expect(resolveAnalyticsTarget({ packaged: true, buildKey: "phc_build", buildHost: "not a url", env: NO_ENV })).toBeNull();
		expect(resolveAnalyticsTarget({ packaged: false, buildKey: undefined, buildHost: undefined, env: { AUTORAG_ANALYTICS_KEY: "k", AUTORAG_ANALYTICS_HOST: "file:///etc/passwd" } })).toBeNull();
	});
});
