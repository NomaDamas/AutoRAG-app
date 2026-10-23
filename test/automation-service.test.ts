import { existsSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	automationsHome,
	cliFailureReason,
	createAutomationService,
	librarianCommand,
	LibrarianCliMissingError,
	type AutomationCliResult,
	type AutomationService,
	type AutomationServiceDeps,
} from "../src/main/automation-service";
import { IDLE_AUTOMATIONS, type AutomationsSnapshot } from "../src/shared/automation-contract";
import { t } from "../src/shared/i18n/core";

const directories: string[] = [];
const POLL_MS = 15;
/** The start suite drives real fs work behind fake timers, so its waits need room under a loaded full-suite run. */
const START_TEST_TIMEOUT_MS = 15_000;
/** The pid the fixture lock claims to belong to. */
const LOCK_PID = 4_242;

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "autorag-automations-"));
	directories.push(dir);
	return dir;
}

/** `text` as a pattern: regex metacharacters stay literal, an interpolated `.*` means "anything". */
function messagePattern(text: string): RegExp {
	const escape = /[$()*+.?[\]^{|}\\]/gu;
	return new RegExp(text.split(".*").map((part) => part.replaceAll(escape, "\\$&")).join(".*"), "u");
}

/** The librarian's files, spelled once: every case writes and asserts against these paths. */
const rulesPath = (dir: string): string => join(dir, "automations.json");
const lockPath = (dir: string): string => join(dir, "automations", "daemon.lock");
const logPath = (dir: string, id: string): string => join(dir, "automations", "logs", `${id}.jsonl`);

async function writeRules(dir: string, entries: readonly unknown[], raw?: string): Promise<string> {
	const path = rulesPath(dir);
	await writeFile(path, raw ?? `${JSON.stringify({ automations: entries }, null, 2)}\n`);
	return path;
}

/** A rule as the librarian's file holds it, with the defaults it fills in already present. */
function rule(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		paths: ["/tmp/watch"],
		events: ["create", "update", "delete"],
		include: ["**"],
		exclude: [],
		run: ["echo", "hi"],
		appendFiles: false,
		debounceMs: 1000,
		timeoutMs: 600_000,
		...extra,
	};
}

/** One line of `automations/logs/<id>.jsonl`, exactly as `runAutomation` writes it. */
function runRecord(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		startedAt: "2026-10-23T10:00:00.000Z",
		durationMs: 12,
		eventCount: 2,
		filesOverflow: false,
		exitCode: 0,
		signal: null,
		timedOut: false,
		stdout: "output\n",
		stderr: "warning\n",
		...extra,
	};
}

function statusOf(input: {
	readonly dir: string;
	readonly automations?: readonly unknown[];
	readonly configError?: string;
	readonly installed?: boolean;
	readonly running?: boolean;
}): Record<string, unknown> {
	return {
		ok: input.configError === undefined,
		service: {
			platform: "darwin",
			id: "com.autorag.automate",
			definitionPath: "/Users/tester/Library/LaunchAgents/com.autorag.automate.plist",
			logPath: join(input.dir, "automations", "daemon.log"),
			installed: input.installed ?? false,
			running: input.running ?? false,
		},
		configPath: rulesPath(input.dir),
		...(input.configError === undefined ? {} : { configError: input.configError }),
		automations: input.automations ?? [],
	};
}

const ok = (payload: unknown): AutomationCliResult => ({ code: 0, stdout: `${JSON.stringify(payload)}\n`, stderr: "" });

/** The rules the file holds, as `autorag automate status` reports them: defaults filled, last run attached. */
function readEntries(dir: string): Record<string, unknown>[] {
	const parsed = JSON.parse(readFileSync(rulesPath(dir), "utf8")) as { automations: Record<string, unknown>[] };
	return parsed.automations.map((entry) => {
		const log = logPath(dir, String(entry.id));
		const lines = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
		const last = lines.at(-1);
		const parsedLog = last === undefined || last.length === 0 ? undefined : (JSON.parse(last) as Record<string, unknown>);
		return { ...rule(String(entry.id)), ...entry, ...(parsedLog === undefined ? {} : { lastRun: parsedLog }) };
	});
}

