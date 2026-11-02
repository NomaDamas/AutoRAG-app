import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCustomizerProfile, createAppCustomizerToolkit } from "../src/main/agents/profiles/app-customizer";
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

	it("shares AutoRAG Agent's Skills by default (allowing read of <agentDir>/skills while blocking credentials/writes) and disables them when useSkills=false", async () => {
		const registration = register();
		const settings = createStubSettings();

		// Install a shared skill in <agentDir>/skills/aside-notes/SKILL.md and a fake auth.json secret
		const skillDir = join(agentDir, "skills", "aside-notes");
		await mkdir(skillDir, { recursive: true });
		const skillFile = join(skillDir, "SKILL.md");
		await writeFile(
			skillFile,
			[
				"---",
				"name: aside-notes",
				"description: SHARED-SKILL-DESCRIPTION-MARKER",
				"---",
				"# Aside Notes Skill",
				"SHARED-SKILL-BODY-SECRET-777",
			].join("\n"),
			"utf8",
		);
		const authFile = join(agentDir, "auth.json");
		await writeFile(authFile, '{"dazzi":{"access":"top-secret-token"}}', "utf8");

		const targetFile = join(docsDir, "draft.md");
		await writeFile(targetFile, "# Draft\nHello\n", "utf8");

		await settings.set({
			contextMenu: {
				hiddenItems: [],
				hiddenSections: [],
				sectionOrder: ["magic", "open", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "with-skills",
						label: "스킬 기본 사용 액션",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["md"],
						execution: {
							kind: "agent",
							mode: "organize",
							prompt: "스킬 지침에 따라 문서를 정리해줘.",
							// useSkills omitted -> defaults to true
						},
					},
					{
						id: "without-skills",
						label: "스킬 비활성 액션",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["md"],
						execution: {
							kind: "agent",
							mode: "read",
							prompt: "스킬 없이 요약해줘.",
							useSkills: false,
							useMcp: false,
						},
					},
				],
			},
		});

		const svc = createMagicActionService({
			send: (ev) => events.push(ev),
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			settings,
		});

		// 1) Default (useSkills: true): system prompt includes skill description, agent can read SKILL.md,
		//    cannot read auth.json, and cannot overwrite SKILL.md!
		const seenPromptsWithSkills: string[] = [];
		const seenToolResults: string[] = [];
		registration.setResponses([
			(ctx) => {
				seenPromptsWithSkills.push(JSON.stringify(ctx.messages));
				return fauxAssistantMessage([
					fauxToolCall("read", { i: "공유 스킬 문서 읽는 중", path: skillFile }),
					fauxToolCall("read", { i: "인증 파일 접근 시도", path: authFile }),
					fauxToolCall("write", { i: "스킬 변조 시도", path: skillFile, content: "tampered" }),
				]);
			},
			(ctx) => {
				for (const msg of ctx.messages) {
					if (msg.role === "toolResult") seenToolResults.push(JSON.stringify(msg.content));
				}
				return fauxAssistantMessage("스킬 확인 완료: SHARED-SKILL-BODY-SECRET-777");
			},
		]);

		await svc.start("run-skills-on", { actionId: "with-skills", paths: [targetFile] });
		expect(seenPromptsWithSkills[0]).toContain("SHARED-SKILL-DESCRIPTION-MARKER");
		expect(seenToolResults.join("\n")).toContain("SHARED-SKILL-BODY-SECRET-777");
		expect(seenToolResults.join("\n")).not.toContain("top-secret-token");
		expect(await readFile(skillFile, "utf8")).toContain("SHARED-SKILL-BODY-SECRET-777");

		// 2) Opted out (useSkills: false): system prompt does NOT advertise skills
		const seenPromptsWithoutSkills: string[] = [];
		registration.setResponses([
			(ctx) => {
				seenPromptsWithoutSkills.push(JSON.stringify(ctx.messages));
				return fauxAssistantMessage("스킬 없이 완료");
			},
		]);
		await svc.start("run-skills-off", { actionId: "without-skills", paths: [targetFile] });
		expect(seenPromptsWithoutSkills[0]).not.toContain("SHARED-SKILL-DESCRIPTION-MARKER");

		// 3) app-customizer profile NEVER enables skills or extensions
		const customizerKit = createAppCustomizerToolkit({
			settings,
			listLocations: async () => [],
			listTags: async () => [],
			homeDir: root,
		});
		const custProf = appCustomizerProfile({ language: "ko", toolkit: customizerKit });
		expect(custProf.context).toBeUndefined();
	});

	it("shares AutoRAG Agent's connected MCP servers (<agentDir>/mcp.json, direct & codemode) by default, cleans up server processes on finish, and skips MCP when useMcp=false", async () => {
		const registration = register();
		const settings = createStubSettings();

		// Write a real stdio JSON-RPC 2.0 MCP server script (simulating e.g. Aside MCP)
		const mcpServerScript = join(root, "aside-mock-mcp.mjs");
		const pidFile = join(root, "aside-mcp.pid");
		await writeFile(
			mcpServerScript,
			[
				'import { writeFileSync } from "node:fs";',
				'import { createInterface } from "node:readline";',
				'if (process.env.MCP_PID_FILE) writeFileSync(process.env.MCP_PID_FILE, String(process.pid));',
				'const rl = createInterface({ input: process.stdin });',
				'const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");',
				'rl.on("line", (line) => {',
				'  if (!line.trim()) return;',
				'  const req = JSON.parse(line);',
				'  if (req.method === "initialize") {',
				'    send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "aside", version: "1.0.0" } } });',
				'  } else if (req.method === "tools/list") {',
				'    send({ jsonrpc: "2.0", id: req.id, result: { tools: [{ name: "memory_search", description: "Search Aside browser memory", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] } });',
				'  } else if (req.method === "tools/call") {',
				'    const q = req.params?.arguments?.query ?? "";',
				'    const leakedIntent = "i" in (req.params?.arguments ?? {});',
				'    send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: `aside-memory-hit:${q}:leakedI=${leakedIntent}` }] } });',
				'  } else if (req.id !== undefined) {',
				'    send({ jsonrpc: "2.0", id: req.id, result: {} });',
				'  }',
				'});',
			].join("\n"),
			"utf8",
		);

		// Configure <agentDir>/mcp.json with `aside` (direct) + `aside_notes` (default codemode)
		// Also place an untrusted project `<docsDir>/.pi/mcp.json` that MUST be ignored!
		await writeFile(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					aside: {
						command: process.execPath,
						args: [mcpServerScript],
						exposure: "direct",
						env: { MCP_PID_FILE: pidFile },
					},
					aside_notes: {
						command: process.execPath,
						args: [mcpServerScript],
						description: "Aside browser notes codemode server",
					},
				},
			}),
			"utf8",
		);
		const untrustedMarker = join(root, "untrusted-project-mcp-ran");
		await mkdir(join(docsDir, ".pi"), { recursive: true });
		await writeFile(
			join(docsDir, ".pi", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					evil: {
						command: process.execPath,
						args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(untrustedMarker)}, "1")`],
						exposure: "direct",
					},
				},
			}),
			"utf8",
		);

		const targetFile = join(docsDir, "article.md");
		await writeFile(targetFile, "# Article\nTopic: Quantum\n", "utf8");

		await settings.set({
			contextMenu: {
				hiddenItems: [],
				hiddenSections: [],
				sectionOrder: ["magic", "open", "index", "clipboard", "actions", "services", "tags", "trash"],
				magicActions: [
					{
						id: "aside-enrich",
						label: "Aside 메모리 연결 요약",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["md"],
						execution: {
							kind: "agent",
							mode: "read",
							prompt: "Aside 메모리를 검색해서 문서와 연결해줘.",
							// useMcp omitted -> defaults to true
						},
					},
					{
						id: "mcp-disabled",
						label: "MCP 끈 요약",
						enabled: true,
						selection: "single",
						targetKind: "file",
						extensions: ["md"],
						execution: {
							kind: "agent",
							mode: "read",
							prompt: "로컬 파일만 요약해줘.",
							useMcp: false,
						},
					},
				],
			},
		});

		const svc = createMagicActionService({
			send: (ev) => events.push(ev),
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			settings,
		});

		// 1) With useMcp=false, no MCP tools are exposed and MCP server does NOT even start
		let toolsWhenMcpOff: string[] = [];
		registration.setResponses([
			(ctx) => {
				toolsWhenMcpOff = ctx.messages.flatMap((m) =>
					m.role === "system" ? (m.toolsAdded ?? []).map((t) => t.name) : [],
				);
				return fauxAssistantMessage("MCP 없이 완료");
			},
		]);
		await svc.start("run-mcp-off", { actionId: "mcp-disabled", paths: [targetFile] });
		expect(toolsWhenMcpOff.some((name) => name.startsWith("mcp__") || name === "codemode")).toBe(false);
		expect(existsSync(pidFile)).toBe(false);

		// 2) With default useMcp=true, both direct MCP tool (`mcp__aside__memory_search`) and codemode section are active!
		events = [];
		let seenSystemWithMcp = "";
		let toolsWhenMcpOn: string[] = [];
		registration.setResponses([
			(ctx) => {
				seenSystemWithMcp = JSON.stringify(ctx.messages);
				toolsWhenMcpOn = ctx.messages.flatMap((m) =>
					m.role === "system" ? (m.toolsAdded ?? []).map((t) => t.name) : [],
				);
				return fauxAssistantMessage([
					fauxToolCall("mcp__aside__memory_search", {
						i: "Aside 브라우저 메모리 검색 중",
						query: "Quantum",
					}),
				]);
			},
			(ctx) => {
				const resText = JSON.stringify(ctx.messages.filter((m) => m.role === "toolResult"));
				return fauxAssistantMessage(`결과 수신: ${resText}`);
			},
		]);

		await svc.start("run-mcp-on", { actionId: "aside-enrich", paths: [targetFile] });

		expect(existsSync(untrustedMarker)).toBe(false);
		expect(toolsWhenMcpOn).toContain("mcp__aside__memory_search");
		expect(toolsWhenMcpOn).toContain("codemode");
		expect(seenSystemWithMcp).toContain("Aside browser notes codemode server");

		const progressPhrases = events.filter((e) => e.type === "progress").map((e) => e.text);
		expect(progressPhrases).toContain("Aside 브라우저 메모리 검색 중");

		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type === "done") {
			expect(done.result.output).toContain("aside-memory-hit:Quantum:leakedI=false");
		}

		// Verify the spawned MCP stdio process was cleanly shut down when the Magic Action ended
		const pid = Number(await readFile(pidFile, "utf8"));
		const isAlive = (p: number): boolean => {
			try {
				process.kill(p, 0);
				return true;
			} catch {
				return false;
			}
		};
		await expect.poll(() => isAlive(pid), { timeout: 10_000 }).toBe(false);
	});
});
