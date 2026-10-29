import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { syncParsedMirrors, createDefaultParserRegistry, loadMirrorIndex, type CliConfig } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { applyAppIndexing, clearDiscoveryCache, readAppIndexing } from "../src/main/app-indexing";
import { DEFAULT_FILE_TIMEOUT_MS, withFileTimeout } from "../src/main/file-timeout";

const directories: string[] = [];

afterEach(async () => {
	clearDiscoveryCache();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const never = (): Promise<never> => new Promise(() => undefined);
const ok = { success: true, markdown: "hello" } as const;

describe("withFileTimeout", () => {
	it("defaults to three minutes", () => {
		expect(DEFAULT_FILE_TIMEOUT_MS).toBe(180_000);
	});

	it("rejects a parse that never settles once the budget is spent", async () => {
		const parse = withFileTimeout(never, 20);

		await expect(parse(new Uint8Array(), {})).rejects.toThrow(/timed out after 20ms/u);
	});

	it("passes a parse that finishes in time through untouched", async () => {
		const parse = withFileTimeout(async () => ok, 1000);

		await expect(parse(new Uint8Array(), {})).resolves.toEqual(ok);
	});

	it("propagates the parser's own failure rather than reporting a timeout", async () => {
		const parse = withFileTimeout(async () => Promise.reject(new Error("boom")), 1000);

		await expect(parse(new Uint8Array(), {})).rejects.toThrow("boom");
	});
});

describe("appIndexing.fileTimeoutMs", () => {
	it("defaults to three minutes and honors an explicit value", () => {
		expect(readAppIndexing({}).fileTimeoutMs).toBe(180_000);
		expect(readAppIndexing({ appIndexing: { fileTimeoutMs: 5000 } }).fileTimeoutMs).toBe(5000);
		expect(readAppIndexing({ appIndexing: { fileTimeoutMs: -1 } }).fileTimeoutMs).toBe(180_000);
	});

	it("makes a stuck file a skip while the rest of the corpus is still indexed", async () => {
		const root = await mkdtemp(join(tmpdir(), "autorag-file-timeout-"));
		directories.push(root);
		const docs = join(root, "docs");
		await mkdir(docs, { recursive: true });
		await mkdir(join(root, "ws"), { recursive: true });
		await writeFile(join(docs, "notes.txt"), "plain notes");
		await writeFile(join(docs, "stuck.pdf"), "%PDF-1.4 never parses");
		await writeFile(join(docs, "fine.pdf"), "%PDF-1.4 parses");
		const config: CliConfig = { searchPaths: [docs], workspacePath: join(root, "ws"), memoryPath: join(root, "m.json") };
		const effective = await applyAppIndexing(config, { appIndexing: { fileTimeoutMs: 50 } });
		expect(typeof (effective.parserOptions?.kordoc as { parse?: unknown }).parse).toBe("function");

		// Stand in for kordoc underneath the wrapper the app installs: hang on one file, parse the other.
		const registry = createDefaultParserRegistry({
			...effective.parserOptions,
			kordoc: {
				parse: withFileTimeout((bytes: Uint8Array) => (new TextDecoder().decode(bytes).includes("never") ? never() : Promise.resolve(ok)), 50),
			},
		});
		const result = await syncParsedMirrors({ root: join(root, "ws"), searchPaths: [docs], registry });

		const index = loadMirrorIndex(join(root, "ws"));
		expect(Object.values(index.entries).map((entry) => basename(entry.sourcePath)).sort()).toEqual(["fine.pdf", "notes.txt"]);
		expect(Object.values(index.skipped ?? {}).map((entry) => [basename(entry.sourcePath), entry.reason])).toEqual([["stuck.pdf", "parser-failed"]]);
		expect(result.skipped).toBe(1);
	});
});