/** The pid of the daemon holding the lock, when a marker is there. */
function lockPid(dir: string): number | null {
	let names: string[];
	try {
		names = readdirSync(lockPath(dir));
	} catch {
		return null;
	}
	for (const name of names) {
		try {
			const owner = JSON.parse(readFileSync(join(lockPath(dir), name), "utf8")) as { pid?: unknown };
			if (typeof owner.pid === "number") return owner.pid;
		} catch {
			continue;
		}
	}
	return null;
}

interface FakeCli {
	readonly run: (args: readonly string[]) => Promise<AutomationCliResult>;
	readonly calls: readonly string[][];
	/** How many times the expensive `status` ran. */
	statusCalls(): number;
}

/**
 * Stand-in for the librarian CLI: it answers `automate status --json` from the files the test
 * wrote (rules, run logs, daemon lock) and records every call, so the tests can assert both on
 * argv and on how often the app paid for the expensive read.
 */
function fakeCli(dir: string, overrides: { readonly status?: () => AutomationCliResult; readonly pidAlive?: (pid: number) => boolean } = {}): FakeCli {
	const calls: string[][] = [];
	const alive = overrides.pidAlive ?? (() => false);
	let installed = false;
	return {
		calls,
		statusCalls: () => calls.filter((args) => args.join(" ") === "automate status --json").length,
		run: async (args) => {
			calls.push([...args]);
			const line = args.join(" ");
			if (line === "automate install --json") {
				installed = true;
				return ok({ ok: true, action: "install" });
			}
			if (line === "automate uninstall --json") {
				installed = false;
				return ok({ ok: true, action: "uninstall" });
			}
			if (line !== "automate status --json") return { code: 2, stdout: "", stderr: `unexpected arguments: ${line}` };
			if (overrides.status !== undefined) return overrides.status();
			const pid = lockPid(dir);
			return ok(statusOf({ dir, automations: readEntries(dir), installed, running: pid !== null && alive(pid) }));
		},
	};
}

function service(dir: string, cli: FakeCli, overrides: Partial<AutomationServiceDeps> = {}): AutomationService {
	return createAutomationService({ home: () => dir, run: cli.run, pollMs: POLL_MS, ...overrides });
}

/**
 * The daemon's lock on disk plus the probe the service and the fake CLI share. Every
 * `signature()` ends by probing that pid, so `probed()` tells a test that a poll really
 * finished — the fs work behind it happens in real time, which fake timers cannot advance.
 */
function daemonLock(dir: string, alive: () => boolean = () => false): { readonly pidAlive: (pid: number) => boolean; readonly probed: () => number } {
	mkdirSync(lockPath(dir), { recursive: true });
	writeFileSync(join(lockPath(dir), "owner-0b6b3c9a.json"), `${JSON.stringify({ token: "0b6b3c9a", pid: LOCK_PID, createdAt: Date.now() })}\n`);
	let polled = 0;
	return {
		pidAlive: (pid) => {
			polled += 1;
			return pid === LOCK_PID && alive();
		},
		probed: () => polled,
	};
}

/** The first poll only records the baseline, so nothing may change until one has finished. */
async function baselineDone(probed: () => number): Promise<void> {
	await vi.waitFor(() => expect(probed()).toBeGreaterThan(0), { timeout: 10_000 });
}

describe("automationsHome", () => {
	it("resolves a trimmed AUTORAG_HOME and falls back to <home>/.autorag", () => {
		expect(automationsHome({ AUTORAG_HOME: "  /tmp/custom-home \n" }, "/Users/tester")).toBe("/tmp/custom-home");
		expect(automationsHome({ AUTORAG_HOME: "" }, "/Users/tester")).toBe("/Users/tester/.autorag");
		expect(automationsHome({}, "/Users/tester")).toBe("/Users/tester/.autorag");
		expect(automationsHome({ AUTORAG_HOME: "relative/state" }, "/Users/tester")).toBe(join(process.cwd(), "relative/state"));
	});
});

