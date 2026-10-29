import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createProfileSession, type ProfileModel } from "@autorag/librarian/profiles";
import type { AppCustomizerEvent, AppCustomizerRequest } from "../shared/app-customizer-contract";
import type { FsLocation, FsTag } from "../shared/fs-contract";
import type { SettingsBridge } from "../shared/settings-contract";
import {
	appCustomizerProfile,
	createAppCustomizerToolkit,
	type AppCustomizerToolkit,
	type ReplyLanguage,
} from "./agents/profiles/app-customizer";
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
	readonly language: () => ReplyLanguage;
	readonly settings: Pick<SettingsBridge, "get" | "set">;
	readonly listLocations: () => Promise<readonly FsLocation[]>;
	readonly listTags: () => Promise<readonly FsTag[]>;
}

export interface AppCustomizerService {
	send(runId: string, request: AppCustomizerRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
	reset(sessionId: string): Promise<void>;
	dispose(): void;
}

interface SessionEntry {
	readonly sessionId: string;
	readonly session: AgentSession;
	readonly toolkit: AppCustomizerToolkit;
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

function latestAssistantReply(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i -= 1) {
		const msg = recordOf(session.messages[i]);
		if (msg?.role !== "assistant") continue;
		const text = assistantTextFromMessage(msg);
		if (text.length > 0) return text;
	}
	return "";
}

export function createAppCustomizerService(deps: AppCustomizerServiceDeps): AppCustomizerService {
	const sessions = new Map<string, SessionEntry>();
	const runs = new Map<string, ActiveRun>();

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

	async function acquireSession(sessionId: string, model: ProfileModel): Promise<SessionEntry> {
		const currentLang = deps.language();
		const modelKey = `${model.model.provider}:${model.model.id}`;
		const existing = sessions.get(sessionId);
		if (existing !== undefined && existing.language === currentLang && existing.modelKey === modelKey) {
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
		const toolkit = createAppCustomizerToolkit({
			settings: deps.settings,
			listLocations: deps.listLocations,
			listTags: deps.listTags,
			...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
			language: () => deps.language(),
			cancelled: () => entryRef?.cancelled === true,
		});
		const session = await createProfileSession({
			profile: appCustomizerProfile({ language: currentLang, toolkit }),
			cwd: deps.cwd,
			agentDir: deps.agentDir,
			env: deps.env,
			model,
		});
		const created: SessionEntry = {
			sessionId,
			session,
			toolkit,
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
				entry = await acquireSession(request.sessionId, model);
				entry.busy = true;
				entry.cancelled = false;
				entry.toolkit.takeChanges();

				const onAbort = (): void => {
					if (entry !== null) entry.cancelled = true;
					void entry?.session.abort();
				};
				run.abort.signal.addEventListener("abort", onAbort, { once: true });

				unsubscribeProgress = subscribeProfileProgress(entry.session, (text) => {
					if (!run.cancelled) {
						deps.send({ type: "progress", runId, sessionId: request.sessionId, text });
					}
				});

				let lastDraft = "";
				unsubscribeDraft = entry.session.subscribe((event) => {
					if (run.cancelled) return;
					const ev = recordOf(event);
					if (ev?.type === "message_update") {
						if (hasToolCall(ev.message)) {
							if (lastDraft !== "") {
								lastDraft = "";
								deps.send({ type: "draft", runId, sessionId: request.sessionId, text: "" });
							}
							return;
						}
						const draft = assistantTextFromMessage(ev.message);
						if (draft !== lastDraft) {
							lastDraft = draft;
							deps.send({ type: "draft", runId, sessionId: request.sessionId, text: draft });
						}
					}
				});

				await entry.session.prompt(request.message);

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
				const rawReply = latestAssistantReply(entry.session);
				const reply =
					rawReply.length > 0
						? rawReply
						: changes.length > 0
							? changes.map((c) => c.summary).join(" · ")
							: "";
				const updatedSettings = await deps.settings.get();

				deps.send({
					type: "turn-done",
					runId,
					sessionId: request.sessionId,
					reply,
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
				runs.delete(runId);
			}
		},

		cancel: async (runId) => {
			const run = runs.get(runId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.abort.abort();
		},

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
