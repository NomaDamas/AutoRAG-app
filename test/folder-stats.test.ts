import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFolderStats, formatFolderStats } from "../src/main/agents/profiles/folder-stats";
import { measureFolder, type FolderStatsOptions } from "../src/main/folder-stats";

let root: string;
const OPTIONS: FolderStatsOptions = { supportedExtensions: new Set([".txt", ".md", ".pdf"]), maxSourceBytes: 100 };
const LIVE = new AbortController().signal;

async function put(path: string, body = "x"): Promise<void> {
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, path), body);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "folder-stats-"));
	for (let i = 1; i <= 60; i += 1) await put(`chat/messages${i}.txt`);
	for (let i = 1; i <= 10; i += 1) await put(`chat/photo${i}.jpg`);
	for (let i = 1; i <= 40; i += 1) await put(`photos/img${i}.jpg`);
	for (let i = 1; i <= 25; i += 1) await put(`Docs/report-${String.fromCharCode(96 + i)}.md`);
	for (let i = 1; i <= 5; i += 1) await put(`Docs/contract-${String.fromCharCode(96 + i)}.pdf`);
	await put("Docs/notes.md");
	await put("node_modules/pkg/readme.md");
	await put(".hidden/secret.md");
	await put("top.txt");
	await put("big.txt", "y".repeat(500));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("measureFolder", () => {
	it("counts a folder's files by extension, subfolders included, and what the index would read", async () => {
		const stats = await measureFolder(join(root, "chat"), [], OPTIONS, LIVE);

		expect(stats).toMatchObject({ indexedFiles: 60, totalFiles: 70, truncated: false });
		expect(stats.extensions).toEqual([
			{ extension: ".txt", files: 60, indexed: true },
			{ extension: ".jpg", files: 10, indexed: false },
		]);
		expect(stats.measure).toMatchObject({ indexedFiles: 60, totalFiles: 70, topExtension: ".txt", topExtensionShare: 1, appDataName: null });
		// messages1 .. messages60 differ only in digits: one distinct name in sixty files.
		expect(stats.measure.stemRatio).toBeCloseTo(1 / 60, 5);
	});

	it("counts files in nested subfolders, skips dot folders and the app's skipped names, and leaves out oversize sources", async () => {
		const stats = await measureFolder(root, [], OPTIONS, LIVE);

		// chat 60 + Docs 31 + top.txt 1; big.txt is over the size cap; node_modules and .hidden are never walked.
		expect(stats.indexedFiles).toBe(60 + 31 + 1);
		expect(stats.totalFiles).toBe(70 + 40 + 31 + 1 + 1);
		expect(stats.indexedBytes).toBe(92);
	});

	it("breaks a folder down by its subfolders, largest first, with each one's own numbers", async () => {
		const stats = await measureFolder(root, [], OPTIONS, LIVE);

		expect(stats.children.map((child) => [child.name, child.indexedFiles, child.totalFiles])).toEqual([
			["chat", 60, 70],
			["Docs", 31, 31],
			["photos", 0, 40],
		]);
		expect(stats.children[0]?.measure).toMatchObject({ topExtension: ".txt", topExtensionShare: 1 });
		expect(stats.children[2]?.measure).toMatchObject({ indexedFiles: 0, topExtension: null, topExtensionShare: 0, stemRatio: 0 });
	});

	it("names the app-data folder on the way down to a subfolder, for the folder and for each of its children", async () => {
		await put("Work/logs/a.txt");
		await put("Work/Reports/b.md");

		const work = await measureFolder(join(root, "Work"), ["Work"], OPTIONS, LIVE);
		expect(work.measure.appDataName).toBeNull();
		expect(work.children.find((child) => child.name === "logs")?.measure.appDataName).toBe("logs");
		expect(work.children.find((child) => child.name === "Reports")?.measure.appDataName).toBeNull();

		const inside = await measureFolder(join(root, "Work", "logs"), ["Work", "logs"], OPTIONS, LIVE);
		expect(inside.measure.appDataName).toBe("logs");
	});

	it("does not follow a symbolic link out of the folder", async () => {
		const outside = await mkdtemp(join(tmpdir(), "folder-stats-outside-"));
		try {
			await writeFile(join(outside, "x.txt"), "x");
			await symlink(outside, join(root, "link"));

			const stats = await measureFolder(root, [], OPTIONS, LIVE);
			expect(stats.children.some((child) => child.name === "link")).toBe(false);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("says it stopped early when the walk hits its entry limit or is cancelled", async () => {
		expect((await measureFolder(root, [], { ...OPTIONS, maxEntries: 20 }, LIVE)).truncated).toBe(true);

		const cancelled = new AbortController();
		cancelled.abort();
		expect((await measureFolder(root, [], OPTIONS, cancelled.signal)).truncated).toBe(true);
	});
});

describe("folder_stats report", () => {
	it("reports the numbers, the extension mix, the criteria that hold and the largest subfolders", async () => {
		const report = await createFolderStats([root], OPTIONS).report(root, LIVE);

		expect(report.ok).toBe(true);
		const text = report.ok ? report.text : "";
		expect(text).toContain(`${root}`);
		expect(text).toContain("92 indexed files of 143 files in all");
		// big.txt is over the size cap, so the index skips it, but it is still a .txt file in the folder.
		expect(text).toContain(".txt 62 (indexed)");
		expect(text).toContain(".jpg 50");
		expect(text).toContain("chat/");
		expect(text).toContain("indexed 60 of 70");
		// chat is a series; photos holds no indexed file, so it is below the minimum and gets no verdict.
		expect(text).toMatch(/chat\/.*series/u);
		expect(text).not.toMatch(/photos\/.*(series|sparse)/u);
	});

	it("tells the model when a criterion holds for the folder itself", async () => {
		const report = await createFolderStats([root], OPTIONS).report(join(root, "chat"), LIVE);

		expect(report.ok && report.text).toContain("criteria met: series");
	});

	it("says no criterion holds when none does", async () => {
		const report = await createFolderStats([root], OPTIONS).report(join(root, "Docs"), LIVE);

		expect(report.ok && report.text).toContain("criteria met: none");
	});

	it("refuses anything but an existing folder inside a chosen one", async () => {
		const stats = createFolderStats([root], OPTIONS);

		for (const path of ["relative/chat", "/etc", join(root, "missing"), join(root, "top.txt"), join(root, "..")]) {
			const report = await stats.report(path, LIVE);
			expect(report.ok, path).toBe(false);
		}
	});

	it("accepts a chosen folder itself and a folder below it", async () => {
		const stats = createFolderStats([root], OPTIONS);

		expect((await stats.report(root, LIVE)).ok).toBe(true);
		expect((await stats.report(join(root, "Docs"), LIVE)).ok).toBe(true);
	});

	it("marks a partial count as such", () => {
		const text = formatFolderStats(
			"/a",
			{ indexedFiles: 1, totalFiles: 1, indexedBytes: 1, extensions: [], children: [], truncated: true, measure: { indexedFiles: 1, totalFiles: 1, topExtension: null, topExtensionShare: 0, stemRatio: 1, appDataName: null } },
		);

		expect(text).toContain("partial");
	});
});
