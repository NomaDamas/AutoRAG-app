import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SmartExclusion, SmartIndexingEvent } from "../shared/smart-indexing-contract";
import { createProfileSession, type ProfileModel } from "./agents/agent-factory";
import { createFolderStats } from "./agents/profiles/folder-stats";
import { createProposalCollector, type ExclusionProposal, type ReplyLanguage, smartIndexingProfile } from "./agents/profiles/smart-indexing";
import { type FolderScanOptions, scanFolder } from "./onboarding-scan";

/**
 * Runs the smart-indexing agent (`agents/profiles/smart-indexing.ts`) over the
 * folders the user selected and turns what it proposes into the entries the
 * onboarding screen shows. The agent only names folders; the file counts and
 * sizes next to each one are measured here with the same walk as the folder
 * pre-scan, so they match what the first index would really take.
 *
 * One terminal event per run: `result`, `error` or `cancelled`. A run that ran
 * out of time still reports the folders found so far.
 */

export interface SmartIndexingServiceDeps {
	readonly send: (event: SmartIndexingEvent) => void;
	/** The model the AutoRAG agent runs on; rejects when none is signed in or connected. */
	readonly resolveModel: () => Promise<ProfileModel>;
	/** pi's agent dir, shared with the AutoRAG agent for credentials. */
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** The interface language, read per run: the agent writes its reasons in it. */
	readonly language: () => ReplyLanguage;
	/** The pre-scan's file rules, so counts match it. */
	readonly scanOptions: FolderScanOptions;
	/** Longest a run may take; default {@link DEFAULT_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
}

export interface SmartIndexingService {
	/** `roots` come from the renderer; anything that is not an existing absolute folder is ignored. */
	analyze(runId: string, roots: readonly unknown[]): Promise<void>;
	cancel(runId: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;

const TASK = "Count the chosen folders with folder_stats, apply the criteria, and propose the sub-folders to leave out of the index.";

/** Tools whose `path` argument names what the agent is looking at. */
const EXPLORING_TOOLS: Readonly<Record<string, true>> = { ls: true, find: true, read: true, folder_stats: true };

interface Run {
	/** Stops the agent: a cancel or the clock. */
	readonly abort: AbortController;
	/** Stops the measuring walk: a cancel only, since a run cut off by the clock still reports what it found. */
	readonly measure: AbortController;
	cancelled: boolean;
	timedOut: boolean;
}

async function existingFolders(candidates: readonly unknown[]): Promise<string[]> {
	const folders: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || !isAbsolute(candidate) || folders.includes(candidate)) continue;
		if (await stat(candidate).then((entry) => entry.isDirectory(), () => false)) folders.push(candidate);
	}
	return folders;
}

/** The provider's error when the last model request failed; pi reports it on the message instead of throwing. */
function modelFailure(session: AgentSession): string | null {
	for (let index = session.messages.length - 1; index >= 0; index -= 1) {
		const message = session.messages[index];
		if (message?.role !== "assistant") continue;
		return message.stopReason === "error" ? (message.errorMessage ?? "The model request failed.") : null;
	}
	return null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createSmartIndexingService(deps: SmartIndexingServiceDeps): SmartIndexingService {
	const runs = new Map<string, Run>();

	async function measured(proposals: readonly ExclusionProposal[], signal: AbortSignal): Promise<SmartExclusion[]> {
		const exclusions: SmartExclusion[] = [];
		for (const proposal of proposals) {
			const scan = await scanFolder(proposal.path, deps.scanOptions, () => undefined, signal);
			// A folder the index would read nothing from changes nothing when left out.
			if (scan.files === 0) continue;
			exclusions.push({ path: proposal.path, root: proposal.root, reason: proposal.reason, files: scan.files, bytes: scan.bytes, excluded: true });
		}
		return exclusions;
	}

	async function execute(runId: string, run: Run, roots: readonly string[]): Promise<void> {
		const stats = createFolderStats(roots, { supportedExtensions: deps.scanOptions.supportedExtensions, maxSourceBytes: deps.scanOptions.maxSourceBytes });
		const collector = createProposalCollector(roots, stats);
		let session: AgentSession | null = null;
		const timer = setTimeout(() => {
			run.timedOut = true;
			run.abort.abort();
		}, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
		try {
			const model = await deps.resolveModel();
			if (run.cancelled) return;
			session = await createProfileSession({
				profile: smartIndexingProfile({ roots, language: deps.language(), extensions: [...deps.scanOptions.supportedExtensions], collector, stats }),
				cwd: roots[0] as string,
				agentDir: deps.agentDir,
				env: deps.env,
				model,
			});
			session.subscribe((event) => {
				if (event.type !== "tool_execution_start" || EXPLORING_TOOLS[event.toolName] !== true || run.cancelled) return;
				const path: unknown = event.args?.path;
				deps.send({ type: "exploring", runId, path: typeof path === "string" ? path : roots[0] as string });
			});
			run.abort.signal.addEventListener("abort", () => void session?.abort(), { once: true });
			await session.prompt(TASK);
			if (run.cancelled) return;
			const failure = run.timedOut ? null : modelFailure(session);
			if (failure !== null) throw new Error(failure);
			// A run cut off by the clock still has what it proposed; one that never
			// answered has nothing to report.
			if (!collector.answered() && !(run.timedOut && collector.proposals().length > 0)) {
				throw new Error(run.timedOut ? "The analysis timed out before the AI reported anything." : "The AI ended without reporting which folders to exclude.");
			}
			const exclusions = await measured(collector.proposals(), run.measure.signal);
			if (!run.cancelled) deps.send({ type: "result", runId, exclusions });
		} catch (error) {
			if (!run.cancelled) deps.send({ type: "error", runId, message: errorText(error) });
		} finally {
			clearTimeout(timer);
			session?.dispose();
		}
	}

	return {
		analyze: async (runId, candidates) => {
			const roots = await existingFolders(candidates);
			if (roots.length === 0) {
				deps.send({ type: "result", runId, exclusions: [] });
				return;
			}
			const run: Run = { abort: new AbortController(), measure: new AbortController(), cancelled: false, timedOut: false };
			runs.set(runId, run);
			try {
				await execute(runId, run, roots);
			} finally {
				runs.delete(runId);
			}
			if (run.cancelled) deps.send({ type: "cancelled", runId });
		},
		cancel: async (runId) => {
			const run = runs.get(runId);
			if (run === undefined || run.cancelled) return;
			run.cancelled = true;
			run.measure.abort();
			run.abort.abort();
		},
	};
}
