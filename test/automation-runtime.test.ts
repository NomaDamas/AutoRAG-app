import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentContextAgent } from "../src/main/attachment-context";
import { resolveNodeBinary, runAutomationToolOnNode, runOnNode, startOnNode } from "../src/main/automation-runtime";
import { t } from "../src/shared/i18n/core";

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-automation-runtime-"));
	tempDirs.push(directory);
	return directory;
}

const realExecPath = process.execPath;
const realAutoragHome = process.env.AUTORAG_HOME;

beforeEach(() => {
	process.execPath = realExecPath;
});

afterEach(async () => {
	process.execPath = realExecPath;
	if (realAutoragHome === undefined) delete process.env.AUTORAG_HOME;
	else process.env.AUTORAG_HOME = realAutoragHome;
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("resolveNodeBinary", () => {
	it("prefers the node the installer ships", async () => {
		const tools = await tempDir();
		const bundled = join(tools, "node", "bin", "node");
		await mkdir(join(tools, "node", "bin"), { recursive: true });
		await writeFile(bundled, "");
		await chmod(bundled, 0o755);
		expect(resolveNodeBinary({ resourcesPath: "/unused", env: { AUTORAG_TOOLS_DIR: tools, PATH: "/nowhere" }, platform: "darwin" })).toBe(bundled);
	});

	it.skipIf(process.platform === "win32")("falls back to the first executable node on PATH, as an absolute path", async () => {
		const empty = await tempDir();
		const notRunnable = await tempDir();
		const first = await tempDir();
		const second = await tempDir();
		await writeFile(join(notRunnable, "node"), "");
		await chmod(join(notRunnable, "node"), 0o644);
		for (const directory of [first, second]) {
			await writeFile(join(directory, "node"), "");
			await chmod(join(directory, "node"), 0o755);
		}
		const found = resolveNodeBinary({ resourcesPath: "/unused", env: { PATH: [empty, notRunnable, first, second].join(delimiter) }, platform: "linux" });
		expect(found).toBe(join(first, "node"));
	});

	it("is undefined when there is no node anywhere, never this process's own binary", async () => {
		const empty = await tempDir();
		expect(resolveNodeBinary({ resourcesPath: "/unused", env: { PATH: empty }, platform: "linux" })).toBeUndefined();
	});
});

describe("startOnNode", () => {
	it("holds the path while the call starts and puts the real one back before the work it began is done", async () => {
		let during = "";
		const work = startOnNode("/x/node", () => {
			during = process.execPath;
			return new Promise<void>((resolve) => setTimeout(resolve, 5));
		});
		expect(process.execPath).toBe(realExecPath);
		await work;
		expect(during).toBe("/x/node");
	});

	it("puts the real path back when the call throws", () => {
		expect(() =>
			startOnNode("/x/node", () => {
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(process.execPath).toBe(realExecPath);
	});
});

describe("runOnNode", () => {
	const seen: string[] = [];
	const execute = async (_id: string, params: { readonly action: string }): Promise<string> => {
		seen.push(`${params.action}@${process.execPath}`);
		return params.action;
	};

	beforeEach(() => {
		seen.length = 0;
	});

	it("runs the actions that start a program on node, and nothing else", async () => {
		const wrapped = runOnNode(execute, () => "/x/node");
		for (const action of ["list", "save", "delete", "run", "install_service", "uninstall_service"]) await wrapped("call", { action });
		expect(seen).toEqual([
			`list@${realExecPath}`,
			`save@${realExecPath}`,
			`delete@${realExecPath}`,
			"run@/x/node",
			"install_service@/x/node",
			`uninstall_service@${realExecPath}`,
		]);
	});

	it("refuses to start a program when no node can be found, and still serves the actions that start none", async () => {
		const wrapped = runOnNode(execute, () => undefined);
		await expect(wrapped("call", { action: "run" })).rejects.toThrow(t("main.automations.errors.nodeMissing"));
		await expect(wrapped("call", { action: "install_service" })).rejects.toThrow(t("main.automations.errors.nodeMissing"));
		await expect(wrapped("call", { action: "list" })).resolves.toBe("list");
		await expect(wrapped("call", { action: "uninstall_service" })).resolves.toBe("uninstall_service");
		expect(seen).toEqual([`list@${realExecPath}`, `uninstall_service@${realExecPath}`]);
	});
});

describe("the librarian agent's manage_automations tool", () => {
	async function fixture() {
		const directory = await tempDir();
		const home = join(directory, "autorag-home");
		const watched = join(directory, "watched");
		await mkdir(join(home, "automations", "logs"), { recursive: true });
		await mkdir(watched, { recursive: true });
		const script = join(directory, "rule.js");
		await writeFile(script, "// the rule's program\n");
		// A node stand-in that records how it was started, so the test sees which binary the librarian chose.
		const recorded = join(directory, "argv.txt");
		const fakeNode = join(directory, "fake-node");
		await writeFile(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nexit 0\n`);
		await chmod(fakeNode, 0o755);
		await writeFile(
			join(home, "automations.json"),
			`${JSON.stringify({ automations: [{ id: "node-rule", paths: [watched], events: ["create"], include: ["**/*"], run: ["node", script] }] })}\n`,
		);
		return { directory, home, watched, recorded, fakeNode, script };
	}

	/** One search where the model calls manage_automations once, then answers; returns the tool results it was shown. */
	async function runModelThatCalls(directory: string, home: string, args: Parameters<typeof fauxToolCall>[1], nodePath: string | undefined): Promise<readonly string[]> {
		const corpus = join(directory, "corpus");
		await mkdir(corpus, { recursive: true });
		const minsync = join(directory, "minsync");
		await writeFile(
			minsync,
			`#!/usr/bin/env node\nconst c = process.argv[2];\nconsole.log(JSON.stringify(c === "query" ? { results: [] } : c === "check" ? { vectorstore_ok: true, embedder_ok: true } : c === "sync" ? { files_processed: 0 } : { initialized: true }));\n`,
		);
		await chmod(minsync, 0o755);
		const toolResults: string[] = [];
		const registration = registerFauxProvider({ api: `faux-${randomUUID()}`, models: [{ id: "automations" }] });
		registration.setResponses([
			fauxAssistantMessage("Quick answer."),
			fauxAssistantMessage(fauxToolCall("manage_automations", args)),
			(context: { readonly messages: readonly { readonly role: string; readonly content?: unknown }[] }) => {
				for (const message of context.messages) {
					if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
					for (const block of message.content as { type: string; text?: string }[]) if (block.type === "text" && block.text !== undefined) toolResults.push(block.text);
				}
				return fauxAssistantMessage("Done.", { stopReason: "stop" });
			},
		]);
		// The tool reads the rules home when the agent is built.
		process.env.AUTORAG_HOME = home;
		try {
			const agent = new AttachmentContextAgent({
				model: registration.getModel() as never,
				searchPaths: [corpus],
				workspacePath: directory,
				memoryPath: join(directory, "memory.json"),
				jikji: false,
				minSync: { binaryPath: minsync, autoInstall: false },
				webSearch: false,
				dupey: false,
			});
			runAutomationToolOnNode(agent, () => nodePath);
			await agent.searchDocuments("Test the node-rule automation");
		} finally {
			registration.unregister();
		}
		return toolResults;
	}

	it("tests a rule's command with node, not with the app's own binary", async () => {
		const { directory, home, watched, recorded, fakeNode, script } = await fixture();
		const results = await runModelThatCalls(directory, home, { action: "run", id: "node-rule", events: [{ type: "create", path: join(watched, "a.txt") }] }, fakeNode);

		expect(results.join("\n")).toContain("Ran automation node-rule: ");
		expect((await readFile(recorded, "utf8")).split("\n")[0]).toBe(script);
		expect(process.execPath).toBe(realExecPath);
	});

	it("answers the model with an error and starts nothing when there is no node", async () => {
		const { directory, home, watched, recorded } = await fixture();
		const results = await runModelThatCalls(directory, home, { action: "run", id: "node-rule", events: [{ type: "create", path: join(watched, "a.txt") }] }, undefined);

		expect(results.join("\n")).toContain(t("main.automations.errors.nodeMissing"));
		await expect(readFile(recorded, "utf8")).rejects.toThrow();
	});

	it("lists the rules without needing a node at all", async () => {
		const { directory, home } = await fixture();
		const results = await runModelThatCalls(directory, home, { action: "list" }, undefined);

		expect(results.join("\n")).toContain("node-rule");
	});

	it("refuses an agent it cannot guard, instead of leaving the tool on the app's own binary", () => {
		expect(() => runAutomationToolOnNode({}, () => "/x/node")).toThrow("manage_automations");
	});
});
