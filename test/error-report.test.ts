import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	datasourceFailureReport,
	embedderStallReport,
	fileTimeoutReport,
	installErrorReporter,
	readErrorReportingEnabled,
	refreshFailureReport,
	reportError,
	scrubEvent,
	scrubText,
	type ErrorReport,
} from "../src/main/error-report-core";
import { withFileTimeout } from "../src/main/file-timeout";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";

const directories: string[] = [];

afterEach(async () => {
	installErrorReporter(null);
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const CORPUS = "분기 매출 3억 원, 계약서 초안";

describe("scrubText", () => {
	it("removes absolute, home and Windows paths but keeps the extension", () => {
		const text = "ENOENT: open '/Users/kim/Documents/비밀 계약서.pdf' then C:\\Users\\kim\\Desktop\\a.docx and ~/notes/todo.md failed";
		const scrubbed = scrubText(text);
		expect(scrubbed).not.toMatch(/kim|Users|Documents|계약서|Desktop|notes/u);
		expect(scrubbed).toContain("<path>.pdf");
		expect(scrubbed).toContain("<path>.docx");
		expect(scrubbed).toContain("<path>.md");
	});

	it("keeps URLs and version-like text intact", () => {
		expect(scrubText("GET https://api.example.com/v1/items 504 on app:///index.html")).toBe("GET https://api.example.com/v1/items 504 on app:///index.html");
	});

	it("cuts long text so echoed document content cannot ride along", () => {
		expect(scrubText("x".repeat(5000)).length).toBeLessThan(600);
	});
});

describe("scrubEvent", () => {
	it("drops identity fields and console breadcrumbs, and scrubs every remaining string", () => {
		const event = scrubEvent({
			message: "failed reading /Users/kim/secret/report.xlsx",
			user: { ip_address: "1.2.3.4", username: "kim" },
			server_name: "kims-macbook",
			request: { url: "file:///Users/kim/x" },
			breadcrumbs: [
				{ category: "console", message: CORPUS },
				{ category: "ui.click", message: "ok" },
			],
			exception: { values: [{ value: "at /Users/kim/app/main.js:10:5", stacktrace: { frames: [{ filename: "/Users/kim/app/main.js" }] } }] },
		});
		const json = JSON.stringify(event);
		expect(json).not.toMatch(/kim|1\.2\.3\.4|Users/u);
		expect(json).not.toContain(CORPUS);
		expect(event.breadcrumbs).toHaveLength(1);
	});
});

describe("refreshFailureReport", () => {
	const failed: ConfigRefreshResult = {
		ok: false,
		methods: ["parsed", "minsync"],
		scanned: 120,
		written: 100,
		deleted: 0,
		skipped: 20,
		diagnostics: [{ code: "minsync-sync-failed", severity: "error", message: "MinSync failed on /Users/kim/Documents/계약서.pdf" }],
		error: "minsync: embedding failed for '/Users/kim/Documents/계약서.pdf' (port 51234)",
	};

	it("produces a report with counts and the failing step, and no path or file name", () => {
		const report = refreshFailureReport(failed);
		expect(report).not.toBeNull();
		expect(report?.extra).toMatchObject({ scanned: 120, written: 100, skipped: 20 });
		expect(report?.tags["index.step"]).toBe("minsync");
		expect(JSON.stringify(report)).not.toMatch(/kim|Users|Documents|계약서/u);
	});

	it("is null for a refresh that succeeded", () => {
		expect(refreshFailureReport({ ...failed, ok: true, error: null })).toBeNull();
	});

	it("groups the same failure across different numbers and paths", () => {
		const first = refreshFailureReport(failed);
		const second = refreshFailureReport({ ...failed, error: "minsync: embedding failed for '/tmp/other/b.pdf' (port 60001)" });
		expect(second?.fingerprint).toEqual(first?.fingerprint);
	});
});

describe("datasourceFailureReport", () => {
	it("names the datasource by built-in type and carries no path or user-chosen name", () => {
		const report = datasourceFailureReport("kakao", "sync failed reading '/Users/kim/Library/kakao.db' (pid 4242)", 1500);
		expect(report.tags["datasource.type"]).toBe("kakao");
		expect(JSON.stringify(report)).not.toMatch(/kim|Users/u);
	});

	it("groups one failure across different numbers and paths, and separates datasource types", () => {
		const first = datasourceFailureReport("kakao", "failed at '/a/x.db' (pid 1)", 10);
		const second = datasourceFailureReport("kakao", "failed at '/b/y.db' (pid 2)", 20);
		expect(second.fingerprint).toEqual(first.fingerprint);
		expect(datasourceFailureReport("slack", "failed at '/a/x.db' (pid 1)", 10).fingerprint).not.toEqual(first.fingerprint);
	});
});

describe("embedderStallReport", () => {
	it("is one issue however many restarts a run needed, with the count as data", () => {
		expect(embedderStallReport(1).fingerprint).toEqual(embedderStallReport(2).fingerprint);
		expect(embedderStallReport(2).extra).toMatchObject({ retries: 2 });
	});
});

describe("reportError", () => {
	it("sends an identical report once per run and different ones separately", () => {
		const sent: ErrorReport[] = [];
		installErrorReporter((report) => sent.push(report));
		const base = fileTimeoutReport(1000, 10);
		reportError(base);
		reportError(base);
		reportError({ ...base, fingerprint: ["other"] });
		expect(sent).toHaveLength(2);
	});

	it("sends nothing and does not throw with no reporter installed", () => {
		expect(() => reportError(fileTimeoutReport(1000, 10))).not.toThrow();
	});

	it("survives a reporter that throws", () => {
		installErrorReporter(() => {
			throw new Error("network down");
		});
		expect(() => reportError(fileTimeoutReport(1000, 10))).not.toThrow();
	});
});

describe("withFileTimeout reporting", () => {
	it("reports the size, never the content, of a file whose parse stalls", async () => {
		const sent: ErrorReport[] = [];
		installErrorReporter((report) => sent.push(report));
		const parse = withFileTimeout(() => new Promise(() => undefined), 20);
		await expect(parse(new TextEncoder().encode(CORPUS), {})).rejects.toThrow(/timed out/u);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.extra).toMatchObject({ timeoutMs: 20 });
		expect(JSON.stringify(sent[0])).not.toContain(CORPUS);
	});
});

describe("readErrorReportingEnabled", () => {
	async function userDataWith(settings: unknown): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "error-reporting-"));
		directories.push(directory);
		await mkdir(join(directory, "settings"));
		if (settings !== undefined) await writeFile(join(directory, "settings", "settings-state.json"), JSON.stringify({ settings }));
		return directory;
	}

	it("is off when nothing is stored yet", async () => {
		expect(readErrorReportingEnabled(await userDataWith(undefined))).toBe(false);
	});

	it("is off for settings saved before the toggle existed", async () => {
		expect(readErrorReportingEnabled(await userDataWith({ language: "ko" }))).toBe(false);
	});

	it("is on only when the user turned it on", async () => {
		expect(readErrorReportingEnabled(await userDataWith({ errorReporting: true }))).toBe(true);
		expect(readErrorReportingEnabled(await userDataWith({ errorReporting: false }))).toBe(false);
		expect(readErrorReportingEnabled(await userDataWith({ errorReporting: "yes" }))).toBe(false);
	});
});
