import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { gzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listArchive, type ArchiveListLimits } from "../src/main/archive-list";
import { writeSevenZip } from "../src/main/sevenzip-writer";
import { collapseToTopLevel, summarizeArchive } from "../src/preview/shared/archive-items";
import type { ArchivePreview } from "../src/preview/shared/contract";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import {
	FIXTURE_7Z,
	FIXTURE_CPIO,
	FIXTURE_TAR_BZ2,
	FIXTURE_TAR_XZ,
	RAR4_TREE,
	RAR5_ENCRYPTED,
	RAR5_STORED,
	arArchive,
	cabArchive,
	debPackage,
	fixtureIso,
	fixtureTar,
	rpmPackage,
} from "./archive-fixtures";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-archive-list-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function put(name: string, bytes: Uint8Array): Promise<string> {
	const path = join(root, name);
	await writeFile(path, bytes);
	return path;
}

/** The panel's view of a listing: its item count and children, newest first. */
function panel(preview: ArchivePreview): { readonly itemCount: number; readonly items: readonly string[] } {
	if (preview.kind !== "entries") throw new Error(`expected entries, got ${preview.reason}`);
	const summary = summarizeArchive(preview.entries, 6);
	return { itemCount: summary.itemCount, items: summary.items.map((item) => `${item.name}${item.folder ? "/" : ""}`) };
}

/** What every fixture container holds at its top level, newest child first. */
const FIXTURE_PANEL = { itemCount: 3, items: ["한글/", "docs/", "readme.md"] };

describe("which files get the archive listing", () => {
	it("claims the container formats the wasm engine and the unwrappers can read", () => {
		for (const ext of ["rar", "7z", "bz2", "tbz2", "tbz", "xz", "txz", "zst", "tzst", "iso", "deb", "rpm", "cab"]) {
			expect(viewerForExtension(ext)).toBe("archiveList");
		}
		expect(byteNeed("archiveList")).toBe("query");
	});

	it("leaves zip and tar to the in-page reader and keeps formats it cannot list on the info panel", () => {
		for (const ext of ["zip", "tar", "gz", "tgz"]) expect(viewerForExtension(ext)).toBe("archive");
		for (const ext of ["dmg", "pkg", "lz4"]) expect(viewerForExtension(ext)).toBe("fallback");
	});

	it("names each format in the panel header", () => {
		expect(describeExtension("rar")).toBe("RAR archive");
		expect(describeExtension("7z")).toBe("7-Zip archive");
		expect(describeExtension("deb")).toBe("Debian package");
		expect(describeExtension("rpm")).toBe("RPM package");
		expect(describeExtension("cab")).toBe("Cabinet archive");
		expect(describeExtension("iso")).toBe("Disc Image");
	});
});

describe("listing an archive", () => {
	it("lists a 7z like a zip: the same count and children, newest first", async () => {
		expect(panel(await listArchive(await put("a.7z", Buffer.from(FIXTURE_7Z, "base64"))))).toEqual(FIXTURE_PANEL);
	});

	it("carries each top-level child's modified date, newest of its members for a folder", async () => {
		const preview = await listArchive(await put("a.7z", Buffer.from(FIXTURE_7Z, "base64")));
		if (preview.kind !== "entries") throw new Error("expected entries");
		const dates = new Map(preview.entries.map((entry) => [entry.name, entry.modified]));
		expect(dates.get("readme.md")).toBe(Date.UTC(2022, 4, 6, 7, 8));
		expect(dates.get("docs/")).toBe(Date.UTC(2024, 0, 2, 3, 4));
		expect(dates.get("한글/")).toBe(Date.UTC(2025, 2, 4, 5, 6));
	});

	it("lists tar.bz2 and tar.xz", async () => {
		expect(panel(await listArchive(await put("a.tar.bz2", Buffer.from(FIXTURE_TAR_BZ2, "base64"))))).toEqual(FIXTURE_PANEL);
		expect(panel(await listArchive(await put("a.tar.xz", Buffer.from(FIXTURE_TAR_XZ, "base64"))))).toEqual(FIXTURE_PANEL);
	});

	it("lists tar.zst through Node's own zstd, which the wasm engine lacks", async () => {
		expect(panel(await listArchive(await put("a.tar.zst", zstdCompressSync(fixtureTar()))))).toEqual(FIXTURE_PANEL);
	});

	it("lists an ISO 9660 image", async () => {
		expect(panel(await listArchive(await put("a.iso", fixtureIso())))).toEqual(FIXTURE_PANEL);
	});

	it("lists a CAB, whose names use backslashes", async () => {
		const date = new Date(Date.UTC(2024, 0, 2, 3, 4, 0));
		const cab = cabArchive([
			{ name: "readme.md", data: "top", date: new Date(Date.UTC(2022, 4, 6, 8, 0, 0)) },
			{ name: "docs\\a.txt", data: "hello", date },
			{ name: "docs\\sub\\b.txt", data: "world", date },
		]);
		expect(panel(await listArchive(await put("a.cab", cab)))).toEqual({ itemCount: 2, items: ["docs/", "readme.md"] });
	});

	it("lists the payload of a deb whatever compresses it", async () => {
		const tar = fixtureTar();
		expect(panel(await listArchive(await put("gz.deb", debPackage("data.tar.gz", gzipSync(tar)))))).toEqual(FIXTURE_PANEL);
		expect(panel(await listArchive(await put("xz.deb", debPackage("data.tar.xz", Buffer.from(FIXTURE_TAR_XZ, "base64")))))).toEqual(FIXTURE_PANEL);
		expect(panel(await listArchive(await put("zst.deb", debPackage("data.tar.zst", zstdCompressSync(tar)))))).toEqual(FIXTURE_PANEL);
		expect(panel(await listArchive(await put("plain.deb", debPackage("data.tar", tar))))).toEqual(FIXTURE_PANEL);
	});

	it("lists the payload of an rpm after its lead and padded headers, gzip or zstd", async () => {
		const cpio = Buffer.from(FIXTURE_CPIO, "base64");
		expect(panel(await listArchive(await put("gz.rpm", rpmPackage(gzipSync(cpio)))))).toEqual(FIXTURE_PANEL);
		expect(panel(await listArchive(await put("zst.rpm", rpmPackage(zstdCompressSync(cpio)))))).toEqual(FIXTURE_PANEL);
	});

	it("lists a RAR4 and a RAR5 archive, listing only", async () => {
		expect(panel(await listArchive(await put("old.rar", Buffer.from(RAR4_TREE, "base64")))).items).toEqual(expect.arrayContaining(["testdir/", "test.txt"]));
		expect(panel(await listArchive(await put("new.rar", Buffer.from(RAR5_STORED, "base64"))))).toEqual({ itemCount: 1, items: ["helloworld.txt"] });
	});

	it("keeps Korean names whole", async () => {
		const source = await put("요약.md", Buffer.from("가"));
		const target = join(root, "ko.7z");
		await writeSevenZip(target, [{ source, entry: "보고서/요약.md", directory: false }]);
		expect(panel(await listArchive(target))).toEqual({ itemCount: 1, items: ["보고서/"] });
	});
});

