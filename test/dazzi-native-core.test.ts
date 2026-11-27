import { mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isNativeCoreDisabled, loadDazziNativeCore } from "../src/main/dazzi-native-core";
import { buildFsEntry } from "../src/main/fs-entry";
import { findExclusion, findExclusionsBatch, createExclusionMatcher } from "../src/main/path-exclusion";
import { measureFolder, type FolderStatsOptions } from "../src/main/folder-stats";
import { scanFolder } from "../src/main/onboarding-scan";

const tempDirs: string[] = [];

afterEach(async () => {
	delete process.env.FAST_ANYTHING_DISABLE;
	const pending = tempDirs.splice(0);
	await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

describe("dazzi-native-core parity & fallback", () => {
	it("loads the native Rust core on supported hosts and respects FAST_ANYTHING_DISABLE=1", () => {
		const native = loadDazziNativeCore();
		expect(native).not.toBeNull();
		expect(isNativeCoreDisabled()).toBe(false);

		process.env.FAST_ANYTHING_DISABLE = "1";
		expect(isNativeCoreDisabled()).toBe(true);
		expect(loadDazziNativeCore()).toBeNull();
	});

	it("matches path & glob exclusions identically between JS and Rust across edge cases", () => {
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
			// Path exclusion takes precedence over glob exclusion even when glob appears earlier
			"/Users/test/Documents/Private/app.log",
			"node_modules/pkg/index.js",
		];

		// Compare with JS fallback (`FAST_ANYTHING_DISABLE=1`)
		process.env.FAST_ANYTHING_DISABLE = "1";
		const jsBatch = findExclusionsBatch(exclusions, testPaths);
		const jsMatcher = createExclusionMatcher(exclusions);
		const jsStream = testPaths.map((p) => jsMatcher.find(p));
		const jsSingle = testPaths.map((p) => findExclusion(exclusions, p));

		delete process.env.FAST_ANYTHING_DISABLE;
		const rustBatch = findExclusionsBatch(exclusions, testPaths);
		const rustMatcher = createExclusionMatcher(exclusions);
		const rustStream = testPaths.map((p) => rustMatcher.find(p));
		const rustIsExcluded = testPaths.map((p) => rustMatcher.isExcluded(p));

		expect(rustBatch).toEqual(jsBatch);
		expect(rustStream).toEqual(jsStream);
		expect(rustBatch).toEqual(jsSingle);
		expect(rustIsExcluded).toEqual(jsBatch.map((m) => m !== null));
	});

	it("falls back transparently to Node matchesGlob for brace/character-class/non-ASCII globs", () => {
		const complexExclusions = ["**/*.{pdf,doc}", "/a/[bc].txt", "**/문서/*.tmp"];
		const paths = ["/a/x.pdf", "/a/x.doc", "/a/x.txt", "/a/b.txt", "/a/d.txt", "/dir/문서/foo.tmp"];

		process.env.FAST_ANYTHING_DISABLE = "1";
		const jsBatch = findExclusionsBatch(complexExclusions, paths);
		const jsMatcher = createExclusionMatcher(complexExclusions);
		const jsStream = paths.map((p) => jsMatcher.find(p));

		delete process.env.FAST_ANYTHING_DISABLE;
		const rustBatch = findExclusionsBatch(complexExclusions, paths);
		const rustMatcher = createExclusionMatcher(complexExclusions);
		const rustStream = paths.map((p) => rustMatcher.find(p));

		expect(rustBatch).toEqual(jsBatch);
		expect(rustStream).toEqual(jsStream);
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

		const native = loadDazziNativeCore();
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

	it("reports hadSkips=false and matching entries on listDirNative", async () => {
		const root = await makeTempDir("dazzi-core-listdir-");
		await writeFile(join(root, "alpha.txt"), "hello");
		await mkdir(join(root, "subdir"));
		await symlink(join(root, "missing-target"), join(root, "broken.lnk"));

		const native = loadDazziNativeCore();
		expect(native).not.toBeNull();
		const listing = native!.listDirNative(root, process.platform);
		expect(listing.hadSkips).toBe(false);
		expect(listing.entries.map((e) => e.name).sort()).toEqual(["alpha.txt", "broken.lnk", "subdir"]);
		expect(listing.entries.find((e) => e.name === "broken.lnk")?.flags).toBe(1);
		expect(listing.entries.find((e) => e.name === "subdir")?.kind).toBe("folder");
		expect(listing.entries.find((e) => e.name === "alpha.txt")?.size).toBe(5);
	});

	it("produces identical scanFolder totals between Rust and JS fallback (skip dirs, caps, dataless, symlinks)", async () => {
		const root = await makeTempDir("dazzi-core-scan-");
		const outside = await makeTempDir("dazzi-core-outside-");
		await writeFile(join(root, "a.txt"), "hello");
		await writeFile(join(root, "b.pdf"), "pdf");
		await writeFile(join(root, "c.bin"), "unsupported");
		await writeFile(join(root, "big.txt"), "x".repeat(50));
		await mkdir(join(root, "sub"));
		await writeFile(join(root, "sub", "d.md"), "md");
		await mkdir(join(root, "node_modules"));
		await writeFile(join(root, "node_modules", "ignored.txt"), "ignored");
		await mkdir(join(root, ".git"));
		await writeFile(join(root, ".git", "ignored.txt"), "ignored");
		await writeFile(join(outside, "ext.txt"), "outside");
		await symlink(outside, join(root, "link-dir"));

		const opts = {
			supportedExtensions: new Set([".txt", ".pdf", ".md"]),
			maxSourceBytes: 10,
			datalessPaths: new Set([join(root, "a.txt")]),
		};

		process.env.FAST_ANYTHING_DISABLE = "1";
		const jsResult = await scanFolder(root, opts, () => {}, new AbortController().signal);

		delete process.env.FAST_ANYTHING_DISABLE;
		const rustResult = await scanFolder(root, opts, () => {}, new AbortController().signal);

		expect(rustResult).toEqual(jsResult);
	});

	it("produces identical measureFolder stats between Rust and JS fallback", async () => {
		const root = await makeTempDir("dazzi-core-measure-");
		const DAY = 86_400_000;
		const put = async (rel: string, body: string, daysAgo?: number) => {
			await mkdir(join(root, rel, ".."), { recursive: true });
			await writeFile(join(root, rel), body);
			if (daysAgo !== undefined) {
				const d = new Date(Date.now() - daysAgo * DAY);
				await utimes(join(root, rel), d, d);
			}
		};
		for (let i = 1; i <= 15; i += 1) await put(`chat/msg_${i}.txt`, "hello", 3);
		for (let i = 1; i <= 5; i += 1) await put(`chat/img_${i}.jpg`, "jpg", 3);
		for (let i = 1; i <= 8; i += 1) await put(`Docs/subA/report_${i}.md`, "md", 120);
		for (let i = 1; i <= 4; i += 1) await put(`Docs/subB/contract_${i}.pdf`, "pdf", 10);
		await put("top.txt", "top");
		await put("big.txt", "y".repeat(200));
		await put("node_modules/pkg/readme.md", "skip");
		await put(".hidden/secret.md", "skip");

		const opts: FolderStatsOptions = {
			supportedExtensions: new Set([".txt", ".md", ".pdf"]),
			maxSourceBytes: 50,
			sampleNames: 6,
		};

		process.env.FAST_ANYTHING_DISABLE = "1";
		const jsStats = await measureFolder(root, opts, new AbortController().signal);

		delete process.env.FAST_ANYTHING_DISABLE;
		const rustStats = await measureFolder(root, opts, new AbortController().signal);

		expect(rustStats.indexedFiles).toBe(jsStats.indexedFiles);
		expect(rustStats.totalFiles).toBe(jsStats.totalFiles);
		expect(rustStats.indexedBytes).toBe(jsStats.indexedBytes);
		expect(rustStats.extensions).toEqual(jsStats.extensions);
		expect(rustStats.truncated).toBe(jsStats.truncated);
		expect(rustStats.children.map((c) => [c.name, c.indexedFiles, c.totalFiles, c.extensions, c.subfolders])).toEqual(
			jsStats.children.map((c) => [c.name, c.indexedFiles, c.totalFiles, c.extensions, c.subfolders]),
		);
		expect(rustStats.modified?.oldest.getTime()).toBeCloseTo(jsStats.modified!.oldest.getTime(), -1);
		expect(rustStats.modified?.newest.getTime()).toBeCloseTo(jsStats.modified!.newest.getTime(), -1);
		expect(rustStats.modified?.sameDayShare).toBeCloseTo(jsStats.modified!.sameDayShare, 5);
	});
});
