import { JEV_SLLM_BACKEND } from "../shared/ai-roles";
import { isJsonObject } from "../shared/settings-contract";
import type { MigrationResult } from "./embedding-migration";

/**
 * The librarian made the decision model required: `jev: false` and `jev.enabled` are refused outright, and
 * `jev.backend: "vercel"` is now the pi provider id `vercel-ai-gateway`. A config an earlier Dazzi wrote still
 * carries them, and the librarian then rejects every later edit of that file (`config:patch` fails with
 * "Config field 'jev' cannot be false"). This rewrites them to what they meant:
 *
 * - switched off (`false` or `enabled: false`) becomes the small chat model deciding in Jev's place, the one
 *   decision model that needs no Jev service; Jev's own model and fallback do not apply to it and are dropped;
 * - `enabled: true` is just removed;
 * - an OpenRouter `typesafe/jev-latest` becomes the catalog's `~typesafe/jev-latest`;
 * - the Vercel backend is renamed, and the model id it served (`typesafe/jev-latest`, an OpenRouter-style id the
 *   gateway does not list) is dropped so the gateway's default decision model is asked.
 */

const VERCEL_LEGACY_BACKEND = "vercel";
const VERCEL_BACKEND = "vercel-ai-gateway";
/** What the app wrote for the Vercel backend before the rename; not an id the gateway serves. */
const VERCEL_LEGACY_MODEL = "typesafe/jev-latest";
/** OpenRouter's catalog lists the rolling alias as `~typesafe/jev-latest`; the bare id the app used to write is not in it. */
const OPENROUTER_LEGACY_LATEST = "typesafe/jev-latest";
const OPENROUTER_LATEST = "~typesafe/jev-latest";

function migrateJevBlock(jev: unknown): unknown {
	if (jev === false) return { backend: JEV_SLLM_BACKEND };
	if (!isJsonObject(jev)) return jev;
	const { enabled, ...rest } = jev;
	if (enabled === false) {
		const { backend: _backend, model: _model, fallback: _fallback, ...kept } = rest;
		return { ...kept, backend: JEV_SLLM_BACKEND };
	}
	if (rest.backend === VERCEL_LEGACY_BACKEND) {
		const { model, ...kept } = rest;
		return { ...kept, backend: VERCEL_BACKEND, ...(model === undefined || model === VERCEL_LEGACY_MODEL ? {} : { model }) };
	}
	if (rest.backend === "openrouter" && rest.model === OPENROUTER_LEGACY_LATEST) return { ...rest, model: OPENROUTER_LATEST };
	return enabled === undefined ? jev : rest;
}

export function migrateLegacyJev(raw: Record<string, unknown>): MigrationResult {
	if (!("jev" in raw)) return { raw, changed: false };
	const jev = migrateJevBlock(raw.jev);
	return jev === raw.jev ? { raw, changed: false } : { raw: { ...raw, jev }, changed: true };
}
