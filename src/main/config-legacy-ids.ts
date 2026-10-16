import { readRawConfigObject, writeConfigObject } from "@autorag/librarian/core";
import { AUTORAG_PROVIDER_ID, isManagedProviderId, LEGACY_AUTORAG_PROVIDER_ID } from "../shared/account-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Rewrite the hosted plan's pre-2.10.2 values in a shared AutoRAG config.
 *
 * Until librarian 2.10.2 the plan was the `autorag` provider and the `jev`
 * backend was named after it; the release renamed both to `dazzi` and made the
 * provider OAuth-only. The librarian now rejects `jev.backend: "autorag"` and
 * every `apiKeyEnv` on a dazzi block at config resolution, so an un-migrated
 * config fails every `resolveConfigReadOnly` call, and Pi cannot resolve the
 * retired provider id for `model`, `queryDecomposition.model`, or `rerank`.
 * Configs this app wrote against an older librarian carry the legacy spelling
 * (and the account key's env name) in exactly those blocks; each is rewritten
 * in place and every other key is preserved verbatim. Returns whether anything
 * changed.
 */
export function migrateLegacyProviderIds(configPath: string): boolean {
	const raw = readRawConfigObject(configPath);
	let changed = false;
	/** `true` once the block names the plan, so its forbidden fields can go too. */
	const rewrite = (block: unknown, field: string): boolean => {
		if (!isJsonObject(block)) return false;
		const managed = field === "backend" ? isManagedBackend(block[field]) : isManagedProviderId(block[field]);
		if (managed && block[field] !== AUTORAG_PROVIDER_ID) {
			block[field] = AUTORAG_PROVIDER_ID;
			changed = true;
		}
		return managed;
	};
	/** The credential moved to Pi's `auth.json`; an env-name leaf is now invalid. */
	const dropApiKeyEnv = (block: unknown, managed: boolean): void => {
		if (managed && isJsonObject(block) && "apiKeyEnv" in block) {
			delete block.apiKeyEnv;
			changed = true;
		}
	};
	dropApiKeyEnv(raw.model, rewrite(raw.model, "provider"));
	const decomposition = raw.queryDecomposition;
	if (decomposition !== false && isJsonObject(decomposition)) {
		const model = isJsonObject(decomposition.model) ? decomposition.model : undefined;
		if (model !== undefined) dropApiKeyEnv(model, rewrite(model, "provider"));
	}
	dropApiKeyEnv(raw.rerank, rewrite(raw.rerank, "provider"));
	rewrite(raw.jev, "backend");
	if (changed) writeConfigObject(configPath, raw);
	return changed;
}

/** The `jev.backend` value the plan used before the rename. */
function isManagedBackend(value: unknown): boolean {
	return value === AUTORAG_PROVIDER_ID || value === LEGACY_AUTORAG_PROVIDER_ID;
}
