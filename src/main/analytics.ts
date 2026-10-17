import { PostHog, type PostHogOptions } from "posthog-node";
import type { AnalyticsSink } from "./analytics-core";

/**
 * The PostHog client behind the analytics sink. Everything that decides what may
 * be sent lives in `analytics-core.ts`; this file only delivers validated events.
 *
 * Configured for anonymous, events-only use: no geo lookup, no feature-flag or
 * remote-config traffic, no exception autocapture. Events are batched and sent
 * from the main process, so no PostHog code runs in a page that shows file names.
 * One project setting cannot be set from here: turn on "Discard client IP data"
 * in PostHog, or the server keeps the request IP it sees.
 */

/** The client's network call; the sink wraps it to hold back an opted-out queue. */
export type PostHogFetch = NonNullable<PostHogOptions["fetch"]>;

/** What a dropped request answers: a success, so the client removes the event from its queue. */
const DROPPED = { status: 200, text: async () => "{}", json: async () => ({}) };

export interface PostHogSinkOptions {
	/** The project key (`phc_…`): public and write-only. */
	readonly apiKey: string;
	/** Ingestion host, for example `https://eu.i.posthog.com`. */
	readonly host: string;
	/** Replaces the network call; tests use it to read what would be sent. */
	readonly fetch?: PostHogFetch;
}

interface Session {
	readonly client: PostHog;
	/** Closed on opt-out: whatever the client still has queued is answered, not sent. */
	readonly gate: { open: boolean };
}

/** The client is created on the first event, so a user who never opts in never starts one. */
export function createPostHogSink(options: PostHogSinkOptions): AnalyticsSink {
	let session: Session | null = null;
	/** Opt-out drains still running; quitting waits for them so none outlives the app. */
	const draining = new Set<Promise<void>>();
	const send: PostHogFetch = options.fetch ?? ((url, init) => fetch(url, init));
	const start = (): Session => {
		const gate = { open: true };
		const client = new PostHog(options.apiKey, {
			host: options.host,
			flushAt: 10,
			flushInterval: 30_000,
			disableGeoip: true,
			preloadFeatureFlags: false,
			disableRemoteConfig: true,
			fetch: async (url, init) => (gate.open ? send(url, init) : DROPPED),
		});
		return { client, gate };
	};
	return {
		capture: (message) => {
			session ??= start();
			session.client.capture({ distinctId: message.distinctId, event: message.event, properties: { ...message.properties } });
		},
		discard: () => {
			const old = session;
			session = null;
			if (old === null) return;
			old.gate.open = false;
			// Shutdown drains the queue through the closed gate and stops the flush timer.
			const drained = old.client.shutdown(1_000).catch(() => undefined);
			draining.add(drained);
			void drained.finally(() => draining.delete(drained));
		},
		shutdown: async () => {
			await Promise.all([session?.client.shutdown(3_000), ...draining]);
		},
	};
}
