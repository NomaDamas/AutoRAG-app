/**
 * Pure rules of the onboarding model step: what the shared AutoRAG config and
 * the connected providers say the BYOK model is. The config is the authority —
 * the draft only remembers it — so a choice never outlives its provider's
 * credential or the config entry it points at.
 */

import { AUTORAG_PROVIDER_ID } from "../../../shared/account-contract";
import type { OnboardingModelChoice } from "../../../shared/onboarding-contract";
import type { AutoRagConfigSnapshot, ModelCatalogEntry, ProviderSummary } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";

/** The answer model in `config` as a choice that has not answered a call yet, or null when none is set or its provider is not connected. */
export function reconcileModelChoice(config: AutoRagConfigSnapshot["config"], providers: readonly ProviderSummary[]): OnboardingModelChoice | null {
	const model = config.model;
	if (!isJsonObject(model)) return null;
	const provider = model.provider;
	const id = model.id;
	if (typeof provider !== "string" || typeof id !== "string" || provider.length === 0 || id.length === 0) return null;
	// The Dazzi plan has its own step; it is never a bring-your-own-key model.
	if (provider === AUTORAG_PROVIDER_ID) return null;
	if (!providers.some((candidate) => candidate.id === provider && candidate.authConfigured)) return null;
	return { provider, modelId: id, verified: false };
}

/** The one model on offer, so the step can choose it without asking; null when there is none or a choice to make. */
export function onlyModel(models: readonly { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }[]): ModelCatalogEntry | null {
	return models.length === 1 ? (models[0]?.model ?? null) : null;
}
