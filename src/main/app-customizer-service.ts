import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createProfileSession, createWebTools, type AgentProfile, type ProfileModel } from "@autorag/librarian/profiles";
import type { AppCustomizerChange, AppCustomizerEvent, AppCustomizerPromptAnswer, AppCustomizerRequest, AppCustomizerSurface } from "../shared/app-customizer-contract";
import { findSecrets, redactSecrets } from "../shared/secret-guard";
import { createCustomizerPrompter } from "./agents/customizer-prompter";
import { guardTools } from "./agents/guard-tools";
import type { FsLocation, FsTag } from "../shared/fs-contract";
import type { SettingsBridge } from "../shared/settings-contract";
import {
	aiCustomizerProfile,
	createAiCustomizerToolkit,
} from "./agents/profiles/ai-customizer";
import {
	connectionsCustomizerProfile,
	createConnectionsCustomizerToolkit,
} from "./agents/profiles/connections-customizer";
import {
	createGeneralCustomizerToolkit,
	generalCustomizerProfile,
} from "./agents/profiles/general-customizer";
import {
	createSearchCustomizerToolkit,
	searchCustomizerProfile,
} from "./agents/profiles/search-customizer";
import type { ConfigCustomizerProfileInput, CustomizerToolkit } from "./agents/profiles/customizer-kit";
import {
	appCustomizerProfile,
	createAppCustomizerToolkit,
	type ReplyLanguage,
} from "./agents/profiles/app-customizer";
import {
	createShortcutCustomizerToolkit,
	shortcutCustomizerProfile,
} from "./agents/profiles/shortcut-customizer";
import { subscribeProfileProgress } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";

const MAX_OPEN_SESSIONS = 8;

export interface AppCustomizerServiceDeps {
	readonly send: (event: AppCustomizerEvent) => void;
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly homeDir?: string;
	readonly platform?: NodeJS.Platform;
	readonly language: () => ReplyLanguage;
	/** The whole settings service: the config assistants write the shared AutoRAG config and MCP file through it, as the pages do. */
	readonly settings: SettingsBridge;
	readonly listLocations: () => Promise<readonly FsLocation[]>;
	readonly listTags: () => Promise<readonly FsTag[]>;
}

