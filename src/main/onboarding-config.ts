import { join } from "node:path";
import type { ByokProviderId, SourceFacts, SourceId } from "../shared/onboarding-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Writes the onboarding choices into the shared AutoRAG config the CLI, TUI,
 * serve, and this app all resolve. Pure over its inputs (a raw config object
 * in, the next one out) so the merge rules — search paths replace, embedder only
 * when absent, datasource aliases merge, allowedTags union, BYOK model — are
 * unit-testable without touching disk.
 */

export interface EmbedderChoice {
	readonly profile: string;
	readonly dimension: number;
}

export interface ByokModelChoice {
	readonly provider: ByokProviderId;
	readonly modelId: string;
	readonly baseUrl: string | null;
	readonly envName: string | null;
}

/** Tags the agent needs in `datasourceAccess.allowedTags`, else it denies the source. */
const SOURCE_TAGS: Readonly<Record<SourceId, readonly string[]>> = {
	kakao: ["kakaotalk"],
	slack: ["slack"],
	discord: ["discord"],
	telegram: ["telegram"],
	whatsapp: ["whatsapp"],
	mailcrawl: ["mailcrawl"],
	github: ["github"],
	obsidian: ["obsidian"],
};

export interface IndexingDatasource {
	readonly id: SourceId;
	readonly description: string;
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
	readonly model: ByokModelChoice | null;
}

interface DatasourceEntries {
	readonly entries: Record<string, Record<string, unknown>>;
	readonly tags: readonly string[];
}

function obsidianAlias(index: number): string {
	return index === 0 ? "obsidian" : `obsidian-${index + 1}`;
}

function entriesFor(datasource: IndexingDatasource, home: string): Record<string, Record<string, unknown>> {
	const description = datasource.description;
	switch (datasource.id) {
		case "kakao":
			return { kakao: { instanceId: "default", description, connector: {} } };
		case "github":
			return {
				github: {
					type: "github",
					description,
					connector: { repos: [...(datasource.facts.repos ?? [])], tokenEnv: "GITHUB_TOKEN" },
				},
			};
		case "obsidian": {
			const entries: Record<string, Record<string, unknown>> = {};
			const vaults = datasource.facts.vaults ?? [];
			vaults.forEach((vaultPath, index) => {
				entries[obsidianAlias(index)] = { type: "obsidian", description, connector: { vaultPath } };
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
					description,
					connector: { account, mailbox: "INBOX", dataDir: join(home, ".mailcrawl", account) },
				};
			}
			return entries;
		}
		case "discord":
			return { discord: { instanceId: "default", description, connector: {} } };
		case "telegram":
			return { telegram: { instanceId: "default", description, connector: {} } };
		case "whatsapp":
			return { whatsapp: { instanceId: "default", description, connector: {} } };
		case "slack":
			return {
				slack: {
					type: "slack",
					description,
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

function buildDatasourceEntries(datasources: readonly IndexingDatasource[], home: string): DatasourceEntries {
	const entries: Record<string, Record<string, unknown>> = {};
	const tags = new Set<string>();
	for (const datasource of datasources) {
		for (const [alias, entry] of Object.entries(entriesFor(datasource, home))) entries[alias] = entry;
		for (const tag of SOURCE_TAGS[datasource.id]) tags.add(tag);
	}
	return { entries, tags: [...tags] };
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function applyIndexingConfig(input: ApplyIndexingConfigInput): Record<string, unknown> {
	const raw = structuredClone(input.raw);
	raw.searchPaths = [...input.folders];
	if (input.workspacePath !== null) raw.workspacePath = input.workspacePath;
	if (input.embedder !== null) {
		const minSync = isJsonObject(raw.minSync) ? raw.minSync : {};
		raw.minSync = { ...minSync, embedder: { profile: input.embedder.profile, dimension: input.embedder.dimension } };
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
	const { entries, tags } = buildDatasourceEntries(input.datasources, input.home);
	if (Object.keys(entries).length > 0) {
		const current = isJsonObject(raw.datasources) ? raw.datasources : {};
		const next: Record<string, unknown> = { ...current };
		for (const [alias, entry] of Object.entries(entries)) {
			const existing = isJsonObject(next[alias]) ? next[alias] : {};
			next[alias] = { ...existing, ...entry };
		}
		raw.datasources = next;
	}
	const access = isJsonObject(raw.datasourceAccess) ? raw.datasourceAccess : {};
	const allowedTags = [...new Set([...stringList(access.allowedTags), ...tags])];
	if (allowedTags.length > 0) raw.datasourceAccess = { ...access, allowedTags };
	return raw;
}
