import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGuardedBashTool, scrubEnv } from "../src/main/agents/guarded-bash";

let root: string;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "guarded-bash-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function tool(env: NodeJS.ProcessEnv = {}) {
	return createGuardedBashTool({ cwd: root, env });
}

interface BashResult {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
	readonly details: { readonly truncation?: unknown } | undefined;
}
async function runBash(t: ToolDefinition, command: string): Promise<BashResult> {
	const execute = t.execute as (callId: string, params: { command: string }, ...rest: unknown[]) => Promise<BashResult>;
	return execute("call", { command }, undefined, undefined, undefined);
}
const textOf = (result: BashResult): string => result.content.map((block) => block.text).join("");

describe("guarded bash: reading is free", () => {
	it("reads credential files and prints the environment: the assistant is meant to look at other agents' config", async () => {
		await mkdir(join(root, ".codex"), { recursive: true });
		await writeFile(join(root, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-proj-ReadableFixture0123456789"}');
		const result = await runBash(tool(), `cat ${join(root, ".codex", "auth.json")} && env | head -3`);
		expect(textOf(result)).toContain("ReadableFixture");
	});

	it("runs discards to /dev/null", async () => {
		expect(textOf(await runBash(tool(), "which node 2>/dev/null; echo done"))).toContain("done");
	});
});

describe("guarded bash: full read/write since the v2.15 permission simplification", () => {
	it("writes any file the person's task needs, not only a managed config", async () => {
		const target = join(root, "outside", "file.txt");
		await mkdir(join(root, "outside"), { recursive: true });
		await runBash(tool(), `echo x > ${target}`);
		expect(await readFile(target, "utf8")).toBe("x\n");
	});

	it("appends a new environment variable to the shell profile", async () => {
		const profile = join(root, ".zshrc");
		await writeFile(profile, "alias a=b\n");
		await runBash(tool(), `echo 'export OPENAI_API_KEY=abc123' >> ${profile}`);
		expect(await readFile(profile, "utf8")).toBe("alias a=b\nexport OPENAI_API_KEY=abc123\n");
	});

	it("runs rm and other formerly gated commands (no Jev gate refuses them any more)", async () => {
		await mkdir(join(root, "victim"), { recursive: true });
		const res = await runBash(tool(), `rm -rf ${join(root, "victim")}`);
		expect(textOf(res)).not.toMatch(/Refused/u);
	});
});

describe("guarded bash: the spawned process never carries the app's own secrets", () => {
	it("drops every secret-looking variable and keeps the rest", async () => {
		const env = { OPENAI_API_KEY: "sk-live", GITHUB_TOKEN: "ghp_x", PLAIN: "keep" };
		expect(scrubEnv(env)).toEqual({ PLAIN: "keep" });
		const result = await runBash(tool(env), "echo [$OPENAI_API_KEY][$PLAIN]");
		expect(textOf(result)).toContain("[][keep]");
	});
});

describe("guarded bash: output is capped by pi's truncation", () => {
	it("truncates a flood of output", async () => {
		expect((await runBash(tool(), "seq 1 100000")).details?.truncation).toBeDefined();
	});
});
