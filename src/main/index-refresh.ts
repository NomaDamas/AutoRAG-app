import { existsSync } from "node:fs";
import { AutoRAGLite, type RefreshMethod } from "@autorag/librarian";
import { readRawConfigObject, resolveConfigPath, resolveConfigReadOnly, writeConfigObject, type CliConfig } from "@autorag/librarian/core";
import type { ConfigRefreshDiagnostic, ConfigRefreshResult } from "../shared/settings-contract";
import { APP_INDEXING_CAPABILITIES, applyAppIndexing, readAppIndexing } from "./app-indexing";
import {
	embedderKind,
	isEmbeddingTimeout,
	smallerBatchSize,
	startingBatchSize,
	withLearnedBatchSize,
} from "./embedding-batch";

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

/** Manual index refresh from Settings; returns diagnostics instead of throwing for known failures. */
export async function refreshAutoragIndex(
	deps: AutoragRefreshDeps,
	methods?: readonly string[],
): Promise<ConfigRefreshResult> {
	const requested = methods ?? LOCAL_REFRESH_METHODS;
	const invalid = requested.filter((method) => REFRESH_METHODS[method as RefreshMethod] !== true);
	if (invalid.length > 0) throw new Error(`Unknown refresh method(s): ${invalid.join(", ")}`);
	const selected = requested as readonly RefreshMethod[];
	if (selected.length === 0) throw new Error("At least one refresh method is required");
	const input = configInput(deps);
	const configPath = resolveConfigPath(input).configPath;
	const raw = existsSync(configPath) ? readRawConfigObject(configPath) : {};
	// A refresh re-walks the folders, so a dot-folder created minutes ago is excluded too.
	const effective = await applyAppIndexing(resolveConfigReadOnly(input), raw, { fresh: true });
	const diagnostics: ConfigRefreshDiagnostic[] = [];
	try {
		const lite = new AutoRAGLite(effective);
		const result = await lite.refresh(false, { methods: selected });
		const toDiagnostic = (diagnostic: { readonly code: unknown; readonly severity: ConfigRefreshDiagnostic["severity"]; readonly message: string }): ConfigRefreshDiagnostic => ({
			code: String(diagnostic.code),
			severity: diagnostic.severity,
			message: diagnostic.message,
		});
		diagnostics.push(...result.diagnostics.map(toDiagnostic));
		// The embedding gateway aborts a request after 30 s. When a MinSync batch is
		// too big for this machine, halve it and run only MinSync again until it fits.
		let minsync = result.minsync;
		if (selected.includes("minsync")) {
			const embedder = effective.minSync?.embedder;
			const kind = embedderKind(embedder);
			const initial = embedder?.batchSize ?? startingBatchSize(raw);
			let batch = initial;
			while (minsync !== undefined && minsync.ok === false && isEmbeddingTimeout(minsyncFailureText(minsync, diagnostics))) {
				const next = smallerBatchSize(batch);
				if (next === null) break;
				batch = next;
				const retry = await new AutoRAGLite({ ...effective, minSync: { ...effective.minSync, embedder: { ...embedder, batchSize: batch } } }).refresh(false, { methods: ["minsync"] });
				minsync = retry.minsync;
				for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
					if (diagnostics[index]?.code === "minsync-sync-failed") diagnostics.splice(index, 1);
				}
				diagnostics.push(...retry.diagnostics.map(toDiagnostic));
			}
			if (minsync?.ok !== false && batch < initial) {
				// Remember what worked so the next refresh does not repeat the failures.
				writeConfigObject(configPath, withLearnedBatchSize(readRawConfigObject(configPath), kind, batch));
			}
		}
		const failures: string[] = [];
		if (minsync !== undefined && minsync.ok === false) failures.push(`minsync: ${minsync.reason ?? "failed"}`);
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

/** The text a failed MinSync step reports: its reason plus any MinSync diagnostic. */
function minsyncFailureText(
	minsync: { readonly reason?: string; readonly diagnostic?: { readonly message: string } },
	diagnostics: readonly ConfigRefreshDiagnostic[],
): string {
	return [minsync.reason, minsync.diagnostic?.message, ...diagnostics.filter((diagnostic) => diagnostic.code === "minsync-sync-failed").map((diagnostic) => diagnostic.message)]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}
