import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSmartIndexingService, type SmartIndexingService } from "../src/main/smart-indexing-service";
import type { SmartIndexingEvent } from "../src/shared/smart-indexing-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let events: SmartIndexingEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "smart-svc-root-"));
	agentDir = await mkdtemp(join(tmpdir(), "smart-svc-agent-"));
	events = [];
	cleanups.push(
		() => rm(root, { recursive: true, force: true }),
		() => rm(agentDir, { recursive: true, force: true }),
	);
	await mkdir(join(root, "Docs"), { recursive: true });
	await mkdir(join(root, "Telegram Desktop"), { recursive: true });
	await writeFile(join(root, "Docs", "report.md"), "0123456789");
	await writeFile(join(root, "Telegram Desktop", "a.md"), "12345");
	await writeFile(join(root, "Telegram Desktop", "b.md"), "123456789012");
	await writeFile(join(root, "Telegram Desktop", "photo.jpg"), "not a supported document");
	await mkdir(join(root, "Pictures"), { recursive: true });
	await writeFile(join(root, "Pictures", "holiday.jpg"), "an image the index never reads");
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(): FauxProviderRegistration {
	const registration = registerFauxProvider({ api: `faux-smart-${Math.random().toString(36).slice(2)}`, provider: "faux-smart", models: [{ id: "smart", reasoning: true }] });
	cleanups.push(() => registration.unregister());
	return registration;
}

function serviceFor(registration: FauxProviderRegistration, overrides: { timeoutMs?: number; resolveModel?: () => Promise<never> } = {}): SmartIndexingService {
	return createSmartIndexingService({
		send: (event) => events.push(event),
		resolveModel: overrides.resolveModel ?? (async () => ({ model: registration.getModel() })),
		agentDir,
		env: {},
		language: () => "ko",
		scanOptions: { supportedExtensions: new Set([".md"]), maxSourceBytes: 1_000_000 },
		...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
	});
}

/** The text of every tool result the model has been sent so far. */
function toolResultTexts(messages: readonly Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "toolResult" ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])) : [],
	);
}

function finalEvent(): SmartIndexingEvent | undefined {
	return events.at(-1);
}

