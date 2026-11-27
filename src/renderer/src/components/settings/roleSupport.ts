/**
 * Jev and rerank are not general LLM roles: only the providers that serve them
 * offer them, with the model ids each accepts. Settings → AI 모델 and the
 * onboarding role step build their pickers and labels from here.
 */

import type { TFunction } from "i18next";
import { JEV_SLLM_BACKEND, jevBackendFor, jevModelsFor, ocrModelsFor, rerankModelsFor } from "../../../../shared/ai-roles";
import type { AutoRagConfigSnapshot, AutoRagConfigUpdate, ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";
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

/**
 * The writes that free every role pointing at `providerId` before it is
 * disconnected: answer and decomposition fall back to their defaults by
 * removing the field; rerank switches off; Jev, which is required, is removed too so
 * the shared default returns instead of the unsupported `jev: false`. Settings and the onboarding
 * model step disconnect through this, so both leave the same config behind.
 */
export function providerRoleCleanup(config: AutoRagConfigSnapshot["config"], providerId: string): AutoRagConfigUpdate[] {
	const model = asRecord(getAt(config, ["model"]));
	const decomposition = asRecord(getAt(config, ["queryDecomposition", "model"]));
	const rerank = asRecord(getAt(config, ["rerank"]));
	const jev = asRecord(getAt(config, ["jev"]));
	const visualParse = asRecord(getAt(config, ["visualParse"]));
	const visualExtractor = asRecord(visualParse?.extractor);
	const visualModel = asRecord(visualExtractor?.model);
	const visualOcr = asRecord(visualParse?.ocr);
	const visualOcrModel = asRecord(visualOcr?.model);
	const ops: AutoRagConfigUpdate[] = [];
	if (stringOf(model?.provider) === providerId) ops.push({ path: ["model"], remove: true });
	if (stringOf(decomposition?.provider) === providerId) ops.push({ path: ["queryDecomposition"], remove: true });
	if (stringOf(rerank?.provider) === providerId) ops.push({ path: ["rerank"], value: false });
	if (stringOf(jev?.backend) === jevBackendFor(providerId)) ops.push({ path: ["jev"], remove: true });
	const vlmUses = stringOf(visualModel?.provider) === providerId;
	const ocrUses = stringOf(visualOcrModel?.provider) === providerId;
	if (vlmUses || ocrUses) {
		const nextVisual: Record<string, unknown> = visualParse ? { ...visualParse } : {};
		if (vlmUses) delete nextVisual.extractor;
		if (ocrUses) nextVisual.ocr = { engine: "auto" };
		const hasVlm = asRecord(nextVisual.extractor as never)?.kind === "vlm";
		const hasOcr = nextVisual.ocr !== false && nextVisual.ocr !== undefined;
		ops.push({ path: ["visualParse"], value: hasVlm || hasOcr ? (nextVisual as never) : false });
	}
	return ops;
}

export function jevOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) => jevModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) })));
}

export function rerankOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) => rerankModelsFor(provider.id).map((model) => ({ provider, model: staticCatalogEntry(provider, model.id, model.label) })));
}

export function visualParseOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) =>
		provider.models
			.filter((model) => model.supportsImage !== false)
			.map((model) => ({ provider, model })),
	);
}

/**
 * Official remote OCR / document-parsing models served by connected providers
 * (Mistral OCR, NVIDIA Nemotron Parse, Upstage Document Parse, Z.AI GLM-OCR).
 * General chat LLMs are excluded; local OCR engines are always offered via specials.
 */
export function visualParseOcrOptionsFor(connected: readonly ProviderSummary[]): RoleOption[] {
	return connected.flatMap((provider) =>
		ocrModelsFor(provider.id).map((model) => ({
			provider,
			model: staticCatalogEntry(provider, model.id, model.label),
		})),
	);
}

export function isVisualParseEnabled(config: AutoRagConfigSnapshot["config"]): boolean {
	const raw = getAt(config, ["visualParse"]);
	const record = asRecord(raw);
	if (raw === undefined || raw === false || record === null) return false;
	if (record.enabled === false) return false;
	const hasVlm = stringOf(asRecord(record.extractor)?.kind) === "vlm";
	const hasOcr = record.ocr !== false;
	return hasVlm || hasOcr;
}

