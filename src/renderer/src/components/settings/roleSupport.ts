/**
 * Jev and rerank are not general LLM roles: only the providers that serve them
 * offer them, with the model ids each accepts. Settings → AI 모델 and the
 * onboarding role step build their pickers and labels from here.
 */

import type { TFunction } from "i18next";
import { jevBackendFor, jevModelsFor, rerankModelsFor } from "../../../../shared/ai-roles";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
import { asRecord, getAt, stringOf } from "./configSupport";
import type { RolePickerSelection } from "./ModelPicker";

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

export function roleSelectionFor(
	role: string,
	config: AutoRagConfigSnapshot["config"],
	connected: readonly ProviderSummary[],
): RolePickerSelection {
	if (role === "answer") {
		const model = asRecord(getAt(config, ["model"]));
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	if (role === "decomposition") {
		const raw = getAt(config, ["queryDecomposition"]);
		if (raw === false) return { kind: "special", value: "same" };
		if (raw === undefined) return { kind: "special", value: "default" };
		const model = asRecord(asRecord(raw)?.model);
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	if (role === "rerank") {
		const raw = getAt(config, ["rerank"]);
		if (raw === false) return { kind: "special", value: "off" };
		const record = asRecord(raw);
		const provider = stringOf(record?.provider);
		const modelId = stringOf(record?.model);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : null;
	}
	if (role === "jev") {
		const raw = getAt(config, ["jev"]);
		if (raw === false) return { kind: "special", value: "off" };
		const record = asRecord(raw);
		const backend = stringOf(record?.backend);
		const modelId = stringOf(record?.model);
		if (backend.length === 0 || modelId.length === 0) return null;
		const matched = connected.find((provider) => jevBackendFor(provider.id) === backend);
		return matched === undefined ? null : { kind: "model", provider: matched.id, modelId };
	}
	return null;
}
