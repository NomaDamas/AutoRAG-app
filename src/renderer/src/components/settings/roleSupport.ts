/**
 * Jev and rerank are not general LLM roles: only the providers that serve them
 * offer them, with the model ids each accepts. Settings → AI 모델 and the
 * onboarding role step build their pickers and labels from here.
 */

import type { TFunction } from "i18next";
import { jevModelsFor, rerankModelsFor } from "../../../../shared/ai-roles";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { asRecord, getAt, stringOf } from "./configSupport";

export interface RoleOption {
	readonly provider: ProviderSummary;
	readonly model: ModelCatalogEntry;
}

/** Build a catalog entry for a static Jev/rerank model so pickers reuse one shape. */
function staticCatalogEntry(provider: ProviderSummary, id: string, name: string): ModelCatalogEntry {
	return { provider: provider.id, id, name, api: "", available: true, baseUrl: provider.baseUrl, apiKeyEnv: provider.apiKeyEnv ?? null };
}

export function jevOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) => jevModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) })));
}

export function rerankOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) => rerankModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) })));
}

export function jevLabel(config: AutoRagConfigSnapshot["config"], t: TFunction): string {
	const raw = getAt(config, ["jev"]);
	if (raw === false) return t("settingsCore.ai.off");
	if (raw === undefined) return t("settingsCore.ai.auto");
	return stringOf(asRecord(raw)?.model) || t("settingsCore.ai.auto");
}

export function rerankLabel(config: AutoRagConfigSnapshot["config"], t: TFunction): string {
	const raw = getAt(config, ["rerank"]);
	if (raw === false) return t("settingsCore.ai.off");
	if (raw === undefined || raw === true) return t("settingsCore.ai.defaultValue");
	return stringOf(asRecord(raw)?.model) || t("settingsCore.ai.defaultValue");
}
