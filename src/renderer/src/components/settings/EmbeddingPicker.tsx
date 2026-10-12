/**
 * Settings → AI 모델 → 문서 이해 모델.
 *
 * Drives the global corpus embedder through the embedding bridge:
 * `embeddingGet` reads the current profile and each source's adoption,
 * `embeddingPlan` dry-runs a profile change (no writes, no reindex) so the
 * screen can show incompatibilities before committing, and `embeddingApply`
 * writes the shared config and reports the rebuilds/reindex results.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { EmbeddingChangeRequest, EmbeddingChangeResult, EmbeddingSettingsSnapshot, EmbeddingSourceStatus } from "../../../../shared/settings-contract";
import { ModalActions, ModalShell, Note, Row, StatusDot } from "./SettingsKit";

const settings = window.autorag.settings;

function adoptionTone(adoption: EmbeddingSourceStatus["adoption"]): "ok" | "warn" | "off" {
	if (adoption === "incompatible") return "warn";
	if (adoption === "not-configured" || adoption === "not-applicable") return "off";
	return "ok";
}

/** Build the apply/plan request, or an error message for a missing local server field. */
function buildRequest(profileId: string, local: { readonly id: string; readonly baseUrl: string; readonly dimension: string }, acknowledge: boolean, t: TFunction): EmbeddingChangeRequest | string {
	const base: EmbeddingChangeRequest = { profileId, ...(acknowledge ? { acknowledgeIncompatible: true } : {}) };
	if (profileId !== "local-server") return base;
	const model = local.id.trim();
	const dimension = Number(local.dimension);
	if (model.length === 0) return t("settingsCore.embedding.errorModelRequired");
	if (!Number.isInteger(dimension) || dimension <= 0) return t("settingsCore.embedding.errorDimension");
	return { ...base, localServer: { id: model, baseUrl: local.baseUrl.trim(), dimension } };
}

export function EmbeddingPicker(): ReactElement {
	const { t } = useTranslation();
	const [state, setState] = useState<EmbeddingSettingsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [profileId, setProfileId] = useState<string>("");
	const [planned, setPlanned] = useState<EmbeddingSettingsSnapshot | null>(null);
	const [result, setResult] = useState<EmbeddingChangeResult | null>(null);
	const [acknowledge, setAcknowledge] = useState(false);
	const [busy, setBusy] = useState(false);
	const [local, setLocal] = useState({ id: "", baseUrl: "http://127.0.0.1:11434", dimension: "" });

	const load = useCallback(async (): Promise<void> => {
		try {
			const next = await settings.embeddingGet();
			setState(next);
			setError(next.error);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const current = state?.current.profileId ?? null;
	const profiles = state?.profiles ?? [];
	const currentProfile = profiles.find((profile) => profile.id === current) ?? null;

	function openModal(): void {
		setOpen(true);
		setProfileId(current ?? profiles[0]?.id ?? "");
		setPlanned(null);
		setResult(null);
		setAcknowledge(false);
		setError(null);
	}

	async function preview(): Promise<void> {
		const request = buildRequest(profileId, local, acknowledge, t);
		if (typeof request === "string") {
			setError(request);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			setPlanned(await settings.embeddingPlan(request));
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	async function apply(): Promise<void> {
		const request = buildRequest(profileId, local, acknowledge, t);
		if (typeof request === "string") {
			setError(request);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const change = await settings.embeddingApply(request);
			setResult(change);
			setError(change.error);
			await load();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const previewSources = planned?.sources ?? [];
	const incompatible = previewSources.filter((source) => source.adoption === "incompatible");

	return (
		<>
			<Row name={t("settingsCore.embedding.title")} hint={t("settingsCore.embedding.hint")}>
				<button type="button" className="settings-trigger" onClick={openModal} aria-haspopup="dialog">
					<span className={`settings-trigger-label${currentProfile === null ? " is-muted" : ""}`}>{currentProfile?.label ?? t("settingsCore.common.notSet")}</span>
					<ChevronDown size={14} aria-hidden="true" focusable="false" />
				</button>
			</Row>
			{open ? (
				<ModalShell onClose={() => setOpen(false)}>
					<h2>{t("settingsCore.embedding.title")}</h2>
					<p>{t("settingsCore.embedding.body")}</p>
					<div className="settings-list">
						{profiles.map((profile) => (
							<label key={profile.id} className="settings-list-row" style={{ cursor: "pointer" }}>
								<input type="radio" name="embedding-profile" checked={profileId === profile.id} onChange={() => { setProfileId(profile.id); setPlanned(null); setResult(null); }} style={{ width: "auto", margin: 0 }} />
								<span className="settings-list-body">
									<span className="settings-list-title">{profile.label}</span>
									<span className="settings-list-meta">{profile.description}{profile.dimension > 0 ? ` · ${t("settingsCore.embedding.dimension", { count: profile.dimension })}` : ""}</span>
								</span>
							</label>
						))}
					</div>
					{profileId === "local-server" ? (
						<>
							<label>{t("settingsCore.embedding.modelName")}<input value={local.id} placeholder={t("settingsCore.embedding.modelPlaceholder")} onChange={(event) => setLocal((prev) => ({ ...prev, id: event.target.value }))} /></label>
							<label>{t("settingsCore.embedding.baseUrl")}<input value={local.baseUrl} onChange={(event) => setLocal((prev) => ({ ...prev, baseUrl: event.target.value }))} /></label>
							<label>{t("settingsCore.embedding.dimensionLabel")}<input inputMode="numeric" value={local.dimension} placeholder={t("settingsCore.embedding.dimensionPlaceholder")} onChange={(event) => setLocal((prev) => ({ ...prev, dimension: event.target.value }))} /></label>
						</>
					) : null}
					{previewSources.length > 0 ? (
						<div className="settings-list" style={{ marginTop: 12 }}>
							{previewSources.map((source) => (
								<div className="settings-list-row" key={source.id}>
									<span className="settings-list-body">
										<span className="settings-list-title">{source.id}</span>
										<span className="settings-list-meta">{source.reason}{source.action !== null ? ` · ${source.action}` : ""}</span>
									</span>
									<span className="settings-status">
										<StatusDot tone={adoptionTone(source.adoption)} />
										{source.adoption}
									</span>
								</div>
							))}
						</div>
					) : null}
					{incompatible.length > 0 ? (
						<>
							<Note>{t("settingsCore.embedding.incompatibleNote", { count: incompatible.length })}</Note>
							<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
								<input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} style={{ width: "auto", margin: 0 }} />
								{t("settingsCore.embedding.acknowledge")}
							</label>
						</>
					) : null}
					{result !== null ? (
						<div className="settings-note" style={{ marginTop: 12 }}>
							<span>
								{result.applied ? t("settingsCore.embedding.applied") : t("settingsCore.embedding.notApplied")} {t("settingsCore.embedding.written", { count: result.written.length })}
								{result.rebuilds.length > 0 ? ` · ${t("settingsCore.embedding.rebuild", { count: result.rebuilds.length })}` : ""}
							</span>
						</div>
					) : null}
					{error !== null ? <p className="settings-modal-error">{error}</p> : null}
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setOpen(false)} disabled={busy}>{t("common.close")}</button>
						<button type="button" className="linear-btn" onClick={() => void preview()} disabled={busy || profileId.length === 0}>{t("settingsCore.embedding.preview")}</button>
						<button type="button" className="linear-btn settings-btn-primary" onClick={() => void apply()} disabled={busy || profileId.length === 0 || result?.applied === true}>{t("settingsCore.embedding.apply")}</button>
					</ModalActions>
				</ModalShell>
			) : null}
		</>
	);
}
