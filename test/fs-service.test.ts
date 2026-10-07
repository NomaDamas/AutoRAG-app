import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { createFsService, FsRenameError, toHandoffPath, untitledFileName, untitledFolderName, type FsServiceDeps } from "../src/main/fs-service";
import type { NewFileFormatId } from "../src/shared/new-file-contract";
import type { FileNameSearchBackend } from "../src/main/file-name-search";
import { createRecentsStore, type RecentsStore } from "../src/main/recents-store";
import { FS_ENTRY_SYMLINK, RECENTS_PATH, type FsLocation } from "../src/shared/fs-contract";
import { createPlaces, type Places } from "../src/main/places";

const unreadablePaths = vi.hoisted(() => new Set<string>());

vi.mock("../src/main/fs-entry", async () => {
	const actual = await vi.importActual<typeof import("../src/main/fs-entry")>("../src/main/fs-entry");
	return {
		...actual,
		buildFsEntry: async (path: string) => {
			if (unreadablePaths.has(path)) throw new Error("simulated lstat failure");
			return actual.buildFsEntry(path);
		},
	};
});

function fakePlaces(rows: readonly FsLocation[]): Places & { readonly ejected: string[] } {
	const ejected: string[] = [];
	return {
		ejected,
		list: async () => rows,
		eject: async (path) => {
			ejected.push(path);
		},
		signature: async () => "",
		watch: () => () => {},
	};
}

interface StubbedDeps {
	readonly deps: FsServiceDeps;
	readonly trashed: string[];
	readonly revealed: string[];
	readonly opened: string[];
	readonly openedUrls: string[];
	readonly clipboardText: string[];
	readonly recents: RecentsStore;
}

function makeDeps(homeDir: string, platform: NodeJS.Platform = "darwin"): StubbedDeps {
	const trashed: string[] = [];
	const revealed: string[] = [];
	const opened: string[] = [];
	const openedUrls: string[] = [];
	const clipboardText: string[] = [];
	return {
		deps: {
			shell: {
				trashItem: async (path: string) => {
					trashed.push(path);
				},
				showItemInFolder: (path: string) => {
					revealed.push(path);
				},
				openPath: async (path: string) => {
					opened.push(path);
					return "";
				},
				openExternal: async (url: string) => {
					openedUrls.push(url);
				},
			},
			clipboard: {
				writeText: (text: string) => {
					clipboardText.push(text);
				},
			},
			homeDir,
			platform,
			places: createPlaces({
				homeDir,
				platform: "darwin",
				volumesRoot: join(homeDir, "Volumes"),
				applicationsDir: join(homeDir, "Applications"),
				run: async () => "",
			}),
			recents: createRecentsStore({ directory: join(homeDir, "recents-store") }),
			osKind: async () => null,
			icons: { icons: async () => new Map(), preview: async () => null },
		},
		trashed,
		revealed,
		opened,
		openedUrls,
		clipboardText,
		recents: createRecentsStore({ directory: join(homeDir, "recents-store") }),
	};
}

function makeFailingTrashDeps(homeDir: string, message: string): FsServiceDeps {
	return {
		shell: {
			trashItem: async () => {
				throw new Error(message);
			},
			showItemInFolder: () => { },
			openPath: async () => "",
			openExternal: async () => { },
		},
		clipboard: { writeText: () => { } },
		homeDir,
	};
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-fs-test-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("listDir", () => {
	it("returns files and folders with the contract shape, folders getting size null", async () => {
		// Given a directory with one file and one folder
		const dir = join(root, "listing");
		await mkdir(join(dir, "sub"), { recursive: true });
		await writeFile(join(dir, "Notes.TXT"), "hello");

		// When listing the directory
		const listing = await createFsService(makeDeps(root).deps).listDir(dir);

		// Then the path echoes the input and both entries carry the contract shape
		expect(listing.path).toBe(dir);
		const file = listing.entries.find((entry) => entry.name === "Notes.TXT");
		const folder = listing.entries.find((entry) => entry.name === "sub");
		expect(file).toBeDefined();
		expect(file?.kind).toBe("file");
		expect(file?.ext).toBe("txt");
		expect(file?.size).toBe(5);
		expect(file?.flags).toBe(0);
		expect(Number.isFinite(file?.mtimeMs)).toBe(true);
		expect(folder).toBeDefined();
		expect(folder?.kind).toBe("folder");
		expect(folder?.ext).toBe("");
		expect(folder?.size).toBeNull();
	});

	it("flags symlinks", async () => {
		// Given a file and a symlink pointing at it
		const dir = join(root, "links");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "target.txt"), "x");
		await symlink(join(dir, "target.txt"), join(dir, "link.txt"));

		// When listing the directory
		const listing = await createFsService(makeDeps(root).deps).listDir(dir);

		// Then the symlink entry is flagged and the real file is not
		expect((listing.entries.find((entry) => entry.name === "link.txt")?.flags ?? 0) & FS_ENTRY_SYMLINK).toBe(
			FS_ENTRY_SYMLINK,
		);
		expect((listing.entries.find((entry) => entry.name === "target.txt")?.flags ?? FS_ENTRY_SYMLINK) & FS_ENTRY_SYMLINK).toBe(
			0,
		);
	});

	it("skips one unreadable entry, keeps the others, and warns verbatim", async () => {
		const dir = join(root, "unreadable");
		const unreadable = join(dir, "unreadable.txt");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "visible-a.txt"), "a");
		await writeFile(unreadable, "hidden");
		await writeFile(join(dir, "visible-b.txt"), "b");
		unreadablePaths.add(unreadable);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

		try {
			const listing = await createFsService(makeDeps(root).deps).listDir(dir);

			expect(listing.entries.map((entry) => entry.name)).toEqual(["visible-a.txt", "visible-b.txt"]);
			expect(warning).toHaveBeenCalledWith(
				`fs:listDir skipping ${unreadable}: simulated lstat failure`,
			);
		} finally {
			unreadablePaths.delete(unreadable);
			warning.mockRestore();
		}
	});

	it("keeps directory entry order deterministic after concurrent metadata reads", async () => {
		const dir = join(root, "sorted");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "zeta.txt"), "");
		await writeFile(join(dir, "alpha.txt"), "");
		await mkdir(join(dir, "middle"), { recursive: true });

		const listing = await createFsService(makeDeps(root).deps).listDir(dir);

		expect(listing.entries.map((entry) => entry.name)).toEqual(["middle", "alpha.txt", "zeta.txt"]);
	});
});

describe("stat", () => {
	it("returns an FsEntry for a single file", async () => {
		// Given a file
		const filePath = join(root, "single.md");
		await writeFile(filePath, "abc");

		// When statting it
		const entry = await createFsService(makeDeps(root).deps).stat(filePath);

		// Then the entry describes the file
		expect(entry).toMatchObject({
			name: "single.md",
			path: filePath,
			kind: "file",
			ext: "md",
			size: 3,
			flags: 0,
		});
	});
});

