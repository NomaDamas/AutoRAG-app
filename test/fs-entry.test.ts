import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFsEntry, onDiskPath } from "../src/main/fs-entry";

/** The temp volume ignores case (APFS and NTFS defaults); most Linux filesystems do not. */
const CASE_INSENSITIVE = (() => {
	const probe = join(tmpdir(), `fs-entry-case-${process.pid}-Probe`);
	try {
		mkdirSync(probe);
		return existsSync(probe.toLowerCase());
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

/** A `.app` on disk is a directory; only its name marks it as such. */
async function appBundle(path: string): Promise<void> {
	await mkdir(join(path, "Contents", "MacOS"), { recursive: true });
	await writeFile(join(path, "Contents", "Info.plist"), "<?xml version=\"1.0\"?><plist><dict/></plist>");
}

describe("buildFsEntry application bundles", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fs-entry-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reports a macOS .app directory as a launchable file, not a folder to browse into", async () => {
		// Given a real app bundle on a macOS host
		const path = join(root, "Hello.app");
		await appBundle(path);

		// When its entry is built
		const entry = await buildFsEntry(path, "darwin");

		// Then it is a file carrying its .app extension, so the OS opens it …
		expect(entry).toMatchObject({ name: "Hello.app", kind: "file", ext: "app" });
		// … and nothing but plain filesystem values rides along: the tile's OS icon
		// arrives later through enrichment, not on the listing
		expect(Object.keys(entry)).not.toContain("iconUrl");
	});

	it("keeps a bundle's size null, exactly like the folder it is on disk", async () => {
		const path = join(root, "Hello.app");
		await appBundle(path);

		expect((await buildFsEntry(path, "darwin")).size).toBeNull();
	});

	it("keeps a directory that is not a bundle a folder", async () => {
		const path = join(root, "Docs");
		await mkdir(path);

		expect(await buildFsEntry(path, "darwin")).toMatchObject({ kind: "folder", ext: "", size: null });
	});

	it("keeps an .app directory a folder on platforms whose OS has no notion of one", async () => {
		const path = join(root, "Hello.app");
		await appBundle(path);

		expect(await buildFsEntry(path, "win32")).toMatchObject({ kind: "folder", ext: "" });
		expect(await buildFsEntry(path, "linux")).toMatchObject({ kind: "folder", ext: "" });
	});

	it.each(["Notes.rtfd", "App.iconset", "Live.pvt", "Localized.lpdf", "Settings.prefpane"])("treats %s as a package on every platform", async (name) => {
		const path = join(root, name);
		await mkdir(path);

		for (const platform of ["darwin", "win32", "linux"] as const) {
			expect(await buildFsEntry(path, platform)).toMatchObject({ kind: "file", ext: name.split(".").pop()?.toLowerCase(), size: null });
		}
	});

	it("keeps a plain file named like a bundle a file", async () => {
		const path = join(root, "not-really.app");
		await writeFile(path, "plain\n");

		expect(await buildFsEntry(path, "darwin")).toMatchObject({ kind: "file", ext: "app", size: 6 });
	});

	it("still reports the enclosing folder of a bundle's contents as folders", async () => {
		const path = join(root, "Hello.app");
		await appBundle(path);

		expect(await buildFsEntry(join(path, "Contents"), "darwin")).toMatchObject({ kind: "folder" });
		expect(await buildFsEntry(dirname(path), "darwin")).toMatchObject({ kind: "folder" });
	});
});

describe("onDiskPath", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "fs-entry-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("keeps a path that is already spelled as on disk", async () => {
		await mkdir(join(root, "AutoRAG", "Docs"), { recursive: true });
		const path = join(root, "AutoRAG", "Docs");
		expect(await onDiskPath(path)).toBe(path);
	});

	it.skipIf(!CASE_INSENSITIVE)("restores every segment's on-disk case on a case-insensitive volume", async () => {
		await mkdir(join(root, "AutoRAG", "Docs"), { recursive: true });
		await writeFile(join(root, "AutoRAG", "Docs", "ReadMe.md"), "x");
		expect(await onDiskPath(join(root, "autorag", "DOCS"))).toBe(join(root, "AutoRAG", "Docs"));
		expect(await onDiskPath(join(root, "AutoRAg", "docs", "readme.MD"))).toBe(join(root, "AutoRAG", "Docs", "ReadMe.md"));
	});

	// NTFS stores names as given and does not unify normalization forms; only APFS does.
	it.skipIf(!CASE_INSENSITIVE || process.platform === "win32")("restores the on-disk Unicode form of a name typed in another normalization", async () => {
		const decomposed = "문서".normalize("NFD");
		await mkdir(join(root, decomposed));
		expect(await onDiskPath(join(root, "문서".normalize("NFC")))).toBe(join(root, decomposed));
	});

	it("never resolves a symlink: the link keeps its own name", async () => {
		await mkdir(join(root, "Target"));
		await symlink(join(root, "Target"), join(root, "Link"));
		const typed = CASE_INSENSITIVE ? join(root, "link") : join(root, "Link");
		expect(await onDiskPath(typed)).toBe(join(root, "Link"));
	});

	it("rejects a path that does not exist", async () => {
		await expect(onDiskPath(join(root, "missing", "child"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
