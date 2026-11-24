import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backendIndexUnit, hasBackendProbe, LIVE_QUERY_TEMPLATES, probeBackendIndex } from "../src/main/datasource-index-probe";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A fake `wombat` that prints `doctor --json` and records its argv, so the probe's exact command is asserted. */
async function fakeWombat(doctor: unknown): Promise<{ readonly binary: string; readonly argvLog: string; readonly root: string }> {
	const root = await mkdtemp(join(tmpdir(), "autorag-wombat-probe-"));
	directories.push(root);
	const binary = join(root, "wombat");
	const argvLog = join(root, "argv.log");
	await writeFile(binary, `#!/bin/sh\necho "$@" >> '${argvLog}'\necho '${JSON.stringify(doctor)}'\n`);
	await chmod(binary, 0o755);
	return { binary, argvLog, root };
}

const context = (connector: Record<string, unknown>, root: string) => ({
	id: "wombat",
	connector,
	instanceId: "default",
	workspacePath: root,
});

describe("wombat index probe", () => {
	it("counts sessions through `wombat doctor --json` and is not a live-query source", () => {
		expect(hasBackendProbe("wombat")).toBe(true);
		expect(backendIndexUnit("wombat")).toBe("session");
		expect(LIVE_QUERY_TEMPLATES.has("wombat")).toBe(false);
	});

	it("reads the indexed session count, never running a sync", async () => {
		const { binary, argvLog, root } = await fakeWombat({
			ok: true,
			ready: true,
			version: "0.1.3",
			freshness: { indexed_sessions: 2093, indexed_turns: 62632, minsync_state: "UpToDate" },
		});
		const reading = await probeBackendIndex("wombat", context({}, root), binary, { PATH: root, HOME: root });
		expect(reading).toEqual({ count: 2093, at: null });
		const { readFile } = await import("node:fs/promises");
		expect((await readFile(argvLog, "utf8")).trim()).toBe("doctor --json");
	});

	it("passes the connector's data dir and config as global flags before the subcommand", async () => {
		const { binary, argvLog, root } = await fakeWombat({ freshness: { indexed_sessions: 1, indexed_turns: 2 } });
		await probeBackendIndex("wombat", context({ dataDir: "/data/w", configPath: "/etc/w.toml" }, root), binary, { PATH: root });
		const { readFile } = await import("node:fs/promises");
		expect((await readFile(argvLog, "utf8")).trim()).toBe("--data-dir /data/w --config /etc/w.toml doctor --json");
	});

	it("reports an empty store as zero sessions, and an unreadable answer as unreadable", async () => {
		const empty = await fakeWombat({ freshness: { indexed_sessions: 0, indexed_turns: 0 } });
		expect(await probeBackendIndex("wombat", context({}, empty.root), empty.binary, { PATH: empty.root })).toEqual({ count: 0, at: null });
		const garbage = await fakeWombat({ nothing: true });
		expect(await probeBackendIndex("wombat", context({}, garbage.root), garbage.binary, { PATH: garbage.root })).toBeNull();
	});

	it("forwards wombat's own environment and none of an unrelated secret", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-wombat-probe-env-"));
		directories.push(root);
		const binary = join(root, "wombat");
		await writeFile(binary, `#!/bin/sh\necho "{\\"freshness\\":{\\"indexed_sessions\\":\\"$WOMBAT_DATA_DIR|$AWS_SECRET_ACCESS_KEY|$CODEX_HOME\\"}}"\n`);
		await chmod(binary, 0o755);
		// The count must be numeric, so read the environment through the argv log instead.
		const log = join(root, "env.log");
		await writeFile(binary, `#!/bin/sh\necho "$WOMBAT_DATA_DIR|$AWS_SECRET_ACCESS_KEY|$CODEX_HOME" > '${log}'\necho '{"freshness":{"indexed_sessions":3}}'\n`);
		await probeBackendIndex("wombat", context({}, root), binary, {
			PATH: root,
			WOMBAT_DATA_DIR: "/w",
			AWS_SECRET_ACCESS_KEY: "secret",
			CODEX_HOME: "/codex",
		});
		const { readFile } = await import("node:fs/promises");
		expect((await readFile(log, "utf8")).trim()).toBe("/w||/codex");
	});
});
