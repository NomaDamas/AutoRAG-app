import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appCustomizerProfile, createAppCustomizerToolkit } from "../src/main/agents/profiles/app-customizer";
import { createAppCustomizerService } from "../src/main/app-customizer-service";
import { createSettingsService } from "../src/main/settings-service";
import type { AppCustomizerEvent } from "../src/shared/app-customizer-contract";
import type { FsLocation, FsTag } from "../src/shared/fs-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let settingsDir: string;
let workFolder: string;
let events: AppCustomizerEvent[];

const LOCATIONS: readonly FsLocation[] = [
	{ name: "me", path: "/Users/me", section: "favorites", icon: "home", available: true, scanned: false, ejectable: false },
	{ name: "Desktop", path: "/Users/me/Desktop", section: "favorites", icon: "desktop", available: true, scanned: true, ejectable: false },
	{ name: "Documents", path: "/Users/me/Documents", section: "favorites", icon: "documents", available: true, scanned: true, ejectable: false },
	{ name: "Downloads", path: "/Users/me/Downloads", section: "favorites", icon: "downloads", available: true, scanned: true, ejectable: false },
	{ name: "Music", path: "/Users/me/Music", section: "favorites", icon: "music", available: true, scanned: false, ejectable: false },
	{ name: "Movies", path: "/Users/me/Movies", section: "favorites", icon: "movies", available: true, scanned: false, ejectable: false },
	{ name: "Trash", path: "/Users/me/.Trash", section: "favorites", icon: "trash", available: true, scanned: false, ejectable: false },
	{ name: "iCloud Drive", path: "/Users/me/Library/Mobile Documents/com~apple~CloudDocs", section: "cloud", icon: "icloud", available: true, scanned: true, ejectable: false },
	{ name: "Macintosh HD", path: "/", section: "locations", icon: "disk", available: true, scanned: false, ejectable: false },
];

const TAGS: readonly FsTag[] = [{ name: "Work", color: 6, sidebar: true }];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "customizer-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "customizer-agent-"));
	settingsDir = join(root, "settings");
	workFolder = join(root, "Projects");
	events = [];
	await mkdir(workFolder, { recursive: true });
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
		api: `faux-customizer-${Math.random().toString(36).slice(2)}`,
		provider: "faux-customizer",
		models: [{ id: "customizer", reasoning: true }],
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

describe("app-customizer pi agent profile & toolkit", () => {
	it("exposes structured customization tools with no raw filesystem/shell tools and states the AI Search & Automations lock rule", () => {
		const settings = createStubSettings();
		const kit = createAppCustomizerToolkit({
			settings,
			listLocations: async () => LOCATIONS,
			listTags: async () => TAGS,
			homeDir: root,
		});
		const profile = appCustomizerProfile({ language: "ko", toolkit: kit });

		expect(profile.id).toBe("app-customizer");
		expect(profile.tools).toEqual([]);
		expect(profile.customTools?.map((t) => t.name).sort()).toEqual([
			"get_app_settings",
			"update_general_settings",
			"update_sidebar",
		]);
		expect(profile.systemPrompt).toContain("AI Search");
		expect(profile.systemPrompt).toContain("Automations");
		expect(profile.systemPrompt).toContain("Korean");
	});

	it("never hides AI Search or Automations even when update_sidebar asks to hide them or uses showOnlyFavorites", async () => {
		const settings = createStubSettings();
		const kit = createAppCustomizerToolkit({
			settings,
			listLocations: async () => LOCATIONS,
			listTags: async () => TAGS,
			homeDir: root,
		});
		const updateSidebar = kit.tools.find((t) => t.name === "update_sidebar")!;

		const res1 = await updateSidebar.execute(
			"call-1",
			{
				hideItems: ["app:aiSearch", "자동화", "music", "movies"],
				hideSections: ["favorites", "cloud"],
			},
			undefined,
			undefined,
			undefined as never,
		);
		const text1 = res1.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		expect(text1).toMatch(/AI Search|app:aiSearch/i);
		expect(text1).toMatch(/Automations|app:automations/i);

		const saved1 = await settings.get();
		expect(saved1.sidebar.hiddenItems).toEqual(["place:music", "place:movies"]);
		expect(saved1.sidebar.hiddenSections).toEqual(["cloud"]);

		// Now test showOnlyFavorites: hides all other OS favorites while keeping AI Search, Automations, and Downloads
		await updateSidebar.execute(
			"call-2",
			{ showOnlyFavorites: ["downloads"], addCustomFavorites: [{ path: workFolder, label: "Projects" }] },
			undefined,
			undefined,
			undefined as never,
		);
		const saved2 = await settings.get();
		expect(saved2.sidebar.hiddenItems).not.toContain("app:aiSearch");
		expect(saved2.sidebar.hiddenItems).not.toContain("app:automations");
		expect(saved2.sidebar.hiddenItems).not.toContain("place:downloads");
		expect(saved2.sidebar.hiddenItems).toContain("place:desktop");
		expect(saved2.sidebar.hiddenItems).toContain("place:music");
		expect(saved2.sidebar.customFavorites).toEqual([{ path: workFolder, label: "Projects" }]);
	});
});

