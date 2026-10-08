import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTrashStore } from "../src/main/trash-store";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-trash-store-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("trash store", () => {
	it("answers the source folder for a payload path recorded by the app", async () => {
		// Given a record for one trashed payload
		const store = createTrashStore({ directory: root });
		await store.record([
			{
				sourcePath: "/Users/me/Documents/notes.md",
				trashPath: "/Users/me/.Trash/notes.md",
			},
		]);

		// When looking the payload up, Then its origin answers; an unrecorded payload does not
		expect(await store.find("/Users/me/.Trash/notes.md")).toEqual({
			sourcePath: "/Users/me/Documents/notes.md",
			trashPath: "/Users/me/.Trash/notes.md",
		});
		expect(await store.find("/Users/me/.Trash/other.md")).toBeNull();
	});

	it("persists across store instances, so a restart keeps Put Back working", async () => {
		// Given a record written by one store
		await createTrashStore({ directory: root }).record([
			{ sourcePath: "/a/x.md", trashPath: "/t/x.md" },
		]);

		// When another instance over the same directory reads it
		expect(await createTrashStore({ directory: root }).find("/t/x.md")).toEqual(
			{
				sourcePath: "/a/x.md",
				trashPath: "/t/x.md",
			},
		);
	});

	it("forgets restored or emptied payloads and lists what is left", async () => {
		// Given two records
		const store = createTrashStore({ directory: root });
		await store.record([
			{ sourcePath: "/a/x.md", trashPath: "/t/x.md" },
			{ sourcePath: "/a/y.md", trashPath: "/t/y.md" },
		]);

		// When one payload is restored
		await store.forget(["/t/x.md"]);

		// Then only the other record remains
		expect(await store.find("/t/x.md")).toBeNull();
		expect((await store.list()).map((record) => record.trashPath)).toEqual([
			"/t/y.md",
		]);
	});

	it("keeps only the newest origin for one payload path", async () => {
		// Given the same payload path recorded twice (the item was trashed again)
		const store = createTrashStore({ directory: root });
		await store.record([{ sourcePath: "/a/x.md", trashPath: "/t/x.md" }]);
		await store.record([{ sourcePath: "/b/x.md", trashPath: "/t/x.md" }]);

		// When reading it, Then the newest origin answers
		expect(await store.find("/t/x.md")).toEqual({
			sourcePath: "/b/x.md",
			trashPath: "/t/x.md",
		});
		expect(await store.list()).toEqual([
			{ sourcePath: "/b/x.md", trashPath: "/t/x.md" },
		]);
	});
});
