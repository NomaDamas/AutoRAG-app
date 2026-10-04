import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileDetails } from "../src/main/file-details";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("readFileDetails", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "autorag-file-details-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("describes a file with its size, times, mode, ownership, and inode", async () => {
		const file = join(root, "notes.txt");
		await writeFile(file, "hello world");
		const stamp = new Date("2026-01-02T03:04:05.000Z");
		await utimes(file, stamp, stamp);

		const details = await readFileDetails(file);

		expect(details.path).toBe(file);
		expect(details.kind).toBe("file");
		expect(details.size).toBe(11);
		expect(details.modifiedAt).toBe(stamp.toISOString());
		expect(details.createdAt).toMatch(ISO);
		expect(details.accessedAt).toMatch(ISO);
		expect(details.changedAt).toMatch(ISO);
		expect(details.isSymlink).toBe(false);
		expect(details.linkTarget).toBeNull();
		expect(details.permissions).toMatch(/^-rw/);
		expect(details.permissions).toHaveLength(10);
		expect(details.owner).not.toBe("");
		expect(details.group).not.toBe("");
		expect(Number.isInteger(details.inode)).toBe(true);
		expect(details.image).toBeNull();
	});

	it("marks a folder with the directory permission bit and no size", async () => {
		const dir = join(root, "folder");
		await mkdir(dir);

		const details = await readFileDetails(dir);

		expect(details.kind).toBe("folder");
		expect(details.size).toBeNull();
		expect(details.permissions.startsWith("d")).toBe(true);
	});

	it("reports a symlink with its absolute target, not the link's own metadata", async () => {
		const target = join(root, "target.txt");
		await writeFile(target, "content");
		const link = join(root, "link.txt");
		await symlink(target, link);

		const details = await readFileDetails(link);

		expect(details.isSymlink).toBe(true);
		expect(details.linkTarget).toBe(target);
		expect(details.size).toBe(7);
	});

	it("attaches image metadata through the injected reader", async () => {
		const file = join(root, "photo.jpg");
		await writeFile(file, "not really a jpeg");

		const details = await readFileDetails(file, {
			readImage: async () => ({
				width: 4000,
				height: 3000,
				make: "TestMake",
				model: null,
				lens: null,
				iso: 400,
				fNumber: null,
				exposureTime: null,
				focalLength: null,
				focalLength35mm: null,
				dateTaken: null,
				exposureProgram: null,
				meteringMode: null,
				flash: null,
				whiteBalance: null,
				colorSpace: null,
				orientation: null,
				software: null,
				artist: null,
				copyright: null,
				gps: null,
			}),
		});

		expect(details.image?.make).toBe("TestMake");
		expect(details.image?.width).toBe(4000);
	});
});
