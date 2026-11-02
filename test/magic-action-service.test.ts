import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { magicActionProfile } from "../src/main/agents/profiles/magic-action";
import { createMagicActionService } from "../src/main/magic-action-service";
import { createSettingsService } from "../src/main/settings-service";
import type { MagicActionEvent } from "../src/shared/magic-actions-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let docsDir: string;
let events: MagicActionEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "magic-action-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "magic-action-agent-"));
	settingsDir = join(root, "settings");
	docsDir = join(root, "docs");
	events = [];
	await mkdir(docsDir, { recursive: true });
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-magic-${Math.random().toString(36).slice(2)}`,
		provider: "faux-magic",
		models: [{ id: "magic-runner", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function createStubSettings() {
	return createSettingsService({
		directory: settingsDir,
		dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
	});
}

describe("magic-action pi agent profile", () => {
	it("offers only read/ls/find/grep with `i` intent fields in read mode, and adds bash/edit/write in organize mode", () => {
		const readProf = magicActionProfile({
			language: "ko",
			mode: "read",
			actionLabel: "문서 요약",
			prompt: "3줄로 요약해줘",
			cwd: docsDir,
			agentDir,
			env: {},
		});
		expect(readProf.id).toBe("magic-action");
		expect(readProf.tools).toEqual([]);
		expect(readProf.customTools?.map((t) => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);

		const orgProf = magicActionProfile({
			language: "ko",
			mode: "organize",
			actionLabel: "파일 정리",
			prompt: "요약본을 새 파일로 저장해줘",
			cwd: docsDir,
			agentDir,
			env: {},
		});
		expect(orgProf.customTools?.map((t) => t.name).sort()).toEqual([
			"bash",
			"edit",
			"find",
			"grep",
			"ls",
			"read",
			"write",
		]);
	});
});

describe("magic-action-service execution", () => {
	it("executes a script Magic Action on single or multiple files with $@ and DAZZI_FILES_JSON, streaming stdout and exit status", async () => {
		const settings = createStubSettings();
		const fileA = join(docsDir, "alpha.txt");
		const fileB = join(docsDir, "beta space.txt");
		await writeFile(fileA, "line1\nline2\n", "utf8");
		await writeFile(fileB, "hello world\n", "utf8");

		await settings.set({
			contextMenu: {
				hiddenItems: [],
				hiddenSections: [],
				sectionOrder: ["open", "magic", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "inspect-files",
						label: "파일 검사 스크립트",
						enabled: true,
						selection: "multiple",
						targetKind: "file",
						extensions: ["txt"],
						execution: {
							kind: "script",
							command: 'printf "count=%s first=%s argc=%s\\n" "$DAZZI_FILE_COUNT" "$DAZZI_FILE" "$#"',
						},
					},
				],
			},
		});

		const svc = createMagicActionService({
			send: (ev) => events.push(ev),
			resolveModel: async () => {
				throw new Error("script action must not require an LLM model");
			},
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			settings,
		});

		await svc.start("run-script-1", { actionId: "inspect-files", paths: [fileA, fileB] });

		expect(events[0]).toMatchObject({
			type: "started",
			runId: "run-script-1",
			actionId: "inspect-files",
			executionKind: "script",
		});
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.result.exitCode).toBe(0);
			expect(done.result.output).toContain(`count=2 first=${fileA} argc=2`);
		}
	});

	it("reports script non-zero exit code as an error event with stderr", async () => {
		const settings = createStubSettings();
		const fileA = join(docsDir, "alpha.txt");
		await writeFile(fileA, "hello", "utf8");

		await settings.set({
			contextMenu: {
				hiddenItems: [],
				hiddenSections: [],
				sectionOrder: ["open", "magic", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "failing-script",
						label: "실패 스크립트",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: [],
						execution: {
							kind: "script",
							command: 'echo "bad input" >&2; exit 2',
						},
					},
				],
			},
		});

		const svc = createMagicActionService({
			send: (ev) => events.push(ev),
			resolveModel: async () => {
				throw new Error("unused");
			},
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			settings,
		});

		await svc.start("run-fail-1", { actionId: "failing-script", paths: [fileA] });

		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.message).toMatch(/bad input|2/);
		}
	});

	it("executes an agent Magic Action loop on target files, streaming `i` intent progress and writing real files in organize mode", async () => {
		const registration = register();
		const settings = createStubSettings();
		const notePath = join(docsDir, "meeting.md");
		const outPath = join(docsDir, "meeting-summary.md");
		await writeFile(notePath, "# 주간 회의\n- 출시일: 11월 15일\n- 담당: 다찌팀\n", "utf8");

		await settings.set({
			contextMenu: {
				hiddenItems: [],
				hiddenSections: [],
				sectionOrder: ["open", "magic", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "make-summary-file",
						label: "회의록 요약본 생성",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["md"],
						execution: {
							kind: "agent",
							mode: "organize",
							prompt: "선택한 마크다운 파일을 읽고 같은 폴더에 meeting-summary.md로 핵심 요약본을 작성해줘.",
						},
					},
				],
			},
		});

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { i: "회의록 내용을 읽는 중", path: notePath })),
			fauxAssistantMessage(
				fauxToolCall("write", {
					i: "요약본 파일 저장 중",
					path: outPath,
					content: "출시일 11월 15일 (다찌팀)\n",
				}),
			),
			fauxAssistantMessage("`meeting-summary.md` 파일을 생성했습니다: 출시일 11월 15일 (다찌팀)."),
		]);

		const svc = createMagicActionService({
			send: (ev) => events.push(ev),
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			settings,
		});

		await svc.start("run-agent-1", { actionId: "make-summary-file", paths: [notePath] });

		const progressTexts = events.filter((e) => e.type === "progress").map((e) => e.text);
		expect(progressTexts).toContain("회의록 내용을 읽는 중");
		expect(progressTexts).toContain("요약본 파일 저장 중");

		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.result.executionKind).toBe("agent");
			expect(done.result.output).toContain("meeting-summary.md");
		}
		expect(await readFile(outPath, "utf8")).toBe("출시일 11월 15일 (다찌팀)\n");
	});
});