describe("librarianCommand", () => {
	const installedCli = "/Applications/Dazzi.app/Contents/Resources/app/node_modules/@autorag/librarian/dist/cli/index.js";
	const installedEntry = "/Applications/Dazzi.app/Contents/Resources/app/node_modules/@autorag/librarian/dist/index.js";

	it("runs the installed CLI under the bundled node when the installer shipped one", () => {
		const command = librarianCommand({
			resourcesPath: "/Applications/Dazzi.app/Contents/Resources",
			env: {},
			platform: "darwin",
			exists: (path) => path === "/Applications/Dazzi.app/Contents/Resources/tools/node" || path === installedCli,
			resolvePackage: () => installedEntry,
		});
		expect(command).toEqual({ command: "/Applications/Dazzi.app/Contents/Resources/tools/node/bin/node", args: [installedCli] });
	});

	it("honours AUTORAG_TOOLS_DIR and the Windows binary name", () => {
		const toolsRoot = "C:\\dazzi\\tools";
		const windowsCli = join("C:\\app", "node_modules", "@autorag", "librarian", "dist", "cli", "index.js");
		const command = librarianCommand({
			resourcesPath: "/unused",
			env: { AUTORAG_TOOLS_DIR: `  ${toolsRoot}  ` },
			platform: "win32",
			exists: (path) => path === join(toolsRoot, "node") || path === windowsCli,
			resolvePackage: () => join("C:\\app", "node_modules", "@autorag", "librarian", "dist", "index.js"),
		});
		expect(command).toEqual({ command: join(toolsRoot, "node", "node.exe"), args: [windowsCli] });
	});

	it("falls back to the PATH's node, never this process's binary", () => {
		const command = librarianCommand({
			resourcesPath: "/Applications/Dazzi.app/Contents/Resources",
			env: {},
			platform: "darwin",
			exists: (path) => path === installedCli,
			resolvePackage: () => installedEntry,
		});
		expect(command.command).toBe("node");
		expect(command.command).not.toBe(process.execPath);
		expect(command.args).toEqual([installedCli]);
	});

	it("reports a missing librarian instead of spawning something else", () => {
		expect(() =>
			librarianCommand({
				resourcesPath: "/x",
				env: {},
				platform: "darwin",
				exists: () => false,
				resolvePackage: () => installedEntry,
			}),
		).toThrow(LibrarianCliMissingError);
		expect(() =>
			librarianCommand({
				resourcesPath: "/x",
				env: {},
				platform: "darwin",
				exists: () => false,
				resolvePackage: () => {
					throw new Error("Cannot find module '@autorag/librarian'");
				},
			}),
		).toThrow(t("main.automations.errors.cliMissing"));
	});

	it("resolves the CLI of the librarian this app installed", () => {
		const command = librarianCommand({
			resourcesPath: "/nonexistent",
			env: {},
			platform: process.platform,
			exists: (path) => existsSync(path),
		});
		expect(command.args).toHaveLength(1);
		expect(command.args[0]).toMatch(/@autorag[\\/]librarian[\\/]dist[\\/]cli[\\/]index\.js$/u);
	});
});

