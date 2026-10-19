import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFolderSurvey, formatSurvey } from "../src/main/agents/profiles/folder-stats";
import { measureFolder, type FolderStatsOptions } from "../src/main/folder-stats";

let root: string;
const OPTIONS: FolderStatsOptions = { supportedExtensions: new Set([".txt", ".md", ".pdf"]), maxSourceBytes: 100 };
const LIVE = new AbortController().signal;
const DAY = 86_400_000;

async function put(path: string, body = "x", modifiedDaysAgo?: number): Promise<void> {
	await mkdir(join(root, path, ".."), { recursive: true });
	await writeFile(join(root, path), body);
	if (modifiedDaysAgo !== undefined) {
		const when = new Date(Date.now() - modifiedDaysAgo * DAY);
		await utimes(join(root, path), when, when);
	}
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "folder-stats-"));
	for (let i = 1; i <= 60; i += 1) await put(`chat/messages${i}.txt`, "x", 3);
	for (let i = 1; i <= 10; i += 1) await put(`chat/photo${i}.jpg`, "x", 3);
	for (let i = 1; i <= 40; i += 1) await put(`photos/img${i}.jpg`);
	for (let i = 1; i <= 25; i += 1) await put(`Docs/report-${String.fromCharCode(96 + i)}.md`, "x", 400);
	for (let i = 1; i <= 5; i += 1) await put(`Docs/contract-${String.fromCharCode(96 + i)}.pdf`, "x", 30);
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
		const stats = await measureFolder(join(root, "chat"), OPTIONS, LIVE);

		expect(stats).toMatchObject({ indexedFiles: 60, totalFiles: 70, truncated: false });
		expect(stats.extensions).toEqual([
			{ extension: ".txt", files: 60, indexed: true },
			{ extension: ".jpg", files: 10, indexed: false },
		]);
	});

	it("counts files in nested subfolders, skips dot folders and the app's skipped names, and leaves out oversize sources", async () => {
		const stats = await measureFolder(root, OPTIONS, LIVE);

		// chat 60 + Docs 31 + top.txt 1; big.txt is over the size cap; node_modules and .hidden are never walked.
		expect(stats.indexedFiles).toBe(60 + 31 + 1);
		expect(stats.totalFiles).toBe(70 + 40 + 31 + 1 + 1);
		expect(stats.indexedBytes).toBe(92);
	});

	it("breaks a folder down by its subfolders, most files first, with each one's own counts", async () => {
		const stats = await measureFolder(root, OPTIONS, LIVE);

		expect(stats.children.map((child) => [child.name, child.indexedFiles, child.totalFiles])).toEqual([
			["chat", 60, 70],
			["photos", 0, 40],
			["Docs", 31, 31],
		]);
	});

	it("reports when the files were last changed: the oldest and newest, and how many changed within a day of the median", async () => {
		const stats = await measureFolder(join(root, "chat"), OPTIONS, LIVE);

		expect(stats.modified).not.toBeNull();
		// All seventy files were written three days ago, so they changed together.
		expect(stats.modified?.spanDays).toBeLessThan(1);
		expect(stats.modified?.sameDayShare).toBe(1);

		const docs = await measureFolder(join(root, "Docs"), OPTIONS, LIVE);
		expect(docs.modified?.spanDays).toBeGreaterThan(300);
		expect(docs.modified?.sameDayShare).toBeLessThan(0.9);
	});

	it("samples file names spread over the folder, not only the first ones", async () => {
		const stats = await measureFolder(join(root, "chat"), { ...OPTIONS, sampleNames: 8 }, LIVE);

		expect(stats.sample).toHaveLength(8);
		expect(new Set(stats.sample).size).toBe(8);
		// Files are listed in name order here; a spread sample reaches past the first eight names.
		expect(stats.sample.some((name) => /messages(4|5|6)\d?\.txt|photo/u.test(name))).toBe(true);
	});

	it("does not follow a symbolic link out of the folder", async () => {
		const outside = await mkdtemp(join(tmpdir(), "folder-stats-outside-"));
		try {
			await writeFile(join(outside, "x.txt"), "x");
			await symlink(outside, join(root, "link"));

			const stats = await measureFolder(root, OPTIONS, LIVE);
			expect(stats.children.some((child) => child.name === "link")).toBe(false);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("says it stopped early when the walk hits its entry limit or is cancelled", async () => {
		expect((await measureFolder(root, { ...OPTIONS, maxEntries: 20 }, LIVE)).truncated).toBe(true);

		const cancelled = new AbortController();
		cancelled.abort();
		expect((await measureFolder(root, OPTIONS, cancelled.signal)).truncated).toBe(true);
	});
});

describe("what a subfolder contains", () => {
	it("names the subfolders inside each subfolder with their file counts, so a mixed folder shows its parts", async () => {
		const other = await mkdtemp(join(tmpdir(), "folder-stats-nested-"));
		try {
			const at = async (path: string): Promise<void> => {
				await mkdir(join(other, path, ".."), { recursive: true });
				await writeFile(join(other, path), "x");
			};
			for (let i = 1; i <= 5; i += 1) await at(`work/exports/report${i}.pdf`);
			for (let i = 1; i <= 3; i += 1) await at(`work/sync/copy${i}.txt`);
			for (let i = 1; i <= 2; i += 1) await at(`work/exports/deeper/old${i}.pdf`);
			await at("work/top.txt");

			const stats = await measureFolder(other, OPTIONS, LIVE);
			const work = stats.children.find((child) => child.name === "work");

			// exports counts its own files and what is under it; files directly in work belong to no subfolder.
			expect(work?.subfolders).toEqual([
				{ name: "exports", totalFiles: 7 },
				{ name: "sync", totalFiles: 3 },
			]);

			const report = await createFolderSurvey([other], OPTIONS).report(other, LIVE);
			expect(report.ok && report.text).toContain("subfolders: exports/ 7, sync/ 3");
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});

	it("lists no subfolders for a subfolder that has none", async () => {
		const stats = await measureFolder(root, OPTIONS, LIVE);

		expect(stats.children.find((child) => child.name === "chat")?.subfolders).toEqual([]);
	});
});

describe("a folder with very many subfolders", () => {
	async function manySubfolders(count: number): Promise<string> {
		const base = await mkdtemp(join(tmpdir(), "folder-stats-many-"));
		for (let i = 1; i <= count; i += 1) {
			const dir = join(base, `project-${String(i).padStart(4, "0")}`);
			await mkdir(dir, { recursive: true });
			// The first ten folders hold more files, so they are the largest and come first; the rest hold one.
			for (let f = 0; f < (i <= 10 ? 12 - i : 1); f += 1) await writeFile(join(dir, `file${f}.txt`), "x");
		}
		return base;
	}

	it("names every subfolder up to 500, not only the first 25", async () => {
		const base = await manySubfolders(120);
		try {
			const report = await createFolderSurvey([base], OPTIONS).report(base, LIVE);
			const text = report.ok ? report.text : "";

			for (const n of [1, 25, 26, 60, 120]) expect(text, `project-${String(n).padStart(4, "0")}`).toContain(`project-${String(n).padStart(4, "0")}/`);
			expect(text).not.toMatch(/and \d+ more subfolders/u);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("describes the largest subfolders in full and gives the rest one line each, so the report stays small", async () => {
		const base = await manySubfolders(500);
		try {
			const report = await createFolderSurvey([base], OPTIONS).report(base, LIVE);
			const text = report.ok ? report.text : "";

			// Detailed blocks carry sample names; compact lines do not, so far fewer blocks than subfolders.
			expect((text.match(/sample names:/gu) ?? []).length).toBeLessThan(250);
			expect(text).toContain("project-0001/");
			expect(text).toContain("project-0500/");
			// Five hundred full blocks would be about 300,000 characters.
			expect(text.length).toBeLessThan(150_000);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("says how many subfolders it left out when there are more than 500", async () => {
		const base = await manySubfolders(520);
		try {
			const report = await createFolderSurvey([base], OPTIONS).report(base, LIVE);
			const text = report.ok ? report.text : "";

			expect(text).toMatch(/and 20 more subfolders/u);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});

	it("counts every subfolder the report names as surveyed, so any of them can be proposed", async () => {
		const base = await manySubfolders(120);
		try {
			const survey = createFolderSurvey([base], OPTIONS);
			await survey.report(base, LIVE);

			expect(survey.counted(join(base, "project-0001"))).toBe(true);
			expect(survey.counted(join(base, "project-0120"))).toBe(true);
		} finally {
			await rm(base, { recursive: true, force: true });
		}
	});
});

describe("folder_survey report", () => {
	it("reports facts only: counts, the extension mix, when files changed, names, and the subfolders with the same", async () => {
		const report = await createFolderSurvey([root], OPTIONS).report(root, LIVE);

		expect(report.ok).toBe(true);
		const text = report.ok ? report.text : "";
		expect(text).toContain("92 indexed files of 143 files in all");
		// big.txt is over the size cap, so the index skips it, but it is still a .txt file in the folder.
		expect(text).toContain(".txt 62 (indexed)");
		expect(text).toContain(".jpg 50");
		expect(text).toContain("chat/");
		expect(text).toContain("indexed 60 of 70");
		expect(text).toMatch(/sample names/iu);
		expect(text).toMatch(/modified/iu);
	});

	it("gives no verdict: nothing in the report says a folder should be left out", async () => {
		const report = await createFolderSurvey([root], OPTIONS).report(root, LIVE);
		const text = report.ok ? report.text : "";

		expect(text).not.toMatch(/criteria|series|sparse|appData|verdict|exclude|leave out/iu);
	});

	it("names a few files from each subfolder, so a subfolder can be judged without opening it", async () => {
		const report = await createFolderSurvey([root], { ...OPTIONS, sampleNames: 6 }).report(root, LIVE);
		const text = report.ok ? report.text : "";

		expect(text).toMatch(/chat\/.*messages\d+\.txt/su);
		expect(text).toMatch(/Docs\/.*(report-|contract-|notes)/su);
	});

	it("lists the entries directly in the folder, so what sits beside the subfolders is visible", async () => {
		const report = await createFolderSurvey([root], OPTIONS).report(root, LIVE);
		const text = report.ok ? report.text : "";

		expect(text).toContain("top.txt");
	});

	it("refuses anything but an existing folder inside a chosen one", async () => {
		const survey = createFolderSurvey([root], OPTIONS);

		for (const path of ["relative/chat", "/etc", join(root, "missing"), join(root, "top.txt"), join(root, "..")]) {
			const report = await survey.report(path, LIVE);
			expect(report.ok, path).toBe(false);
		}
	});

	it("accepts a chosen folder itself and a folder below it, and remembers which it looked at", async () => {
		const survey = createFolderSurvey([root], OPTIONS);

		expect((await survey.report(root, LIVE)).ok).toBe(true);
		expect((await survey.report(join(root, "Docs"), LIVE)).ok).toBe(true);
		expect(survey.counted(root)).toBe(true);
		expect(survey.counted(join(root, "Docs"))).toBe(true);
		// The root's report described chat/ (counts, dates, names), so it counts as looked at.
		expect(survey.counted(join(root, "chat"))).toBe(true);
		// Not described by any report: a folder two levels down, and one outside.
		expect(survey.counted(join(root, "chat", "deeper"))).toBe(false);
		expect(survey.counted(join(root, "..", "elsewhere"))).toBe(false);
	});

	it("marks a partial count as such", () => {
		const text = formatSurvey("/a", {
			indexedFiles: 1,
			totalFiles: 1,
			indexedBytes: 1,
			extensions: [],
			children: [],
			ownFiles: [],
			sample: [],
			modified: null,
			truncated: true,
		});

		expect(text).toContain("partial");
	});
});
