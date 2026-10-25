import { existsSync } from "node:fs";
import { AutoRAGLite, type AutoRAGRefreshResult, type RefreshMethod } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, type CliConfig } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readDazziPlanCredential } from "./dazzi-plan-credential";
import type { ConfigRefreshDiagnostic, ConfigRefreshResult } from "../shared/settings-contract";
import { APP_INDEXING_CAPABILITIES, applyAppIndexing, readAppIndexing } from "./app-indexing";
import { preflightEmbedder } from "./embedder-preflight";
import {
	embedderKind,
	isEmbeddingTimeout,
	smallerBatchSize,
	saveLearnedBatchSize,
	startingBatchSize,
} from "./embedding-batch";
import { ensureEmbeddingForConfig, localModelMissing } from "./embedding-daemon";
import { createMinSyncWatchdog, EMBEDDING_STALL_RETRIES, runWithStallRetry } from "./minsync-watchdog";
import { ensureMessengerConfigsFor } from "./messenger-config";
import { takeSharedParseFailures } from "./parse-isolation";
import { runWithRecovery } from "./refresh-recovery";
import { findUnavailableRoots } from "./search-roots";
import { methodsForSemantic, runWithoutSemanticIndexing } from "./semantic-policy";
import { t } from "../shared/i18n/core";
import { embedderStallReport, refreshFailureReport, reportError } from "./error-report-core";

/**
 * The single AutoRAG index-refresh path shared by Settings (manual refresh) and
 * onboarding (the first index run). Both resolve the one config every surface
 * (CLI, TUI, serve, this app) reads, apply the app's code-folder exclusions, and
 * run the same AutoRAGLite methods, so their diagnostics and semantics never
 * drift apart.
 */
export interface AutoragRefreshDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** Test seam: waits between retries of a transient file error; production uses `RECOVERY_BACKOFF_MS`. */
	readonly recoveryBackoffMs?: readonly number[];
	/** Test seam for the embedder preflight request; production uses the global `fetch`. */
	readonly preflightFetch?: typeof fetch;
}

export const REFRESH_METHODS: Record<RefreshMethod, true> = {
	parsed: true,
	minsync: true,
	datasources: true,
	jikji: true,
	everything: true,
	fsearch: true,
};

/** The config resolver input shared by every helper here. */
export function configInput(deps: AutoragRefreshDeps): { flags: Record<string, never>; env: NodeJS.ProcessEnv; cwd: string } {
	return { flags: {}, env: deps.env, cwd: deps.cwd };
}

/**
 * The config the app actually runs with: raw config read, `appIndexing`
 * exclusions already applied. Onboarding reads the workspace path from here so
 * progress files land where AutoRAGLite wrote them.
 */
export async function resolveEffectiveConfig(
	deps: AutoragRefreshDeps,
): Promise<{ readonly configPath: string; readonly raw: Record<string, unknown>; readonly config: CliConfig }> {
	const input = configInput(deps);
	const configPath = resolveConfigPath(input).configPath;
	const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
	const config = await applyAppIndexing(resolveConfigReadOnly(input), raw);
	return { configPath, raw, config };
}

/** What a plain "refresh my folders" run covers: the parsed mirror and its vector index. */
export const LOCAL_REFRESH_METHODS: readonly RefreshMethod[] = ["parsed", "minsync"];

/**
 * Manual index refresh from Settings; returns diagnostics instead of throwing for known failures.
 * A failed run is reported here, so every caller (Settings, onboarding, the Finder checkbox in the
 * fs worker) reports the same way.
 */
export async function refreshAutoragIndex(deps: AutoragRefreshDeps, methods?: readonly string[]): Promise<ConfigRefreshResult> {
	const result = await runRefresh(deps, methods);
	const report = refreshFailureReport(result);
	if (report !== null) reportError(report);
	return result;
}