describe("readEntries", () => {
	it("resolves and enriches only the requested direct children", async () => {
		// Given a directory with three files
		const dir = join(root, "incremental");
		await mkdir(dir, { recursive: true });
		for (const name of ["a.txt", "b.txt", "c.txt"]) {
			await writeFile(join(dir, name), name);
		}
		const requested = [join(dir, "a.txt"), join(dir, "c.txt")];
		const iconTargets: string[] = [];
		const osKindPaths: string[] = [];
		const deps: FsServiceDeps = {
			...makeDeps(root).deps,
			osKind: async (path) => {
				osKindPaths.push(path);
				return null;
			},
			icons: {
				icons: async (targets) => {
					iconTargets.push(...targets.map((target) => target.path));
					return new Map();
				},
				preview: async () => null,
			},
		};

		const service = createFsService(deps);
		const patch = await service.readEntries(dir, requested);

		// The live patch carries basic metadata immediately; enrichment is a separate call.
		expect(patch.entries.map((entry) => entry.name)).toEqual(["a.txt", "c.txt"]);
		expect(patch.removed).toEqual([]);
		expect(iconTargets).toEqual([]);
		expect(osKindPaths).toEqual([]);
		await service.enrichEntries(
			patch.entries.map(({ path, kind, ext, mtimeMs }) => ({ path, kind, ext, mtimeMs })),
			true,
		);
		expect(iconTargets).toEqual(requested);
		expect(osKindPaths).toEqual(requested);
	});

	it("deduplicates repeated requested paths", async () => {
		// Given a file requested three times
		const dir = join(root, "dedupe");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, "once.txt");
		await writeFile(filePath, "x");

		// When reading it
		const patch = await createFsService(makeDeps(root).deps).readEntries(dir, [filePath, filePath, filePath]);

		// Then it appears exactly once
		expect(patch.entries.map((entry) => entry.path)).toEqual([filePath]);
	});

	it("returns the final on-disk state across a delete and recreate", async () => {
		// Given a file
		const dir = join(root, "atomic");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, "save.txt");
		await writeFile(filePath, "old");
		const service = createFsService(makeDeps(root).deps);

		// When it exists, then is deleted, then is recreated with fresh content
		const first = await service.readEntries(dir, [filePath]);
		await rm(filePath);
		const afterDelete = await service.readEntries(dir, [filePath]);
		await writeFile(filePath, "recreated");

		// Then both the removal and the recreated entry are truthful
		expect(first.entries[0]?.size).toBe(3);
		expect(afterDelete.entries).toEqual([]);
		expect(afterDelete.removed).toEqual([filePath]);
		const afterRecreate = await service.readEntries(dir, [filePath]);
		expect(afterRecreate.removed).toEqual([]);
		expect(afterRecreate.entries[0]?.size).toBe("recreated".length);
	});

	it("reports missing and ENOTDIR children as removed", async () => {
		// Given a real directory and a regular file standing in as a "directory"
		const dir = join(root, "removals");
		await mkdir(dir, { recursive: true });
		const missing = join(dir, "gone.txt");
		const filePath = join(root, "not-a-dir.txt");
		await writeFile(filePath, "x");
		const child = join(filePath, "child.txt");
		const service = createFsService(makeDeps(root).deps);

		// When reading a missing child and a child under a non-directory
		const patch = await service.readEntries(dir, [missing]);
		const enotdir = await service.readEntries(filePath, [child]);

		// Then both are reported removed rather than failing
		expect(patch.removed).toEqual([missing]);
		expect(enotdir.removed).toEqual([child]);
	});

	it("rejects a relative directory or a path outside the requested dir", async () => {
		// Given an absolute directory
		const dir = join(root, "scope");
		await mkdir(dir, { recursive: true });
		const service = createFsService(makeDeps(root).deps);

		// When the scope is not absolute or the path is not a direct child
		await expect(service.readEntries("relative/dir", [])).rejects.toThrow(/absolute/);
		await expect(service.readEntries(dir, [join(root, "elsewhere.txt")])).rejects.toThrow(/direct child/);
		await expect(service.readEntries(dir, ["relative.txt"])).rejects.toThrow(/direct child/);
	});

	it("rethrows non-missing filesystem errors verbatim", async () => {
		// Given a child whose metadata read fails
		const dir = join(root, "incremental-error");
		const unreadable = join(dir, "unreadable.txt");
		await mkdir(dir, { recursive: true });
		await writeFile(unreadable, "x");
		unreadablePaths.add(unreadable);

		try {
			// When reading it, the real error surfaces rather than a false removal
			await expect(createFsService(makeDeps(root).deps).readEntries(dir, [unreadable])).rejects.toThrow(
				"simulated lstat failure",
			);
		} finally {
			unreadablePaths.delete(unreadable);
		}
	});
});

describe("exists", () => {
	it("returns false for a missing path and true for an existing path", async () => {
		const existing = join(root, "exists.txt");
		await writeFile(existing, "x");
		const service = createFsService(makeDeps(root).deps);

		await expect(service.exists(existing)).resolves.toBe(true);
		await expect(service.exists(join(root, "missing.txt"))).resolves.toBe(false);
	});

	it("rethrows non-missing filesystem errors verbatim", async () => {
		const service = createFsService(makeDeps(root).deps);
		const failure = await service.exists("\u0000").catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(TypeError);
		expect((failure as TypeError).message).toContain("null bytes");
	});
});

describe("copy", () => {
	it("copies into the destination with Finder-style collision naming", async () => {
		// Given a source file and a destination already holding "a.txt" and "a copy.txt"
		const srcDir = join(root, "src");
		const destDir = join(root, "dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "a.txt");
		await writeFile(source, "payload");
		await writeFile(join(destDir, "a.txt"), "old");
		await writeFile(join(destDir, "a copy.txt"), "old copy");

		// When copying the source into the destination
		const result = await createFsService(makeDeps(root).deps).copy([source], destDir);

		// Then the copy lands as "a copy 2.txt" with the original content
		expect(result.ok).toEqual([source]);
		expect(result.failed).toEqual([]);
		expect(await readFile(join(destDir, "a copy 2.txt"), "utf8")).toBe("payload");
	});

	it("uses ' copy' for the first collision", async () => {
		// Given a destination holding only the original name
		const srcDir = join(root, "src1");
		const destDir = join(root, "dest1");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "b.txt");
		await writeFile(source, "payload");
		await writeFile(join(destDir, "b.txt"), "old");

		// When copying the source into the destination
		await createFsService(makeDeps(root).deps).copy([source], destDir);

		// Then the copy lands as "b copy.txt"
		expect(await readFile(join(destDir, "b copy.txt"), "utf8")).toBe("payload");
	});

	it("reports per-path failures verbatim instead of throwing", async () => {
		// Given a path that does not exist
		const destDir = join(root, "dest2");
		await mkdir(destDir, { recursive: true });
		const missing = join(root, "missing.txt");

		// When copying it
		const result = await createFsService(makeDeps(root).deps).copy([missing], destDir);

		// Then the batch result names the failed path with a non-empty reason
		expect(result.ok).toEqual([]);
		expect(result.failed).toHaveLength(1);
		expect(result.failed[0]?.path).toBe(missing);
		expect(result.failed[0]?.message.length).toBeGreaterThan(0);
	});
});

