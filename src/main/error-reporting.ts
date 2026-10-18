import * as Sentry from "@sentry/electron/main";
import { installErrorReporter, scrubEvent } from "./error-report-core";

/**
 * Sentry in the main process. Renderer and utility-process events are relayed
 * here, so this one client is the only place that decides whether anything
 * leaves the machine and what it contains.
 *
 * Dropped from the SDK's defaults, each because it would carry content or
 * identity the app does not report: console and network breadcrumbs, local
 * variables, source context, screenshots, sessions, and native minidumps (they
 * hold process memory, which can hold document text). Crashes are still
 * reported: the child-process integration captures a crashed or killed renderer
 * or utility process (the fs worker) without a dump.
 */

const DROPPED_INTEGRATIONS: Record<string, true> = {
	Console: true,
	ContextLines: true,
	LocalVariables: true,
	LocalVariablesAsync: true,
	ElectronNet: true,
	NodeFetch: true,
	Screenshots: true,
	SentryMinidump: true,
	ElectronMinidump: true,
	MainProcessSession: true,
	BrowserWindowSession: true,
	// The app's own preload imports the SDK preload; the injected copy would register it twice.
	PreloadInjection: true,
	ChildProcess: true,
};

let enabled = false;

/** The Settings toggle: while off, every event is dropped before it is queued or sent. */
export function setErrorReportingEnabled(next: boolean): void {
	enabled = next;
}

/** Start the SDK. Without a DSN (a build that was given none) nothing is initialised and no report is sent. */
export function initErrorReporting(options: { readonly dsn: string | undefined; readonly enabled: boolean; readonly version: string; readonly packaged: boolean }): void {
	enabled = options.enabled;
	if (options.dsn === undefined || options.dsn === "") return;
	Sentry.init({
		dsn: options.dsn,
		release: `dazzi@${options.version}`,
		environment: options.packaged ? "production" : "development",
		sendClientReports: false,
		maxBreadcrumbs: 20,
		dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false },
		integrations: (defaults) => [
			...defaults.filter((integration) => DROPPED_INTEGRATIONS[integration.name] !== true),
			Sentry.childProcessIntegration({ breadcrumbs: false, events: ["abnormal-exit", "crashed", "oom", "launch-failed", "integrity-failure"] }),
		],
		beforeSend: (event) => (enabled ? scrubEvent(event) : null),
		beforeSendTransaction: () => null,
	});
	installErrorReporter((report) =>
		Sentry.captureMessage(report.title, { level: "error", fingerprint: [...report.fingerprint], tags: { ...report.tags }, extra: { ...report.extra } }),
	);
}
