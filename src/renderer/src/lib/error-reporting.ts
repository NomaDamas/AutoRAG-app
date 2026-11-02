import * as Sentry from "@sentry/electron/renderer";

/** A remote browser session has no Electron main process to report through. */
const isRemoteSession = Reflect.get(globalThis, "autoragIsRemote") === true;

/**
 * Sentry in a page. The DSN, the Settings toggle and the scrubbing live in the
 * main process, which every renderer event passes through. Breadcrumbs are off:
 * they record clicks and console output from a UI that shows file names.
 * Import this module first, before the app renders.
 */
if (!isRemoteSession) {
	Sentry.init({
		integrations: (defaults) => defaults.filter((integration) => integration.name !== "Breadcrumbs"),
	});
}