export function visualParseLabel(config: AutoRagConfigSnapshot["config"], t: TFunction): string {
	if (!isVisualParseEnabled(config)) return t("settingsCore.ai.off");
	const record = asRecord(getAt(config, ["visualParse"]));
	const extractor = asRecord(record?.extractor);
	if (stringOf(extractor?.kind) !== "vlm") return t("settingsCore.ai.off");
	const model = asRecord(extractor?.model);
	return stringOf(model?.name) || stringOf(model?.id) || t("settingsCore.ai.off");
}

export function visualParseOcrLabel(config: AutoRagConfigSnapshot["config"], t: TFunction): string {
	if (!isVisualParseEnabled(config)) return t("settingsCore.ai.off");
	const record = asRecord(getAt(config, ["visualParse"]));
	if (record === null || record.ocr === false) return t("settingsCore.ai.off");
	const ocr = asRecord(record.ocr);
	if (ocr !== null) {
		const engine = stringOf(ocr.engine);
		if (engine === "api" || engine === "vlm" || ocr.model !== undefined) {
			const model = asRecord(ocr.model);
			return stringOf(model?.name) || stringOf(model?.id) || t("settingsCore.ai.visualParseOcrAuto");
		}
		if (engine === "kordoc") return t("settingsCore.ai.visualParseOcrKordoc");
		if (engine === "tesseract") return t("settingsCore.ai.visualParseOcrTesseract");
		return t("settingsCore.ai.visualParseOcrAuto");
	}
	const legacyEngine = stringOf(asRecord(record.extractor)?.engine);
	if (legacyEngine === "kordoc") return t("settingsCore.ai.visualParseOcrKordoc");
	if (legacyEngine === "tesseract") return t("settingsCore.ai.visualParseOcrTesseract");
	return t("settingsCore.ai.visualParseOcrAuto");
}

export function jevLabel(config: AutoRagConfigSnapshot["config"], t: TFunction): string {
	const raw = getAt(config, ["jev"]);
	if (raw === undefined || raw === false) return t("settingsCore.ai.auto");
	const record = asRecord(raw);
	if (stringOf(record?.backend) === JEV_SLLM_BACKEND) return t("settingsCore.ai.jevSllm");
	return stringOf(record?.model) || t("settingsCore.ai.auto");
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
		if (raw === false) return null;
		const record = asRecord(raw);
		const backend = stringOf(record?.backend);
		if (backend === JEV_SLLM_BACKEND) return { kind: "special", value: JEV_SLLM_BACKEND };
		const modelId = stringOf(record?.model);
		if (backend.length === 0 || modelId.length === 0) return null;
		const matched = connected.find((provider) => jevBackendFor(provider.id) === backend);
		return matched === undefined ? null : { kind: "model", provider: matched.id, modelId };
	}
	if (role === "visualParse") {
		if (!isVisualParseEnabled(config)) return { kind: "special", value: "off" };
		const record = asRecord(getAt(config, ["visualParse"]));
		const extractor = asRecord(record?.extractor);
		if (stringOf(extractor?.kind) !== "vlm") return { kind: "special", value: "off" };
		const model = asRecord(extractor?.model);
		const provider = stringOf(model?.provider);
		const modelId = stringOf(model?.id);
		return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : { kind: "special", value: "off" };
	}
	if (role === "visualParseOcr") {
		if (!isVisualParseEnabled(config)) return { kind: "special", value: "off" };
		const record = asRecord(getAt(config, ["visualParse"]));
		if (record === null || record.ocr === false) return { kind: "special", value: "off" };
		const ocr = asRecord(record.ocr);
		if (ocr !== null) {
			const engine = stringOf(ocr.engine);
			if (engine === "api" || engine === "vlm" || ocr.model !== undefined) {
				const model = asRecord(ocr.model);
				const provider = stringOf(model?.provider);
				const modelId = stringOf(model?.id);
				return provider.length > 0 && modelId.length > 0 ? { kind: "model", provider, modelId } : { kind: "special", value: "auto" };
			}
			if (engine === "kordoc" || engine === "tesseract" || engine === "auto") {
				return { kind: "special", value: engine };
			}
			return { kind: "special", value: "auto" };
		}
		const legacyEngine = stringOf(asRecord(record.extractor)?.engine);
		if (legacyEngine === "kordoc" || legacyEngine === "tesseract" || legacyEngine === "auto") {
			return { kind: "special", value: legacyEngine };
		}
		return { kind: "special", value: "auto" };
	}
	return null;
}
