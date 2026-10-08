import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFsEntry } from "../src/main/fs-entry";

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
