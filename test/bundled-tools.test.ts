import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBundledTools, pathKey, prependPath } from "../src/main/bundled-tools";
import { minSyncModelCacheRoot, readSeedManifest, seedAssets } from "../src/main/seed-assets";

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

describe("bundled Kiwi", () => {
	function toolsWithKiwi(): { readonly resources: string; readonly library: string; readonly model: string } {
		const resources = temp();
		const kiwi = join(resources, "tools", "kiwi");
		mkdirSync(join(resources, "tools", "bin"), { recursive: true });
		mkdirSync(join(kiwi, "lib"), { recursive: true });
		mkdirSync(join(kiwi, "models", "cong", "base"), { recursive: true });
		const library = join(kiwi, "lib", "libkiwi.dylib");
		writeFileSync(library, "");
		return { resources, library, model: join(kiwi, "models", "cong", "base") };
	}

	it("points MinSync's tokenizer at the library and model that shipped with the app", () => {
		const { resources, library, model } = toolsWithKiwi();
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

		applyBundledTools({ resourcesPath: resources, env, platform: "darwin" });

		expect(env.KIWI_LIBRARY_PATH).toBe(library);
		expect(env.KIWI_MODEL_PATH).toBe(model);
	});

	it("never overrides a path the user chose, and does not pair a bundled half with theirs", () => {
		const { resources } = toolsWithKiwi();
		for (const chosen of [{ KIWI_LIBRARY_PATH: "/mine/libkiwi.dylib" }, { KIWI_MODEL_PATH: "/mine/base" }]) {
			const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", ...chosen };
			applyBundledTools({ resourcesPath: resources, env, platform: "darwin" });
			expect({ library: env.KIWI_LIBRARY_PATH, model: env.KIWI_MODEL_PATH }).toEqual({ library: chosen.KIWI_LIBRARY_PATH, model: chosen.KIWI_MODEL_PATH });
		}
	});

	it("sets nothing when the model is missing, so the librarian's probe falls back to whitespace tokenization", () => {
		const { resources, model } = toolsWithKiwi();
		rmSync(model, { recursive: true });
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

		applyBundledTools({ resourcesPath: resources, env, platform: "darwin" });

		expect(env.KIWI_LIBRARY_PATH).toBeUndefined();
		expect(env.KIWI_MODEL_PATH).toBeUndefined();
	});

	it("finds kiwi.dll on Windows, where the environment spells PATH `Path`", () => {
		const resources = temp();
		const kiwi = join(resources, "tools", "kiwi");
		mkdirSync(join(resources, "tools", "bin"), { recursive: true });
		mkdirSync(join(kiwi, "lib"), { recursive: true });
		mkdirSync(join(kiwi, "models", "cong", "base"), { recursive: true });
		writeFileSync(join(kiwi, "lib", "kiwi.dll"), "");
		const env: NodeJS.ProcessEnv = { Path: "C:\\Windows" };

		applyBundledTools({ resourcesPath: resources, env, platform: "win32" });

		expect(env.KIWI_LIBRARY_PATH).toBe(join(kiwi, "lib", "kiwi.dll"));
		expect(env.KIWI_MODEL_PATH).toBe(join(kiwi, "models", "cong", "base"));
	});
});

describe("seeding the native MinSync embedding model", () => {
	const content = Buffer.from("not really safetensors");
	const sha256 = createHash("sha256").update(content).digest("hex");
	const repoDest = "models--Qwen--Qwen3-Embedding-0.6B/snapshots/97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3/model.safetensors";

	function seedDir(overrides: Record<string, unknown> = {}): string {
		const dir = temp();
		mkdirSync(join(dir, "models--Qwen--Qwen3-Embedding-0.6B", "snapshots", "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"), { recursive: true });
		writeFileSync(join(dir, repoDest), content);
		const file = { path: repoDest, destination: repoDest, sha256, bytes: content.length, ...overrides };
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 1, files: [file] }));
		return dir;
	}

	it("resolves MinSync's native model cache root on macOS and Windows", () => {
		expect(minSyncModelCacheRoot({ platform: "darwin", home: "/Users/me", env: {} })).toBe(join("/Users/me", ".cache", "minsync", "models"));
		expect(minSyncModelCacheRoot({ platform: "win32", home: "C:\\Users\\me", env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } })).toBe(
			join("C:\\Users\\me\\AppData\\Local", "minsync", "models"),
		);
		expect(minSyncModelCacheRoot({ platform: "darwin", home: "/Users/me", env: { FASTEMBED_CACHE_DIR: "/custom/cache" } })).toBe("/custom/cache");
	});

	it("copies the shipped native model files into the MinSync cache root", async () => {
		const cacheRoot = temp();
		const outcome = await seedAssets({ seedDir: seedDir(), cacheRoot });
		expect(outcome).toEqual({ kind: "done", copied: [repoDest], present: [] });
		expect(readFileSync(join(cacheRoot, repoDest))).toEqual(content);
	});

	it("never overwrites a model file the user already has", async () => {
		const cacheRoot = temp();
		mkdirSync(join(cacheRoot, "models--Qwen--Qwen3-Embedding-0.6B", "snapshots", "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"), { recursive: true });
		writeFileSync(join(cacheRoot, repoDest), "mine");
		const outcome = await seedAssets({ seedDir: seedDir(), cacheRoot });
		expect(outcome).toEqual({ kind: "done", copied: [], present: [repoDest] });
		expect(readFileSync(join(cacheRoot, repoDest), "utf8")).toBe("mine");
	});

	it("rejects a corrupt shipped file and leaves no partial file behind", async () => {
		const cacheRoot = temp();
		const wrong = seedDir({ sha256: "0".repeat(64) });
		await expect(seedAssets({ seedDir: wrong, cacheRoot })).rejects.toThrow(/corrupt/);
		expect(existsSync(join(cacheRoot, repoDest))).toBe(false);
		expect(existsSync(join(cacheRoot, `${repoDest}.seed-part`))).toBe(false);
	});

	it("rejects a manifest entry that escapes the cache root", () => {
		expect(() => readSeedManifest(seedDir({ destination: "../outside.safetensors" }))).toThrow(/escapes/);
		expect(() => readSeedManifest(seedDir({ path: "/etc/passwd" }))).toThrow(/escapes/);
	});

	it("reports no seed when the build has none", async () => {
		expect(await seedAssets({ seedDir: temp(), cacheRoot: temp() })).toEqual({ kind: "none" });
	});
});