describe("duplicate", () => {
	it("duplicates in place as '<name> copy' without touching the original", async () => {
		// Given a file
		const filePath = join(root, "doc.txt");
		await writeFile(filePath, "v1");

		// When duplicating it twice
		const service = createFsService(makeDeps(root).deps);
		await service.duplicate([filePath]);
		await service.duplicate([filePath]);

		// Then "doc copy.txt" and "doc copy 2.txt" exist next to the intact original
		expect(await readFile(join(root, "doc copy.txt"), "utf8")).toBe("v1");
		expect(await readFile(join(root, "doc copy 2.txt"), "utf8")).toBe("v1");
		expect(await readFile(filePath, "utf8")).toBe("v1");
	});
});

describe("rename", () => {
	it("rejects an empty name with a typed invalid-name error", async () => {
		// Given a file
		const filePath = join(root, "a.txt");
		await writeFile(filePath, "x");
		const service = createFsService(makeDeps(root).deps);

		// When renaming to an empty or whitespace-only name, Then a typed error is raised
		for (const badName of ["", "   "]) {
			const failure = await service.rename(filePath, badName).catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(FsRenameError);
			expect((failure as FsRenameError).code).toBe("invalid-name");
		}
	});

	it("rejects names containing path separators", async () => {
		// Given a file
		const filePath = join(root, "a.txt");
		await writeFile(filePath, "x");

		// When renaming to a name with a path separator, Then a typed invalid-name error is raised
		const failure = await createFsService(makeDeps(root).deps)
			.rename(filePath, "nested/a.txt")
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(FsRenameError);
		expect((failure as FsRenameError).code).toBe("invalid-name");
	});

	it("rejects a collision with an existing name", async () => {
		// Given two files
		const aPath = join(root, "a.txt");
		const bPath = join(root, "b.txt");
		await writeFile(aPath, "a");
		await writeFile(bPath, "b");

		// When renaming a.txt over b.txt, Then a typed name-collision error is raised and b.txt survives
		const failure = await createFsService(makeDeps(root).deps)
			.rename(aPath, "b.txt")
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(FsRenameError);
		expect((failure as FsRenameError).code).toBe("name-collision");
		expect(await readFile(bPath, "utf8")).toBe("b");
	});

	it("renames to a fresh name and returns the new entry", async () => {
		// Given a file
		const oldPath = join(root, "old.txt");
		await writeFile(oldPath, "content");

		// When renaming it
		const entry = await createFsService(makeDeps(root).deps).rename(oldPath, "new.txt");

		// Then the new entry points at the new path and the old path is gone
		expect(entry.name).toBe("new.txt");
		expect(entry.path).toBe(join(root, "new.txt"));
		expect(entry.kind).toBe("file");
		await expect(access(oldPath)).rejects.toThrow();
		expect(await readFile(entry.path, "utf8")).toBe("content");
	});
});

describe("createFolder", () => {
	it("creates 'untitled folder' and numbers subsequent folders on collision", async () => {
		// Given a fresh service
		const service = createFsService(makeDeps(root).deps);

		// When creating three folders in a row
		const first = await service.createFolder(root);
		const second = await service.createFolder(root);
		const third = await service.createFolder(root);

		// Then Finder-style names are chosen and the folders exist on disk
		expect(first).toEqual({ path: join(root, "untitled folder"), name: "untitled folder" });
		expect(second).toEqual({ path: join(root, "untitled folder 2"), name: "untitled folder 2" });
		expect(third).toEqual({ path: join(root, "untitled folder 3"), name: "untitled folder 3" });
		for (const folder of [first, second, third]) {
			expect((await stat(folder.path)).isDirectory()).toBe(true);
		}
	});

	it("skips over a non-folder entry that already owns the name", async () => {
		// Given a plain file occupying "untitled folder"
		await writeFile(join(root, "untitled folder"), "not a folder");
		const service = createFsService(makeDeps(root).deps);

		// When creating a folder, Then it takes the next number
		expect(await service.createFolder(root)).toEqual({
			path: join(root, "untitled folder 2"),
			name: "untitled folder 2",
		});
	});

	it("names the Nth attempt Finder-style", () => {
		expect([1, 2, 3, 11].map(untitledFolderName)).toEqual([
			"untitled folder",
			"untitled folder 2",
			"untitled folder 3",
			"untitled folder 11",
		]);
	});
});

describe("createFile", () => {
	it("creates 'untitled.txt' and numbers subsequent files on collision", async () => {
		// Given a fresh service
		const service = createFsService(makeDeps(root).deps);

		// When creating three text files in a row
		const first = await service.createFile(root, "text");
		const second = await service.createFile(root, "text");
		const third = await service.createFile(root, "text");

		// Then Finder-style names are chosen and the files exist on disk
		expect(first).toEqual({ path: join(root, "untitled.txt"), name: "untitled.txt" });
		expect(second.name).toBe("untitled 2.txt");
		expect(third.name).toBe("untitled 3.txt");
		expect(await readFile(first.path, "utf8")).toBe("");
	});

	it("writes the format's template bytes (docx is an OOXML package)", async () => {
		// Given a fresh service
		const service = createFsService(makeDeps(root).deps);

		// When creating a Word document
		const created = await service.createFile(root, "word");

		// Then the file carries the OOXML parts, not an empty placeholder
		expect(created.name).toBe("untitled.docx");
		expect(Object.keys(unzipSync(await readFile(created.path)))).toContain("word/document.xml");
	});

	it("skips over a non-file entry that already owns the name", async () => {
		// Given a directory occupying "untitled.txt"
		await mkdir(join(root, "untitled.txt"));
		const service = createFsService(makeDeps(root).deps);

		// When creating a file, Then it takes the next number
		expect((await service.createFile(root, "text")).name).toBe("untitled 2.txt");
	});

	it("names the Nth attempt Finder-style", () => {
		expect([1, 2, 3, 11].map((attempt) => untitledFileName("txt", attempt))).toEqual([
			"untitled.txt",
			"untitled 2.txt",
			"untitled 3.txt",
			"untitled 11.txt",
		]);
	});

	it("rejects a format outside the catalog", async () => {
		const service = createFsService(makeDeps(root).deps);
		await expect(service.createFile(root, "exe" as NewFileFormatId)).rejects.toThrow();
	});
});

