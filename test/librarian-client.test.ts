import { MessageChannel } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import type { DupeyScanResult } from "@autorag/librarian";
import { createLibrarianClient, type LibrarianClient } from "../src/fs-worker/librarian-client";
import type { LibrarianThread } from "../src/fs-worker/librarian-contract";
import { serveLibrarian, type LibrarianServices } from "../src/fs-worker/librarian-serve";
import { adaptNodePort } from "../src/fs-worker/thread-port";
import { installErrorReporter, reportError, type ErrorReport } from "../src/main/error-report-core";
import type { FsLocation } from "../src/shared/fs-contract";
import { t } from "../src/shared/i18n/core";
import type { IndexStatus } from "../src/shared/index-contract";

const SCAN: DupeyScanResult = { dir: "/d", files: [], families: [], errors: [] };
const STATUS: IndexStatus = { path: "/d/a.txt", kind: "included", excluded: false, toggleable: true, detail: "ok" };
const LOCATION: FsLocation = { name: "Documents", path: "/d", section: "favorites", icon: "documents", available: true, scanned: true, ejectable: false };

interface Calls {
	search: [string, string | undefined][];
	ensure: number;
	stop: number;
	scanned: string[];
	shutdowns: number;
	excluded: [string, boolean][];
	locationsSeen: (readonly FsLocation[])[];
}

/** Services that record what the thread was asked, and can be told to fail. */
function stubServices(calls: Calls, host: { locations(): Promise<readonly FsLocation[]>; indexRefreshed(error: string | null): void }, fail: { search?: Error } = {}): LibrarianServices {
	return {
		fileNameSearch: {
			search: async (query, scope) => {
				calls.search.push([query, scope]);
				calls.locationsSeen.push(await host.locations());
				if (fail.search !== undefined) throw fail.search;
				return query === "none" ? null : [`/d/${query}.txt`];
			},
			ensureDaemon: async () => {
				calls.ensure += 1;
			},
			stop: async () => {
				calls.stop += 1;
			},
		},
		scanDuplicates: async (dir) => {
			calls.scanned.push(dir);
			return { ...SCAN, dir };
		},
		indexStatus: {
			indexStatus: async (paths) => paths.map((path) => ({ ...STATUS, path })),
			setIndexExcluded: async (path, excluded) => {
				calls.excluded.push([path, excluded]);
				host.indexRefreshed(excluded ? "refresh failed" : null);
				return { ...STATUS, path, excluded };
			},
		},
	};
}

interface Harness {
	readonly client: LibrarianClient;
	readonly calls: Calls;
	readonly spawned: () => number;
	readonly terminated: () => number;
	/** End the running thread the way a crash does. */
	crash(code: number): void;
	readonly refreshed: (string | null)[];
	readonly reports: ErrorReport[];
}

const closers: (() => void)[] = [];

function harness(options: { fail?: { search?: Error }; hang?: boolean; shutdownMs?: number } = {}): Harness {
	const calls: Calls = { search: [], ensure: 0, stop: 0, scanned: [], shutdowns: 0, excluded: [], locationsSeen: [] };
	const refreshed: (string | null)[] = [];
	const reports: ErrorReport[] = [];
	let spawned = 0;
	let terminated = 0;
	let exit: ((code: number | null, error: Error | null) => void) | null = null;
	const client = createLibrarianClient({
		spawn: (): LibrarianThread => {
			spawned += 1;
			const { port1, port2 } = new MessageChannel();
			if (options.hang !== true) serveLibrarian(adaptNodePort(port2), {
					services: (host) => stubServices(calls, host, options.fail),
					onShutdown: () => {
						calls.shutdowns += 1;
					},
				});
			closers.push(() => {
				port1.close();
				port2.close();
			});
			return {
				port: adaptNodePort(port1),
				onExit: (listener) => {
					exit = listener;
				},
				terminate: async () => {
					terminated += 1;
					port1.close();
				},
			};
		},
		locations: async () => [LOCATION],
		onIndexRefreshed: (error) => refreshed.push(error),
		onReport: (report) => reports.push(report),
		...(options.shutdownMs === undefined ? {} : { shutdownMs: options.shutdownMs }),
	});
	return { client, calls, spawned: () => spawned, terminated: () => terminated, crash: (code) => exit?.(code, null), refreshed, reports };
}

afterEach(() => {
	installErrorReporter(null);
	for (const close of closers.splice(0)) close();
});