describe("createAutomationService snapshot", () => {
	it("answers an absent rules file without spawning the CLI, however many reads ask at once", async () => {
		const dir = await home();
		const cli = fakeCli(dir);
		const automations = service(dir, cli);
		const [first, second] = await Promise.all([automations.snapshot(), automations.snapshot()]);

		expect(cli.calls).toEqual([]);
		expect(first).toEqual({ ready: true, rules: [], daemon: null, configPath: rulesPath(dir), configError: null, error: null });
		expect(second).toBe(first);
	});

	it("spawns the CLI as soon as a rules file is there, and reads what it says", async () => {
		const dir = await home();
		await mkdir(join(dir, "automations", "logs"), { recursive: true });
		await writeFile(logPath(dir, "a"), `${JSON.stringify(runRecord("a"))}\n`);
		const cli = fakeCli(dir);
		const automations = service(dir, cli);
		expect((await automations.snapshot()).rules).toEqual([]);
		expect(cli.calls).toEqual([]);

		await writeRules(dir, [rule("a")]);
		const mapped = await automations.snapshot();
		expect(cli.calls).toEqual([["automate", "status", "--json"]]);
		expect(mapped.rules.map((item) => item.id)).toEqual(["a"]);
		expect(mapped.daemon).toEqual({ platform: "darwin", installed: false, running: false });
		expect(mapped.rules[0]?.lastRun?.startedAt).toBe(Date.parse("2026-10-23T10:00:00.000Z"));
	});

	it("reads a rule that runs an AI agent instead of a command", async () => {
		const dir = await home();
		const agentRule: Record<string, unknown> = {
			...rule("triage"),
			agent: { profile: "file-triage", task: "Summarize each new PDF in three lines", retrieval: { searchAll: false, datasources: [] } },
		};
		delete agentRule.run;
		await writeRules(dir, [agentRule, rule("plain")]);
		const cli = fakeCli(dir, { status: () => ok(statusOf({ dir, automations: [agentRule, rule("plain")] })) });
		const rules = (await service(dir, cli).snapshot()).rules;

		expect(rules[0]).toMatchObject({ id: "triage", run: [], agent: { profile: "file-triage", task: "Summarize each new PDF in three lines" } });
		expect(rules[1]?.agent).toBeUndefined();
		expect(rules[1]?.run).toEqual(["echo", "hi"]);
	});

	it("leaves an existing but empty rules file to the librarian", async () => {
		const dir = await home();
		await writeFile(rulesPath(dir), "");
		const cli = fakeCli(dir, { status: () => ({ code: 1, stdout: `${JSON.stringify(statusOf({ dir, configError: "Invalid JSON in automations.json: Unexpected end of JSON input" }))}\n`, stderr: "" }) });
		const snapshot = await service(dir, cli).snapshot();

		expect(cli.statusCalls()).toBe(1);
		expect(snapshot.rules).toEqual([]);
		expect(snapshot.configError).toBe("Invalid JSON in automations.json: Unexpected end of JSON input");
	});

	it("maps the status report onto the contract, dropping the fields the app does not show", async () => {
		const dir = await home();
		await writeRules(dir, [rule("inbox-pdf"), rule("no-run-yet")]);
		const cli = fakeCli(dir, {
			status: () =>
				ok(
					statusOf({
						dir,
						installed: true,
						running: false,
						automations: [
							rule("inbox-pdf", { paths: ["/Users/tester/Downloads"], include: ["*.pdf"], lastRun: runRecord("inbox-pdf") }),
							rule("no-run-yet"),
						],
					}),
				),
		});
		const snapshot = await service(dir, cli).snapshot();

		expect(cli.calls).toEqual([["automate", "status", "--json"]]);
		expect(snapshot).toEqual({
			ready: true,
			configPath: rulesPath(dir),
			configError: null,
			error: null,
			daemon: { platform: "darwin", installed: true, running: false },
			rules: [
				{
					...rule("inbox-pdf", { paths: ["/Users/tester/Downloads"], include: ["*.pdf"] }),
					lastRun: {
						startedAt: Date.parse("2026-10-23T10:00:00.000Z"),
						durationMs: 12,
						eventCount: 2,
						exitCode: 0,
						signal: null,
						timedOut: false,
					},
				},
				{ ...rule("no-run-yet"), lastRun: null },
			],
		});
	});

	it("keeps a run's error and reports a null exit code for a signalled process", async () => {
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		const cli = fakeCli(dir, {
			status: () =>
				ok(
					statusOf({
						dir,
						automations: [rule("a", { lastRun: runRecord("a", { exitCode: null, signal: "SIGKILL", timedOut: true, error: "spawn echo ENOENT" }) })],
					}),
				),
		});
		const [ruleA] = (await service(dir, cli).snapshot()).rules;
		expect(ruleA?.lastRun).toEqual({
			startedAt: Date.parse("2026-10-23T10:00:00.000Z"),
			durationMs: 12,
			eventCount: 2,
			exitCode: null,
			signal: "SIGKILL",
			timedOut: true,
			error: "spawn echo ENOENT",
		});
	});

	it("reports a refused rules file: no rules, the librarian's reason, no read error", async () => {
		const dir = await home();
		await writeRules(dir, [rule("a", { nope: true })]);
		const cli = fakeCli(dir, { status: () => ({ code: 1, stdout: `${JSON.stringify(statusOf({ dir, configError: 'Unknown field "nope" in automations[0]' }))}\n`, stderr: "" }) });
		const snapshot = await service(dir, cli).snapshot();

		expect(snapshot.ready).toBe(true);
		expect(snapshot.rules).toEqual([]);
		expect(snapshot.configError).toBe('Unknown field "nope" in automations[0]');
		expect(snapshot.error).toBeNull();
		expect(snapshot.daemon).toEqual({ platform: "darwin", installed: false, running: false });
	});

	it("keeps the last good list when the CLI stops answering, and says why", async () => {
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		let broken = false;
		const cli = fakeCli(dir, {
			status: () => (broken ? { code: 1, stdout: "", stderr: "boom: the librarian refused to start\n" } : ok(statusOf({ dir, automations: readEntries(dir) }))),
		});
		const automations = service(dir, cli);
		expect((await automations.snapshot()).rules.map((item) => item.id)).toEqual(["a"]);

		broken = true;
		const snapshot = await automations.snapshot();
		expect(snapshot.rules.map((item) => item.id)).toEqual(["a"]);
		expect(snapshot.ready).toBe(true);
		expect(snapshot.error).toBe(t("main.automations.errors.cliFailed", { reason: cliFailureReason({ code: 1, stdout: "", stderr: "boom: the librarian refused to start\n" }) }));

		broken = false;
		expect((await automations.snapshot()).error).toBeNull();
	});

	it("reports a CLI that never ran over the idle snapshot, and a missing CLI as such", async () => {
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		const failing = service(dir, {
			...fakeCli(dir),
			run: async () => {
				throw new Error("spawn node ENOENT");
			},
		});
		const failed = await failing.snapshot();
		expect(failed.rules).toEqual(IDLE_AUTOMATIONS.rules);
		expect(failed.ready).toBe(true);
		expect(failed.error).toBe(t("main.automations.errors.cliFailed", { reason: "spawn node ENOENT" }));

		const missing = service(dir, {
			...fakeCli(dir),
			run: async () => {
				throw new LibrarianCliMissingError();
			},
		});
		expect((await missing.snapshot()).error).toBe(t("main.automations.errors.cliMissing"));
	});

	it("treats noise on stdout as a failure and shares one read between concurrent calls", async () => {
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		const cli = fakeCli(dir, { status: () => ({ code: 0, stdout: "not json at all", stderr: "" }) });
		const automations = service(dir, cli);
		const [first, second, third] = await Promise.all([automations.snapshot(), automations.snapshot(), automations.snapshot()]);
		expect(cli.statusCalls()).toBe(1);
		expect(first.rules).toEqual([]);
		expect(first.error).toBe(t("main.automations.errors.cliFailed", { reason: cliFailureReason({ code: 0, stdout: "not json at all", stderr: "" }) }));
		expect(second).toEqual(first);
		expect(third).toEqual(first);
	});
});