describe("undo of a create", () => {
	it("removes the file a create made", async () => {
		// Given a created file
		const service = createFsService(makeDeps(root).deps);
		const created = await service.createFile(root, "text");

		// When undoing
		const outcome = await service.undo();

		// Then the created file is gone and the undo applied fully
		expect(outcome).toEqual({ ok: true, empty: false, failed: [] });
		await expect(access(created.path)).rejects.toThrow();
	});

	it("removes the folder a create made", async () => {
		// Given a created folder
		const service = createFsService(makeDeps(root).deps);
		const created = await service.createFolder(root);

		// When undoing, Then the folder is gone
		await service.undo();
		await expect(access(created.path)).rejects.toThrow();
	});

	it("consumes the record: a second undo reports empty", async () => {
		// Given a created file that was undone
		const service = createFsService(makeDeps(root).deps);
		await service.createFile(root, "text");
		await service.undo();

		// When undoing again, Then there is nothing left
		expect(await service.undo()).toEqual({ ok: false, empty: true, failed: [] });
	});
});

describe("in-app clipboard and move", () => {
	it("starts empty and round-trips a cut entry", async () => {
		// Given a fresh service
		const service = createFsService(makeDeps(root).deps);

		// Then the clipboard starts empty
		expect(await service.clipboardGet()).toBeNull();

		// When setting a cut clipboard
		await service.clipboardSet({ op: "cut", paths: [join(root, "clip.txt")] });

		// Then it round-trips
		expect(await service.clipboardGet()).toEqual({ op: "cut", paths: [join(root, "clip.txt")] });
	});

	it("moves the clipboard cut paths into the destination (cut + paste)", async () => {
		// Given a file captured in the clipboard as cut
		const srcDir = join(root, "cut-src");
		const destDir = join(root, "cut-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "move-me.txt");
		await writeFile(source, "moving");
		const service = createFsService(makeDeps(root).deps);
		await service.clipboardSet({ op: "cut", paths: [source] });

		// When pasting: reading the clipboard and moving its paths into the destination
		const clipboard = await service.clipboardGet();
		expect(clipboard?.op).toBe("cut");
		const result = await service.move(clipboard?.paths ?? [], destDir);

		// Then the file lives in the destination and the source is gone
		expect(result.ok).toEqual([source]);
		expect(await readFile(join(destDir, "move-me.txt"), "utf8")).toBe("moving");
		await expect(access(source)).rejects.toThrow();
	});

	it("applies collision naming when the destination already has the name", async () => {
		// Given a destination already holding the same file name
		const srcDir = join(root, "move-src");
		const destDir = join(root, "move-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "same.txt");
		await writeFile(source, "incoming");
		await writeFile(join(destDir, "same.txt"), "existing");

		// When moving the source into the destination
		await createFsService(makeDeps(root).deps).move([source], destDir);

		// Then it lands as "same copy.txt"
		expect(await readFile(join(destDir, "same copy.txt"), "utf8")).toBe("incoming");
		expect(await readFile(join(destDir, "same.txt"), "utf8")).toBe("existing");
	});
});

describe("trash", () => {
	it("routes paths through the injected shell (stubbed, no real Trash)", async () => {
		// Given a real file and a stubbed shell
		const filePath = join(root, "trash-me.txt");
		await writeFile(filePath, "x");
		const stubs = makeDeps(root);

		// When trashing it
		const result = await createFsService(stubs.deps).trash([filePath]);

		// Then the shell was asked to trash the path; the stub leaves the file on disk
		expect(result.ok).toEqual([filePath]);
		expect(stubs.trashed).toEqual([filePath]);
		expect(await readFile(filePath, "utf8")).toBe("x");
	});

	it("reports the shell error verbatim in the batch result", async () => {
		// Given a shell whose trashItem always fails
		const filePath = join(root, "trash-fail.txt");
		await writeFile(filePath, "x");

		// When trashing
		const result = await createFsService(makeFailingTrashDeps(root, "trash boom")).trash([filePath]);

		// Then the failure carries the path and the verbatim shell message
		expect(result.ok).toEqual([]);
		expect(result.failed).toEqual([{ path: filePath, message: "trash boom" }]);
	});

	it("retries a refused item once after a rename round trip, keeping its name", async () => {
		// Given three files and a shell that, like the iCloud Drive provider
		// partway through a batch, refuses the first attempt on every item after
		// the first
		const paths = ["a.txt", "b.txt", "c.txt"].map((name) => join(root, name));
		for (const path of paths) await writeFile(path, `body of ${path}`);
		const refuseOnce = new Set(paths.slice(1));
		const trashed: string[] = [];
		const stubs = makeDeps(root);
		const service = createFsService({
			...stubs.deps,
			shell: {
				...stubs.deps.shell,
				trashItem: async (path) => {
					if (refuseOnce.delete(path)) {
						throw new Error(`"${path}" couldn't be moved to the trash because you don't have permission to access it.`);
					}
					// The retry still finds the item under its own name and content.
					trashed.push(`${path}:${await readFile(path, "utf8")}`);
				},
			},
		});

		// When trashing all three in one batch
		const result = await service.trash(paths);

		// Then every item reached the Trash under its original name, and no
		// parked sibling was left behind
		expect(result).toEqual({ ok: paths, failed: [] });
		expect(trashed).toEqual(paths.map((path) => `${path}:body of ${path}`));
		expect((await readdir(root)).filter((name) => name.includes("autorag-trash"))).toEqual([]);
	});

	it("reports a refusal that survives the retry and leaves the item in place", async () => {
		// Given a file the shell refuses on every attempt
		const filePath = join(root, "stuck.txt");
		await writeFile(filePath, "stuck");

		// When trashing it
		const result = await createFsService(makeFailingTrashDeps(root, "no permission")).trash([filePath]);

		// Then the verbatim refusal is reported and the file is untouched
		expect(result).toEqual({ ok: [], failed: [{ path: filePath, message: "no permission" }] });
		expect(await readFile(filePath, "utf8")).toBe("stuck");
		expect(await readdir(root)).toEqual(["stuck.txt"]);
	});
});

describe("OS handoff path normalization", () => {
	it("normalizes forward slashes for Windows and leaves POSIX paths alone", () => {
		expect(toHandoffPath("C:/Users/me/Documents/a.txt", "win32")).toBe("C:\\Users\\me\\Documents\\a.txt");
		expect(toHandoffPath("C:\\Users\\me\\a.txt", "win32")).toBe("C:\\Users\\me\\a.txt");
		expect(toHandoffPath("/Users/me/a.txt", "darwin")).toBe("/Users/me/a.txt");
		expect(toHandoffPath("/Users/me/a.txt", "linux")).toBe("/Users/me/a.txt");
	});

	it("hands Windows trash/reveal/open backslash paths even when given slashes", async () => {
		// Given a win32 service whose shell records what it receives
		const stubs = makeDeps(root);
		const service = createFsService({ ...stubs.deps, platform: "win32" });

		// When the caller passes a forward-slash path (clipboard, QA fixture, other OS)
		const result = await service.trash(["C:/Users/me/Documents/a.txt"]);
		await service.reveal("C:/Users/me/Documents/b.txt");
		await service.open("C:/Users/me/Documents/c.txt");

		// Then the batch reports the caller's path but the shell sees backslashes
		expect(result).toEqual({ ok: ["C:/Users/me/Documents/a.txt"], failed: [] });
		expect(stubs.trashed).toEqual(["C:\\Users\\me\\Documents\\a.txt"]);
		expect(stubs.revealed).toEqual(["C:\\Users\\me\\Documents\\b.txt"]);
		expect(stubs.opened).toEqual(["C:\\Users\\me\\Documents\\c.txt"]);
	});
});
describe("undo", () => {
	it("removes the copies a copy created, keeping the originals", async () => {
		// Given a source file copied into another folder
		const srcDir = join(root, "undo-copy-src");
		const destDir = join(root, "undo-copy-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "undo-me.txt");
		await writeFile(source, "payload");
		const service = createFsService(makeDeps(root).deps);
		await service.copy([source], destDir);

		// When undoing the copy
		const outcome = await service.undo();

		// Then the copy is gone, the original stays, and the undo applied fully
		expect(outcome).toEqual({ ok: true, empty: false, failed: [] });
		expect(await readFile(source, "utf8")).toBe("payload");
		await expect(access(join(destDir, "undo-me.txt"))).rejects.toThrow();
	});

	it("removes a collision-named copy without touching the pre-existing file", async () => {
		// Given a destination already holding the same name
		const srcDir = join(root, "undo-collide-src");
		const destDir = join(root, "undo-collide-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "same.txt");
		await writeFile(source, "incoming");
		await writeFile(join(destDir, "same.txt"), "existing");
		const service = createFsService(makeDeps(root).deps);
		await service.copy([source], destDir);

		// When undoing the copy that landed as "same copy.txt"
		const outcome = await service.undo();

		// Then only the created copy is removed
		expect(outcome).toEqual({ ok: true, empty: false, failed: [] });
		expect(await readFile(join(destDir, "same.txt"), "utf8")).toBe("existing");
		await expect(access(join(destDir, "same copy.txt"))).rejects.toThrow();
		expect(await readFile(source, "utf8")).toBe("incoming");
	});

	it("moves rows back to their original folder after a move", async () => {
		// Given a file moved into another folder
		const srcDir = join(root, "undo-move-src");
		const destDir = join(root, "undo-move-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "move-back.txt");
		await writeFile(source, "payload");
		const service = createFsService(makeDeps(root).deps);
		await service.move([source], destDir);

		// When undoing the move
		const outcome = await service.undo();

		// Then the file is back in its original folder with its content
		expect(outcome).toEqual({ ok: true, empty: false, failed: [] });
		expect(await readFile(join(srcDir, "move-back.txt"), "utf8")).toBe("payload");
		await expect(access(join(destDir, "move-back.txt"))).rejects.toThrow();
	});

	it("keeps undoing to Finder-style collision names when the original name was retaken", async () => {
		// Given a moved file whose original folder now holds another file with the same name
		const srcDir = join(root, "undo-retake-src");
		const destDir = join(root, "undo-retake-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "retake.txt");
		await writeFile(source, "moved");
		const service = createFsService(makeDeps(root).deps);
		await service.move([source], destDir);
		await writeFile(join(srcDir, "retake.txt"), "new occupant");

		// When undoing the move
		const outcome = await service.undo();

		// Then the moved file returns under a " copy" name and both survive
		expect(outcome).toEqual({ ok: true, empty: false, failed: [] });
		expect(await readFile(join(srcDir, "retake copy.txt"), "utf8")).toBe("moved");
		expect(await readFile(join(srcDir, "retake.txt"), "utf8")).toBe("new occupant");
	});

	it("consumes the record: a second undo reports empty", async () => {
		// Given a copied file that was undone
		const srcDir = join(root, "undo-once-src");
		const destDir = join(root, "undo-once-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "once.txt");
		await writeFile(source, "payload");
		const service = createFsService(makeDeps(root).deps);
		await service.copy([source], destDir);
		await service.undo();
		await writeFile(join(destDir, "once.txt"), "recreated by the user");

		// When undoing again
		const outcome = await service.undo();

		// Then there is nothing left to undo and the user's file survives
		expect(outcome).toEqual({ ok: false, empty: true, failed: [] });
		expect(await readFile(join(destDir, "once.txt"), "utf8")).toBe("recreated by the user");
	});

	it("reports empty when no transfer was ever recorded", async () => {
		// Given a fresh service
		const outcome = await createFsService(makeDeps(root).deps).undo();

		// Then there is nothing to undo
		expect(outcome).toEqual({ ok: false, empty: true, failed: [] });
	});

	it("names a failed undo step with the verbatim reason", async () => {
		// Given a copy whose created file was already removed before the undo
		const srcDir = join(root, "undo-gone-src");
		const destDir = join(root, "undo-gone-dest");
		await mkdir(srcDir, { recursive: true });
		await mkdir(destDir, { recursive: true });
		const source = join(srcDir, "gone.txt");
		await writeFile(source, "payload");
		const service = createFsService(makeDeps(root).deps);
		await service.copy([source], destDir);
		await rm(join(destDir, "gone.txt"));

		// When undoing
		const outcome = await service.undo();

		// Then the failure carries the path and a non-empty reason
		expect(outcome.ok).toBe(false);
		expect(outcome.failed).toHaveLength(1);
		expect(outcome.failed[0]?.path).toBe(join(destDir, "gone.txt"));
		expect(outcome.failed[0]?.message.length).toBeGreaterThan(0);
	});
});

describe("search", () => {
	it("finds files and folders by case-insensitive name substring across locations", async () => {
		// Given a home whose Documents tree holds a matching file and a matching folder
		const home = join(root, "home");
		await mkdir(join(home, "Documents", "inner"), { recursive: true });
		await mkdir(join(home, "Downloads"), { recursive: true });
		await writeFile(join(home, "Documents", "inner", "report-final.txt"), "r");
		await mkdir(join(home, "Documents", "Quarterly Reports"));
		await writeFile(join(home, "Downloads", "unrelated.txt"), "u");

		// When searching for "report"
		const results = await createFsService(makeDeps(home).deps).search("REPORT");

		// Then both the file and the folder match, attributed to Documents, and unrelated files do not
		const names = results.map((hit) => hit.entry.name).sort();
		expect(names).toEqual(["Quarterly Reports", "report-final.txt"]);
		expect(results.every((hit) => hit.location === "Documents")).toBe(true);
	});

	it("returns nothing when no name matches", async () => {
		// Given a home with files that do not match the query
		const home = join(root, "home-empty");
		await mkdir(join(home, "Documents"), { recursive: true });
		await writeFile(join(home, "Documents", "alpha.txt"), "a");

		// When searching for a missing substring, Then the result is empty
		expect(await createFsService(makeDeps(home).deps).search("zzz-nothing")).toEqual([]);
	});

	it("prefers the file-name index and attributes each hit to its location", async () => {
		// Given two walkable matches, but an index that returns only the Documents one
		const home = join(root, "home-index");
		await mkdir(join(home, "Documents"), { recursive: true });
		await mkdir(join(home, "Downloads"), { recursive: true });
		await writeFile(join(home, "Documents", "report-final.txt"), "r");
		await writeFile(join(home, "Downloads", "report-other.txt"), "u");
		const calls: { query: string; scope: string | undefined }[] = [];
		const fileNameSearch: FileNameSearchBackend = {
			search: async (query, scope) => {
				calls.push({ query, scope });
				return [join(home, "Documents", "report-final.txt")];
			},
			ensureDaemon: async () => {},
			stop: async () => {},
		};

		// When searching
		const results = await createFsService({ ...makeDeps(home).deps, fileNameSearch }).search("REPORT");

		// Then only the indexed hit comes back, labeled by its location
		expect(results.map((hit) => [hit.entry.name, hit.location])).toEqual([["report-final.txt", "Documents"]]);
		expect(calls).toEqual([{ query: "REPORT", scope: undefined }]);
	});

	it("passes the current-folder scope to the index", async () => {
		// Given an index that records the scope it was asked for
		const home = join(root, "home-scope");
		await mkdir(join(home, "Documents"), { recursive: true });
		await writeFile(join(home, "Documents", "plan.txt"), "p");
		const scopes: (string | undefined)[] = [];
		const fileNameSearch: FileNameSearchBackend = {
			search: async (_query, scope) => {
				scopes.push(scope);
				return [join(home, "Documents", "plan.txt")];
			},
			ensureDaemon: async () => {},
			stop: async () => {},
		};

		// When searching with the folder in view as scope
		const results = await createFsService({ ...makeDeps(home).deps, fileNameSearch }).search("plan", {
			scope: join(home, "Documents"),
		});

		// Then the scope rode through and the hit is scoped to it
		expect(scopes).toEqual([join(home, "Documents")]);
		expect(results.map((hit) => hit.entry.path)).toEqual([join(home, "Documents", "plan.txt")]);
	});

	it("falls back to the disk walk when the index answers null", async () => {
		// Given an index with no database to answer from
		const home = join(root, "home-noindex");
		await mkdir(join(home, "Documents"), { recursive: true });
		await writeFile(join(home, "Documents", "report.txt"), "r");
		const fileNameSearch: FileNameSearchBackend = {
			search: async () => null,
			ensureDaemon: async () => {},
			stop: async () => {},
		};

		// When searching, Then the walk still finds the file
		const results = await createFsService({ ...makeDeps(home).deps, fileNameSearch }).search("report");

		expect(results.map((hit) => [hit.entry.name, hit.location])).toEqual([["report.txt", "Documents"]]);
	});

	it("falls back to the disk walk when the index throws", async () => {
		// Given an index that fails
		const home = join(root, "home-broken");
		await mkdir(join(home, "Documents"), { recursive: true });
		await writeFile(join(home, "Documents", "report.txt"), "r");
		const fileNameSearch: FileNameSearchBackend = {
			search: async () => {
				throw new Error("fsearch-cli exploded");
			},
			ensureDaemon: async () => {},
			stop: async () => {},
		};

		// When searching, Then the walk answers instead of surfacing the failure
		const results = await createFsService({ ...makeDeps(home).deps, fileNameSearch }).search("report");

		expect(results.map((hit) => hit.entry.name)).toEqual(["report.txt"]);
	});
});

describe("locations", () => {
	const disk: FsLocation = {
		name: "SSD1",
		path: "/Volumes/SSD1",
		section: "locations",
		icon: "disk",
		available: true,
		scanned: false,
		ejectable: true,
	};

	it("leads with Recents and the QA root, then the OS places in order", async () => {
		// Given OS places and a QA root
		const home = join(root, "home-locations");
		await mkdir(join(home, "qa"), { recursive: true });
		const places = fakePlaces([disk]);
		const service = createFsService({ ...makeDeps(home).deps, places, qaRoot: join(home, "qa") });

		// When listing locations
		const locations = await service.locations();

		// Then the app's own rows come first and the OS places follow untouched
		expect(locations.map((location) => location.name)).toEqual([RECENTS_PATH, "QA", "SSD1"]);
		expect(locations[1]).toMatchObject({ section: "favorites", icon: "qa", available: true, scanned: true });
	});

	it("searches only the scanned locations, never a whole disk", async () => {
		// Given a mounted disk and a scanned Documents folder that both hold a match
		const home = join(root, "home-scan");
		await mkdir(join(home, "Documents"), { recursive: true });
		await mkdir(join(home, "disk"), { recursive: true });
		await writeFile(join(home, "Documents", "plan.txt"), "p");
		await writeFile(join(home, "disk", "plan-copy.txt"), "p");
		const places = fakePlaces([
			{ ...disk, name: "Documents", path: join(home, "Documents"), section: "favorites", icon: "documents", scanned: true, ejectable: false },
			{ ...disk, path: join(home, "disk") },
		]);

		// When searching
		const hits = await createFsService({ ...makeDeps(home).deps, places }).search("plan");

		// Then only the Documents hit comes back
		expect(hits.map((hit) => [hit.entry.name, hit.location])).toEqual([["plan.txt", "Documents"]]);
	});

	it("ejects through the places service", async () => {
		// Given a mounted disk
		const places = fakePlaces([disk]);

		// When ejecting it from the fs bridge
		await createFsService({ ...makeDeps(root).deps, places }).ejectLocation("/Volumes/SSD1");

		// Then the places service unmounted exactly that path
		expect(places.ejected).toEqual(["/Volumes/SSD1"]);
	});
});

describe("Windows Recycle Bin listing", () => {
	it("shows each deleted item under its original name and hides the $I records", async () => {
		// Given a Recycle Bin folder with one $R payload and its $I record
		const bin = join(root, "bin");
		await mkdir(bin);
		await writeFile(join(bin, "$RAB12CD.txt"), "payload");
		const original = "C:\\Users\\me\\Documents\\메모.txt";
		const header = Buffer.alloc(28);
		header.writeBigInt64LE(2n, 0);
		header.writeInt32LE(original.length + 1, 24);
		await writeFile(join(bin, "$IAB12CD.txt"), Buffer.concat([header, Buffer.from(`${original}\0`, "utf16le")]));
		const service = createFsService({ ...makeDeps(root).deps, recycleBin: (dir) => dir === bin });

		// When listing it
		const listing = await service.listDir(bin);

		// Then the row keeps its real path but reads like Explorer
		expect(listing.entries.map((entry) => [entry.name, entry.path])).toEqual([["메모.txt", join(bin, "$RAB12CD.txt")]]);
	});
});

describe("shell and clipboard side effects", () => {
	it("reveal forwards the path to shell.showItemInFolder", async () => {
		// Given a stubbed shell
		const stubs = makeDeps(root);
		const filePath = join(root, "reveal.txt");
		await writeFile(filePath, "x");

		// When revealing the file
		await createFsService(stubs.deps).reveal(filePath);

		// Then the shell was asked to reveal it
		expect(stubs.revealed).toEqual([filePath]);
	});

	it("quickLook records the path and does not need an OS preview command", async () => {
		// Given a file
		const stubs = makeDeps(root);
		const filePath = join(root, "peek.txt");
		await writeFile(filePath, "x");

		// When opening Quick Look
		await createFsService(stubs.deps).quickLook(filePath);

		// Then only the recents list changes
		expect(await stubs.recents.list()).toEqual([filePath]);
		expect(stubs.opened).toEqual([]);
	});

	it("open forwards the path to shell.openPath, the OS default application", async () => {
		// Given a stubbed shell
		const stubs = makeDeps(root);
		const filePath = join(root, "deck.key");
		await writeFile(filePath, "x");

		// When opening the file like a double-click
		await createFsService(stubs.deps).open(filePath);

		// Then the shell was asked to open it with the OS default app
		expect(stubs.opened).toEqual([filePath]);
	});

	it("open rejects with the verbatim shell error message", async () => {
		// Given a shell that failed to open the path
		const deps: FsServiceDeps = {
			shell: {
				trashItem: async () => { },
				showItemInFolder: () => { },
				openPath: async () => "The file “deck.key” does not exist.",
				openExternal: async () => { },
			},
			clipboard: { writeText: () => { } },
			homeDir: root,
		};

		// When opening the file, the real message surfaces verbatim
		await expect(createFsService(deps).open(join(root, "deck.key"))).rejects.toThrow(
			"The file “deck.key” does not exist.",
		);
	});

	it("openUrl hands an http(s) page to the OS default browser", async () => {
		const stubs = makeDeps(root);
		await createFsService(stubs.deps).openUrl("https://v.daum.net/v/20250326175451054");
		expect(stubs.openedUrls).toEqual(["https://v.daum.net/v/20250326175451054"]);
	});

	it("openUrl refuses anything but an http(s) page without calling the shell", async () => {
		const stubs = makeDeps(root);
		const service = createFsService(stubs.deps);
		await expect(service.openUrl("file:///etc/passwd")).rejects.toThrow("웹 주소가 아닙니다");
		await expect(service.openUrl("/Users/me/brief.md")).rejects.toThrow("웹 주소가 아닙니다");
		expect(stubs.openedUrls).toEqual([]);
	});

	it("copyPathsToClipboard writes newline-joined paths to the OS clipboard", async () => {
		// Given a stubbed OS clipboard
		const stubs = makeDeps(root);

		// When copying two paths
		await createFsService(stubs.deps).copyPathsToClipboard(["/a/one.txt", "/b/two.txt"]);

		// Then the clipboard received them joined by newlines
		expect(stubs.clipboardText).toEqual(["/a/one.txt\n/b/two.txt"]);
	});
});

describe("recents", () => {
	it("lists the virtual Recents location first and always available", async () => {
		// Given a home with only Documents
		const home = join(root, "home-recents-location");
		await mkdir(join(home, "Documents"), { recursive: true });

		// When listing locations
		const locations = await createFsService(makeDeps(home).deps).locations();

		// Then Recents leads the favorites and is offered even before anything was opened
		expect(locations[0]).toEqual({
			name: RECENTS_PATH,
			path: RECENTS_PATH,
			section: "favorites",
			icon: "recents",
			available: true,
			scanned: false,
			ejectable: false,
		});
	});

	it("lists recorded files most-recent first and drops the ones that no longer exist", async () => {
		// Given two recorded files, the older of which has since been deleted
		const older = join(root, "recents-older.pdf");
		const newer = join(root, "recents-newer.xlsx");
		await writeFile(older, "old");
		await writeFile(newer, "new");
		const stubs = makeDeps(root);
		const service = createFsService(stubs.deps);
		await stubs.recents.record(older);
		await stubs.recents.record(newer);
		await rm(older);

		// When listing the virtual location
		const listing = await service.listDir(RECENTS_PATH);

		// Then the surviving file is listed in recency order with the contract shape
		expect(listing.path).toBe(RECENTS_PATH);
		expect(listing.entries.map((entry) => entry.path)).toEqual([newer]);
		expect(listing.entries[0]).toMatchObject({ name: "recents-newer.xlsx", kind: "file", ext: "xlsx" });
	});

	it("lists nothing before anything was opened", async () => {
		// Given a fresh service with no history
		// When listing the virtual location
		const listing = await createFsService(makeDeps(root).deps).listDir(RECENTS_PATH);

		// Then it is empty rather than an error
		expect(listing).toEqual({ path: RECENTS_PATH, entries: [] });
	});

	it("records a file opened with the OS default application", async () => {
		// Given a file
		const filePath = join(root, "opened.pdf");
		await writeFile(filePath, "x");
		const stubs = makeDeps(root);

		// When opening it like a double-click
		await createFsService(stubs.deps).open(filePath);

		// Then it joins the recent files
		expect(await stubs.recents.list()).toEqual([filePath]);
	});

	it("does not record a file whose open failed", async () => {
		// Given a shell that reports the file is gone
		const filePath = join(root, "gone.key");
		const stubs = makeDeps(root);
		const service = createFsService({
			...stubs.deps,
			shell: { ...stubs.deps.shell, openPath: async () => "The file “gone.key” does not exist." },
		});

		// When opening it
		await expect(service.open(filePath)).rejects.toThrow("The file “gone.key” does not exist.");

		// Then nothing was recorded
		expect(await stubs.recents.list()).toEqual([]);
	});

	it("records a file previewed with Quick Look", async () => {
		// Given a file
		const filePath = join(root, "previewed.md");
		await writeFile(filePath, "x");
		const stubs = makeDeps(root);

		// When previewing it
		await createFsService(stubs.deps).quickLook(filePath);

		// Then it joins the recent files
		expect(await stubs.recents.list()).toEqual([filePath]);
	});

	it("does not walk the virtual location while searching", async () => {
		// Given a home with a matching file and a watch on the diagnostics
		const home = join(root, "home-recents-search");
		await mkdir(join(home, "Documents"), { recursive: true });
		await writeFile(join(home, "Documents", "recents-probe.txt"), "x");
		const warnings: string[] = [];
		const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.join(" "));
		});

		// When searching
		const results = await createFsService(makeDeps(home).deps)
			.search("recents-probe")
			.finally(() => spy.mockRestore());

		// Then only the real location was walked
		expect(results.map((hit) => hit.location)).toEqual(["Documents"]);
		expect(warnings.filter((line) => line.includes(RECENTS_PATH))).toEqual([]);
	});
});

describe("osKind", () => {
	it("annotates each file with the OS-detected kind", async () => {
		// Given a folder with a video and a markdown file
		const dir = await mkdtemp(join(tmpdir(), "fs-oskind-"));
		await writeFile(join(dir, "clip.mp4"), "x");
		await writeFile(join(dir, "note.md"), "x");
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			osKind: async (_path, ext) => (ext === "mp4" ? "MPEG-4 movie" : ext === "md" ? "Markdown Document" : null),
		};

		const service = createFsService(deps);
		const listing = await service.listDir(dir);
		// The basic listing is immediately usable: a lean record with no blocking OS metadata.
		expect(listing.entries.find((entry) => entry.name === "clip.mp4")).toMatchObject({
			kind: "file",
			ext: "mp4",
			flags: 0,
		});
		const enriched = await service.enrichEntries(
			listing.entries.map(({ path, kind, ext, mtimeMs }) => ({ path, kind, ext, mtimeMs })),
			false,
		);
		expect(enriched.find((entry) => entry.path.endsWith("clip.mp4"))?.osKind).toBe("MPEG-4 movie");
		expect(enriched.find((entry) => entry.path.endsWith("note.md"))?.osKind).toBe("Markdown Document");
		await rm(dir, { recursive: true, force: true });
	});

	it("leaves folders without an OS kind", async () => {
		// Given a folder holding a subfolder
		const dir = await mkdtemp(join(tmpdir(), "fs-oskind-folder-"));
		await mkdir(join(dir, "sub"));

		// When listing and enriching it
		const service = createFsService(makeDeps(dir).deps);
		const listing = await service.listDir(dir);
		const sub = listing.entries.find((entry) => entry.name === "sub");
		expect(sub).toBeDefined();

		// Then enriching the subfolder yields no OS kind
		const enriched = await service.enrichEntries(
			[{ path: sub!.path, kind: sub!.kind, ext: sub!.ext, mtimeMs: sub!.mtimeMs }],
			false,
		);
		expect(enriched[0]?.osKind).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});

	it("degrades to null when the OS lookup fails, keeping the entry", async () => {
		// Given a folder whose OS lookup throws
		const dir = await mkdtemp(join(tmpdir(), "fs-oskind-fail-"));
		await writeFile(join(dir, "clip.mp4"), "x");
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			osKind: async () => {
				throw new Error("mdls: boom");
			},
		};

		// When listing and enriching it
		const service = createFsService(deps);
		const listing = await service.listDir(dir);
		const entry = listing.entries.find((candidate) => candidate.name === "clip.mp4");
		expect(entry?.ext).toBe("mp4");

		// Then the entry survives the failed lookup with no OS kind
		const enriched = await service.enrichEntries(
			[{ path: entry!.path, kind: entry!.kind, ext: entry!.ext, mtimeMs: entry!.mtimeMs }],
			false,
		);
		expect(enriched[0]?.osKind).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});
});

describe("icons", () => {
	it("annotates each file with the OS tile icon", async () => {
		// Given a folder whose provider produced an icon for the video only
		const dir = await mkdtemp(join(tmpdir(), "fs-icons-"));
		await writeFile(join(dir, "clip.mp4"), "x");
		await writeFile(join(dir, "note.txt"), "x");
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			icons: {
				icons: async (targets) =>
					new Map(
						targets
							.filter((target) => target.path.endsWith(".mp4"))
							.map((target) => [target.path, "autorag-thumb://local/?path=clip.mp4&mtime=2026-09-29T00%3A00%3A00.000Z"]),
					),
				preview: async () => null,
			},
		};

		const service = createFsService(deps);
		const listing = await service.listDir(dir);
		const enriched = await service.enrichEntries(
			listing.entries.map(({ path, kind, ext, mtimeMs }) => ({ path, kind, ext, mtimeMs })),
			true,
		);
		expect(enriched.find((entry) => entry.path.endsWith("clip.mp4"))?.iconUrl).toBe(
			"autorag-thumb://local/?path=clip.mp4&mtime=2026-09-29T00%3A00%3A00.000Z",
		);
		expect(enriched.find((entry) => entry.path.endsWith("note.txt"))?.iconUrl).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});

	it("returns icons without waiting for Finder metadata, which arrives on its own call", async () => {
		// Given Finder metadata that never answers until released (a slow disk)
		const dir = await mkdtemp(join(tmpdir(), "fs-icons-metadata-"));
		await writeFile(join(dir, "photo.jpg"), "x");
		const release = Promise.withResolvers<void>();
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			icons: {
				icons: async (targets) => new Map(targets.map((target) => [target.path, "autorag-thumb://local/?path=photo.jpg&mtime=t"])),
				preview: async () => null,
			},
			finderMetadata: async () => {
				await release.promise;
				return { createdAt: null, addedAt: null, lastOpenedAt: null, tags: ["Red"], comments: null, width: 4, height: 3, rating: null, application: null };
			},
		};
		const service = createFsService(deps);
		const listing = await service.listDir(dir);
		const targets = listing.entries.map(({ path, kind, ext, mtimeMs }) => ({ path, kind, ext, mtimeMs }));

		// When both passes start, the icon pass settles while metadata is still pending
		const metadata = service.finderMetadata(targets);
		const enriched = await service.enrichEntries(targets, true);
		expect(enriched[0]?.iconUrl).toBe("autorag-thumb://local/?path=photo.jpg&mtime=t");

		// Then the metadata lands separately, echoing the requested identity
		release.resolve();
		expect(await metadata).toEqual([
			{ path: targets[0]?.path, mtimeMs: targets[0]?.mtimeMs, finder: expect.objectContaining({ tags: ["Red"], width: 4, height: 3 }) },
		]);
		await rm(dir, { recursive: true, force: true });
	});
});

