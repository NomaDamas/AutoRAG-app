import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFileNameSearch,
	escapeSearchRegex,
	everythingRegexQuery,
	type EverythingSearchClient,
	type FileNameRunResult,
	type FileNameSearchRunner,
} from "../src/main/file-name-search";
import type { FsLocation } from "../src/shared/fs-contract";

let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-filename-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function loc(overrides: Partial<FsLocation> & Pick<FsLocation, "name" | "path">): FsLocation {
	return {
		section: "favorites",
		icon: "documents",
		available: true,
		scanned: true,
		ejectable: false,
		...overrides,
	};
}

function jsonLine(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? path;
	return `${JSON.stringify({ path, name, type: "file", size: 1, mtime: 1_700_000_000 })}\n`;
}

interface FsearchFake {
	readonly run: FileNameSearchRunner;
	readonly launch: (command: string, args: readonly string[]) => number | undefined;
	readonly calls: { readonly command: string; readonly args: readonly string[] }[];
	readonly launched: { readonly command: string; readonly args: readonly string[] }[];
	readonly state: {
		binary: boolean;
		db: string | undefined;
		live: boolean;
		searchCode: number;
		searchStdout: string;
	};
}

function freshFsearchFake(): FsearchFake {
	const calls: { command: string; args: readonly string[] }[] = [];
	const launched: { command: string; args: readonly string[] }[] = [];
	const state = { binary: true, db: "/data/fsearch/fsearch.db" as string | undefined, live: false, searchCode: 0, searchStdout: "" };
	const reply = (code: number, stdout = "", stderr = ""): FileNameRunResult => ({ code, stdout, stderr });
	const run: FileNameSearchRunner = async (command, args) => {
		calls.push({ command, args: [...args] });
		if (args[0] === "--version") return reply(state.binary ? 0 : 1, state.binary ? "fsearch-cli 0.3" : "", "not found");
		if (args[0] === "stats") {
			if (state.db === undefined) return reply(1, "", "can't read database");
			return reply(0, JSON.stringify({ db: state.db, live: args.includes("--db") ? state.live : false }));
		}
		if (args[0] === "search") return reply(state.searchCode, state.searchStdout);
		return reply(1);
	};
	const launch = (command: string, args: readonly string[]): number => {
		launched.push({ command, args: [...args] });
		state.live = true; // the daemon serves as soon as it is launched, for the poll
		return 4242;
	};
	return { run, launch, calls, launched, state };
}

function fsearchBackend(fake: FsearchFake) {
	return createFileNameSearch({
		userDataDir: root,
		locations: async () => [loc({ name: "Documents", path: "/data/Documents" })],
		platform: "darwin",
		run: fake.run,
		launch: fake.launch,
		isProcessAlive: (pid) => pid === 4242,
	});
}

describe("escapeSearchRegex", () => {
	it("turns a literal query into an unanchored regex that matches a substring", () => {
		expect(escapeSearchRegex("report.final (v2)")).toBe("report\\.final \\(v2\\)");
	});

	it("builds an Everything regex: query whose spaces survive the search syntax", () => {
		expect(everythingRegexQuery("report.final (v2)")).toBe("regex:report\\.final\\x20\\(v2\\)");
	});
});

