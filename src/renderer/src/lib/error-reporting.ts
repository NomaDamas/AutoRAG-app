import * as Sentry from "@sentry/electron/renderer";

/**
 * Sentry in a page. The DSN, the Settings toggle and the scrubbing live in the
 * main process, which every renderer event passes through. Breadcrumbs are off:
 * they record clicks and console output from a UI that shows file names.
 * Import this module first, before the app renders.
 */
Sentry.init({
	integrations: (defaults) => defaults.filter((integration) => integration.name !== "Breadcrumbs"),
});
