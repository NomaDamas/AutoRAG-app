import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPARSE_MODEL, seedBundledSparseModel, sparseModelPresent } from "../src/main/bundled-sparse-model";
import { applyBundledTools, pathKey, prependPath } from "../src/main/bundled-tools";

const dirs: string[] = [];
function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "autorag-bundled-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bundled tools on PATH", () => {
	it("puts the bundled bin first and moves an existing entry instead of duplicating it", () => {
		const resources = temp();
		mkdirSync(join(resources, "tools", "bin"), { recursive: true });
		const bin = join(resources, "tools", "bin");
		// Host platform and delimiter: a Windows temp directory contains `:`, so a fixed `:` separator would split it.
		const env: NodeJS.ProcessEnv = { PATH: [join(tmpdir(), "a"), bin, join(tmpdir(), "b")].join(delimiter) };
		expect(applyBundledTools({ resourcesPath: resources, env })).toBe(join(resources, "tools"));
		expect(env.PATH?.split(delimiter)).toEqual([bin, join(tmpdir(), "a"), join(tmpdir(), "b")]);
	});

	it("does nothing when the build carries no tools (development)", () => {
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		expect(applyBundledTools({ resourcesPath: temp(), env })).toBeNull();
		expect(env.PATH).toBe("/usr/bin");
	});

	it("never takes a tools directory from the working directory when there is no resources path (plain Node)", () => {
		const work = temp();
		mkdirSync(join(work, "tools", "bin"), { recursive: true });
		const before = process.cwd();
		process.chdir(work);
		try {
			const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
			expect(applyBundledTools({ resourcesPath: "", env })).toBeNull();
			expect(env.PATH).toBe("/usr/bin");
		} finally {
			process.chdir(before);
		}
	});

	it("uses AUTORAG_TOOLS_DIR as the tools root when there is no resources path", () => {
		const tools = temp();
		mkdirSync(join(tools, "bin"), { recursive: true });
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", AUTORAG_TOOLS_DIR: tools };
		expect(applyBundledTools({ resourcesPath: "", env })).toBe(tools);
		expect(env.PATH?.split(delimiter)[0]).toBe(join(tools, "bin"));
	});

	it("augments a minimal launchd/Finder PATH with standard user and system tool directories when requested", () => {
		const env: NodeJS.ProcessEnv = { HOME: "/Users/test", PATH: "/usr/bin:/bin" };
		applyBundledTools({ resourcesPath: temp(), env, platform: "darwin", augmentUserPaths: true });
		expect(env.PATH?.split(":")).toEqual([
			"/usr/bin",
			"/bin",
			"/Users/test/.cargo/bin",
			"/Users/test/.local/bin",
			"/opt/homebrew/bin",
			"/usr/local/bin",
			"/usr/sbin",
			"/sbin",
		]);
	});

	it("keeps the Windows spelling of the variable and compares entries case-insensitively", () => {
		const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
		expect(pathKey(env, "win32")).toBe("Path");
		const joined = prependPath("C:\\Windows;C:\\TOOLS\\BIN", "c:\\tools\\bin", "win32");
		expect(joined.split(win32.delimiter)).toEqual(["c:\\tools\\bin", "C:\\Windows"]);
	});
});

describe("bundled SPLADE model", () => {
	/** The bundled snapshot, every file at its pinned size (sparse files, so no 299 MB is written). */
	function toolsWithSparseModel(): { readonly resources: string; readonly bundled: string } {
		const resources = temp();
		mkdirSync(join(resources, "tools", "bin"), { recursive: true });
		const bundled = join(resources, "tools", "models", SPARSE_MODEL.repoDir, "snapshots", SPARSE_MODEL.revision);
		for (const file of SPARSE_MODEL.files) {
			mkdirSync(dirname(join(bundled, file.name)), { recursive: true });
			writeFileSync(join(bundled, file.name), file.name);
			truncateSync(join(bundled, file.name), file.bytes);
		}
		return { resources, bundled };
	}

	it("seeds MinSync's model cache from the installer so sparse search needs no download", () => {
		const { resources } = toolsWithSparseModel();
		const home = temp();

		applyBundledTools({ resourcesPath: resources, env: { PATH: "/usr/bin" }, platform: "darwin", home });

		const cache = join(home, ".cache", "minsync", "models");
		expect(sparseModelPresent(cache)).toBe(true);
		expect(readFileSync(join(cache, SPARSE_MODEL.repoDir, "refs", "main"), "utf8")).toBe(SPARSE_MODEL.revision);
		const config = join(cache, SPARSE_MODEL.repoDir, "snapshots", SPARSE_MODEL.revision, "config.json");
		expect(readFileSync(config, "utf8").startsWith("config.json")).toBe(true);
	});

	it("honours FASTEMBED_CACHE_DIR, the cache MinSync itself reads", () => {
		const { resources } = toolsWithSparseModel();
		const custom = temp();

		applyBundledTools({ resourcesPath: resources, env: { PATH: "/usr/bin", FASTEMBED_CACHE_DIR: custom }, platform: "darwin", home: temp() });

		expect(sparseModelPresent(custom)).toBe(true);
	});

	it("leaves a complete cached copy untouched", () => {
		const { resources, bundled } = toolsWithSparseModel();
		const home = temp();
		const cache = join(home, ".cache", "minsync", "models");
		const input = { resourcesPath: resources, env: { PATH: "/usr/bin" }, platform: "darwin" as const, home };
		applyBundledTools(input);
		const tokenizer = join(cache, SPARSE_MODEL.repoDir, "snapshots", SPARSE_MODEL.revision, "tokenizer.json");
		writeFileSync(tokenizer, "kept");
		truncateSync(tokenizer, SPARSE_MODEL.files.find((file) => file.name === "tokenizer.json")?.bytes ?? 0);
		// A different bundled build of the same size must not overwrite what the cache already holds.
		writeFileSync(join(bundled, "tokenizer.json"), "bundled");
		truncateSync(join(bundled, "tokenizer.json"), SPARSE_MODEL.files.find((file) => file.name === "tokenizer.json")?.bytes ?? 0);

		expect(seedBundledSparseModel({ toolsRoot: join(resources, "tools"), home, env: {}, platform: "darwin" })).toBe("present");
		expect(readFileSync(tokenizer, "utf8").startsWith("kept")).toBe(true);
	});

	it("does not mark a cache complete while a file is missing, and finishes it on the next start", () => {
		const { resources } = toolsWithSparseModel();
		const home = temp();
		const cache = join(home, ".cache", "minsync", "models");
		const input = { resourcesPath: resources, env: { PATH: "/usr/bin" }, platform: "darwin" as const, home };
		applyBundledTools(input);
		rmSync(join(cache, SPARSE_MODEL.repoDir, "snapshots", SPARSE_MODEL.revision, "model.safetensors"));
		expect(sparseModelPresent(cache)).toBe(false);

		expect(seedBundledSparseModel({ toolsRoot: join(resources, "tools"), home, env: {}, platform: "darwin" })).toBe("seeded");
		expect(sparseModelPresent(cache)).toBe(true);
	});

	it("does nothing when the build carries no model, so MinSync downloads it itself", () => {
		const resources = temp();
		mkdirSync(join(resources, "tools", "bin"), { recursive: true });
		const home = temp();

		expect(seedBundledSparseModel({ toolsRoot: join(resources, "tools"), home, env: {}, platform: "darwin" })).toBe("not-bundled");
		expect(existsSync(join(home, ".cache", "minsync"))).toBe(false);
	});
});
