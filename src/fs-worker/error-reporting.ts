import * as Sentry from "@sentry/electron/utility";
import { installErrorReporter, type ErrorReport } from "../main/error-report-core";

/**
 * Sentry in the fs worker. Events travel to the main process, whose client owns
 * the DSN, the Settings toggle and the scrubbing (`src/main/error-reporting.ts`);
 * with no client there, they go nowhere.
 */
export function initWorkerErrorReporting(): void {
	Sentry.init({
		integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),
	});
	installErrorReporter((report: ErrorReport) => {
		Sentry.captureMessage(report.title, { level: "error", fingerprint: [...report.fingerprint], tags: { ...report.tags }, extra: { ...report.extra } });
	});
}
