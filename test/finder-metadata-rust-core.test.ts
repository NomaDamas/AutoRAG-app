import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeLoader from "../src/main/dazzi-native-core";
import {
	createFinderMetadataResolver,
	parseFinderMetadataBatchPlist,
} from "../src/main/finder-metadata";
import { createFinderTags } from "../src/main/finder-tags";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	const pending = tempDirs.splice(0);
	await Promise.all(pending.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("dazzi-native-core Finder metadata, tags, and Windows kind", () => {
	it("round-trips binary plist string arrays identically to macOS plutil (ASCII + Korean + color suffixes)", async () => {
		const native = nativeLoader.loadDazziNativeCore()!;
		const values = ["Urgent\n6", "한글 태그\n4", "Review & ship", "Q3 2026"];
		const bplist = native.encodeBinaryPlistStringsNative(values);
		expect(bplist.subarray(0, 8).toString("ascii")).toBe("bplist00");
		expect(native.decodePlistStringsNative(bplist)).toEqual(values);
		expect(JSON.parse(native.decodePlistToJsonNative(bplist))).toEqual(values);

		// Empty array must also round-trip as [] (not null)
		const emptyBplist = native.encodeBinaryPlistStringsNative([]);
		expect(native.decodePlistStringsNative(emptyBplist)).toEqual([]);

		// On macOS, cross-verify our generated binary plist against Apple's own `plutil`
		if (process.platform === "darwin") {
			const dir = await makeTempDir("dazzi-plist-check-");
			const plistPath = join(dir, "tags.plist");
			await writeFile(plistPath, bplist);
			const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
			expect(JSON.parse(stdout)).toEqual(values);
		}
	});

	it("parses multi-path mdls -plist <array><dict>...</dict></array> batches cleanly", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<array>
  <dict>
    <key>kMDItemFSCreationDate</key><date>2026-09-01T12:00:00Z</date>
    <key>kMDItemStarRating</key><integer>5</integer>
  </dict>
  <dict>
    <key>kMDItemDateAdded</key><date>2026-10-05T08:30:00Z</date>
    <key>kMDItemFinderComment</key><string>Ship &amp; verify</string>
  </dict>
</array>
</plist>`;
		const parsed = parseFinderMetadataBatchPlist(xml, 2);
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveLength(2);
		expect(parsed?.[0]?.createdAt).toBe("2026-09-01T12:00:00.000Z");
		expect(parsed?.[0]?.rating).toBe(5);
		expect(parsed?.[1]?.addedAt).toBe("2026-10-05T08:30:00.000Z");
		expect(parsed?.[1]?.comments).toBe("Ship & verify");
		// Mismatched count signals per-path fallback
		expect(parseFinderMetadataBatchPlist(xml, 3)).toBeNull();
	});

	it.skipIf(process.platform !== "darwin")(
		"writes, reads, and removes real macOS Finder tags & comments directly via native getxattr/setxattr with Apple xattr/plutil parity",
		async () => {
			const dir = await makeTempDir("dazzi-real-xattr-");
			const fileA = join(dir, "report.txt");
			const fileB = join(dir, "memo.txt");
			await writeFile(fileA, "hello");
			await writeFile(fileB, "world");

			const native = nativeLoader.loadDazziNativeCore()!;

			// 1. Write tags via native setxattr and verify Apple's `xattr` + `plutil` sees the exact tags
			const finderTags = createFinderTags({ platform: "darwin", warn: () => {} });
			const setRes = await finderTags.set([fileA, fileB], { add: ["Urgent", "한글태그"], remove: [] });
			expect(setRes.failed).toEqual([]);
			expect([...setRes.ok].sort()).toEqual([fileA, fileB].sort());

			// Cross-check with real /usr/bin/xattr + /usr/bin/plutil
			const { stdout: hexOut } = await execFileAsync("/usr/bin/xattr", [
				"-p",
				"-x",
				"com.apple.metadata:_kMDItemUserTags",
				fileA,
			]);
			const rawBytes = Buffer.from(hexOut.replace(/[^0-9a-fA-F]/g, ""), "hex");
			const tmpPlist = join(dir, "verify.plist");
			await writeFile(tmpPlist, rawBytes);
			const { stdout: plutilJson } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", tmpPlist]);
			expect(JSON.parse(plutilJson)).toEqual(["Urgent", "한글태그"]);

			// 2. Write a Finder comment via Apple's xattr and verify readFinderXattrsNative reads both tags + comment
			const commentPlist = native.encodeBinaryPlistStringsNative(["리뷰 완료 & 배포"]);
			// Use single string plist (Finder comment format) via plutil
			const commentXml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><string>리뷰 완료 &amp; 배포</string></plist>`;
			const commentXmlPath = join(dir, "comment.xml");
			const commentBinPath = join(dir, "comment.bplist");
			await writeFile(commentXmlPath, commentXml);
			await execFileAsync("/usr/bin/plutil", ["-convert", "binary1", "-o", commentBinPath, commentXmlPath]);
			const { readFile } = await import("node:fs/promises");
			const commentBin = await readFile(commentBinPath);
			await execFileAsync("/usr/bin/xattr", [
				"-w",
				"-x",
				"com.apple.metadata:kMDItemFinderComment",
				commentBin.toString("hex"),
				fileA,
			]);
			void commentPlist;

			const xattrs = native.readFinderXattrsNative(fileA);
			expect(xattrs.tagsError ?? null).toBeNull();
			expect(xattrs.commentError ?? null).toBeNull();
			expect(xattrs.tags).toEqual(["Urgent", "한글태그"]);
			expect(xattrs.comment).toBe("리뷰 완료 & 배포");

			// 3. Verify real createFinderMetadataResolver (default native + batched mdls path) resolves both files concurrently
			const resolveMeta = createFinderMetadataResolver({ platform: "darwin", warn: () => {} });
			const [metaA, metaB] = await Promise.all([resolveMeta(fileA), resolveMeta(fileB)]);
			expect(metaA?.tags).toEqual(["Urgent", "한글태그"]);
			expect(metaA?.comments).toBe("리뷰 완료 & 배포");
			expect(metaB?.tags).toEqual(["Urgent", "한글태그"]);
			expect(metaB?.comments).toBeNull();

			// 4. Remove all tags and verify the xattr is cleanly removed
			const clearRes = await finderTags.set([fileA], { add: [], remove: ["urgent", "한글태그"] });
			expect(clearRes.failed).toEqual([]);
			expect(native.readFinderTagsNative(fileA)).toEqual([]);
		},
	);

	it.skipIf(process.platform !== "darwin")(
		"refuses to overwrite a malformed non-array tag xattr in native mode",
		async () => {
			const dir = await makeTempDir("dazzi-bad-xattr-");
			const file = join(dir, "bad.txt");
			await writeFile(file, "x");
			// Write a dictionary plist instead of a string array
			const dictXml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>not</key><string>array</string></dict></plist>`;
			const xmlPath = join(dir, "d.xml");
			const binPath = join(dir, "d.bplist");
			await writeFile(xmlPath, dictXml);
			await execFileAsync("/usr/bin/plutil", ["-convert", "binary1", "-o", binPath, xmlPath]);
			const { readFile } = await import("node:fs/promises");
			await execFileAsync("/usr/bin/xattr", [
				"-w",
				"-x",
				"com.apple.metadata:_kMDItemUserTags",
				(await readFile(binPath)).toString("hex"),
				file,
			]);

			const finderTags = createFinderTags({ platform: "darwin", warn: () => {} });
			const res = await finderTags.set([file], { add: ["Work"], remove: [] });
			expect(res.ok).toEqual([]);
			expect(res.failed).toHaveLength(1);
			expect(res.failed[0]?.path).toBe(file);
		},
	);

	it("returns null from lookupWindowsFileKindsNative on non-Windows platforms", () => {
		const native = nativeLoader.loadDazziNativeCore()!;
		if (process.platform !== "win32") {
			expect(native.lookupWindowsFileKindsNative([".pdf", ".txt"])).toBeNull();
		} else {
			const kinds = native.lookupWindowsFileKindsNative([".txt", ".nonexistent_ext_xyz99"]);
			expect(kinds).not.toBeNull();
			expect(kinds).toHaveLength(2);
			expect(typeof kinds?.[0]).toBe("string");
			expect(kinds?.[1]).toBeNull();
		}
	});
});