async function runRefresh(
	deps: AutoragRefreshDeps,
	methods?: readonly string[],
): Promise<ConfigRefreshResult> {
	const requested = methods ?? LOCAL_REFRESH_METHODS;
	const invalid = requested.filter((method) => REFRESH_METHODS[method as RefreshMethod] !== true);
	if (invalid.length > 0) throw new Error(`Unknown refresh method(s): ${invalid.join(", ")}`);
	if (requested.length === 0) throw new Error("At least one refresh method is required");
	const input = configInput(deps);
	const configPath = resolveConfigPath(input).configPath;
	const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
	// Keyword-only mode runs no MinSync: its parsed mirror and Jikji steps run instead.
	const semantic = readAppIndexing(raw).semanticSearch;
	const selected = methodsForSemantic(requested as readonly RefreshMethod[], semantic);
	// MinSync would download the missing weights itself, with no progress and no way to stop it: the app's own download comes first.
	if (selected.includes("minsync") && localModelMissing(raw)) {
		const message = t("main.refresh.modelMissing");
		return {
			ok: false,
			methods: selected,
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics: [{ code: "embedding-model-missing", severity: "error", message }],
			error: message,
		};
	}
	// Everything that embeds during this run (MinSync, mailcrawl, the chat sidecars) finds the local server by its state files.
	if (semantic) await ensureEmbeddingForConfig(raw);
	// Windows: discrawl/slacrawl cannot find the messenger apps' data without a config at their default path.
	if (selected.includes("datasources")) {
		await ensureMessengerConfigsFor(raw.datasources, { platform: process.platform, env: deps.env, home: deps.env.USERPROFILE ?? deps.env.HOME ?? "" });
	}
	// A refresh re-walks the folders, so a dot-folder created minutes ago is excluded too.
	const effective = await applyAppIndexing(resolveConfigReadOnly(input), raw, { fresh: true, configPath });
	const diagnostics: ConfigRefreshDiagnostic[] = [];
	// A root that cannot be listed, or reads as empty although it was full, would make this
	// refresh delete everything indexed from it; leave the index alone until it returns.
	if (selected.includes("parsed") || selected.includes("minsync")) {
		const problems = await findUnavailableRoots(effective.searchPaths, effective.workspacePath);
		if (problems.length > 0) {
			const message = problems.map((problem) => t("main.refresh.rootUnavailable", { folder: problem.root, indexed: problem.indexed })).join(" ");
			return {
				ok: false,
				methods: selected,
				scanned: 0,
				written: 0,
				deleted: 0,
				skipped: 0,
				diagnostics: [{ code: "search-root-unavailable", severity: "error", message, folders: problems.map((problem) => problem.root) }],
				error: message,
			};
		}
	}
	if (
		selected.includes("minsync") &&
		effective.minSync?.embedder?.id === "openai:qwen/qwen3-embedding-0.6b" &&
		effective.minSync.embedder.apiKeyEnv === "OPENAI_API_KEY" &&
		(typeof process.env.OPENAI_API_KEY !== "string" || process.env.OPENAI_API_KEY.length === 0)
	) {
		const bridged =
			deps.env.OPENAI_API_KEY ||
			(await readDazziPlanCredential(getAgentDir()));
		if (typeof bridged === "string" && bridged.length > 0) {
			process.env.OPENAI_API_KEY = bridged;
		}
	}
	// One embedding request before any document is parsed: a remote embedder that cannot
	// work would otherwise fail only when MinSync starts, after the whole parse phase.
	if (selected.includes("minsync")) {
		const preflight = await preflightEmbedder(effective.minSync?.embedder, {
			env: process.env,
			...(deps.preflightFetch === undefined ? {} : { fetchImpl: deps.preflightFetch }),
		});
		if (!preflight.ok) {
			return {
				ok: false,
				methods: selected,
				scanned: 0,
				written: 0,
				deleted: 0,
				skipped: 0,
				diagnostics: [{ code: "embedder-preflight-failed", severity: "error", message: preflight.message, reason: preflight.reason }],
				error: preflight.message,
			};
		}
	}
	try {
		// A file the OS keeps failing to read is left out of this run, not allowed to abort every other document.
		let recovered: { retries: number; quarantined: readonly string[]; code: string | null } = { retries: 0, quarantined: [], code: null };
		const refreshOnce = async (): Promise<AutoRAGRefreshResult> => {
			const outcome = await runWithRecovery(
				(left) => new AutoRAGLite({ ...effective, excludePaths: [...(effective.excludePaths ?? []), ...left] }).refresh(false, { methods: selected }),
				{ searchPaths: effective.searchPaths, ...(deps.recoveryBackoffMs === undefined ? {} : { backoffMs: deps.recoveryBackoffMs }) },
			);
			recovered = { retries: recovered.retries + outcome.retries, quarantined: [...new Set([...recovered.quarantined, ...outcome.quarantined])], code: outcome.code ?? recovered.code };
			return outcome.value;
		};
		// A hung embedder never returns on its own: the watchdog kills it and the sync is retried
		// (parsing is incremental, so a retry repeats only the embedding).
		const stallRetried = (): Promise<{ value: AutoRAGRefreshResult; retries: number }> =>
			runWithStallRetry(refreshOnce, (outcome) => outcome.minsync?.ok !== false, createMinSyncWatchdog(), EMBEDDING_STALL_RETRIES);
		// Keyword-only mode also turns the datasources' own embedding steps off for the duration of the run.
		const { value: result, retries } = await (semantic ? stallRetried() : runWithoutSemanticIndexing(stallRetried));
		if (recovered.retries > 0 || recovered.quarantined.length > 0) {
			diagnostics.push({
				code: recovered.quarantined.length > 0 ? "files-left-out" : "refresh-retried",
				severity: "warning",
				...(recovered.quarantined.length > 0 ? { count: recovered.quarantined.length } : {}),
				message: t(recovered.quarantined.length > 0 ? "main.refresh.filesLeftOut" : "main.refresh.retried", { files: recovered.quarantined.length, retries: recovered.retries, code: recovered.code ?? "" }),
			});
		}
		if (retries > 0) {
			reportError(embedderStallReport(retries));
			diagnostics.push({
				code: "minsync-stalled-retried",
				severity: "warning",
				message: `The embedder stopped making progress and was restarted ${retries} time(s).`,
			});
		}
		// The librarian reports every failed parse with one generic message; what killed the file is only known here.
		const killed = takeSharedParseFailures();
		if (killed.timedOut > 0 || killed.crashed > 0) {
			diagnostics.push({ code: "parse-killed", severity: "warning", message: t("main.refresh.parseKilled", { timedOut: killed.timedOut, crashed: killed.crashed }), count: killed.timedOut + killed.crashed });
		}
		const toDiagnostic = (diagnostic: { readonly code: unknown; readonly severity: ConfigRefreshDiagnostic["severity"]; readonly message: string }): ConfigRefreshDiagnostic => ({
			code: String(diagnostic.code),
			severity: diagnostic.severity,
			message: diagnostic.message,
		});
		// The embedding gateway aborts a request after 30 s. When a MinSync batch is
		// too big for this machine, halve it and re-run only the MinSync step
		// (`syncMinSync`, not a full refresh) until it fits.
		let minsyncOk = result.minsync?.ok;
		let minsyncReason = result.minsync?.reason;
		let minsyncDiagnostics: readonly ConfigRefreshDiagnostic[] = [
			...(result.minsync?.diagnostics ?? []),
			...result.diagnostics.filter((diagnostic) => diagnostic.code === "minsync-file-skipped"),
		].map(toDiagnostic);
		if (selected.includes("minsync")) {
			const embedder = effective.minSync?.embedder;
			const initial = embedder?.batchSize ?? startingBatchSize(configPath, raw);
			let batch = initial;
			// MinSync 0.4.8 aborts (`ok: false`) when the first files time out, and exits 6
			// (`ok: true`, `minsync-file-skipped`) when a later batch times out mid-run;
			// either way, halving the batch and re-running `syncMinSync` retries the skipped files.
			const minsyncTimedOut = (): boolean =>
				isEmbeddingTimeout([minsyncReason, ...minsyncDiagnostics.map((diagnostic) => diagnostic.message)]);
			while (minsyncTimedOut()) {
				const next = smallerBatchSize(batch);
				if (next === null) break;
				batch = next;
				const { value: retry } = await runWithStallRetry(
					() => new AutoRAGLite({ ...effective, minSync: { ...effective.minSync, embedder: { ...embedder, batchSize: batch } } }).syncMinSync(),
					(outcome) => outcome?.ok !== false,
					createMinSyncWatchdog(),
					EMBEDDING_STALL_RETRIES,
				);
				minsyncOk = retry?.ok;
				minsyncReason = retry?.reason;
				const baseDiagnostics: ConfigRefreshDiagnostic[] =
					retry?.diagnostic === undefined
						? retry?.ok === false
							? [{ code: "minsync-sync-failed", severity: "error", message: `MinSync sync failed: ${retry.reason ?? "failed"}` }]
							: []
						: [{ code: retry.diagnostic.code, severity: retry.ok ? "info" : "error", message: retry.diagnostic.message }];
				const skippedDiagnostics: ConfigRefreshDiagnostic[] = (retry?.filesFailed ?? []).map((failure) => ({
					code: "minsync-file-skipped",
					severity: "warning",
					message: `MinSync skipped this file at the ${failure.stage} stage and will retry it on the next sync: ${failure.error}`,
				}));
				minsyncDiagnostics = [...baseDiagnostics, ...skippedDiagnostics];
			}
			if (minsyncOk !== false && !minsyncTimedOut() && batch < initial) {
				// Remember what worked so the next refresh does not repeat the failures.
				saveLearnedBatchSize(configPath, embedderKind(embedder), batch);
			}
		}
		// Everything but MinSync's own diagnostics comes from the one full refresh; MinSync's
		// are the last attempt's, so a superseded timeout never reaches the user.
		diagnostics.push(
			...result.diagnostics.filter((diagnostic) => diagnostic.source !== "minsync" && diagnostic.code !== "minsync-file-skipped").map(toDiagnostic),
			...minsyncDiagnostics,
		);
		const failures: string[] = [];
		if (minsyncOk === false) failures.push(`minsync: ${minsyncReason ?? "failed"}`);
		if (result.everything !== undefined && result.everything.ok === false) failures.push(`everything: ${result.everything.reason ?? "failed"}`);
		// fsearch-cli is an optional user install: without it file-name search falls
		// back to a filesystem walk, so a missing binary must not fail the refresh.
		if (result.fsearch !== undefined && result.fsearch.ok === false && result.fsearch.reason !== "binary-missing") {
			failures.push(`fsearch: ${result.fsearch.message ?? result.fsearch.reason ?? "failed"}`);
		}
		for (const datasource of result.datasources ?? []) {
			if (datasource.ok === false) failures.push(`datasources ${datasource.skill}: ${datasource.message ?? datasource.error ?? "failed"}`);
		}
		for (const diagnostic of diagnostics) {
			if (diagnostic.severity === "error") failures.push(diagnostic.message);
		}
		const settings = readAppIndexing(raw);
		if (settings.excludeCodeFolders) {
			const unsupported = selected
				.filter((method): method is "everything" | "fsearch" => method === "everything" || method === "fsearch")
				.filter((method) => APP_INDEXING_CAPABILITIES[method] !== true);
			if (unsupported.length > 0) {
				diagnostics.push({
					code: "code-folder-exclusions-unsupported",
					severity: "warning",
					message: `Automatic code-folder exclusions are not forwarded to ${unsupported.join(", ")} (its native client has no exclusion option).`,
				});
			}
		}
		const error = failures.length > 0 ? failures.join("; ") : null;
		return {
			ok: error === null,
			methods: selected,
			scanned: result.scanned,
			written: result.written,
			deleted: result.deleted,
			skipped: result.skipped,
			diagnostics,
			error,
		};
	} catch (error) {
		return {
			ok: false,
			methods: selected,
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