describe("fsearch backend", () => {
	it("searches the fsearch-cli default database and returns the matching paths", async () => {
		const fake = freshFsearchFake();
		fake.state.searchStdout = jsonLine("/data/Documents/report-final.txt") + `{"done":true,"num_results":1,"num_returned":1}`;

		const paths = await fsearchBackend(fake).search("report.final");

		expect(paths).toEqual(["/data/Documents/report-final.txt"]);
		const search = fake.calls.find((call) => call.args[0] === "search");
		expect(search?.command).toBe("fsearch-cli");
		expect(search?.args).toEqual([
			"search",
			"--db",
			"/data/fsearch/fsearch.db",
			"--socket",
			"/data/fsearch/fsearch.db.sock",
			"--json",
			"-r",
			"--limit",
			"200",
			"--",
			"report\\.final",
		]);
	});

	it("narrows to the scope subtree and fetches the higher cap the index needs", async () => {
		const fake = freshFsearchFake();
		fake.state.searchStdout =
			jsonLine("/data/Documents/plan-a.txt") +
			jsonLine("/data/Documents/nested/plan-b.txt") +
			jsonLine("/data/Downloads/plan-c.txt") +
			`{"done":true,"num_results":3,"num_returned":3}`;

		const paths = await fsearchBackend(fake).search("plan", "/data/Documents");

		expect(paths).toEqual(["/data/Documents/plan-a.txt", "/data/Documents/nested/plan-b.txt"]);
		const search = fake.calls.find((call) => call.args[0] === "search");
		expect(search?.args).toContain("1000");
	});

	it("answers null when fsearch-cli is not installed", async () => {
		const fake = freshFsearchFake();
		fake.state.binary = false;

		expect(await fsearchBackend(fake).search("plan")).toBeNull();
	});

	it("answers null when no database exists", async () => {
		const fake = freshFsearchFake();
		fake.state.db = undefined;

		expect(await fsearchBackend(fake).search("plan")).toBeNull();
	});

	it("answers null when the search process fails", async () => {
		const fake = freshFsearchFake();
		fake.state.searchCode = 1;

		expect(await fsearchBackend(fake).search("plan")).toBeNull();
	});

	it("starts a watch daemon when the database is not live and records its pid", async () => {
		const fake = freshFsearchFake();
		fake.state.live = false;

		await fsearchBackend(fake).ensureDaemon();

		expect(fake.launched).toEqual([
			{
				command: "fsearch-cli",
				args: ["watch", "--db", "/data/fsearch/fsearch.db", "--socket", "/data/fsearch/fsearch.db.sock", "--quiet"],
			},
		]);
		expect(await readFile(join(root, "fsearch", "watch.pid"), "utf8")).toBe("4242");
	});

	it("adopts a live daemon without launching another", async () => {
		const fake = freshFsearchFake();
		fake.state.live = true;

		await fsearchBackend(fake).ensureDaemon();

		expect(fake.launched).toEqual([]);
	});

	it("adopts a tracked daemon that is still rescanning", async () => {
		const fake = freshFsearchFake();
		fake.state.live = false;
		await mkdir(join(root, "fsearch"), { recursive: true });
		await writeFile(join(root, "fsearch", "watch.pid"), "4242");

		await fsearchBackend(fake).ensureDaemon();

		expect(fake.launched).toEqual([]);
	});

	it("stops the daemon it started and clears the pid file", async () => {
		const fake = freshFsearchFake();
		const killed: number[] = [];
		const backend = createFileNameSearch({
			userDataDir: root,
			locations: async () => [],
			platform: "darwin",
			run: fake.run,
			launch: fake.launch,
			isProcessAlive: (pid) => pid === 4242,
			killProcess: (pid) => killed.push(pid),
		});
		await backend.ensureDaemon();

		await backend.stop();

		expect(killed).toEqual([4242]);
		expect(existsSync(join(root, "fsearch", "watch.pid"))).toBe(false);
	});

	it("never routes through the index on an unsupported platform", async () => {
		const fake = freshFsearchFake();
		const backend = createFileNameSearch({
			userDataDir: root,
			locations: async () => [],
			platform: "freebsd",
			run: fake.run,
			launch: fake.launch,
		});

		expect(await backend.search("plan")).toBeNull();
		await backend.ensureDaemon();
		expect(fake.calls).toEqual([]);
	});
});

interface EverythingFake {
	readonly client: EverythingSearchClient;
	readonly calls: { readonly request: unknown }[];
	readonly indexed: string[];
	readonly roots: { readonly root: string; readonly folders: readonly string[] }[];
}

describe("everything backend", () => {
	function fakeEverything(): EverythingFake {
		const calls: { readonly request: unknown }[] = [];
		const indexed: string[] = [];
		const roots: { readonly root: string; readonly folders: readonly string[] }[] = [];
		const client: EverythingSearchClient = {
			index: async () => {
				indexed.push("index");
				return { ok: true, indexedItems: 3 };
			},
			search: async (request) => {
				calls.push({ request });
				return { ok: true, results: [{ path: "C:\\Users\\me\\Documents\\report.txt" }] };
			},
			stop: async () => {
				indexed.push("stop");
			},
		};
		return { client, calls, indexed, roots };
	}

	function windowsBackend(fake: EverythingFake) {
		return createFileNameSearch({
			userDataDir: root,
			locations: async () => [
				loc({ name: "Documents", path: "C:\\Users\\me\\Documents" }),
				loc({ name: "SSD2", path: "D:\\", section: "locations", icon: "disk", scanned: false, ejectable: true }),
			],
			platform: "win32",
			everythingFactory: (options) => {
				fake.roots.push(options);
				return fake.client;
			},
		});
	}

	it("searches the bundled Everything instance with a literal regex: query", async () => {
		const fake = fakeEverything();
		const paths = await windowsBackend(fake).search("report.final");

		expect(paths).toEqual(["C:\\Users\\me\\Documents\\report.txt"]);
		expect(fake.calls[0]?.request).toMatchObject({ query: "regex:report\\.final", maxResults: 200 });
	});

	it("passes the scope folder to Everything and indexes only scanned locations", async () => {
		const fake = fakeEverything();
		await windowsBackend(fake).search("report", "C:\\Users\\me\\Documents");

		expect(fake.roots[0]).toEqual({ root, folders: ["C:\\Users\\me\\Documents"] });
		expect(fake.calls[0]?.request).toMatchObject({ path: "C:\\Users\\me\\Documents" });
	});

	it("answers null when Everything fails", async () => {
		const fake = fakeEverything();
		fake.client.search = async () => ({ ok: false, reason: "startup-failed", message: "no instance" });

		expect(await windowsBackend(fake).search("report")).toBeNull();
	});

	it("starts the instance at ensureDaemon and stops it on request", async () => {
		const fake = fakeEverything();
		const backend = windowsBackend(fake);

		await backend.ensureDaemon();
		await backend.stop();

		expect(fake.indexed).toEqual(["index", "stop"]);
	});
});