describe("an archive that cannot be listed says why", () => {
	it("refuses a password-protected RAR with a note instead of an error", async () => {
		expect(await listArchive(await put("locked.rar", Buffer.from(RAR5_ENCRYPTED, "base64")))).toEqual({ kind: "unreadable", reason: "encrypted" });
	});

	it("reports a file that is not the archive its name claims as damaged", async () => {
		for (const name of ["junk.7z", "junk.rar", "junk.iso", "junk.cab", "junk.deb", "junk.rpm", "junk.tar.xz", "junk.zst"]) {
			const preview = await listArchive(await put(name, Buffer.from("this is plain text, not an archive at all ".repeat(20))));
			expect(preview, name).toEqual({ kind: "unreadable", reason: "corrupt" });
		}
	});

	it("reports a 7z cut short as damaged", async () => {
		const whole = Buffer.from(FIXTURE_7Z, "base64");
		expect(await listArchive(await put("cut.7z", whole.subarray(0, whole.length - 40)))).toEqual({ kind: "unreadable", reason: "corrupt" });
	});

	it("reports a deb with no data member as damaged", async () => {
		const empty = arArchive([{ name: "debian-binary", data: Buffer.from("2.0\n") }]);
		expect(await listArchive(await put("empty.deb", empty))).toEqual({ kind: "unreadable", reason: "corrupt" });
	});
});

describe("huge archives stay bounded", () => {
	const limits = (over: Partial<ArchiveListLimits>): Partial<ArchiveListLimits> => over;

	it("does not read an archive over the input cap", async () => {
		const path = await put("big.7z", Buffer.from(FIXTURE_7Z, "base64"));
		expect(await listArchive(path, { limits: limits({ maxInputBytes: 100 }) })).toEqual({ kind: "unreadable", reason: "tooLarge" });
	});

	it("stops decompressing a zstd stream that inflates past the output cap", async () => {
		const bomb = zstdCompressSync(Buffer.alloc(8 * 1024 * 1024));
		const path = await put("bomb.tar.zst", bomb);
		expect(bomb.length).toBeLessThan(1024);
		expect(await listArchive(path, { limits: limits({ maxOutputBytes: 1024 * 1024 }) })).toEqual({ kind: "unreadable", reason: "tooLarge" });
	});

	it("gives up on an archive with more entries than the cap", async () => {
		const path = await put("many.7z", Buffer.from(FIXTURE_7Z, "base64"));
		expect(await listArchive(path, { limits: limits({ maxEntries: 3 }) })).toEqual({ kind: "unreadable", reason: "tooManyEntries" });
	});

	it("gives up on an archive that takes longer than the time cap", async () => {
		const path = await put("slow.7z", Buffer.from(FIXTURE_7Z, "base64"));
		expect(await listArchive(path, { limits: limits({ timeoutMs: 1 }) })).toEqual({ kind: "unreadable", reason: "tooSlow" });
	});

	it("abandons the work when the preview moved on", async () => {
		const path = await put("gone.7z", Buffer.from(FIXTURE_7Z, "base64"));
		await expect(listArchive(path, { stopped: () => true })).rejects.toThrow(/cancel/i);
	});
});

describe("collapsing a listing to what the panel draws", () => {
	it("summarizes identically to the full list while sending one entry per top-level child", () => {
		const entries = [
			{ name: "./docs/", size: 0, modified: 5 },
			{ name: "./docs/a.txt", size: 10, modified: 9 },
			{ name: "docs\\b.txt", size: 20, modified: 7 },
			{ name: "readme.md", size: 3, modified: 8 },
			{ name: ".hidden/x", size: 1, modified: 99 },
			{ name: "__MACOSX/._a", size: 1, modified: 99 },
			{ name: "empty/", size: 0, modified: null },
			{ name: "", size: 0, modified: 1 },
		];
		const collapsed = collapseToTopLevel(entries);
		expect(collapsed.length).toBe(5);
		expect(summarizeArchive(collapsed, 6)).toEqual(summarizeArchive(entries, 6));
		expect(collapsed.find((entry) => entry.name === "docs/")).toEqual({ name: "docs/", size: 30, modified: 9 });
	});
});
