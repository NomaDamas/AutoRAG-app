import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createProfileSession, type ProfileModel } from "@autorag/librarian/profiles";
import type { ErrorFixEvent, ErrorFixRequest } from "../shared/error-fix-contract";
import type { ConfigRefreshResult } from "../shared/settings-contract";
import { createErrorFixToolkit, errorFixProfile, type ErrorFixToolkit, type ReplyLanguage } from "./agents/profiles/error-fix";
import { subscribeProfileProgress } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import type { AutoRagConfigService } from "./autorag-config-service";

/**
 * Runs the error-fix agent (`agents/profiles/error-fix.ts`) for one error the
 * person saw and reports what it found and changed.
 *
 * One terminal event per run: `result`, `error` or `cancelled`. The run never
 * makes a change after a cancel: the config and index handed to the agent are
 * wrapped so a late tool call of a stopped run is refused.
 */

export interface ErrorFixServiceDeps {
	readonly send: (event: ErrorFixEvent) => void;
	/** The model AI Search runs on; rejects when none is signed in or connected. */
	readonly resolveModel: () => Promise<ProfileModel>;
	/** pi's agent dir, shared with the AutoRAG agent for credentials. */
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** Working directory of the agent's file and shell tools. */
	readonly cwd: string;
	/** The interface language, read per run: the agent writes its summary in it. */
	readonly language: () => ReplyLanguage;
	readonly config: Pick<AutoRagConfigService, "get" | "patch">;
	readonly diagnostics: () => Promise<unknown>;
	readonly refreshIndex: () => Promise<ConfigRefreshResult>;
	/** Called after the agent wrote a change to the config, so what was built on the old config can be rebuilt. */
	readonly onConfigChanged?: () => void;
}

export interface ErrorFixService {
	start(runId: string, request: ErrorFixRequest): Promise<void>;
	cancel(runId: string): Promise<void>;
}

const TASK = "Find out why the error happened, repair what you can reach, and report the result with report_result.";

interface Run {
	readonly abort: AbortController;
	cancelled: boolean;
}

export function createErrorFixService(deps: ErrorFixServiceDeps): ErrorFixService {
	const runs = new Map<string, Run>();

	async function execute(runId: string, run: Run, request: ErrorFixRequest, toolkit: ErrorFixToolkit): Promise<void> {
		let session: AgentSession | null = null;
		try {
			const model = await deps.resolveModel();
			if (run.cancelled) return;
			session = await createProfileSession({
				profile: errorFixProfile({ message: request.message, surface: request.surface, language: deps.language(), toolkit }),
				cwd: deps.cwd,
				agentDir: deps.agentDir,
				env: deps.env,
				model,
			});
			run.abort.signal.addEventListener("abort", () => void session?.abort(), { once: true });
			subscribeProfileProgress(session, (text) => {
				if (!run.cancelled) deps.send({ type: "progress", runId, text });
			});
			await session.prompt(TASK);
			if (run.cancelled) return;
			const failure = modelFailure(session);
			if (failure !== null) throw new Error(failure);
			const result = toolkit.result();
			if (result === null) throw new Error("The AI ended without reporting a result.");
			deps.send({ type: "result", runId, result });
		} catch (error) {
			if (!run.cancelled) deps.send({ type: "error", runId, message: errorText(error), ...toolkit.trace() });
		} finally {
			session?.dispose();
		}
	}

	return {
		start: async (runId, request) => {
			const run: Run = { abort: new AbortController(), cancelled: false };
			runs.set(runId, run);
			const stopped = (): Promise<never> => Promise.reject(new Error("The run was cancelled."));
			const toolkit = createErrorFixToolkit({
				cwd: deps.cwd,
				agentDir: deps.agentDir,
				env: deps.env,
				cancelled: () => run.cancelled,
				config: {
					get: () => deps.config.get(),
					patch: async (updates) => {
						if (run.cancelled) return stopped();
						const snapshot = await deps.config.patch(updates);
						deps.onConfigChanged?.();
						return snapshot;
					},
				},
				diagnostics: deps.diagnostics,
				refreshIndex: () => (run.cancelled ? stopped() : deps.refreshIndex()),
			});
			try {
				await execute(runId, run, request, toolkit);
			} finally {
				runs.delete(runId);
			}
			if (run.cancelled) deps.send({ type: "cancelled", runId, ...toolkit.trace() });
		},
		cancel: async (runId) => {
			const run = runs.get(runId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.abort.abort();
		},
	};
}