export interface AppCustomizerService {
	send(runId: string, request: AppCustomizerRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	reset(sessionId: string): Promise<void>;
	/** The person's answer to a prompt card (a typed secret, a confirmation); false when it matches no open prompt. */
	answerPrompt(promptId: string, answer: AppCustomizerPromptAnswer): boolean;
	dispose(): void;
}

interface SessionChangesTracker {
	takeChanges(): readonly AppCustomizerChange[];
}

interface SessionEntry {
	readonly sessionId: string;
	readonly surface: AppCustomizerSurface;
	readonly session: AgentSession;
	readonly toolkit: SessionChangesTracker;
	/** Every secret value this conversation handled; no message or tool result may repeat one. */
	readonly knownSecrets: Set<string>;
	/** The run the next prompt belongs to; set when a run starts. */
	currentRunId: string;
	readonly language: ReplyLanguage;
	readonly modelKey: string;
	busy: boolean;
	cancelled: boolean;
}

interface ActiveRun {
	readonly runId: string;
	readonly sessionId: string;
	readonly abort: AbortController;
	cancelled: boolean;
}

/** The assistants that research something outside the app: a server's docs, a provider's key page. The others never need the web. */
const WEB_SURFACES: readonly AppCustomizerSurface[] = ["mcp", "apps", "ai"];

export function configProfileInput(
	language: ReplyLanguage,
	surface: AppCustomizerSurface,
	toolkit: CustomizerToolkit,
	known: ReadonlySet<string>,
	web: readonly ToolDefinition[],
): ConfigCustomizerProfileInput {
	return { language, surface, toolkit: { ...toolkit, tools: guardTools([...toolkit.tools, ...(WEB_SURFACES.includes(surface) ? web : [])], known) } };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function assistantTextFromMessage(message: unknown): string {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
	return msg.content
		.map((entry) => recordOf(entry))
		.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
		.map((entry) => (entry?.text as string).trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function hasToolCall(message: unknown): boolean {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return false;
	return msg.content.some((entry) => recordOf(entry)?.type === "toolCall");
}

function assistantMessagesSince(session: AgentSession, startIndex: number): readonly string[] {
	const messages: string[] = [];
	for (let i = startIndex; i < session.messages.length; i += 1) {
		const msg = recordOf(session.messages[i]);
		if (msg?.role !== "assistant" || msg.stopReason === "error") continue;
		const text = assistantTextFromMessage(msg);
		if (text.length > 0) messages.push(text);
	}
	return messages;
}

export function createAppCustomizerService(deps: AppCustomizerServiceDeps): AppCustomizerService {
	const sessions = new Map<string, SessionEntry>();
	const runs = new Map<string, ActiveRun>();
	const prompter = createCustomizerPrompter({ send: (event) => deps.send(event) });

	function evictOldestIfNeeded(): void {
		if (sessions.size < MAX_OPEN_SESSIONS) return;
		for (const [id, entry] of sessions) {
			if (!entry.busy) {
				entry.session.dispose();
				sessions.delete(id);
				if (sessions.size < MAX_OPEN_SESSIONS) return;
			}
		}
	}

	async function acquireSession(
		sessionId: string,
		surface: AppCustomizerSurface,
		model: ProfileModel,
	): Promise<SessionEntry> {
		const currentLang = deps.language();
		const modelKey = `${model.model.provider}:${model.model.id}`;
		const existing = sessions.get(sessionId);
		if (
			existing !== undefined &&
			existing.surface === surface &&
			existing.language === currentLang &&
			existing.modelKey === modelKey
		) {
			sessions.delete(sessionId);
			sessions.set(sessionId, existing);
			return existing;
		}
		if (existing !== undefined) {
			existing.session.dispose();
			sessions.delete(sessionId);
		}
		evictOldestIfNeeded();

		let entryRef: SessionEntry | null = null;
		const cancelled = (): boolean => entryRef?.cancelled === true;
		// The librarian's own web tools, as the AutoRAG agent has them. Fetched pages and search results are data the model reads;
		// they pass through `guardTools` like every other result, and the prompts say they are never instructions.
		const web = WEB_SURFACES.includes(surface) ? createWebTools() : [];
		const knownSecrets = new Set<string>();
		const secrets = {
			known: knownSecrets,
			prompter: () => (entryRef === null ? undefined : prompter.forRun({ runId: entryRef.currentRunId, sessionId })),
		};
		const language = (): ReplyLanguage => deps.language();
		const platformDep = deps.platform === undefined ? {} : { platform: deps.platform };
		let toolkit: SessionChangesTracker;
		let profile: AgentProfile;
		switch (surface) {
			case "shortcuts": {
				const kit = createShortcutCustomizerToolkit({ settings: deps.settings, ...platformDep, language, cancelled });
				toolkit = kit;
				profile = shortcutCustomizerProfile({ language: currentLang, toolkit: kit });
				break;
			}
			case "sidebar":
			case "contextMenu": {
				const kit = createAppCustomizerToolkit({
					settings: deps.settings,
					listLocations: deps.listLocations,
					listTags: deps.listTags,
					...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
					...platformDep,
					language,
					cancelled,
				});
				toolkit = kit;
				profile = appCustomizerProfile({ language: currentLang, toolkit: kit, ...platformDep });
				break;
			}
			case "general": {
				const kit = createGeneralCustomizerToolkit({ settings: deps.settings, ...platformDep, language, cancelled, secrets });
				toolkit = kit;
				profile = generalCustomizerProfile(configProfileInput(currentLang, surface, kit, knownSecrets, web));
				break;
			}
			case "ai":
			case "web": {
				const kit = createAiCustomizerToolkit({
					settings: deps.settings,
					...platformDep,
					language,
					cancelled,
					secrets,
					// Other coding agents keep their config under `$HOME` (`%USERPROFILE%` on Windows), which is what a person or a test
					// sets; Electron's own home path is only the fallback.
					...(deps.homeDir === undefined && deps.env.HOME === undefined && deps.env.USERPROFILE === undefined
						? {}
						: { shell: { homeDir: (process.platform === "win32" ? deps.env.USERPROFILE : deps.env.HOME)?.trim() || deps.homeDir || "", agentDir: deps.agentDir, cwd: deps.cwd, env: deps.env } }),
				});
				toolkit = kit;
				profile = aiCustomizerProfile(configProfileInput(currentLang, surface, kit, knownSecrets, web));
				break;
			}
			case "indexing":
			case "duplicates": {
				const kit = createSearchCustomizerToolkit({ settings: deps.settings, ...platformDep, language, cancelled, secrets });
				toolkit = kit;
				profile = searchCustomizerProfile(configProfileInput(currentLang, surface, kit, knownSecrets, web));
				break;
			}
			case "mcp":
			case "apps": {
				const kit = createConnectionsCustomizerToolkit({ settings: deps.settings, ...platformDep, language, cancelled, secrets });
				toolkit = kit;
				profile = connectionsCustomizerProfile(configProfileInput(currentLang, surface, kit, knownSecrets, web));
				break;
			}
		}
		const session = await createProfileSession({
			profile,
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			env: deps.env,
			model,
		});
		const created: SessionEntry = {
			sessionId,
			surface,
			session,
			toolkit,
			knownSecrets,
			currentRunId: "",
			language: currentLang,
			modelKey,
			busy: false,
			cancelled: false,
		};
		entryRef = created;
		sessions.set(sessionId, created);
		return created;
	}

	return {
		send: async (runId, request) => {
			const run: ActiveRun = {
				runId,
				sessionId: request.sessionId,
				abort: new AbortController(),
				cancelled: false,
			};
			runs.set(runId, run);
			let entry: SessionEntry | null = null;
			let unsubscribeProgress: (() => void) | null = null;
			let unsubscribeDraft: (() => void) | null = null;

			try {
				const model = await deps.resolveModel();
				if (run.cancelled) {
					deps.send({ type: "cancelled", runId, sessionId: request.sessionId, changes: [] });
					return;
				}
				entry = await acquireSession(request.sessionId, request.surface ?? "sidebar", model);
				entry.busy = true;
				entry.cancelled = false;
				entry.currentRunId = runId;
				entry.toolkit.takeChanges();

				const onAbort = (): void => {
					if (entry !== null) entry.cancelled = true;
					void entry?.session.abort();
				};
				run.abort.signal.addEventListener("abort", onAbort, { once: true });

				const startMessageCount = entry.session.messages.length;
				const committedMessages: string[] = [];
				let committedCurrent = false;
				let lastDraft = "";
				const clean = (text: string): string => redactSecrets(text, [...(entry?.knownSecrets ?? [])]);
				const commitStepText = (rawText: string): void => {
					const text = clean(rawText);
					committedCurrent = true;
					if (text.length > 0) {
						lastDraft = "";
						committedMessages.push(text);
						deps.send({ type: "assistant-message", runId, sessionId: request.sessionId, text });
					} else if (lastDraft !== "") {
						lastDraft = "";
						deps.send({ type: "draft", runId, sessionId: request.sessionId, text: "" });
					}
				};

				// Subscribed before `subscribeProfileProgress` so a step's spoken text commits before its tool's `i` shimmer.
				unsubscribeDraft = entry.session.subscribe((event) => {
					if (run.cancelled) return;
					const ev = recordOf(event);
					if (ev?.type === "message_start" && recordOf(ev.message)?.role === "assistant") {
						committedCurrent = false;
						lastDraft = "";
						return;
					}
					if (ev?.type === "message_update") {
						const text = assistantTextFromMessage(ev.message);
						if (hasToolCall(ev.message)) {
							if (!committedCurrent) commitStepText(text);
							return;
						}
						if (!committedCurrent && text !== lastDraft) {
							lastDraft = text;
							deps.send({ type: "draft", runId, sessionId: request.sessionId, text: clean(text) });
						}
						return;
					}
					if (ev?.type === "message_end" && recordOf(ev.message)?.role === "assistant") {
						const msg = recordOf(ev.message);
						if (msg?.stopReason === "toolUse" && !committedCurrent) {
							commitStepText(assistantTextFromMessage(msg));
						} else if (msg?.stopReason === "error" && lastDraft !== "") {
							lastDraft = "";
							deps.send({ type: "draft", runId, sessionId: request.sessionId, text: "" });
						}
					}
				});

				unsubscribeProgress = subscribeProfileProgress(entry.session, (text) => {
					if (!run.cancelled && committedMessages.at(-1) !== text) {
						deps.send({ type: "progress", runId, sessionId: request.sessionId, text });
					}
				});

				// A key pasted into the chat box goes to the remote model with the message, so it is taken out first and the
				// person is pointed at the masked field; the model is told that a secret was removed, never what it was.
				const pasted = findSecrets(request.message) > 0;
				const message = pasted
					? `${redactSecrets(request.message)}\n\n[The message contained a credential. It was removed before reaching you. Never ask the person to paste a secret in the chat: use the tool that opens the masked key field.]`
					: request.message;
				await entry.session.prompt(message);

				if (run.cancelled) {
					deps.send({
						type: "cancelled",
						runId,
						sessionId: request.sessionId,
						changes: entry.toolkit.takeChanges(),
					});
					return;
				}

				const failure = modelFailure(entry.session);
				if (failure !== null) throw new Error(failure);

				const changes = entry.toolkit.takeChanges();
				const known = [...entry.knownSecrets];
				const spoken = assistantMessagesSince(entry.session, startMessageCount).map((text) => redactSecrets(text, known));
				const messages =
					spoken.length > 0
						? spoken
						: changes.length > 0
							? [changes.map((c) => c.summary).join(" · ")]
							: [];
				const updatedSettings = await deps.settings.get();

				deps.send({
					type: "turn-done",
					runId,
					sessionId: request.sessionId,
					messages,
					changes,
					settings: updatedSettings,
				});
			} catch (error) {
				const changes = entry?.toolkit.takeChanges() ?? [];
				if (run.cancelled) {
					deps.send({ type: "cancelled", runId, sessionId: request.sessionId, changes });
				} else {
					deps.send({
						type: "error",
						runId,
						sessionId: request.sessionId,
						message: errorText(error),
						changes,
					});
				}
			} finally {
				unsubscribeProgress?.();
				unsubscribeDraft?.();
				if (entry !== null) {
					entry.busy = false;
					entry.cancelled = false;
				}
				prompter.closeRun(runId);
				runs.delete(runId);
			}
		},

		cancel: async (runId) => {
			const run = runs.get(runId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.abort.abort();
			prompter.closeRun(runId);
		},

		answerPrompt: (promptId, answer) => prompter.answer(promptId, answer),

		reset: async (sessionId) => {
			for (const run of runs.values()) {
				if (run.sessionId === sessionId && !run.cancelled) {
					run.cancelled = true;
					run.abort.abort();
				}
			}
			const existing = sessions.get(sessionId);
			if (existing !== undefined) {
				existing.cancelled = true;
				existing.session.dispose();
				sessions.delete(sessionId);
			}
		},

		dispose: () => {
			for (const run of runs.values()) {
				run.cancelled = true;
				run.abort.abort();
			}
			runs.clear();
			for (const entry of sessions.values()) {
				entry.cancelled = true;
				entry.session.dispose();
			}
			sessions.clear();
		},
	};
}
