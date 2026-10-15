import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveMirrorIndex, type ParsedMirrorEntry } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_ROOT_MIN_INDEXED, findUnavailableRoots } from "../src/main/search-roots";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map(async (directory) => {
		await chmod(join(directory, "docs"), 0o755).catch(() => undefined);
		await rm(directory, { recursive: true, force: true });
	}));
});

/** A workspace whose previous refresh indexed `indexed` files from `<root>/docs`. */
async function fixture(indexed: number): Promise<{ readonly docs: string; readonly workspace: string }> {
	const root = await mkdtemp(join(tmpdir(), "autorag-search-roots-"));
	directories.push(root);
	const docs = join(root, "docs");
	const workspace = join(root, "workspace");
	await mkdir(docs, { recursive: true });
	await mkdir(workspace, { recursive: true });
	const entries: Record<string, ParsedMirrorEntry> = {};
	for (let index = 0; index < indexed; index += 1) {
		const sourcePath = join(docs, `note-${index}.md`);
		entries[`/docs/note-${index}.md`] = {
			virtualPath: `/docs/note-${index}.md`,
			sourcePath,
			outputPath: join(workspace, `note-${index}.md`),
			parserName: "plain-text",
			sourceMtimeNs: 1,
			sourceSizeBytes: 1,
			updatedAt: new Date(0).toISOString(),
		};
	}
	saveMirrorIndex(workspace, { version: 1, entries, skipped: {} });
	return { docs, workspace };
}

describe("findUnavailableRoots", () => {
	it("accepts a root that lists entries", async () => {
		const { docs, workspace } = await fixture(30);
		await writeFile(join(docs, "a.md"), "x");

		expect(await findUnavailableRoots([docs], workspace)).toEqual([]);
	});

	it("flags an empty root that used to hold many documents, and reports how many", async () => {
		const { docs, workspace } = await fixture(EMPTY_ROOT_MIN_INDEXED);

		expect(await findUnavailableRoots([docs], workspace)).toEqual([{ root: docs, reason: "empty", indexed: EMPTY_ROOT_MIN_INDEXED }]);
	});

	it("lets a root that held only a few documents be emptied on purpose", async () => {
		const { docs, workspace } = await fixture(EMPTY_ROOT_MIN_INDEXED - 1);

		expect(await findUnavailableRoots([docs], workspace)).toEqual([]);
	});

	it("never blocks a root nothing was indexed from, however it looks", async () => {
		const { workspace } = await fixture(0);

		expect(await findUnavailableRoots([join(tmpdir(), "autorag-search-roots-never-existed")], workspace)).toEqual([]);
	});

	it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("flags a root that cannot be listed, even for one indexed document", async () => {
		const { docs, workspace } = await fixture(1);
		await chmod(docs, 0o000);

		expect(await findUnavailableRoots([docs], workspace)).toEqual([{ root: docs, reason: "unreadable", indexed: 1 }]);
	});

	it("treats a listing that never returns as unreadable instead of waiting on a hung mount", async () => {
		const { docs, workspace } = await fixture(3);

		const problems = await findUnavailableRoots([docs], workspace, { probe: () => new Promise(() => undefined), timeoutMs: 20 });

		expect(problems).toEqual([{ root: docs, reason: "unreadable", indexed: 3 }]);
	});

	it("also stops waiting when the root's real path never resolves, and falls back to the configured one", async () => {
		const { docs, workspace } = await fixture(3);

		const problems = await findUnavailableRoots([docs], workspace, { probe: () => new Promise(() => undefined), realpath: () => new Promise(() => undefined), timeoutMs: 20 });

		expect(problems).toEqual([{ root: docs, reason: "unreadable", indexed: 3 }]);
	});

	it("only counts documents under the root that is checked", async () => {
		const { docs, workspace } = await fixture(5);
		const other = join(tmpdir(), "autorag-search-roots-other");

		const problems = await findUnavailableRoots([other, docs], workspace, { probe: async () => "unreadable" });

		expect(problems).toEqual([{ root: docs, reason: "unreadable", indexed: 5 }]);
	});

	it.skipIf(process.platform === "win32")("matches documents under a filesystem root, whose path already ends in a separator", async () => {
		const { workspace } = await fixture(EMPTY_ROOT_MIN_INDEXED + 5);

		const problems = await findUnavailableRoots(["/"], workspace, { probe: async () => "empty" });
		expect(problems).toEqual([{ root: "/", reason: "empty", indexed: EMPTY_ROOT_MIN_INDEXED + 5 }]);
	});
});
