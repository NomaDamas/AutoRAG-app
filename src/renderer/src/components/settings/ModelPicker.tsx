import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import type { ModelCatalogEntry, ProviderSummary } from "../../../../shared/settings-contract";

/**
 * The searchable, provider-grouped model list inside a floating menu. Settings →
 * AI 모델 uses it for every role; the onboarding model step for the answer model.
 * `specials` are the non-model choices a role has (e.g. "same as answer", "off").
 */
export function RolePicker({
	role,
	models,
	specials,
	onPick,
	onSpecial,
}: {
	readonly role: string;
	readonly models: readonly { readonly provider: ProviderSummary; readonly model: ModelCatalogEntry }[];
	readonly specials: readonly { readonly value: string; readonly label: string }[];
	readonly onPick: (entry: ModelCatalogEntry) => void;
	readonly onSpecial: (special: string) => void;
}): ReactElement {
	const { t } = useTranslation();
	const [query, setQuery] = useState("");
	const lower = query.trim().toLowerCase();
	const match = (text: string): boolean => lower.length === 0 || text.toLowerCase().includes(lower);
	const byProvider = new Map<string, { readonly provider: ProviderSummary; readonly models: ModelCatalogEntry[] }>();
	for (const entry of models) {
		if (!match(entry.model.name) && !match(entry.model.id) && !match(entry.provider.name)) continue;
		const bucket = byProvider.get(entry.provider.id) ?? { provider: entry.provider, models: [] };
		bucket.models.push(entry.model);
		byProvider.set(entry.provider.id, bucket);
	}
	return (
		<>
			{specials.length > 0 ? (
				<div className="settings-list">
					{specials.map((special) => (
						<button key={special.value} type="button" className="settings-menu-item" onClick={() => onSpecial(special.value)}>
							<span>{special.label}</span>
						</button>
					))}
					<div className="settings-menu-sep" />
				</div>
			) : null}
			<label className="settings-menu-search">
				<Search size={14} aria-hidden="true" focusable="false" />
				<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("settingsCore.ai.searchModels")} />
			</label>
			{byProvider.size === 0 ? (
				<p className="settings-menu-empty">{role === "jev" || role === "rerank" ? t("settingsCore.ai.emptyRoleModels") : t("settingsCore.ai.emptyModels")}</p>
			) : (
				[...byProvider.values()].map((bucket) => (
					<div key={bucket.provider.id}>
						<p className="settings-menu-group">{bucket.provider.name}</p>
						{bucket.models.map((model) => (
							<button key={`${model.provider}/${model.id}`} type="button" className="settings-menu-item" data-model-id={`${model.provider}/${model.id}`} onClick={() => onPick(model)}>
								<span>{model.name || model.id}</span>
								<small>{model.id}</small>
							</button>
						))}
					</div>
				))
			)}
		</>
	);
}
