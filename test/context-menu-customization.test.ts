import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSettingsService } from "../src/main/settings-service";
import {
	CONTEXT_MENU_SECTION_IDS,
	DEFAULT_CONTEXT_MENU_SETTINGS,
	isDefaultContextMenuSettings,
	isLockedContextMenuItemId,
	matchesMagicAction,
	normalizeContextMenuItemId,
	normalizeContextMenuSettings,
	normalizeExtensionList,
	type MagicAction,
} from "../src/shared/context-menu-contract";
import { isMagicActionRunRequest } from "../src/shared/magic-actions-contract";

describe("context-menu-contract normalization, locked Tags invariant & MagicAction matching", () => {
	it("treats Tags (`builtin:tags` and natural-language aliases) as locked and strips them from hiddenItems & hiddenSections", () => {
		for (const locked of ["builtin:tags", "tags", "tag", "태그", "タグ", "标签"]) {
			expect(isLockedContextMenuItemId(locked), locked).toBe(true);
		}
		expect(isLockedContextMenuItemId("builtin:copy")).toBe(false);
		expect(normalizeContextMenuItemId("복사")).toBe("builtin:copy");
		expect(normalizeContextMenuItemId("이름 변경")).toBe("builtin:rename");
		expect(normalizeContextMenuItemId("휴지통")).toBe("builtin:trash");

		const normalized = normalizeContextMenuSettings({
			hiddenItems: ["builtin:tags", "태그", "copy", "builtin:rename", "compress", "copy", "unknown-junk"],
			hiddenSections: ["tags", "clipboard", "invalid"],
			sectionOrder: ["magic", "clipboard"],
			magicActions: [
				{
					id: " Summarize PDF ",
					label: "  PDF 요약하기  ",
					enabled: true,
					selection: "single",
					targetKind: "file",
					extensions: [".PDF", "md", "  .Docx  ", "pdf"],
					execution: {
						kind: "agent",
						mode: "read",
						prompt: "  이 문서를 핵심 3줄로 요약해줘  ",
					},
				},
				{
					// Duplicate ID should be deduplicated
					id: "summarize-pdf",
					label: "Duplicate",
					execution: { kind: "agent", mode: "read", prompt: "ignored" },
				},
				{
					// Invalid empty label or empty execution is dropped
					id: "broken",
					label: "   ",
					execution: { kind: "script", command: "" },
				},
			],
		});

		expect(normalized.hiddenItems).toEqual(["builtin:copy", "builtin:rename", "builtin:compress"]);
		expect(normalized.hiddenSections).toEqual(["clipboard"]);
		expect(normalized.sectionOrder).toEqual([
			"magic",
			"clipboard",
			...CONTEXT_MENU_SECTION_IDS.filter((s) => s !== "magic" && s !== "clipboard"),
		]);
		expect(normalized.magicActions).toHaveLength(1);
		expect(normalized.magicActions[0]).toEqual({
			id: "summarize-pdf",
			label: "PDF 요약하기",
			enabled: true,
			selection: "single",
			targetKind: "file",
			extensions: ["pdf", "md", "docx"],
			execution: {
				kind: "agent",
				mode: "read",
				prompt: "이 문서를 핵심 3줄로 요약해줘",
				useSkills: true,
				useMcp: true,
			},
		});

		const optedOut = normalizeContextMenuSettings({
			magicActions: [
				{
					id: "no-mcp-skills",
					label: "격리 요약",
					execution: {
						kind: "agent",
						mode: "read",
						prompt: "요약",
						useSkills: false,
						useMcp: false,
					},
				},
			],
		});
		expect(optedOut.magicActions[0]?.execution).toEqual({
			kind: "agent",
			mode: "read",
			prompt: "요약",
			useSkills: false,
			useMcp: false,
		});
		expect(isDefaultContextMenuSettings(normalized)).toBe(false);
		expect(isDefaultContextMenuSettings(DEFAULT_CONTEXT_MENU_SETTINGS)).toBe(true);
	});

	it("normalizes extension lists from comma/space/dot strings or arrays", () => {
		expect(normalizeExtensionList([".PDF", " png ", "tar.gz", ".JPG", "pdf", ""])).toEqual([
			"pdf",
			"png",
			"tar.gz",
			"jpg",
		]);
	});

	it("matches MagicAction conditions across single/multi selection, file/folder kind, and extensions", () => {
		const singlePdfAction: MagicAction = {
			id: "pdf-summary",
			label: "PDF 요약",
			enabled: true,
			selection: "single",
			targetKind: "file",
			extensions: ["pdf"],
			execution: { kind: "agent", mode: "read", prompt: "Summarize" },
		};

		const multiImageScript: MagicAction = {
			id: "batch-png",
			label: "이미지 일괄 처리",
			enabled: true,
			selection: "multiple",
			targetKind: "file",
			extensions: ["png", "jpg"],
			execution: { kind: "script", command: "echo $DAZZI_FILE_COUNT" },
		};

		const anyFolderAction: MagicAction = {
			id: "folder-organize",
			label: "폴더 정리",
			enabled: true,
			selection: "any",
			targetKind: "folder",
			extensions: [],
			execution: { kind: "agent", mode: "organize", prompt: "Organize folder" },
		};

		// Single PDF matches singlePdfAction, fails on multi or non-pdf or folder
		expect(matchesMagicAction(singlePdfAction, [{ name: "report.PDF", kind: "file" }])).toBe(true);
		expect(matchesMagicAction(singlePdfAction, [{ name: "report.pdf", kind: "file" }, { name: "b.pdf", kind: "file" }])).toBe(false);
		expect(matchesMagicAction(singlePdfAction, [{ name: "notes.txt", kind: "file" }])).toBe(false);
		expect(matchesMagicAction(singlePdfAction, [{ name: "Docs", kind: "folder" }])).toBe(false);

		// Disabled action never matches
		expect(matchesMagicAction({ ...singlePdfAction, enabled: false }, [{ name: "report.pdf", kind: "file" }])).toBe(false);

		// Multiple image script requires >= 2 files and every selected file to match extensions
		expect(matchesMagicAction(multiImageScript, [{ name: "a.png", kind: "file" }])).toBe(false);
		expect(
			matchesMagicAction(multiImageScript, [
				{ name: "a.png", kind: "file" },
				{ name: "b.JPG", kind: "file" },
			]),
		).toBe(true);
		expect(
			matchesMagicAction(multiImageScript, [
				{ name: "a.png", kind: "file" },
				{ name: "notes.txt", kind: "file" },
			]),
		).toBe(false);

		// Folder action matches 1 or more folders, not files
		expect(matchesMagicAction(anyFolderAction, [{ name: "Downloads", kind: "folder" }])).toBe(true);
		expect(
			matchesMagicAction(anyFolderAction, [
				{ name: "Downloads", kind: "folder" },
				{ name: "Desktop", kind: "folder" },
			]),
		).toBe(true);
		expect(matchesMagicAction(anyFolderAction, [{ name: "a.pdf", kind: "file" }])).toBe(false);

		// Archive compound extension support (e.g. tar.gz)
		const tarGzAction: MagicAction = {
			...singlePdfAction,
			extensions: ["tar.gz"],
		};
		expect(matchesMagicAction(tarGzAction, [{ name: "backup.tar.gz", kind: "file" }])).toBe(true);
		expect(matchesMagicAction(tarGzAction, [{ name: "backup.gz", kind: "file" }])).toBe(false);
	});

	it("validates MagicActionRunRequest payloads at the IPC boundary", () => {
		expect(isMagicActionRunRequest({ actionId: "pdf-summary", paths: ["/tmp/a.pdf"] })).toBe(true);
		expect(isMagicActionRunRequest({ actionId: "", paths: ["/tmp/a.pdf"] })).toBe(false);
		expect(isMagicActionRunRequest({ actionId: "pdf-summary", paths: [] })).toBe(false);
		expect(isMagicActionRunRequest(null)).toBe(false);
	});
});

