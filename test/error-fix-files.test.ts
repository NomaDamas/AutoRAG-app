import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFixTools, type FixTools } from "../src/main/agents/profiles/error-fix-files";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import type { ErrorFixChange } from "../src/shared/error-fix-contract";

let root: string;
let agentDir: string;
let configPath: string;
let changes: ErrorFixChange[];
let cancelled: boolean;
let patched: number;
let commands: string[];

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readConfig(): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(configPath, "utf8"));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "fix-files-"));
	agentDir = join(root, "agent");
	configPath = join(root, "config.json");
	changes = [];
	cancelled = false;
	patched = 0;
	commands = [];
	await mkdir(agentDir, { recursive: true });
	await mkdir(join(root, "Docs"), { recursive: true });
	await mkdir(join(root, "Documents"), { recursive: true });
	await writeFile(join(root, "Documents", "a.md"), "alpha");
	await writeFile(join(root, "note.txt"), "my own note");
	await writeFile(join(agentDir, "auth.json"), '{"dazzi":{"access":"AGENT-SECRET"}}');
	await writeConfig({
		searchPaths: [join(root, "Docs")],
		workspacePath: join(root, "ws"),
		memoryPath: join(root, "memory.json"),
		model: { provider: "dazzi", id: "deepseek" },
		datasources: { demo: { connector: { token: "s3cret-value", dataDir: join(root, "missing"), configPath: join(root, "demo.json") } } },
	});
	await writeFile(join(root, "demo.json"), '{"folder":"old"}\n');
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function tools(env: NodeJS.ProcessEnv = {}): FixTools {
	const service = createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root });
	return createFixTools({
		cwd: root,
		agentDir,
		env,
		config: {
			get: () => service.get(),
			patch: async (updates) => {
				patched += 1;
				return service.patch(updates);
			},
		},
		now: () => new Date("2026-10-26T10:11:12Z"),
		cancelled: () => cancelled,
		onChange: (change) => changes.push(change),
		onCommand: (command) => commands.push(command),
	});
}

/** Runs one tool the way the agent would; a refusal comes back as the error text. */
async function call(kit: FixTools, name: string, params: object): Promise<string> {
	const tool = kit.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	try {
		const result = await tool.execute("call", params as never, undefined, undefined, undefined as never);
		return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	} catch (error) {
		return `ERROR ${error instanceof Error ? error.message : String(error)}`;
	}
}

const BACKUP = (): string => `${configPath}.bak-20261026101112-before-error-fix`;

