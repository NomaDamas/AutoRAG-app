import {
	buildVersionDiffSystemPrompt,
	cleanVersionDiffSummary,
	formatCompactDiffForLlm,
	summarizeVersionDiffWithLlm,
	type VersionDiffCompleter,
} from "@autorag/librarian";
import { resolveConfigReadOnly, type CliConfig } from "@autorag/librarian/core";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { FsVersionDiffSummaryRequest, FsVersionDiffSummaryResult } from "../shared/fs-contract";
import { resolveSllmDecisionModel, type SllmDecisionTarget } from "./decision-model";

const VERSION_DIFF_SUMMARY_TIMEOUT_MS = 18_000;
const VERSION_DIFF_SUMMARY_CACHE_MAX = 256;

export interface VersionDiffSummaryDeps {
	readonly resolveModel?: () => Promise<SllmDecisionTarget | undefined>;
	readonly complete?: VersionDiffCompleter;
	readonly defaultLanguage?: () => string;
}

export interface VersionDiffSummaryService {
	summarize(request: FsVersionDiffSummaryRequest): Promise<FsVersionDiffSummaryResult>;
}

function defaultResolveModel(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<SllmDecisionTarget | undefined> {
	const config: CliConfig = resolveConfigReadOnly({ flags: {}, env, cwd });
	const agentDir = env.PI_CODING_AGENT_DIR ?? getAgentDir();
	// Reuse the query-decomposition sLLM resolver (falls back to main session model when decomposition lacks auth).
	return resolveSllmDecisionModel(
		{
			...config,
			jev: { ...config.jev, backend: "sllm" },
		},
		env,
		cwd,
		agentDir,
		{ allowFallback: true },
	);
}

function createTargetCompleter(target: SllmDecisionTarget): VersionDiffCompleter {
	return async ({ systemPrompt, userPrompt }) => {
		const context = {
			systemPrompt,
			messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }],
		};
		const opts = {
			...(target.apiKey !== undefined ? { apiKey: target.apiKey } : {}),
			temperature: 0,
			maxTokens: 256,
			reasoning: "minimal" as const,
			signal: AbortSignal.timeout(VERSION_DIFF_SUMMARY_TIMEOUT_MS),
		};
		const message =
			target.runtime !== undefined
				? await target.runtime.completeSimple(target.model, context, opts)
				: await completeSimple(target.model, context, opts);
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			throw new Error(message.errorMessage ?? `version diff summary ${message.stopReason}`);
		}
		return message.content
			.filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("");
	};
}

function cacheKeyFor(request: FsVersionDiffSummaryRequest, language: string | undefined): string {
	const compact = formatCompactDiffForLlm(request.hunks, 1_200);
	return `${language ?? ""}|${request.previousName}|${request.currentName}|+${request.addedCount}/-${request.removedCount}|${compact}`;
}

export function isVersionDiffSummaryRequest(value: unknown): value is FsVersionDiffSummaryRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rec = value as Record<string, unknown>;
	return (
		typeof rec.previousName === "string" &&
		typeof rec.currentName === "string" &&
		typeof rec.addedCount === "number" &&
		typeof rec.removedCount === "number" &&
		Array.isArray(rec.hunks)
	);
}

/**
 * Generates an ultra-short 1–2 sentence natural-language summary of a document diff
 * using the app's query-decomposition sLLM. Results are cached in memory and any
 * missing model/auth or transient LLM error degrades silently to `{ summary: null }`
 * so the instant local diff remains unaffected.
 */
export function createVersionDiffSummaryService(deps: VersionDiffSummaryDeps = {}): VersionDiffSummaryService {
	const cache = new Map<string, FsVersionDiffSummaryResult>();
	const inflight = new Map<string, Promise<FsVersionDiffSummaryResult>>();
	const resolveModel = deps.resolveModel ?? (() => defaultResolveModel());

	function remember(key: string, value: FsVersionDiffSummaryResult): void {
		if (cache.size >= VERSION_DIFF_SUMMARY_CACHE_MAX) {
			const oldest = cache.keys().next().value;
			if (oldest !== undefined) cache.delete(oldest);
		}
		cache.set(key, value);
	}

	return {
		async summarize(request: FsVersionDiffSummaryRequest): Promise<FsVersionDiffSummaryResult> {
			const language = request.language ?? deps.defaultLanguage?.();
			const key = cacheKeyFor(request, language);
			const cached = cache.get(key);
			if (cached !== undefined) return cached;

			const existing = inflight.get(key);
			if (existing !== undefined) return existing;

			const task = (async (): Promise<FsVersionDiffSummaryResult> => {
				try {
					let completer = deps.complete;
					let modelId: string | undefined;
					if (completer === undefined) {
						const target = await resolveModel();
						if (target === undefined) return { summary: null };
						completer = createTargetCompleter(target);
						modelId = `${target.model.provider}/${target.model.id}`;
					}
					const summary = await summarizeVersionDiffWithLlm(completer, {
						previousName: request.previousName,
						currentName: request.currentName,
						addedCount: request.addedCount,
						removedCount: request.removedCount,
						hunks: request.hunks,
						...(language !== undefined ? { language } : {}),
					});
					const result: FsVersionDiffSummaryResult = {
						summary,
						...(modelId !== undefined ? { modelId } : {}),
					};
					if (summary !== null) remember(key, result);
					return result;
				} catch {
					return { summary: null };
				} finally {
					inflight.delete(key);
				}
			})();

			inflight.set(key, task);
			return task;
		},
	};
}

export { buildVersionDiffSystemPrompt, cleanVersionDiffSummary };