describe("createLibrarianClient", () => {
	it("starts no thread until the first call needs one, then reuses it", async () => {
		const h = harness();
		expect(h.spawned()).toBe(0);

		await h.client.fileNameSearch.search("a");
		await h.client.scanDuplicates("/d");
		await h.client.indexStatus.indexStatus(["/d/a.txt"]);

		expect(h.spawned()).toBe(1);
	});

	it("searches the file-name index through the thread, with the scope", async () => {
		const h = harness();

		expect(await h.client.fileNameSearch.search("report", "/d")).toEqual(["/d/report.txt"]);
		expect(await h.client.fileNameSearch.search("none")).toBeNull();
		expect(h.calls.search).toEqual([["report", "/d"], ["none", undefined]]);
	});

	it("lets the thread ask the worker for the sidebar locations", async () => {
		const h = harness();

		await h.client.fileNameSearch.search("a");

		expect(h.calls.locationsSeen).toEqual([[LOCATION]]);
	});

	it("rejects with the thread's own error so the caller can fall back to a disk walk", async () => {
		const h = harness({ fail: { search: new Error("Everything is not running") } });

		await expect(h.client.fileNameSearch.search("a")).rejects.toThrow("Everything is not running");
	});

	it("warms and stops the daemon through the thread, and never throws from either", async () => {
		const h = harness();

		await h.client.fileNameSearch.ensureDaemon();
		await h.client.fileNameSearch.stop();

		expect(h.calls.ensure).toBe(1);
		expect(h.calls.stop).toBe(1);
	});

	it("scans for duplicates and reports index status through the thread", async () => {
		const h = harness();

		expect((await h.client.scanDuplicates("/photos")).dir).toBe("/photos");
		expect(await h.client.indexStatus.indexStatus(["/d/a.txt", "/d/b.txt"])).toEqual([
			{ ...STATUS, path: "/d/a.txt" },
			{ ...STATUS, path: "/d/b.txt" },
		]);
		expect(h.calls.scanned).toEqual(["/photos"]);
	});

	it("passes an exclusion toggle through and delivers the refresh outcome the thread pushes", async () => {
		const h = harness();

		const status = await h.client.indexStatus.setIndexExcluded("/d/a.txt", true);
		await h.client.indexStatus.setIndexExcluded("/d/a.txt", false);
		await expect.poll(() => h.refreshed).toEqual(["refresh failed", null]);

		expect(status.excluded).toBe(true);
		expect(h.calls.excluded).toEqual([["/d/a.txt", true], ["/d/a.txt", false]]);
	});

	it("forwards the thread's error reports to the worker's reporter", async () => {
		const h = harness();
		await h.client.scanDuplicates("/d");
		// The thread side installs its own reporter; here the report is raised in this process, which is the thread's.
		const report: ErrorReport = { title: "refresh failed", fingerprint: ["refresh"], tags: {}, extra: { count: 1 } };
		reportError(report);
		await expect.poll(() => h.reports).toEqual([report]);
	});

	it("fails the calls in flight when the thread dies, then starts a fresh one for the next call", async () => {
		// Given a thread that never answers
		const h = harness({ hang: true });
		const waiting = h.client.scanDuplicates("/d");
		expect(h.spawned()).toBe(1);

		// When it crashes
		h.crash(7);

		// Then the call fails with the exit code, and the next call gets a new thread
		await expect(waiting).rejects.toThrow(t("main.worker.librarianExited", { code: 7 }));
		const next = h.client.scanDuplicates("/e").catch(() => undefined);
		expect(h.spawned()).toBe(2);
		h.crash(1);
		await next;
	});

	it("keeps the interface language across a restart", async () => {
		const languages: string[] = [];
		let spawned = 0;
		const client = createLibrarianClient({
			spawn: (): LibrarianThread => {
				spawned += 1;
				const { port1, port2 } = new MessageChannel();
				port2.on("message", (message: { id?: number; op?: string; args?: unknown[] }) => {
					if (message.op === "setLanguage") languages.push(String(message.args?.[0]));
					if (message.id !== undefined) port2.postMessage({ id: message.id, ok: true, value: null });
				});
				closers.push(() => {
					port1.close();
					port2.close();
				});
				return { port: adaptNodePort(port1), onExit: () => {}, terminate: async () => port1.close() };
			},
			locations: async () => [],
			onIndexRefreshed: () => {},
			onReport: () => {},
		});

		// When the language is set before any thread runs, and again after the first thread started
		await client.setLanguage("ja");
		await client.scanDuplicates("/d");
		await client.setLanguage("en");
		await expect.poll(() => languages).toEqual(["ja", "en"]);
		expect(spawned).toBe(1);
	});

	it("stops the daemon, lets the librarian clean up, and ends the thread on dispose, then refuses calls", async () => {
		const h = harness();
		await h.client.fileNameSearch.ensureDaemon();

		await h.client.dispose();

		expect(h.calls.stop).toBe(1);
		expect(h.calls.shutdowns).toBe(1);
		expect(h.terminated()).toBe(1);
		await expect(h.client.scanDuplicates("/d")).rejects.toThrow();
		expect(h.spawned()).toBe(1);
	});

	it("ends a thread that does not answer the shutdown within the bound", async () => {
		const h = harness({ hang: true, shutdownMs: 30 });
		void h.client.scanDuplicates("/d").catch(() => undefined);

		await h.client.dispose();

		expect(h.terminated()).toBe(1);
	});

	it("stops the file-name index on request without ending the thread", async () => {
		const h = harness();
		await h.client.fileNameSearch.ensureDaemon();

		await h.client.fileNameSearch.stop();

		expect(h.calls.stop).toBe(1);
		expect(h.terminated()).toBe(0);
	});

	it("does not start a thread just to shut down", async () => {
		const h = harness();

		await h.client.fileNameSearch.stop();
		await h.client.dispose();

		expect(h.spawned()).toBe(0);
		expect(h.terminated()).toBe(0);
	});
});
