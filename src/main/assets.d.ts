/// <reference types="electron-vite/node" />

interface ImportMetaEnv {
	/** Sentry project DSN, injected at build time (a public write-only key); unset in dev, where nothing is reported. */
	readonly MAIN_VITE_SENTRY_DSN?: string;
}