describe("createAutomationService remove", () => {
	it("takes one rule out, keeping every other entry byte for byte", async () => {
		const dir = await home();
		const keep = rule("keep", { futureOption: { nested: [1, 2] }, paths: ["~/Documents"] });
		const alsoKeep = rule("other");
		const drop = rule("drop", { extra: true });
		const file = await writeRules(dir, [drop, keep, alsoKeep]);

		const result = await service(dir, fakeCli(dir)).remove("drop");

		expect(result.removal).toEqual({ entry: drop, index: 0 });
		expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ automations: [keep, alsoKeep] }, null, 2)}\n`);
		expect(result.snapshot.rules.map((item) => item.id)).toEqual(["keep", "other"]);
	});

	it("answers a removal with a read of what it just wrote, not one already in flight", async () => {
		const dir = await home();
		const file = await writeRules(dir, [rule("a"), rule("b")]);
		const cli = fakeCli(dir);
		const gate = Promise.withResolvers<void>();
		const written = Promise.withResolvers<void>();
		// The file itself is the only signal that the removal's write landed; nothing here waits on a duration.
		const watcher = watch(dir, (_event, name) => {
			if (name !== "automations.json") return;
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { automations: unknown[] };
			if (parsed.automations.length === 1) written.resolve();
		});
		let held = false;
		const automations = service(dir, {
			...cli,
			run: async (args) => {
				const result = await cli.run(args);
				if (!held) {
					held = true;
					await gate.promise;
				}
				return result;
			},
		});

		// This read sees both rules and then waits: it must not be the read that answers the removal.
		const rendered = automations.snapshot();
		const removing = automations.remove("a");
		await written.promise;
		gate.resolve();
		const removed = await removing;
		watcher.close();
		expect((await rendered).rules.map((item) => item.id)).toEqual(["a", "b"]);
		expect(removed.snapshot.rules.map((item) => item.id)).toEqual(["b"]);
	});

	it("refuses an unknown id and leaves the file untouched", async () => {
		const dir = await home();
		const file = await writeRules(dir, [rule("a")]);
		const before = await readFile(file, "utf8");

		await expect(service(dir, fakeCli(dir)).remove("ghost")).rejects.toThrow(t("main.automations.errors.unknownRule", { id: "ghost" }));
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("refuses a file it cannot use, and leaves whatever is there byte for byte", async () => {
		const dir = await home();
		const automations = service(dir, fakeCli(dir));
		// The reason differs per failure and is the librarian's or Node's own text, so match the message around it.
		const unreadable = messagePattern(t("main.automations.errors.unreadable", { reason: ".*" }));
		await expect(automations.remove("a")).rejects.toThrow(unreadable);

		const file = await writeRules(dir, [], '{"automations": [');
		await expect(automations.remove("a")).rejects.toThrow(unreadable);
		expect(await readFile(file, "utf8")).toBe('{"automations": [');

		await writeRules(dir, [], '{"rules": []}\n');
		await expect(automations.remove("a")).rejects.toThrow(unreadable);
		expect(await readFile(file, "utf8")).toBe('{"rules": []}\n');
	});
});

describe("createAutomationService restore", () => {
	it("puts the entry back where it was", async () => {
		const dir = await home();
		const file = await writeRules(dir, [rule("a"), rule("c")]);
		const snapshot = await service(dir, fakeCli(dir)).restore({ entry: rule("b"), index: 1 });

		expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ automations: [rule("a"), rule("b"), rule("c")] }, null, 2)}\n`);
		expect(snapshot.rules.map((item) => item.id)).toEqual(["a", "b", "c"]);
	});

	it("clamps an index past the end and recreates a file that vanished", async () => {
		const dir = await home();
		const file = await writeRules(dir, [rule("a")]);
		const automations = service(dir, fakeCli(dir));
		await automations.restore({ entry: rule("z"), index: 99 });
		expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ automations: [rule("a"), rule("z")] }, null, 2)}\n`);

		await rm(file);
		await automations.restore({ entry: rule("fresh"), index: 5 });
		expect(await readFile(file, "utf8")).toBe(`${JSON.stringify({ automations: [rule("fresh")] }, null, 2)}\n`);
	});

	it("refuses a duplicate id and a payload that is not an entry", async () => {
		const dir = await home();
		const file = await writeRules(dir, [rule("a")]);
		const before = await readFile(file, "utf8");
		const automations = service(dir, fakeCli(dir));

		await expect(automations.restore({ entry: rule("a"), index: 0 })).rejects.toThrow(t("main.automations.errors.duplicateRule", { id: "a" }));
		await expect(automations.restore({ entry: [rule("b")] as unknown as Record<string, unknown>, index: 0 })).rejects.toThrow(t("main.automations.errors.invalidRemoval"));
		await expect(automations.restore({ entry: { id: 7 } as unknown as Record<string, unknown>, index: 0 })).rejects.toThrow(t("main.automations.errors.invalidRemoval"));
		expect(await readFile(file, "utf8")).toBe(before);
	});

	it("applies interleaved removals and restores without losing an edit", async () => {
		const dir = await home();
		const entries = [rule("a"), rule("b"), rule("c")];
		const file = await writeRules(dir, entries);
		const automations = service(dir, fakeCli(dir));

		const [removedA, removedB] = await Promise.all([automations.remove("a"), automations.remove("b")]);
		expect(removedA.removal).toEqual({ entry: rule("a"), index: 0 });
		// The second removal sees the file the first one left, so its entry sat at the front of the shorter list.
		expect(removedB.removal).toEqual({ entry: rule("b"), index: 0 });
		expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ automations: [rule("c")] });

		await Promise.all([automations.restore(removedA.removal), automations.restore(removedB.removal)]);
		const restored = JSON.parse(await readFile(file, "utf8")) as { automations: Record<string, unknown>[] };
		const byId = (list: readonly Record<string, unknown>[]): Record<string, unknown>[] => [...list].sort((left, right) => String(left.id).localeCompare(String(right.id)));
		expect(byId(restored.automations)).toEqual(byId(entries));
	});
});

describe("createAutomationService setDaemon", () => {
	it("installs and removes the login service through the CLI", async () => {
		const dir = await home();
		await writeRules(dir, []);
		const cli = fakeCli(dir);
		const automations = service(dir, cli);

		const installed = await automations.setDaemon(true);
		expect(cli.calls[0]).toEqual(["automate", "install", "--json"]);
		expect(installed.daemon).toEqual({ platform: "darwin", installed: true, running: false });
		expect(installed.ready).toBe(true);

		const removed = await automations.setDaemon(false);
		expect(cli.calls.filter((args) => args.join(" ") !== "automate status --json")).toEqual([
			["automate", "install", "--json"],
			["automate", "uninstall", "--json"],
		]);
		expect(removed.daemon).toEqual({ platform: "darwin", installed: false, running: false });
	});

	it("translates a failing install, keeping the beginning of what the CLI said", async () => {
		const dir = await home();
		const stderr = `${"x".repeat(400)}\n`;
		const cli = service(dir, {
			...fakeCli(dir),
			run: async () => ({ code: 3, stdout: "", stderr }),
		});

		const message = t("main.automations.errors.cliFailed", { reason: cliFailureReason({ code: 3, stdout: "", stderr }) });
		await expect(cli.setDaemon(true)).rejects.toThrow(message);
		// The window gets the start of what the CLI said, not all 400 characters of it.
		expect(message).toContain("x".repeat(300));
		expect(message).not.toContain("x".repeat(301));
	});
});

describe("createAutomationService start", () => {
	it("emits once when the rules file changes, and nothing while it does not", async () => {
		vi.useFakeTimers();
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		const lock = daemonLock(dir);
		const cli = fakeCli(dir, { pidAlive: lock.pidAlive });
		const automations = service(dir, cli, { pidAlive: lock.pidAlive });
		const seen: AutomationsSnapshot[] = [];
		const stop = automations.start((snapshot) => seen.push(snapshot));

		// The first poll only establishes the baseline: nothing has changed, and the CLI was never asked.
		await baselineDone(lock.probed);
		expect(seen).toEqual([]);
		expect(cli.statusCalls()).toBe(0);

		await writeRules(dir, [rule("a"), rule("b")]);
		await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10_000 });
		expect(seen[0]?.rules.map((item) => item.id)).toEqual(["a", "b"]);
		expect(cli.statusCalls()).toBe(1);

		// Idle polls keep matching their own signature: no second CLI run, no second push.
		await vi.advanceTimersByTimeAsync(POLL_MS * 10);
		expect(seen).toHaveLength(1);
		expect(cli.statusCalls()).toBe(1);

		stop();
		await writeRules(dir, [rule("a"), rule("b"), rule("c")]);
		await vi.advanceTimersByTimeAsync(POLL_MS * 20);
		expect(seen).toHaveLength(1);
		expect(cli.statusCalls()).toBe(1);
	}, START_TEST_TIMEOUT_MS);

	it("emits when a run log grows", async () => {
		vi.useFakeTimers();
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		await mkdir(join(dir, "automations", "logs"), { recursive: true });
		await writeFile(logPath(dir, "a"), `${JSON.stringify(runRecord("a"))}\n`);
		const lock = daemonLock(dir);
		const automations = service(dir, fakeCli(dir, { pidAlive: lock.pidAlive }), { pidAlive: lock.pidAlive });
		const seen: AutomationsSnapshot[] = [];
		const stop = automations.start((snapshot) => seen.push(snapshot));

		await baselineDone(lock.probed);
		await writeFile(logPath(dir, "a"), `${JSON.stringify(runRecord("a"))}\n${JSON.stringify(runRecord("a", { startedAt: "2026-10-23T11:30:00.000Z", eventCount: 5 }))}\n`);
		await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10_000 });
		stop();

		expect(seen[0]?.rules[0]?.lastRun?.startedAt).toBe(Date.parse("2026-10-23T11:30:00.000Z"));
		expect(seen[0]?.rules[0]?.lastRun?.eventCount).toBe(5);
	}, START_TEST_TIMEOUT_MS);

	it("emits nothing while there is no rules file, then emits when one appears", async () => {
		vi.useFakeTimers();
		const dir = await home();
		const lock = daemonLock(dir);
		const cli = fakeCli(dir, { pidAlive: lock.pidAlive });
		const automations = service(dir, cli, { pidAlive: lock.pidAlive });
		const seen: AutomationsSnapshot[] = [];
		const stop = automations.start((snapshot) => seen.push(snapshot));

		await baselineDone(lock.probed);
		await vi.advanceTimersByTimeAsync(POLL_MS * 6);
		expect(seen).toEqual([]);
		expect(cli.calls).toEqual([]);

		await writeRules(dir, [rule("a")]);
		await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10_000 });
		expect(cli.statusCalls()).toBe(1);
		expect(seen[0]?.rules.map((item) => item.id)).toEqual(["a"]);
		expect(seen[0]?.daemon).toEqual({ platform: "darwin", installed: false, running: false });

		stop();
		await vi.advanceTimersByTimeAsync(POLL_MS * 5);
		expect(seen).toHaveLength(1);
	}, START_TEST_TIMEOUT_MS);

	it("emits when the daemon lock's pid starts and stops being alive", async () => {
		vi.useFakeTimers();
		const dir = await home();
		await writeRules(dir, [rule("a")]);
		let alive = false;
		const lock = daemonLock(dir, () => alive);
		const automations = service(dir, fakeCli(dir, { pidAlive: lock.pidAlive }), { pidAlive: lock.pidAlive });
		const seen: AutomationsSnapshot[] = [];
		const stop = automations.start((snapshot) => seen.push(snapshot));

		await baselineDone(lock.probed);
		expect(seen).toEqual([]);
		expect(lockPid(dir)).toBe(LOCK_PID);

		alive = true;
		await vi.waitFor(() => expect(seen).toHaveLength(1), { timeout: 10_000 });
		expect(seen[0]?.daemon?.running).toBe(true);

		alive = false;
		await vi.waitFor(() => expect(seen).toHaveLength(2), { timeout: 10_000 });
		stop();
		expect(seen[1]?.daemon?.running).toBe(false);
	}, START_TEST_TIMEOUT_MS);
});
