import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFileNameSearch,
	escapeSearchRegex,
	everythingRegexQuery,
	fsearchRegexQuery,
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

describe("fsearchRegexQuery", () => {
	const nfc = "보안".normalize("NFC");
	const nfd = "보안".normalize("NFD");

	it("leaves a query with a single Unicode form as the plain escaped substring", () => {
		expect(fsearchRegexQuery("report.final")).toBe("report\\.final");
	});

	it("matches both the composed and the decomposed spelling of Hangul", () => {
		const expected = `(?:${nfc}|${nfd})`;
		expect(fsearchRegexQuery(nfc)).toBe(expected);
		// Typed as separate jamo, the same alternation is sent, so the spelling the user types does not matter.
		expect(fsearchRegexQuery(nfd)).toBe(expected);
	});

	it("escapes regex metacharacters inside each alternative", () => {
		expect(fsearchRegexQuery(`${nfc}(1)`)).toBe(`(?:${nfc}\\(1\\)|${nfd}\\(1\\))`);
	});
});

describe("fsearch backend", () => {
	it("sends the NFC|NFD alternation so a decomposed folder name is found", async () => {
		const fake = freshFsearchFake();
		const decomposed = "/data/Documents/" + "보안".normalize("NFD");
		fake.state.searchStdout = jsonLine(decomposed) + `{"done":true,"num_results":1,"num_returned":1}`;

		const paths = await fsearchBackend(fake).search("보안".normalize("NFC"));

		expect(paths).toEqual([decomposed]);
		const search = fake.calls.find((call) => call.args[0] === "search");
		expect(search?.args.at(-1)).toBe(`(?:${"보안".normalize("NFC")}|${"보안".normalize("NFD")})`);
	});

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

	it("searches AutoRAG's workspace fsearch database when no XDG default database exists", async () => {
		const autoragHome = join(root, "autorag-home");
		const workspace = join(root, "workspace");
		const workspaceDb = join(workspace, ".autorag", "fsearch", "fsearch.db");
		await mkdir(autoragHome, { recursive: true });
		await mkdir(join(workspace, ".autorag", "fsearch"), { recursive: true });
		await writeFile(join(autoragHome, "config.json"), JSON.stringify({ workspacePath: workspace }));
		await writeFile(workspaceDb, "db");
		const calls: { readonly command: string; readonly args: readonly string[] }[] = [];
		const backend = createFileNameSearch({
			userDataDir: join(root, "userData"),
			locations: async () => [],
			platform: "darwin",
			env: { HOME: root, AUTORAG_HOME: autoragHome, XDG_DATA_HOME: join(root, "xdg") },
			run: async (command, args) => {
				calls.push({ command, args: [...args] });
				if (args[0] === "--version") return { code: 0, stdout: "fsearch-cli 0.3", stderr: "" };
				if (args[0] === "stats") {
					if (args.includes(workspaceDb)) {
						return { code: 0, stdout: JSON.stringify({ db: workspaceDb, live: true, files: 12, folders: 3 }), stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "missing default db" };
				}
				if (args[0] === "search") {
					return { code: 0, stdout: jsonLine("/data/Documents/plan.md") + `{"done":true,"num_results":1,"num_returned":1}`, stderr: "" };
				}
				return { code: 1, stdout: "", stderr: "" };
			},
			launch: () => 4242,
		});

		const paths = await backend.search("plan");

		expect(paths).toEqual(["/data/Documents/plan.md"]);
		const search = calls.find((call) => call.args[0] === "search");
		expect(search?.args.slice(0, 4)).toEqual(["search", "--db", workspaceDb, "--socket"]);
		expect(search?.args[4]).toMatch(/^\/tmp\/autorag-fsearch-\d+-[0-9a-f]{12}\.sock$/u);
	});

	it("falls over to AutoRAG's workspace fsearch database when the XDG database is empty, while keeping a populated XDG database", async () => {
		const autoragHome = join(root, "autorag-home");
		const workspace = join(root, "workspace");
		const xdg = join(root, "xdg");
		const xdgDb = join(xdg, "fsearch", "fsearch.db");
		const workspaceDb = join(workspace, ".autorag", "fsearch", "fsearch.db");
		await mkdir(autoragHome, { recursive: true });
		await mkdir(join(xdg, "fsearch"), { recursive: true });
		await mkdir(join(workspace, ".autorag", "fsearch"), { recursive: true });
		await writeFile(join(autoragHome, "config.json"), JSON.stringify({ workspacePath: workspace }));
		await writeFile(xdgDb, "empty");
		await writeFile(workspaceDb, "populated");
		let xdgFiles = 0;
		const searchedDbs: string[] = [];
		const makeBackend = () =>
			createFileNameSearch({
				userDataDir: join(root, "userData"),
				locations: async () => [],
				platform: "darwin",
				env: { HOME: root, AUTORAG_HOME: autoragHome, XDG_DATA_HOME: xdg },
				run: async (_command, args) => {
					if (args[0] === "--version") return { code: 0, stdout: "fsearch-cli 0.3", stderr: "" };
					if (args[0] === "stats") {
						if (args.includes(workspaceDb)) {
							return { code: 0, stdout: JSON.stringify({ db: workspaceDb, live: true, files: 25, folders: 4 }), stderr: "" };
						}
						return { code: 0, stdout: JSON.stringify({ db: xdgDb, live: true, files: xdgFiles, folders: 0 }), stderr: "" };
					}
					if (args[0] === "search") {
						const dbIdx = args.indexOf("--db");
						if (dbIdx >= 0 && typeof args[dbIdx + 1] === "string") searchedDbs.push(args[dbIdx + 1]!);
						return { code: 0, stdout: jsonLine("/data/Documents/plan.md") + `{"done":true,"num_results":1,"num_returned":1}`, stderr: "" };
					}
					return { code: 1, stdout: "", stderr: "" };
				},
				launch: () => 4242,
			});

		await makeBackend().search("plan");
		xdgFiles = 100;
		await makeBackend().search("plan");

		expect(searchedDbs).toEqual([workspaceDb, xdgDb]);
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