describe("smart indexing service", () => {
	it("reports the folders the agent proposes with the file count and size the index would otherwise take", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("list_folder", { path: root })),
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: join(root, "Telegram Desktop") })),
			fauxAssistantMessage(
				fauxToolCall("propose_exclusions", {
					exclusions: [
						{ path: join(root, "Telegram Desktop"), reason: "채팅 앱 다운로드" },
						{ path: "/etc", reason: "outside the chosen folders" },
					],
				}),
			),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-1", [root]);

		expect(events).toEqual([
			{ type: "exploring", runId: "run-1", path: root },
			{ type: "exploring", runId: "run-1", path: join(root, "Telegram Desktop") },
			{
				type: "result",
				runId: "run-1",
				exclusions: [{ path: join(root, "Telegram Desktop"), root, reason: "채팅 앱 다운로드", files: 2, bytes: 17, excluded: true }],
			},
		]);
	});

	it("keeps a proposal even when the index would read nothing from it: what to leave out is the person's to decide, and its count is shown as it is", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: join(root, "Pictures") })),
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: join(root, "Telegram Desktop") })),
			fauxAssistantMessage(
				fauxToolCall("propose_exclusions", {
					exclusions: [
						{ path: join(root, "Pictures"), reason: "photos" },
						{ path: join(root, "Telegram Desktop"), reason: "chat" },
					],
				}),
			),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-10", [root]);

		const last = finalEvent();
		expect(last).toMatchObject({ type: "result", exclusions: [{ path: join(root, "Pictures"), files: 0, bytes: 0 }, { path: join(root, "Telegram Desktop"), files: 2 }] });
	});

	it("refuses a folder that was never counted and feeds the model the instruction to count it", async () => {
		const registration = register();
		const fed: string[][] = [];
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [{ path: join(root, "Telegram Desktop"), reason: "sounds like chat" }] })),
			(context) => {
				fed.push(toolResultTexts(context.messages));
				return fauxAssistantMessage("done");
			},
		]);

		await serviceFor(registration).analyze("run-11", [root]);

		expect(fed[0]?.join("\n")).toContain("folder_survey first");
		expect(finalEvent()).toEqual({ type: "result", runId: "run-11", exclusions: [] });
	});

	it("gives the model the folder's real counts, names and dates, subfolders included", async () => {
		const registration = register();
		const fed: string[][] = [];
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: root })),
			(context) => {
				fed.push(toolResultTexts(context.messages));
				return fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [] }));
			},
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-12", [root]);

		const report = fed[0]?.join("\n") ?? "";
		// report.md + a.md + b.md are indexed; photo.jpg and holiday.jpg are not.
		expect(report).toContain("3 indexed files of 5 files in all");
		expect(report).toContain(".md 3 (indexed)");
		expect(report).toContain(".jpg 2");
		expect(report).toContain("Telegram Desktop/ 3 files, indexed 2 of 3");
		// What the model judges from: the names and when they were written, never the contents.
		expect(report).toContain("a.md");
		expect(report).toContain("photo.jpg");
		expect(report).toMatch(/modified \d{4}-\d{2}-\d{2}/u);
		expect(report).not.toContain("12345");
	});

	it("tells the model which proposed paths were refused so it can correct them", async () => {
		const registration = register();
		const fed: string[][] = [];
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [{ path: "/etc", reason: "nope" }] })),
			(context) => {
				fed.push(toolResultTexts(context.messages));
				return fauxAssistantMessage(fauxToolCall("folder_survey", { path: join(root, "Telegram Desktop") }));
			},
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [{ path: join(root, "Telegram Desktop"), reason: "chat" }] })),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-2", [root]);

		expect(fed[0]?.join("\n")).toContain("Refused: /etc");
		expect(finalEvent()).toMatchObject({ type: "result", exclusions: [{ path: join(root, "Telegram Desktop") }] });
	});

	it("announces each folder the agent looks at", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("list_folder", { path: root })),
			fauxAssistantMessage(fauxToolCall("list_folder", { path: join(root, "Docs") })),
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: root })),
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [] })),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-3", [root]);

		expect(events.filter((event) => event.type === "exploring").map((event) => (event.type === "exploring" ? event.path : ""))).toEqual([
			root,
			join(root, "Docs"),
			root,
		]);
		expect(finalEvent()).toEqual({ type: "result", runId: "run-3", exclusions: [] });
	});

	it("ignores roots that are not existing absolute folders and never calls the model when none is left", async () => {
		const resolveModel = vi.fn(async () => {
			throw new Error("must not be called");
		});

		await serviceFor(register(), { resolveModel }).analyze("run-4", ["relative/path", join(root, "missing"), 42]);

		expect(resolveModel).not.toHaveBeenCalled();
		expect(events).toEqual([{ type: "result", runId: "run-4", exclusions: [] }]);
	});

	it("reports an error when no model can be resolved", async () => {
		const resolveModel = vi.fn(async () => {
			throw new Error("No API key found for provider");
		});

		await serviceFor(register(), { resolveModel }).analyze("run-5", [root]);

		expect(events).toEqual([{ type: "error", runId: "run-5", message: "No API key found for provider" }]);
	});

	it("reports the provider's error when the model request fails", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider exploded" })]);

		await serviceFor(registration).analyze("run-6", [root]);

		expect(finalEvent()).toMatchObject({ type: "error", runId: "run-6", message: expect.stringContaining("provider exploded") });
		expect(events.some((event) => event.type === "result")).toBe(false);
	});

	it("reports an error, not an empty result, when the agent ends without answering through the tool", async () => {
		const registration = register();
		registration.setResponses([fauxAssistantMessage("I looked around and everything is fine.")]);

		await serviceFor(registration).analyze("run-7", [root]);

		expect(finalEvent()).toMatchObject({ type: "error", runId: "run-7" });
	});

	it("stops on cancel and sends no result", async () => {
		const registration = register();
		const service = serviceFor(registration);
		registration.setResponses([
			async (): Promise<AssistantMessage> => {
				await service.cancel("run-8");
				return fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [{ path: join(root, "Telegram Desktop"), reason: "chat" }] }));
			},
			fauxAssistantMessage("done"),
		]);

		await service.analyze("run-8", [root]);

		expect(events).toEqual([{ type: "cancelled", runId: "run-8" }]);
	});

	it("keeps what the agent found when it runs out of time", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("folder_survey", { path: join(root, "Telegram Desktop") })),
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [{ path: join(root, "Telegram Desktop"), reason: "chat" }] })),
			(_context, options) =>
				new Promise<AssistantMessage>((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("", { stopReason: "aborted" })));
				}),
		]);

		await serviceFor(registration, { timeoutMs: 300 }).analyze("run-9", [root]);

		expect(finalEvent()).toMatchObject({ type: "result", runId: "run-9", exclusions: [{ path: join(root, "Telegram Desktop"), files: 2 }] });
	});

	it("streams the agent's pre-tool `i` progress phrase to the UI", async () => {
		const registration = register();
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("folder_survey", { i: "채팅 다운로드 폴더 살펴보는 중", path: join(root, "Telegram Desktop") })),
			fauxAssistantMessage(fauxToolCall("propose_exclusions", { exclusions: [] })),
			fauxAssistantMessage("done"),
		]);

		await serviceFor(registration).analyze("run-10", [root]);

		expect(events).toContainEqual({ type: "progress", runId: "run-10", text: "채팅 다운로드 폴더 살펴보는 중" });
	});
});
