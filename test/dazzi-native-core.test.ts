import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeLoader from "../src/main/dazzi-native-core";
import { buildFsEntry } from "../src/main/fs-entry";
import { createFsService } from "../src/main/fs-service";
import { createExclusionMatcher, findExclusion, findExclusionsBatch } from "../src/main/path-exclusion";
import { measureFolder, type FolderStatsOptions } from "../src/main/folder-stats";
import { buildIndexMap, scanIndexScope, type IndexScopeContext } from "../src/main/index-map";
import { scanFolder } from "../src/main/onboarding-scan";
import { createPlaces } from "../src/main/places";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	const pending = tempDirs.splice(0);
	await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

describe("dazzi-native-core single-source primary & error-only fallback", () => {
	it("loads the bundled Rust N-API core by default with no env-var toggle", () => {
		const native = nativeLoader.loadDazziNativeCore();
		expect(native).not.toBeNull();
		expect(typeof native!.findExclusionBatch).toBe("function");
		expect(typeof native!.scanFolderNative).toBe("function");
		expect(typeof native!.measureFolderNative).toBe("function");
		expect(typeof native!.listDirNative).toBe("function");
		expect(typeof native!.scanIndexScopeNative).toBe("function");
		expect(typeof native!.walkSearchNative).toBe("function");
	});

	it("matches path & glob exclusions identically between Rust primary and JS emergency fallback", () => {
		const exclusions = [
			"/Users/test/Documents/Private",
			"/Users/test/Documents/Archive/",
			"**/node_modules/**",
			"**/.git/**",
			"**/*.log",
			"**/*.tmp",
			"**/dist/**",
			"**/build/**",
			"**/Library/Caches/**",
			"**/exact-file.txt",
			"**/prefix_*",
		];
		const testPaths = [
			"/Users/test/Documents/Private",
			"/Users/test/Documents/Private/secret.pdf",
			"/Users/test/Documents/Private-other/ok.pdf",
			"/Users/test/Documents/Archive/old.txt",
			"/Users/test/Documents/Projects/a/node_modules/pkg/index.js",
			"/Users/test/Documents/Projects/a/node_modules",
			"/Users/test/Documents/Projects/a/node_modules/",
			"/Users/test/Documents/Projects/.cfg/node_modules/pkg/index.js",
			"/Users/test/Documents/Projects/a/node_modules/.bin/cli",
			"/Users/test/Documents/Projects/a/.git/HEAD",
			"/Users/test/Documents/Projects/a/.git/.hidden",
			"/Users/test/Documents/Projects/a/app.log",
			"/Users/test/Documents/Projects/a/APP.LOG",
			"/Users/test/Documents/Projects/a/.hidden.log",
			"/Users/test/Documents/Projects/.dotdir/app.log",
			"/Users/test/Documents/Projects/a/Library/Caches/item.bin",
			"/Users/test/Documents/Projects/a/exact-file.txt",
			"/Users/test/Documents/Projects/a/EXACT-FILE.TXT",
			"/Users/test/Documents/Projects/a/prefix_123.txt",
			"/Users/test/Documents/Projects/a/PREFIX_123.txt",
			"/Users/test/Documents/Projects/a/.prefix_123.txt",
			"/Users/test/Documents/Projects/a/normal/report_보고서.pdf",
			"/Users/test/Documents/Private/app.log",
			"node_modules/pkg/index.js",
		];

		// Rust primary
		const rustBatch = findExclusionsBatch(exclusions, testPaths);
		const rustMatcher = createExclusionMatcher(exclusions);
		const rustStream = testPaths.map((p) => rustMatcher.find(p));
		const rustIsExcluded = testPaths.map((p) => rustMatcher.isExcluded(p));

		// Emergency JS fallback (when loader returns null)
		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue(null);
		const jsBatch = findExclusionsBatch(exclusions, testPaths);
		const jsMatcher = createExclusionMatcher(exclusions);
		const jsStream = testPaths.map((p) => jsMatcher.find(p));
		const jsSingle = testPaths.map((p) => findExclusion(exclusions, p));

		expect(rustBatch).toEqual(jsBatch);
		expect(rustStream).toEqual(jsStream);
		expect(rustBatch).toEqual(jsSingle);
		expect(rustIsExcluded).toEqual(jsBatch.map((m) => m !== null));
	});

	it("delegates brace/character-class/non-ASCII globs cleanly to Node matchesGlob", () => {
		const complexExclusions = ["**/*.{pdf,doc}", "/a/[bc].txt", "**/문서/*.tmp"];
		const paths = ["/a/x.pdf", "/a/x.doc", "/a/x.txt", "/a/b.txt", "/a/d.txt", "/dir/문서/foo.tmp"];

		const primaryBatch = findExclusionsBatch(complexExclusions, paths);
		const primaryMatcher = createExclusionMatcher(complexExclusions);
		const primaryStream = paths.map((p) => primaryMatcher.find(p));

		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue(null);
		const jsBatch = findExclusionsBatch(complexExclusions, paths);
		const jsMatcher = createExclusionMatcher(complexExclusions);
		const jsStream = paths.map((p) => jsMatcher.find(p));

		expect(primaryBatch).toEqual(jsBatch);
		expect(primaryStream).toEqual(jsStream);
	});

	it("falls back to JS only when a native call throws at runtime", async () => {
		const root = await makeTempDir("dazzi-core-error-fallback-");
		await writeFile(join(root, "doc.txt"), "hello");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const real = nativeLoader.loadDazziNativeCore()!;
		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue({
			...real,
			scanFolderNative: () => Promise.reject(new Error("simulated native failure")),
			measureFolderNative: () => Promise.reject(new Error("simulated native failure")),
		});

		const scanRes = await scanFolder(
			root,
			{ supportedExtensions: new Set([".txt"]), maxSourceBytes: 1024 },
			() => {},
			new AbortController().signal,
		);
		expect(scanRes.files).toBe(1);
		expect(scanRes.bytes).toBe(5);
		expect(scanRes.error).toBeNull();

		const statsRes = await measureFolder(
			root,
			{ supportedExtensions: new Set([".txt"]), maxSourceBytes: 1024 },
			new AbortController().signal,
		);
		expect(statsRes.indexedFiles).toBe(1);
		expect(statsRes.totalFiles).toBe(1);
		expect(warn).toHaveBeenCalledTimes(2);
	});

	it("runs scanIndexScope natively off the JS thread with exact parity against JS fallback", async () => {
		const root = await makeTempDir("dazzi-core-index-map-");
		const docs = join(root, "docs");
		await mkdir(join(docs, "sub"), { recursive: true });
		await mkdir(join(docs, "private"), { recursive: true });
		await mkdir(join(docs, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(docs, "a.md"), "# A\n");
		await writeFile(join(docs, "b.log"), "log\n");
		await writeFile(join(docs, "c.qaunknown"), "bin\n");
		await writeFile(join(docs, "sub", "deep.txt"), "deep\n");
		await writeFile(join(docs, "private", "secret.md"), "secret\n");
		await writeFile(join(docs, "node_modules", "pkg", "readme.md"), "dep\n");

		const supported = new Set([".md", ".txt", ".log"]);
		const ctx: IndexScopeContext = {
			roots: [docs],
			exclusions: [join(docs, "private"), "**/*.log", "**/node_modules/**"],
			entries: new Map(),
			skips: new Map(),
			minSyncRoot: join(root, ".minsync"),
			indexable: (_p, name) => supported.has(name.slice(name.lastIndexOf(".")).toLowerCase()),
			supportedExtensions: supported,
			productArtifacts: new Set([".jikji_agent_map.md"]),
		};

		const rustMap = buildIndexMap(await scanIndexScope(ctx));

		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue(null);
		const jsMap = buildIndexMap(await scanIndexScope(ctx));

		expect(rustMap).toEqual(jsMap);
	});

	it("runs walkSearchNative off the JS thread with Unicode NFC/NFD parity against JS fallback", async () => {
		const root = await makeTempDir("dazzi-core-walk-search-");
		await mkdir(join(root, "sub", "deep"), { recursive: true });
		await mkdir(join(root, ".Trash"), { recursive: true });
		await writeFile(join(root, "보고서_2026.pdf".normalize("NFD")), "a");
		await writeFile(join(root, "sub", "Quarterly_Report.md"), "b");
		await writeFile(join(root, "sub", "deep", "보고서_최종.txt"), "c");
		await writeFile(join(root, ".Trash", "보고서_삭제.txt"), "d");

		const makeSvc = () =>
			createFsService({
				shell: { trashItem: async () => {}, showItemInFolder: () => {}, openPath: async () => "", openExternal: async () => {} },
				clipboard: { writeText: () => {}, writeFiles: async () => {} },
				homeDir: root,
				places: createPlaces({ homeDir: root }),
			});

		const rustHits = await makeSvc().search("보고서", { scope: root });
		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue(null);
		const jsHits = await makeSvc().search("보고서", { scope: root });

		const norm = (hits: readonly { readonly entry: { readonly path: string; readonly name: string; readonly size: number | null }; readonly location: string }[]) =>
			[...hits]
				.map((h) => ({ path: h.entry.path, name: h.entry.name, size: h.entry.size, location: h.location }))
				.sort((a, b) => a.path.localeCompare(b.path));

		expect(norm(rustHits)).toEqual(norm(jsHits));
		expect(rustHits).toHaveLength(2);
	});

	it("runs native folder scan off the JS main thread and honors mid-walk AbortSignal cancellation", async () => {
		const root = await makeTempDir("dazzi-core-abort-");
		for (let d = 0; d < 20; d += 1) {
			const sub = join(root, `d_${d}`);
			await mkdir(sub, { recursive: true });
			for (let f = 0; f < 30; f += 1) await writeFile(join(sub, `f_${f}.txt`), "x");
		}
		const controller = new AbortController();
		let tickedDuringWalk = false;
		const tick = new Promise<void>((resolve) => {
			setImmediate(() => {
				tickedDuringWalk = true;
				controller.abort();
				resolve();
			});
		});
		const scanPromise = scanFolder(
			root,
			{ supportedExtensions: new Set([".txt"]), maxSourceBytes: 1024, throttleMs: 1 },
			() => {},
			controller.signal,
		);
		const [res] = await Promise.all([scanPromise, tick]);
		expect(tickedDuringWalk).toBe(true);
		expect(res.done).toBe(true);
		expect(res.error).toBeNull();
	});

	it("listDirNative returns exactly what buildFsEntry returns for every entry kind (mtime/birthtime bit-identical)", async () => {
		const root = await makeTempDir("dazzi-core-parity-listdir-");
		const outside = await makeTempDir("dazzi-core-parity-outside-");
		for (let i = 0; i < 40; i += 1) await writeFile(join(root, `파일_${i}.PDF`), "x".repeat(i));
		await writeFile(join(root, ".hidden"), "h");
		await writeFile(join(root, "noext"), "n");
		await writeFile(join(root, "archive.tar.gz"), "t");
		await mkdir(join(root, "folder.d"));
		await mkdir(join(root, "Sample.app"));
		await mkdir(join(root, "doc.rtfd"));
		await writeFile(join(outside, "target.txt"), "target");
		await symlink(join(outside, "target.txt"), join(root, "link-to-file"));
		await symlink(outside, join(root, "link-to-dir"));
		await symlink(join(root, "missing-target"), join(root, "broken-link"));
		const odd = new Date("2001-02-03T04:05:06.789Z");
		await utimes(join(root, "noext"), odd, odd);

		const native = nativeLoader.loadDazziNativeCore();
		expect(native).not.toBeNull();
		const listing = native!.listDirNative(root, process.platform);
		expect(listing.hadSkips).toBe(false);

		for (const item of listing.entries) {
			const expected = await buildFsEntry(item.path, process.platform);
			const { birthtimeMs, ...rest } = item;
			expect({ ...rest, size: item.size }).toMatchObject({
				name: expected.name,
				path: expected.path,
				kind: expected.kind,
				ext: expected.ext,
				size: expected.size,
				mtimeMs: expected.mtimeMs,
				flags: expected.flags,
			});
			expect(birthtimeMs ?? undefined).toBe(expected.birthtimeMs);
		}
		expect(listing.entries).toHaveLength(40 + 3 + 3 + 3);
	});

	it("produces identical scanFolder and measureFolder results between Rust primary and JS fallback", async () => {
		const root = await makeTempDir("dazzi-core-scan-measure-");
		const outside = await makeTempDir("dazzi-core-outside-");
		const DAY = 86_400_000;
		const put = async (rel: string, body: string, daysAgo?: number) => {
			await mkdir(join(root, rel, ".."), { recursive: true });
			await writeFile(join(root, rel), body);
			if (daysAgo !== undefined) {
				const d = new Date(Date.now() - daysAgo * DAY);
				await utimes(join(root, rel), d, d);
			}
		};
		for (let i = 1; i <= 10; i += 1) await put(`chat/msg_${i}.txt`, "hello", 3);
		for (let i = 1; i <= 4; i += 1) await put(`chat/img_${i}.jpg`, "jpg", 3);
		for (let i = 1; i <= 6; i += 1) await put(`Docs/subA/report_${i}.md`, "md", 120);
		await put("top.txt", "top");
		await put("big.txt", "y".repeat(200));
		await put("node_modules/pkg/readme.md", "skip");
		await put(".hidden/secret.md", "skip");
		await writeFile(join(outside, "ext.txt"), "outside");
		await symlink(outside, join(root, "link-dir"));

		const scanOpts = {
			supportedExtensions: new Set([".txt", ".pdf", ".md"]),
			maxSourceBytes: 50,
			datalessPaths: new Set([join(root, "top.txt")]),
		};
		const measureOpts: FolderStatsOptions = {
			supportedExtensions: new Set([".txt", ".md", ".pdf"]),
			maxSourceBytes: 50,
			sampleNames: 6,
		};

		const rustScan = await scanFolder(root, scanOpts, () => {}, new AbortController().signal);
		const rustStats = await measureFolder(root, measureOpts, new AbortController().signal);

		vi.spyOn(nativeLoader, "loadDazziNativeCore").mockReturnValue(null);
		const jsScan = await scanFolder(root, scanOpts, () => {}, new AbortController().signal);
		const jsStats = await measureFolder(root, measureOpts, new AbortController().signal);

		expect(rustScan).toEqual(jsScan);
		expect(rustStats.indexedFiles).toBe(jsStats.indexedFiles);
		expect(rustStats.totalFiles).toBe(jsStats.totalFiles);
		expect(rustStats.indexedBytes).toBe(jsStats.indexedBytes);
		expect(rustStats.extensions).toEqual(jsStats.extensions);
		expect(rustStats.truncated).toBe(jsStats.truncated);
		expect(rustStats.children.map((c) => [c.name, c.indexedFiles, c.totalFiles, c.extensions, c.subfolders])).toEqual(
			jsStats.children.map((c) => [c.name, c.indexedFiles, c.totalFiles, c.extensions, c.subfolders]),
		);
	});
});
