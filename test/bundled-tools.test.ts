import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBundledTools, pathKey, prependPath } from "../src/main/bundled-tools";
import { readSeedManifest, seedAssets } from "../src/main/seed-assets";

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

	it("keeps the Windows spelling of the variable and compares entries case-insensitively", () => {
		const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };
		expect(pathKey(env, "win32")).toBe("Path");
		const joined = prependPath("C:\\Windows;C:\\TOOLS\\BIN", "c:\\tools\\bin", "win32");
		expect(joined.split(win32.delimiter)).toEqual(["c:\\tools\\bin", "C:\\Windows"]);
	});
});

describe("seeding the embedding model", () => {
	const content = Buffer.from("not really a gguf");
	const sha256 = createHash("sha256").update(content).digest("hex");

	function seedDir(overrides: Record<string, unknown> = {}): string {
		const dir = temp();
		mkdirSync(join(dir, "models"), { recursive: true });
		writeFileSync(join(dir, "models", "m.gguf"), content);
		const file = { path: "models/m.gguf", destination: "models/m.gguf", sha256, bytes: content.length, ...overrides };
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, files: [file] }));
		return dir;
	}

	it("copies the shipped file into the AutoRAG home", async () => {
		const home = temp();
		const outcome = await seedAssets({ seedDir: seedDir(), autoragHome: home });
		expect(outcome).toEqual({ kind: "done", copied: ["models/m.gguf"], present: [] });
		expect(readFileSync(join(home, "models", "m.gguf"))).toEqual(content);
	});

	it("never overwrites a model the user already has", async () => {
		const home = temp();
		mkdirSync(join(home, "models"), { recursive: true });
		writeFileSync(join(home, "models", "m.gguf"), "mine");
		const outcome = await seedAssets({ seedDir: seedDir(), autoragHome: home });
		expect(outcome).toEqual({ kind: "done", copied: [], present: ["models/m.gguf"] });
		expect(readFileSync(join(home, "models", "m.gguf"), "utf8")).toBe("mine");
	});

	it("rejects a corrupt shipped file and leaves nothing the librarian could trust", async () => {
		const home = temp();
		const wrong = seedDir({ sha256: "0".repeat(64) });
		await expect(seedAssets({ seedDir: wrong, autoragHome: home })).rejects.toThrow(/corrupt/);
		expect(existsSync(join(home, "models", "m.gguf"))).toBe(false);
		expect(existsSync(join(home, "models", "m.gguf.seed-part"))).toBe(false);
	});

	it("rejects a manifest entry that escapes the AutoRAG home", () => {
		expect(() => readSeedManifest(seedDir({ destination: "../outside.gguf" }))).toThrow(/escapes/);
		expect(() => readSeedManifest(seedDir({ path: "/etc/passwd" }))).toThrow(/escapes/);
	});

	it("reports no seed when the build has none", async () => {
		expect(await seedAssets({ seedDir: temp(), autoragHome: temp() })).toEqual({ kind: "none" });
	});

	describe("a runtime shipped extracted (signed macOS build)", () => {
		function treeSeed(): string {
			const dir = temp();
			const tree = join(dir, "runtime", "llama.tar.gz.extracted");
			mkdirSync(join(tree, "llama-b10951"), { recursive: true });
			writeFileSync(join(tree, ".autorag-archive-sha256"), `${"a".repeat(64)}\n`);
			writeFileSync(join(tree, "llama-b10951", "libggml.0.23.0.dylib"), "lib");
			symlinkSync("libggml.0.23.0.dylib", join(tree, "llama-b10951", "libggml.dylib"));
			const entry = { kind: "tree", path: "runtime/llama.tar.gz.extracted", destination: "runtime/llama.tar.gz.extracted" };
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, files: [entry] }));
			return dir;
		}

		it("copies the whole tree, keeping the dylib symlinks as symlinks", async () => {
			const home = temp();
			const outcome = await seedAssets({ seedDir: treeSeed(), autoragHome: home });
			expect(outcome).toEqual({ kind: "done", copied: ["runtime/llama.tar.gz.extracted"], present: [] });
			const tree = join(home, "runtime", "llama.tar.gz.extracted");
			expect(readFileSync(join(tree, ".autorag-archive-sha256"), "utf8").trim()).toBe("a".repeat(64));
			expect(lstatSync(join(tree, "llama-b10951", "libggml.dylib")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(tree, "llama-b10951", "libggml.dylib"))).toBe("libggml.0.23.0.dylib");
			expect(existsSync(`${tree}.seed-part`)).toBe(false);
		});

		it("leaves a runtime tree the user already has untouched", async () => {
			const home = temp();
			mkdirSync(join(home, "runtime", "llama.tar.gz.extracted"), { recursive: true });
			const outcome = await seedAssets({ seedDir: treeSeed(), autoragHome: home });
			expect(outcome).toEqual({ kind: "done", copied: [], present: ["runtime/llama.tar.gz.extracted"] });
			expect(existsSync(join(home, "runtime", "llama.tar.gz.extracted", ".autorag-archive-sha256"))).toBe(false);
		});
	});
});