describe("settingsService contextMenu persistence in settings-state.json", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		for (const fn of cleanups.splice(0)) await fn();
	});

	function createStubDeps(directory: string, onSettingsChanged?: (s: unknown) => void) {
		return {
			directory,
			dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
			models: { resolve: vi.fn(), catalog: vi.fn() } as never,
			config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
			refreshConfig: vi.fn() as never,
			credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
			onSettingsChanged: onSettingsChanged as never,
		};
	}

	it("persists contextMenu settings to settings-state.json and sanitizes locked Tags on write and reload", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dazzi-cmenu-settings-"));
		cleanups.push(() => rm(dir, { recursive: true, force: true }));

		const changed = vi.fn();
		const svc = createSettingsService(createStubDeps(dir, changed));

		const updated = await svc.set({
			contextMenu: {
				hiddenItems: ["builtin:tags", "builtin:copyPath", "builtin:compress7z"],
				hiddenSections: ["tags" as never, "services"],
				sectionOrder: ["magic", "open", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "word-count",
						label: "줄 수 세기",
						enabled: true,
						selection: "any",
						targetKind: "file",
						extensions: ["txt", "md"],
						execution: { kind: "script", command: "wc -l \"$@\"" },
					},
				],
			},
		});

		expect(updated.contextMenu.hiddenItems).toEqual(["builtin:copyPath", "builtin:compress7z"]);
		expect(updated.contextMenu.hiddenSections).toEqual(["services"]);
		expect(updated.contextMenu.magicActions).toHaveLength(1);
		expect(changed).toHaveBeenCalledTimes(1);

		const disk = JSON.parse(await readFile(join(dir, "settings-state.json"), "utf8"));
		expect(disk.settings.contextMenu.hiddenItems).toEqual(["builtin:copyPath", "builtin:compress7z"]);

		// Simulate hand-editing settings-state.json to try hiding builtin:tags or tags section
		disk.settings.contextMenu.hiddenItems = ["builtin:tags", "builtin:share"];
		disk.settings.contextMenu.hiddenSections = ["tags", "actions"];
		await writeFile(join(dir, "settings-state.json"), JSON.stringify(disk, null, 2), "utf8");

		const reloaded = await createSettingsService(createStubDeps(dir)).get();
		expect(reloaded.contextMenu.hiddenItems).toEqual(["builtin:share"]);
		expect(reloaded.contextMenu.hiddenSections).toEqual(["actions"]);
		expect(reloaded.contextMenu.magicActions[0]?.id).toBe("word-count");
	});
});
