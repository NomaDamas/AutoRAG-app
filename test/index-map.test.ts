import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { minSyncDocumentPath, minSyncWorkspaceRoot, type ParsedMirrorEntry } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { createIndexStatusService } from "../src/main/index-status";
import { emptyIndexMapCounts, type IndexMapState } from "../src/shared/index-map-contract";
import { seedMirrorStage } from "./support/seed-mirror-stage";

const directories: string[] = [];

afterEach(async () => {
	const pending = directories.splice(0);
	if (process.platform === "win32") return;
	await Promise.all(pending.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A search root as a refresh leaves it: some files parsed and staged, one changed since, some never indexed. */
async function createScope(): Promise<{ docs: string; env: NodeJS.ProcessEnv; workspace: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "autorag-index-map-")));
	directories.push(root);
	const docs = join(root, "docs");
	const workspace = join(root, "workspace");
	await mkdir(join(docs, "private"), { recursive: true });
	await mkdir(join(docs, "sub"), { recursive: true });
	await mkdir(join(docs, "node_modules", "pkg"), { recursive: true });
	await mkdir(workspace, { recursive: true });
	const configPath = join(root, "config.json");
	await writeFile(configPath, `${JSON.stringify({ searchPaths: [docs], workspacePath: workspace, excludePaths: [join(docs, "private")], minSync: { enabled: true } }, null, 2)}\n`);

	await writeFile(join(docs, "indexed.txt"), "indexed\n");
	await writeFile(join(docs, "changed.txt"), "changed\n");
	await writeFile(join(docs, "fresh.txt"), "fresh\n");
	await writeFile(join(docs, "photo.png"), "png");
	await writeFile(join(docs, "sub", "deep.txt"), "deep\n");
	await writeFile(join(docs, "private", "secret.txt"), "secret\n");
	await writeFile(join(docs, "private", "other.txt"), "other\n");
	await writeFile(join(docs, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

	const entries: Record<string, ParsedMirrorEntry> = {};
	for (const name of ["indexed.txt", "changed.txt"]) {
		const sourcePath = join(docs, name);
		const info = await stat(sourcePath, { bigint: true });
		const virtualPath = `/docs/${name}`;
		const outputPath = join(workspace, ".autorag", "parsed", "files", `${name}.md`);
		await mkdir(join(outputPath, ".."), { recursive: true });
		await writeFile(outputPath, name);
		entries[virtualPath] = {
			virtualPath,
			sourcePath,
			outputPath,
			parserName: "plain-text",
			sourceMtimeNs: Number(info.mtimeNs),
			sourceSizeBytes: Number(info.size),
			updatedAt: new Date(0).toISOString(),
		};
		const staged = minSyncDocumentPath(minSyncWorkspaceRoot(workspace), virtualPath);
		await mkdir(join(staged, ".."), { recursive: true });
		await writeFile(staged, name);
	}
	seedMirrorStage(workspace, { version: 1, entries });
	// Edited after the refresh: the index holds the old version.
	await writeFile(join(docs, "changed.txt"), "changed, and longer now\n");
	return { docs, workspace, env: { HOME: root, AUTORAG_CONFIG: configPath } };
}

describe("index map service", () => {
	it("classifies every file under the search root against the index", async () => {
		const { docs, env, workspace } = await createScope();
		const service = createIndexStatusService({ env, cwd: workspace, onRefreshed: () => {} });

		const map = await service.indexMap();
		const byPath = new Map(map.nodes.map((node) => [node.path, node]));

		expect(map.roots).toEqual([docs]);
		expect(byPath.get(join(docs, "indexed.txt"))).toMatchObject({ kind: "file", state: "indexed" });
		expect(byPath.get(join(docs, "changed.txt"))).toMatchObject({ kind: "file", state: "stale" });
		expect(byPath.get(join(docs, "fresh.txt"))).toMatchObject({ kind: "file", state: "unindexed" });
		expect(byPath.get(join(docs, "photo.png"))).toMatchObject({ kind: "file", state: "unindexable" });
		expect(byPath.get(join(docs, "sub", "deep.txt"))).toMatchObject({ kind: "file", state: "unindexed", depth: 2 });
		// Excluded folders are not entered: one excluded plot sized by what sits directly inside.
		expect(byPath.get(join(docs, "private"))).toMatchObject({ kind: "folder", state: "excluded", weight: 2 });
		expect(byPath.has(join(docs, "private", "secret.txt"))).toBe(false);
		expect(byPath.get(join(docs, "node_modules"))).toMatchObject({ kind: "folder", state: "excluded" });
		expect(byPath.has(join(docs, "node_modules", "pkg"))).toBe(false);
		expect(map.totals).toEqual({ indexed: 1, stale: 1, unindexed: 2, excluded: 3, unindexable: 1 });
		expect(map.nodes[0]).toMatchObject({ kind: "root", parent: null, weight: 8 });
		expect(map.truncated).toBe(false);
		expect(map.folded).toBe(false);
	});

	it("counts a file the index still holds under a newly excluded folder as needing a refresh", async () => {
		const { docs, env, workspace } = await createScope();
		const config = JSON.parse(await readFile(env.AUTORAG_CONFIG as string, "utf8")) as Record<string, unknown>;
		await writeFile(env.AUTORAG_CONFIG as string, JSON.stringify({ ...config, excludePaths: [join(docs, "private"), join(docs, "indexed.txt")] }));
		const service = createIndexStatusService({ env, cwd: workspace, onRefreshed: () => {} });

		const map = await service.indexMap();

		expect(map.nodes.find((node) => node.path === join(docs, "indexed.txt"))?.state).toBe("stale");
		expect(map.totals.indexed).toBe(0);
		expect(map.totals.stale).toBe(2);
	});
});

function file(dir: string, name: string, state: IndexMapState): ScanFile {
	return { name, path: `${dir}/${name}`, state };
}

function folder(path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir {
	return { name: path.split("/").at(-1) ?? path, path, files, dirs, sealed: null };
}

describe("buildIndexMap", () => {
	it("draws every file while the scope fits the budget, parents before children", () => {
		const root = folder("/r", [file("/r", "a.md", "indexed"), file("/r", "b.md", "stale")], [folder("/r/s", [file("/r/s", "c.md", "unindexed")])]);

		const map = buildIndexMap({ roots: [root], truncated: false }, 100);

		expect(map.nodes.map((node) => [node.kind, node.name])).toEqual([
			["root", "r"],
			["file", "a.md"],
			["file", "b.md"],
			["folder", "s"],
			["file", "c.md"],
		]);
		for (const node of map.nodes) if (node.parent !== null) expect(node.parent).toBeLessThan(node.id);
		expect(map.nodes[3]).toMatchObject({ state: "unindexed", weight: 1, parent: 0 });
		expect(map.folded).toBe(false);
	});

	it("folds a crowded folder into one parcel per state and keeps every file counted", () => {
		const big = Array.from({ length: 300 }, (_, index) => file("/r/big", `f${index}.md`, index < 200 ? "indexed" : index < 290 ? "unindexed" : "excluded"));
		const root = folder("/r", [file("/r", "top.md", "stale")], [folder("/r/big", big)]);

		const map = buildIndexMap({ roots: [root], truncated: false }, 40);

		expect(map.nodes.length).toBeLessThanOrEqual(40);
		const parcels = map.nodes.filter((node) => node.kind === "parcel");
		expect(parcels.map((node) => [node.state, node.weight])).toEqual([
			["indexed", 200],
			["unindexed", 90],
			["excluded", 10],
		]);
		expect(map.nodes.find((node) => node.name === "top.md")?.kind).toBe("file");
		expect(map.totals).toEqual({ ...emptyIndexMapCounts(), indexed: 200, stale: 1, unindexed: 90, excluded: 10 });
		expect(map.nodes[0]).toMatchObject({ weight: 301, state: "indexed" });
		expect(map.folded).toBe(true);
	});

	it("folds the deepest folders into their ancestors when even parcels per folder do not fit", () => {
		const chain = (depth: number, path: string): ScanDir =>
			folder(path, [file(path, "x.md", depth % 2 === 0 ? "indexed" : "unindexed")], depth === 0 ? [] : Array.from({ length: 3 }, (_, index) => chain(depth - 1, `${path}/d${index}`)));
		const root = chain(5, "/r");

		const map = buildIndexMap({ roots: [root], truncated: false }, 60);

		expect(map.nodes.length).toBeLessThanOrEqual(60);
		const total = map.nodes.filter((node) => node.kind === "file" || node.kind === "parcel").reduce((sum, node) => sum + node.weight, 0);
		expect(total).toBe(map.nodes[0]?.weight);
		expect(total).toBe(1 + 3 + 9 + 27 + 81 + 243);
	});
});
