import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliConfig } from "@autorag/librarian/core";
import { applyAppIndexing, clearDiscoveryCache, readAppIndexing } from "../src/main/app-indexing";
import { DEFAULT_CODE_FOLDER_NAMES } from "../src/shared/settings-contract";

const directories: string[] = [];

beforeEach(() => clearDiscoveryCache());

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTree(extraDirs: readonly string[] = []): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "autorag-app-indexing-"));
	directories.push(root);
	for (const dir of ["projectA/node_modules/pkg", "projectA/src", "projectA/.git", ".venv/lib", "keep", ...extraDirs]) {
		await mkdir(join(root, dir), { recursive: true });
	}
	return root;
}

function configFor(root: string): CliConfig {
	return {
		searchPaths: [root],
		workspacePath: root,
		memoryPath: join(root, "memory.json"),
		jikji: {},
		excludePaths: [join(root, "keep")],
	};
}

describe("app indexing", () => {
	it("defaults to excluding the built-in code folders", () => {
		expect(readAppIndexing({})).toEqual({ excludeCodeFolders: true, codeFolderNames: DEFAULT_CODE_FOLDER_NAMES, fileTimeoutMs: 180_000, semanticSearch: true });
	});

	it("honors explicit appIndexing overrides", () => {
		expect(readAppIndexing({ appIndexing: { excludeCodeFolders: false, codeFolderNames: ["custom"] } })).toEqual({
			excludeCodeFolders: false,
			codeFolderNames: ["custom"],
			fileTimeoutMs: 180_000,
			semanticSearch: true,
		});
	});

	it("adds discovered code folders to excludePaths and Jikji globs, keeping existing values", async () => {
		const root = await createTree();

		const effective = await applyAppIndexing(configFor(root), {});

		expect(effective.excludePaths).toEqual(
			expect.arrayContaining([
				join(root, "keep"),
				join(root, ".autorag"),
				join(root, "projectA", "node_modules"),
				join(root, ".venv"),
				join(root, "projectA", ".git"),
			]),
		);
		// The walk does not descend into excluded directories.
		expect(effective.excludePaths).not.toEqual(expect.arrayContaining([join(root, "projectA", "node_modules", "pkg")]));
		expect(effective.jikji).toMatchObject({ exclude: expect.arrayContaining(["**/node_modules/**", "**/.git/**"]) });
	});

	it("excludes every dot-folder at any depth, not only the named ones, and leaves ordinary folders alone", async () => {
		const root = await createTree([".idea", "work/.vscode/settings", "a/b/c/.omx/state", "docs/notes", "dots.in.name"]);

		const effective = await applyAppIndexing(configFor(root), {});

		expect(effective.excludePaths).toEqual(
			expect.arrayContaining([join(root, ".idea"), join(root, "work", ".vscode"), join(root, "a", "b", "c", ".omx")]),
		);
		// Not descended into, and plain folders (even ones containing dots) stay indexed.
		expect(effective.excludePaths).not.toEqual(expect.arrayContaining([join(root, "work", ".vscode", "settings")]));
		expect(effective.excludePaths).not.toContain(join(root, "docs"));
		expect(effective.excludePaths).not.toContain(join(root, "dots.in.name"));
	});

	it("finds dot-folders beyond the first 20,000 entries instead of silently stopping there", async () => {
		const root = await createTree(["bulk"]);
		// Breadth-first, so 20,001 sibling entries are all read before `deep` is reached.
		await Promise.all(Array.from({ length: 20_001 }, (_, index) => mkdir(join(root, "bulk", `d${index}`))));
		await mkdir(join(root, "zzz-last", ".hidden"), { recursive: true });

		const effective = await applyAppIndexing(configFor(root), {});

		expect(effective.excludePaths).toContain(join(root, "zzz-last", ".hidden"));
	}, 60_000);

	it("keeps dot-folders excluded even when code-folder exclusion is turned off", async () => {
		const root = await createTree([".idea"]);

		const effective = await applyAppIndexing(configFor(root), { appIndexing: { excludeCodeFolders: false } });

		expect(effective.excludePaths).toEqual(expect.arrayContaining([join(root, "keep"), join(root, ".autorag"), join(root, ".idea")]));
		expect(effective.excludePaths).not.toContain(join(root, "projectA", "node_modules"));
		// No code-folder globs are added, but the media index stays pinned off (indexing-policy).
		expect(effective.jikji).toEqual({ enableMediaIndex: false });
	});

	it("reuses a recent walk for ordinary callers but walks again when asked to (a refresh)", async () => {
		const root = await createTree();
		await applyAppIndexing(configFor(root), {});
		await mkdir(join(root, "late", ".new"), { recursive: true });

		const reused = await applyAppIndexing(configFor(root), {});
		const refreshed = await applyAppIndexing(configFor(root), {}, { fresh: true });

		expect(reused.excludePaths).not.toContain(join(root, "late", ".new"));
		expect(refreshed.excludePaths).toContain(join(root, "late", ".new"));
	});
});
