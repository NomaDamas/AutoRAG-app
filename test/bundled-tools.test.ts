import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
