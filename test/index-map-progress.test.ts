import { describe, expect, it } from "vitest";
import { buildIndexMap, type ScanDir, type ScanFile } from "../src/main/index-map";
import { mapProgress } from "../src/renderer/src/components/settings/index-map/progress";
import { nodeKey } from "../src/renderer/src/components/settings/index-map/radial";
import type { IndexMap, IndexMapNodeKind, IndexMapState } from "../src/shared/index-map-contract";

const file = (path: string, state: IndexMapState): ScanFile => ({ path, name: path.split("/").at(-1)!, state });
const folder = (path: string, files: ScanFile[], dirs: ScanDir[] = []): ScanDir => ({ path, name: path.split("/").at(-1)!, files, dirs, sealed: null });

/** /r holds top.md and two folders: a (1.md, 2.md) and b (1.md). Everything starts not indexed. */
function scope(states: Readonly<Record<string, IndexMapState>> = {}, extra: ScanFile[] = []): IndexMap {
	const at = (path: string): ScanFile => file(path, states[path] ?? "unindexed");
	return buildIndexMap({
		roots: [folder("/r", [at("/r/top.md")], [folder("/r/a", [at("/r/a/1.md"), at("/r/a/2.md"), ...extra]), folder("/r/b", [at("/r/b/1.md")])])],
		truncated: false,
	});
}

const key = (map: IndexMap, path: string, kind: IndexMapNodeKind): string => nodeKey(map.nodes.find((node) => node.path === path && node.kind === kind)!);

describe("mapProgress", () => {
	it("finds nothing when nothing moved between two reads", () => {
		const progress = mapProgress(scope(), scope());
		expect(progress.here.size).toBe(0);
		expect(progress.inside.size).toBe(0);
	});

	it("puts the mark on the file that was just read, and on the folders that hold it as 'inside'", () => {
		const before = scope();
		const after = scope({ "/r/a/1.md": "stale" });
		const progress = mapProgress(before, after);

		expect([...progress.here]).toEqual([key(after, "/r/a/1.md", "file")]);
		expect(progress.inside).toEqual(new Set([key(after, "/r/a/1.md", "file"), key(after, "/r/a", "folder"), key(after, "/r", "root")]));
		// The folder is not itself the place: only the file inside it is.
		expect(progress.here.has(key(after, "/r/a", "folder"))).toBe(false);
		expect(progress.inside.has(key(after, "/r/b", "folder"))).toBe(false);
	});

	it("counts staging as progress too: a file read earlier that is now in the index", () => {
		const progress = mapProgress(scope({ "/r/b/1.md": "stale" }), scope({ "/r/b/1.md": "indexed" }));
		expect(progress.here.size).toBe(1);
	});

	it("marks several places when the index moved in several at once", () => {
		const after = scope({ "/r/a/1.md": "indexed", "/r/b/1.md": "stale" });
		const progress = mapProgress(scope(), after);
		expect(progress.here).toEqual(new Set([key(after, "/r/a/1.md", "file"), key(after, "/r/b/1.md", "file")]));
	});

	it("does not call leaving something out progress", () => {
		const progress = mapProgress(scope(), scope({ "/r/a/1.md": "excluded", "/r/a/2.md": "excluded" }));
		expect(progress.here.size).toBe(0);
	});

	it("does not compare two different scopes: a folder added or removed is not the index moving", () => {
		const other = buildIndexMap({ roots: [folder("/r", [file("/r/top.md", "indexed")]), folder("/x", [file("/x/1.md", "indexed")])], truncated: false });
		const progress = mapProgress(scope(), other);
		expect(progress.here.size).toBe(0);
		expect(progress.inside.size).toBe(0);
	});

	it("credits a file that arrives already indexed to the folder it landed in, since it has no earlier state to compare", () => {
		const before = scope();
		const after = scope({}, [file("/r/a/3.md", "indexed")]);
		const progress = mapProgress(before, after);

		expect(progress.here).toEqual(new Set([key(after, "/r/a", "folder")]));
		expect(progress.inside.has(key(after, "/r", "root"))).toBe(true);
	});
});
