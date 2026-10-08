import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliConfig } from "@autorag/librarian/core";
import { applyAppIndexing, DEFAULT_CODE_FOLDER_NAMES, readAppIndexing } from "../src/main/app-indexing";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createTree(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "autorag-app-indexing-"));
	directories.push(root);
	for (const dir of ["projectA/node_modules/pkg", "projectA/src", "projectA/.git", ".venv/lib", "keep"]) {
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
		expect(readAppIndexing({})).toEqual({ excludeCodeFolders: true, codeFolderNames: DEFAULT_CODE_FOLDER_NAMES });
	});

	it("honors explicit appIndexing overrides", () => {
		expect(readAppIndexing({ appIndexing: { excludeCodeFolders: false, codeFolderNames: ["custom"] } })).toEqual({
			excludeCodeFolders: false,
			codeFolderNames: ["custom"],
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

	it("keeps only AutoRAG state exclusions when code-folder exclusion is disabled", async () => {
		const root = await createTree();

		const effective = await applyAppIndexing(configFor(root), { appIndexing: { excludeCodeFolders: false } });

		expect(effective.excludePaths).toEqual(expect.arrayContaining([join(root, "keep"), join(root, ".autorag")]));
		expect(effective.excludePaths).not.toEqual(expect.arrayContaining([join(root, "projectA", "node_modules")]));
		// No code-folder globs are added, but the media index stays pinned off (indexing-policy).
		expect(effective.jikji).toEqual({ enableMediaIndex: false });
	});
});