describe("the fix agent's pi tools", () => {
	it("are pi's own read, ls, find, grep, edit, write and bash", () => {
		expect(tools().tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	});
});

describe("reading the config", () => {
	it("shows the config file without its secrets: the person's keys never reach the model", async () => {
		const text = await call(tools(), "read", { path: configPath });

		expect(text).not.toContain("s3cret-value");
		expect(text).toContain(join(root, "Docs"));
		expect(text).toContain("__AUTORAG_SECRET_REDACTED__");
	});

	it("masks the secrets of a config that is not valid JSON, so it can still be looked at", async () => {
		await writeFile(configPath, `{ "searchPaths": ["/x"], "datasources": { "a": { "connector": { "token": "s3cret-value", } } }`);

		const text = await call(tools(), "read", { path: configPath });

		expect(text).not.toContain("s3cret-value");
		expect(text).toContain("searchPaths");
	});
});

describe("changing the config with edit and write", () => {
	it("repoints a folder through the validating service, keeps a copy first and records before and after", async () => {
		const kit = tools();

		const text = await call(kit, "edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] });

		expect(text).not.toMatch(/^ERROR/u);
		expect((await readConfig()).searchPaths).toEqual([join(root, "Documents")]);
		expect(JSON.parse(await readFile(BACKUP(), "utf8")).searchPaths).toEqual([join(root, "Docs")]);
		expect(changes).toEqual([{ path: "searchPaths", before: JSON.stringify([join(root, "Docs")]), after: JSON.stringify([join(root, "Documents")]) }]);
		expect(kit.backupPath()).toBe(BACKUP());
	});

	it("leaves the secrets in the file as they were when another key changes", async () => {
		await call(tools(), "edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] });

		expect(JSON.stringify(await readConfig())).toContain("s3cret-value");
	});

	it("takes a whole new config through write the same way: only what differs is changed", async () => {
		const view = JSON.parse(await call(tools(), "read", { path: configPath }));
		view.searchPaths = [join(root, "Documents")];
		view.excludeExactDuplicates = false;

		const text = await call(tools(), "write", { path: configPath, content: JSON.stringify(view) });

		expect(text).not.toMatch(/^ERROR/u);
		expect(await readConfig()).toMatchObject({ searchPaths: [join(root, "Documents")], excludeExactDuplicates: false, datasources: { demo: { connector: { token: "s3cret-value" } } } });
		expect(changes.map((change) => change.path).sort()).toEqual(["excludeExactDuplicates", "searchPaths"]);
	});

	it("takes the backup once per run, however many changes follow", async () => {
		const kit = tools();
		await call(kit, "edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] });
		await call(kit, "write", { path: configPath, content: JSON.stringify({ ...JSON.parse(await call(kit, "read", { path: configPath })), excludeExactDuplicates: false }) });

		expect((await readdir(root)).filter((name) => name.includes(".bak-"))).toEqual([`config.json.bak-20261026101112-before-error-fix`]);
		expect(JSON.parse(await readFile(BACKUP(), "utf8")).searchPaths).toEqual([join(root, "Docs")]);
	});

	it("refuses to change the AI model, which is the person's choice, and writes nothing", async () => {
		const view = JSON.parse(await call(tools(), "read", { path: configPath }));
		view.model = { provider: "other", id: "x" };

		const text = await call(tools(), "write", { path: configPath, content: JSON.stringify(view) });

		expect(text).toMatch(/^ERROR.*model/su);
		expect((await readConfig()).model).toEqual({ provider: "dazzi", id: "deepseek" });
		expect(patched).toBe(0);
	});

	it("refuses to set or remove a key, token or other secret", async () => {
		const withToken = JSON.parse(await call(tools(), "read", { path: configPath }));
		withToken.datasources.demo.connector.token = "new-plaintext";
		const withoutToken = JSON.parse(await call(tools(), "read", { path: configPath }));
		delete withoutToken.datasources.demo.connector.token;

		expect(await call(tools(), "write", { path: configPath, content: JSON.stringify(withToken) })).toMatch(/^ERROR.*secret/su);
		expect(await call(tools(), "write", { path: configPath, content: JSON.stringify(withoutToken) })).toMatch(/^ERROR.*secret/su);
		expect(JSON.stringify(await readConfig())).toContain("s3cret-value");
	});

	it("refuses the folders AutoRAG manages itself", async () => {
		const view = JSON.parse(await call(tools(), "read", { path: configPath }));
		view.workspacePath = "/tmp/elsewhere";

		expect(await call(tools(), "write", { path: configPath, content: JSON.stringify(view) })).toMatch(/^ERROR/u);
		expect((await readConfig()).workspacePath).toBe(join(root, "ws"));
	});

	it("hands the validator's complaint back and leaves the file and the backup alone", async () => {
		const view = JSON.parse(await call(tools(), "read", { path: configPath }));
		view.searchPaths = 5;

		const text = await call(tools(), "write", { path: configPath, content: JSON.stringify(view) });

		expect(text).toMatch(/^ERROR/u);
		expect((await readConfig()).searchPaths).toEqual([join(root, "Docs")]);
		expect((await readdir(root)).filter((name) => name.includes(".bak-"))).toEqual([]);
		expect(changes).toEqual([]);
	});

	it("refuses a config that is not a JSON object", async () => {
		expect(await call(tools(), "write", { path: configPath, content: "[1,2]" })).toMatch(/^ERROR/u);
		expect(await call(tools(), "write", { path: configPath, content: "not json" })).toMatch(/^ERROR/u);
		expect((await readConfig()).searchPaths).toEqual([join(root, "Docs")]);
	});

	it("does not rewrite a config that is not valid JSON: its secrets are masked in what the agent saw, so a write would destroy them", async () => {
		await writeFile(configPath, `{ "searchPaths": ["/x"], "token": "s3cret-value", }`);

		const text = await call(tools(), "write", { path: configPath, content: '{"searchPaths":["/y"]}' });

		expect(text).toMatch(/^ERROR.*(?:valid|restore|shell)/su);
		expect(await readFile(configPath, "utf8")).toContain("s3cret-value");
	});

	it("counts nothing as a change when the file comes out the same", async () => {
		const view = await call(tools(), "read", { path: configPath });

		await call(tools(), "write", { path: configPath, content: view });

		expect(changes).toEqual([]);
		expect(patched).toBe(0);
	});
});

describe("files other than the config", () => {
	it("lets the agent repair the config file of a data source that the config names, after a copy", async () => {
		const target = join(root, "demo.json");

		const text = await call(tools(), "write", { path: target, content: '{"folder":"new"}\n' });

		expect(text).not.toMatch(/^ERROR/u);
		expect(await readFile(target, "utf8")).toBe('{"folder":"new"}\n');
		expect(await readFile(`${target}.bak-20261026101112-before-error-fix`, "utf8")).toBe('{"folder":"old"}\n');
		expect(changes).toEqual([{ path: target, before: "17 bytes", after: "17 bytes", backup: `${target}.bak-20261026101112-before-error-fix` }]);
	});

	it("edits such a file in place too", async () => {
		const target = join(root, "demo.json");

		await call(tools(), "edit", { path: target, edits: [{ oldText: '"old"', newText: '"new"' }] });

		expect(await readFile(target, "utf8")).toBe('{"folder":"new"}\n');
	});

	it("refuses to write anywhere else: the person's own documents are not the agent's to change", async () => {
		const kit = tools();

		expect(await call(kit, "write", { path: join(root, "note.txt"), content: "x" })).toMatch(/^ERROR/u);
		expect(await call(kit, "edit", { path: join(root, "note.txt"), edits: [{ oldText: "own", newText: "other" }] })).toMatch(/^ERROR/u);
		expect(await call(kit, "write", { path: join(root, "Documents", "new.md"), content: "x" })).toMatch(/^ERROR/u);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("my own note");
		expect(changes).toEqual([]);
	});

	it("does not let a link out of the allowed places lead the write somewhere else", async () => {
		await symlink(join(root, "note.txt"), join(root, "link.json"));
		await writeConfig({ ...(await readConfig()), datasources: { demo: { connector: { configPath: join(root, "link.json") } } } });

		expect(await call(tools(), "write", { path: join(root, "link.json"), content: "x" })).toMatch(/^ERROR/u);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("my own note");
	});

	it("resolves a relative path against the working folder, and applies the same rules to it", async () => {
		expect(await call(tools(), "write", { path: "note.txt", content: "x" })).toMatch(/^ERROR/u);
		expect(await readFile(join(root, "note.txt"), "utf8")).toBe("my own note");
	});
});

describe("what the agent may look at", () => {
	it("can read, list and search the person's folders to find where a folder went", async () => {
		const kit = tools();

		expect(await call(kit, "ls", { path: root })).toContain("Documents");
		expect(await call(kit, "read", { path: join(root, "Documents", "a.md") })).toContain("alpha");
		expect(await call(kit, "grep", { pattern: "alpha", path: join(root, "Documents") })).toContain("a.md");
	});

	it("never opens the AI's own sign-in and key files, with any file tool", async () => {
		const kit = tools();
		const auth = join(agentDir, "auth.json");

		expect(await call(kit, "read", { path: auth })).toMatch(/^ERROR/u);
		expect(await call(kit, "grep", { pattern: "AGENT-SECRET", path: agentDir })).toMatch(/^ERROR/u);
		expect(await call(kit, "ls", { path: agentDir })).toMatch(/^ERROR/u);
		expect(await call(kit, "write", { path: auth, content: "{}" })).toMatch(/^ERROR/u);
		expect(await readFile(auth, "utf8")).toContain("AGENT-SECRET");
	});

	it("never opens a file that is named like a key, a token or a credential", async () => {
		await writeFile(join(root, ".env"), "API_KEY=abc");
		await writeFile(join(root, "id_ed25519"), "private");
		await writeFile(join(root, "server.pem"), "private");

		for (const name of [".env", "id_ed25519", "server.pem"]) expect(await call(tools(), "read", { path: join(root, name) }), name).toMatch(/^ERROR/u);
	});
});

describe("the shell", () => {
	it("runs a command and returns its output", async () => {
		expect(await call(tools(), "bash", { command: "echo shell-works" })).toContain("shell-works");
		expect(commands).toEqual(["echo shell-works"]);
	});

	it("does not hand the agent the app's keys and tokens in its environment", async () => {
		const kit = tools({ ...process.env, DAZZI_TEST_API_KEY: "env-secret", DAZZI_TEST_VISIBLE: "plain" });

		const text = await call(kit, "bash", { command: 'echo "key=[$DAZZI_TEST_API_KEY] visible=[$DAZZI_TEST_VISIBLE]"' });

		expect(text).toContain("key=[]");
		expect(text).toContain("visible=[plain]");
	});
});

describe("no limit on how much the agent looks", () => {
	it("lets the agent read, list, find, search and run commands as often as it needs", async () => {
		const kit = tools();

		for (let index = 0; index < 60; index += 1) {
			const name = ["read", "ls", "find", "grep", "bash"][index % 5] as string;
			const params = name === "read" ? { path: join(root, "note.txt") } : name === "ls" ? { path: root } : name === "find" ? { pattern: "*.md", path: root } : name === "grep" ? { pattern: "alpha", path: root } : { command: "true" };
			expect(await call(kit, name, params), `${name} #${index}`).not.toMatch(/^ERROR/u);
		}
		expect(commands).toHaveLength(12);
	});

	it("still allows a repair after any number of looks", async () => {
		const kit = tools();
		for (let index = 0; index < 60; index += 1) await call(kit, "ls", { path: root });

		const text = await call(kit, "edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] });

		expect(text).not.toMatch(/^ERROR/u);
		expect((await readConfig()).searchPaths).toEqual([join(root, "Documents")]);
	});
});

describe("a stopped run", () => {
	it("refuses every tool, so a late call changes nothing", async () => {
		const kit = tools();
		cancelled = true;

		for (const [name, params] of [
			["read", { path: join(root, "note.txt") }],
			["ls", { path: root }],
			["grep", { pattern: "x", path: root }],
			["write", { path: join(root, "demo.json"), content: "x" }],
			["edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] }],
			["bash", { command: "echo hi > cancelled.txt" }],
		] as const) {
			expect(await call(kit, name, params), name).toMatch(/^ERROR.*cancel/su);
		}
		expect((await readConfig()).searchPaths).toEqual([join(root, "Docs")]);
		expect(await readFile(join(root, "demo.json"), "utf8")).toBe('{"folder":"old"}\n');
	});
});
