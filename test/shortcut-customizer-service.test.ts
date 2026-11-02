import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShortcutCustomizerToolkit, shortcutCustomizerProfile } from "../src/main/agents/profiles/shortcut-customizer";
import { createAppCustomizerService } from "../src/main/app-customizer-service";
import { createSettingsService } from "../src/main/settings-service";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let events: AppCustomizerEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "shortcut-agent-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "shortcut-agent-dir-"));
	settingsDir = join(root, "settings");
	events = [];
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
		api: `faux-shortcut-customizer-${Math.random().toString(36).slice(2)}`,
		provider: "faux-shortcut-customizer",
		models: [{ id: "shortcut-customizer", reasoning: true }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function createStubSettings(onChanged?: () => void) {
	return createSettingsService({
		directory: settingsDir,
		dataSources: { list: vi.fn(), setEnabled: vi.fn(), setDescription: vi.fn(), sync: vi.fn() } as never,
		models: { resolve: vi.fn(), catalog: vi.fn() } as never,
		config: { get: vi.fn(), set: vi.fn(), remove: vi.fn(), patch: vi.fn(), rename: vi.fn() } as never,
		refreshConfig: vi.fn() as never,
		credentials: { list: vi.fn(), set: vi.fn(), remove: vi.fn() } as never,
		onSettingsChanged: onChanged as never,
	});
}

describe("shortcut-customizer pi agent profile & toolkit", () => {
	it("exposes only get_shortcuts and update_shortcuts tools and states the fixed-catalog & Esc lock rules", () => {
		const settings = createStubSettings();
		const kit = createShortcutCustomizerToolkit({ settings, platform: "darwin" });
		const profile = shortcutCustomizerProfile({ language: "ko", toolkit: kit });

		expect(profile.id).toBe("shortcut-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((t) => t.name).sort()).toEqual(["get_shortcuts", "update_shortcuts"]);
		expect(profile.systemPrompt).toContain("Esc");
		expect(profile.systemPrompt).toContain("Korean");
	});

	it("updates existing catalog shortcuts via natural aliases, refuses arbitrary new actions or locked Esc, and supports swapConflicts & reset", async () => {
		const settings = createStubSettings();
		const kit = createShortcutCustomizerToolkit({ settings, platform: "darwin" });
		const updateShortcuts = kit.tools.find((t) => t.name === "update_shortcuts")!;

		// 1. Update valid actions + attempt unknown action ("터미널 열기") + attempt locked (" 닫기 ")
		const res1 = await updateShortcuts.execute(
			"call-1",
			{
				bindings: [
					{ action: "이름 변경", shortcut: "F2" },
					{ action: "새 폴더", shortcut: "⌘N" },
					{ action: "터미널 열기", shortcut: "⌘J" },
					{ action: "닫기", shortcut: "⌘Q" },
				],
			},
			undefined,
			undefined,
			undefined as never,
		);
		const parsed1 = JSON.parse(res1.content[0]?.type === "text" ? res1.content[0].text : "{}");
		expect(parsed1.warnings.length).toBeGreaterThanOrEqual(2);

		const saved1 = await settings.get();
		expect(saved1.shortcuts.overrides).toEqual({
			rename: "F2",
			newFolder: "Mod+N",
		});

		// 2. Conflict swap: set duplicate to F2 with swapConflicts: true -> duplicate becomes F2, rename gets Mod+D
		await updateShortcuts.execute(
			"call-2",
			{
				bindings: [{ action: "duplicate", shortcut: "F2" }],
				swapConflicts: true,
			},
			undefined,
			undefined,
			undefined as never,
		);
		const saved2 = await settings.get();
		expect(saved2.shortcuts.overrides.duplicate).toBe("F2");
		expect(saved2.shortcuts.overrides.rename).toBe("Mod+D");

		// 3. Apply Windows Explorer and Mac Finder presets via tool
		await updateShortcuts.execute("call-3a", { preset: "windowsExplorer" }, undefined, undefined, undefined as never);
		expect((await settings.get()).shortcuts.overrides.rename).toBe("F2");
		expect((await settings.get()).shortcuts.overrides.editPath).toBe("Alt+D");

		await updateShortcuts.execute("call-3b", { preset: "macFinder" }, undefined, undefined, undefined as never);
		expect((await settings.get()).shortcuts.overrides.rename).toBe("Enter");
		expect((await settings.get()).shortcuts.overrides.trash).toBe("Mod+Backspace");

		// 4. Reset all
		await updateShortcuts.execute(
			"call-4",
			{ resetAll: true },
			undefined,
			undefined,
			undefined as never,
		);
		const saved4 = await settings.get();
		expect(saved4.shortcuts.overrides).toEqual({});
	});

	it("routes surface='shortcuts' in createAppCustomizerService to shortcut-customizer while streaming progress and updating AppSettings", async () => {
		const registration = register();
		const settings = createStubSettings();
		const service = createAppCustomizerService({
			send: (event) => events.push(event),
			resolveModel: async () => ({ model: registration.getModel()! }),
			agentDir,
			env: {},
			cwd: root,
			language: () => "ko",
			settings,
			listLocations: async () => [],
			listTags: async () => [],
		});

		registration.setResponses([
			fauxAssistantMessage([
				fauxToolCall("get_shortcuts", { i: "현재 단축키 구성을 확인하는 중" }),
			]),
			fauxAssistantMessage([
				fauxToolCall("update_shortcuts", {
					i: "이름 변경을 F2로, 다시 실행을 ⌘Y로 변경하는 중",
					bindings: [
						{ action: "이름 변경", shortcut: "F2" },
						{ action: "다시 실행", shortcut: "⌘Y" },
					],
				}),
			]),
			fauxAssistantMessage("이름 변경을 F2로, 다시 실행을 ⌘Y로 변경했습니다."),
		]);

		await service.send("run-sc-1", {
			sessionId: "sess-sc-1",
			surface: "shortcuts",
			message: "이름 변경을 F2로 바꾸고 다시 실행은 커맨드 Y로 해줘",
		});

		const progressTexts = events.filter((e) => e.type === "progress").map((e) => e.text);
		expect(progressTexts).toContain("현재 단축키 구성을 확인하는 중");
		expect(progressTexts).toContain("이름 변경을 F2로, 다시 실행을 ⌘Y로 변경하는 중");

		const done = events.find((e) => e.type === "turn-done");
		expect(done?.type).toBe("turn-done");
		if (done?.type === "turn-done") {
			expect(done.changes[0]?.kind).toBe("shortcuts");
			expect(done.settings.shortcuts.overrides).toEqual({
				rename: "F2",
				redo: "Mod+Y",
			});
		}
		service.dispose();
	});
});
