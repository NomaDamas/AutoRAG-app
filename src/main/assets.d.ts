/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
	/** Sentry project DSN, injected at build time (a public write-only key); unset in dev, where nothing is reported. */
	readonly MAIN_VITE_SENTRY_DSN?: string;
	/** PostHog project key (`phc_…`), injected at build time (public and write-only); unset in dev, where no usage statistics are sent. */
	readonly MAIN_VITE_POSTHOG_KEY?: string;
	/** PostHog ingestion host; defaults to the EU cloud. */
	readonly MAIN_VITE_POSTHOG_HOST?: string;
}
