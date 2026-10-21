import { isJsonObject } from "../shared/settings-contract";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "./embedding-daemon";

/**
 * Config written by an earlier Dazzi still names things that no longer exist: the `profile` field of the
 * retired llama-server runtime, a GGUF model id with the loopback gateway address that served it, and the
 * embedding overrides the app put into mailcrawl's environment (its own native Qwen3, or the app's
 * ephemeral loopback adapter). The librarian drops the `profile` field and `.gguf` ids silently, which can
 * leave a bare `baseUrl` that reads as a server nobody runs. This rewrites them to what they meant: the
 * local Qwen3 model, served by MinSync.
 */

const LOCAL_ID = `native:${DEFAULT_LOCAL_EMBEDDING_MODEL}`;
const GGUF_ID = /\.gguf$/iu;
const OWNED_MAILCRAWL_KEY = /^MAILCRAWL_(EMBED|NATIVE_)/u;

export interface MigrationResult {
	readonly raw: Record<string, unknown>;
	readonly changed: boolean;
}

function migrateEmbedder(minSync: Record<string, unknown>): Record<string, unknown> | undefined {
	const embedder = minSync.embedder;
	if (!isJsonObject(embedder)) return undefined;
	const { profile, ...rest } = embedder;
	const retiredId = typeof rest.id === "string" && GGUF_ID.test(rest.id);
	if (profile === undefined && !retiredId) return undefined;
	const { id: _id, baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, ...kept } = rest;
	// A `profile` next to a user's own server keeps that server; only the runtime's own entries are dropped.
	const ownServer = !retiredId && typeof rest.id === "string" && !GGUF_ID.test(rest.id);
	return { ...minSync, embedder: ownServer ? rest : { id: LOCAL_ID, ...kept } };
}

function migrateDatasource(entry: unknown): unknown {
	if (!isJsonObject(entry) || !isJsonObject(entry.connector) || !isJsonObject(entry.connector.env)) return entry;
	const env = entry.connector.env;
	const kept = Object.fromEntries(Object.entries(env).filter(([key]) => !OWNED_MAILCRAWL_KEY.test(key)));
	if (Object.keys(kept).length === Object.keys(env).length) return entry;
	const { env: _env, ...connector } = entry.connector;
	return { ...entry, connector: Object.keys(kept).length > 0 ? { ...connector, env: kept } : connector };
}

export function migrateLegacyEmbedding(raw: Record<string, unknown>): MigrationResult {
	let next = raw;
	if (isJsonObject(raw.minSync)) {
		const minSync = migrateEmbedder(raw.minSync);
		if (minSync !== undefined) next = { ...next, minSync };
	}
	if (isJsonObject(raw.datasources)) {
		let changed = false;
		const datasources = Object.fromEntries(
			Object.entries(raw.datasources).map(([id, entry]) => {
				const migrated = migrateDatasource(entry);
				if (migrated !== entry) changed = true;
				return [id, migrated];
			}),
		);
		if (changed) next = { ...next, datasources };
	}
	return { raw: next, changed: next !== raw };
}