describe("previewIcon", () => {
	it("serves the Inspector preview through the provider's large tier", async () => {
		// Given a provider whose preview tier answers a 640px URL for the file
		const dir = await mkdtemp(join(tmpdir(), "fs-preview-"));
		await writeFile(join(dir, "deck.pdf"), "x");
		const seen: Array<{ readonly path: string; readonly ext: string; readonly mtimeMs: number }> = [];
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			icons: {
				icons: async () => new Map(),
				preview: async (target) => {
					seen.push({ path: target.path, ext: target.ext, mtimeMs: target.mtimeMs });
					return "autorag-thumb://local/?path=deck.pdf&mtime=t&size=640";
				},
			},
		};

		// When the inspector asks for the file's preview
		const service = createFsService(deps);
		const url = await service.previewIcon(join(dir, "deck.pdf"), Date.parse("2026-09-29T00:00:00.000Z"));

		// Then the provider answered for exactly that identity, extension included for the visual-types gate
		expect(url).toBe("autorag-thumb://local/?path=deck.pdf&mtime=t&size=640");
		expect(seen).toEqual([{ path: join(dir, "deck.pdf"), ext: "pdf", mtimeMs: Date.parse("2026-09-29T00:00:00.000Z") }]);
		await rm(dir, { recursive: true, force: true });
	});

	it("returns null when the OS has no preview for the file, so the panel keeps its letter tile", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fs-preview-"));
		const deps: FsServiceDeps = {
			...makeDeps(dir).deps,
			icons: { icons: async () => new Map(), preview: async () => null },
		};

		const service = createFsService(deps);

		expect(await service.previewIcon(join(dir, "a.bin"), Date.parse("2026-09-29T00:00:00.000Z"))).toBeNull();
		await rm(dir, { recursive: true, force: true });
	});
});