describe("app-customizer multi-turn service", () => {
	it("streams `i` progress phrases, executes tool calls to mutate AppSettings, preserves multi-turn session history, and resets cleanly", async () => {
		const registration = register();
		const settings = createStubSettings();
		const svc = createAppCustomizerService({
			send: (event) => events.push(event),
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: {},
			cwd: root,
			homeDir: root,
			language: () => "ko",
			settings,
			listLocations: async () => LOCATIONS,
			listTags: async () => TAGS,
		});

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("get_app_settings", { i: "현재 사이드바 설정 확인 중" })),
			fauxAssistantMessage(
				fauxToolCall("update_sidebar", {
					i: "음악과 동영상 폴더 숨기는 중",
					hideItems: ["music", "movies"],
					favoritesOrder: ["downloads", "documents"],
				}),
			),
			fauxAssistantMessage("사이드바에서 음악과 동영상 폴더를 숨기고 다운로드와 문서를 위로 올렸습니다."),
		]);

		await svc.send("run-1", { sessionId: "sess-1", message: "음악이랑 동영상 숨기고 다운로드 위로 올려줘" });

		expect(events.map((e) => (e.type === "progress" ? `progress:${e.text}` : e.type))).toContain("progress:현재 사이드바 설정 확인 중");
		expect(events.map((e) => (e.type === "progress" ? `progress:${e.text}` : e.type))).toContain("progress:음악과 동영상 폴더 숨기는 중");

		const done1 = events.at(-1);
		expect(done1).toMatchObject({
			type: "turn-done",
			runId: "run-1",
			sessionId: "sess-1",
			reply: "사이드바에서 음악과 동영상 폴더를 숨기고 다운로드와 문서를 위로 올렸습니다.",
		});
		if (done1?.type === "turn-done") {
			expect(done1.settings.sidebar.hiddenItems).toEqual(["place:music", "place:movies"]);
			expect(done1.settings.sidebar.favoritesOrder).toEqual(["place:downloads", "place:documents"]);
			expect(done1.changes.length).toBeGreaterThan(0);
		}

		// Turn 2 on the same sessionId must carry Turn 1's user message in history
		let sawPreviousTurn = false;
		events = [];
		registration.setResponses([
			(ctx) => {
				sawPreviousTurn = JSON.stringify(ctx.messages).includes("음악이랑 동영상 숨기고 다운로드 위로 올려줘");
				return fauxAssistantMessage(fauxToolCall("update_general_settings", { i: "다크 모드로 전환 중", appearance: "dark" }));
			},
			fauxAssistantMessage("다크 모드로 변경했습니다."),
		]);

		await svc.send("run-2", { sessionId: "sess-1", message: "다크 모드로도 바꿔줘" });
		expect(sawPreviousTurn).toBe(true);
		expect((await settings.get()).appearance).toBe("dark");

		// Resetting sessionId clears history
		await svc.reset("sess-1");
		let sawAfterReset = false;
		registration.setResponses([
			(ctx) => {
				sawAfterReset = JSON.stringify(ctx.messages).includes("음악이랑 동영상 숨기고 다운로드 위로 올려줘");
				return fauxAssistantMessage("초기화된 새 대화입니다.");
			},
		]);
		await svc.send("run-3", { sessionId: "sess-1", message: "안녕" });
		expect(sawAfterReset).toBe(false);
	});
});
