import { join } from "node:path";
import type { ByokProviderId, SourceFacts, SourceId } from "../shared/onboarding-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Writes the onboarding choices into the shared AutoRAG config the CLI, TUI,
 * serve, and this app all resolve. Pure over its inputs (a raw config object
 * in, the next one out) so the merge rules — search paths replace, embedder only
 * when absent, datasource aliases merge, BYOK model — are
 * unit-testable without touching disk.
 */

export interface EmbedderChoice {
	readonly id: string;
	readonly dimension: number;
	readonly baseUrl?: string;
	readonly apiKeyEnv?: string;
}

export interface ByokModelChoice {
	readonly provider: ByokProviderId;
	readonly modelId: string;
	readonly baseUrl: string | null;
	readonly envName: string | null;
}

/**
 * A source the user switched on. No `description` is written: an existing one in
 * the config survives the alias merge, and a missing one is filled in later from
 * the indexed content, not typed during onboarding.
 */
export interface IndexingDatasource {
	readonly id: SourceId;
	readonly facts: SourceFacts;
}

export interface ApplyIndexingConfigInput {
	readonly raw: Record<string, unknown>;
	readonly folders: readonly string[];
	readonly datasources: readonly IndexingDatasource[];
	/** Home directory; each mailcrawl account's archive lives in `<home>/.mailcrawl/<account>`. */
	readonly home: string;
	/** Null keeps an existing `minSync.embedder` untouched. */
	readonly embedder: EmbedderChoice | null;
	/** Null keeps the existing `workspacePath`; a path replaces it. */
	readonly workspacePath: string | null;
	/** False writes keyword-only mode (`appIndexing.semanticSearch: false`); true removes the switch. Absent leaves it as is. */
	readonly semanticSearch?: boolean;
	/** Folders to leave out; kept after any exclusions the config already has. */
	readonly excludePaths?: readonly string[];
	readonly model: ByokModelChoice | null;
}

function obsidianAlias(index: number): string {
	return index === 0 ? "obsidian" : `obsidian-${index + 1}`;
}

function entriesFor(datasource: IndexingDatasource, home: string): Record<string, Record<string, unknown>> {
	switch (datasource.id) {
		case "kakao":
			// With librarian >= 2.10.4 the kakao sidecar reads lazykatok's archive and embeds
			// with the shared embedder, so `lazykatok index` (fastembed) is never run.
			return { kakao: { instanceId: "default", connector: {} } };
		case "github":
			return {
				github: {
					type: "github",
					connector: { repos: [...(datasource.facts.repos ?? [])], tokenEnv: "GITHUB_TOKEN" },
				},
			};
		case "obsidian": {
			const entries: Record<string, Record<string, unknown>> = {};
			const vaults = datasource.facts.vaults ?? [];
			vaults.forEach((vaultPath, index) => {
				entries[obsidianAlias(index)] = { type: "obsidian", connector: { vaultPath } };
			});
			return entries;
		}
		case "mailcrawl": {
			// One archive per verified himalaya account: mailcrawl's data dir is a
			// single-account store, and the source path carries the account name.
			const entries: Record<string, Record<string, unknown>> = {};
			for (const account of datasource.facts.accounts ?? []) {
				entries[`mailcrawl-${account}`] = {
					type: "mailcrawl",
					instanceId: account,
					connector: { account, mailbox: "INBOX", dataDir: join(home, ".mailcrawl", account) },
				};
			}
			return entries;
		}
		case "discord":
			return { discord: { instanceId: "default", connector: {} } };
		case "telegram":
			return { telegram: { instanceId: "default", connector: {} } };
		case "whatsapp":
			return { whatsapp: { instanceId: "default", connector: {} } };
		case "slack":
			return {
				slack: {
					type: "slack",
					connector: {
						// Detection counted the local mirror's rows (`~/.slacrawl`), so the
						// first index must sync the same way: `--source wiretap` reads the
						// Slack Desktop cache and needs no token. slacrawl's default sync
						// is the API source, which exits nonzero without SLACK_BOT_TOKEN
						// and fails the whole refresh.
						syncSource: "wiretap",
					},
				},
			};
	}
}

export function buildDatasourceEntries(datasources: readonly IndexingDatasource[], home: string): Record<string, Record<string, unknown>> {
	const entries: Record<string, Record<string, unknown>> = {};
	for (const datasource of datasources) {
		for (const [alias, entry] of Object.entries(entriesFor(datasource, home))) entries[alias] = entry;
	}
	return entries;
}

export function applyIndexingConfig(input: ApplyIndexingConfigInput): Record<string, unknown> {
	const raw = structuredClone(input.raw);
	raw.searchPaths = [...input.folders];
	if (input.excludePaths !== undefined && input.excludePaths.length > 0) {
		const existing = Array.isArray(raw.excludePaths) ? raw.excludePaths.filter((value): value is string => typeof value === "string") : [];
		raw.excludePaths = [...new Set([...existing, ...input.excludePaths])];
	}
	if (input.workspacePath !== null) raw.workspacePath = input.workspacePath;
	if (input.embedder !== null) {
		const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
		const embedder = {
			id: input.embedder.id,
			dimension: input.embedder.dimension,
			...(input.embedder.baseUrl !== undefined ? { baseUrl: input.embedder.baseUrl } : {}),
			...(input.embedder.apiKeyEnv !== undefined ? { apiKeyEnv: input.embedder.apiKeyEnv } : {}),
		};
		raw.minSync = { ...minSync, embedder };
	}
	if (input.semanticSearch !== undefined) {
		const { semanticSearch: _previous, ...rest } = isJsonObject(raw.appIndexing) ? raw.appIndexing : {};
		const appIndexing = input.semanticSearch ? rest : { ...rest, semanticSearch: false };
		if (Object.keys(appIndexing).length > 0) raw.appIndexing = appIndexing;
		else delete raw.appIndexing;
	}
	if (input.model !== null) {
		raw.model = {
			provider: input.model.provider,
			id: input.model.modelId,
			...(input.model.baseUrl !== null && input.model.baseUrl.length > 0
				? { baseUrl: input.model.baseUrl, api: "openai-completions" }
				: {}),
			...(input.model.envName !== null ? { apiKeyEnv: input.model.envName } : {}),
		};
	}
	const entries = buildDatasourceEntries(input.datasources, input.home);
	if (Object.keys(entries).length > 0) {
		const current = isJsonObject(raw.datasources) ? raw.datasources : {};
		const next: Record<string, unknown> = { ...current };
		for (const [alias, entry] of Object.entries(entries)) {
			const existing = isJsonObject(next[alias]) ? next[alias] : {};
			next[alias] = { ...existing, ...entry };
		}
		raw.datasources = next;
	}
	return raw;
}
