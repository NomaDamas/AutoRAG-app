/**
 * Settings → AI 모델 → 문서 이해 모델.
 *
 * Drives the global corpus embedder through the embedding bridge:
 * `embeddingGet` reads the current profile and each source's adoption,
 * `embeddingPlan` dry-runs a profile change (no writes, no reindex) so the
 * screen can show how each source follows it before committing, and `embeddingApply`
 * writes the shared config and reports the rebuilds/reindex results.
 */

import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { EmbeddingChangeRequest, EmbeddingChangeResult, EmbeddingSettingsSnapshot, EmbeddingSourceStatus } from "../../../../shared/settings-contract";
import { localModelNeeded, useModelDownload } from "../../state/model-download";
import { ModelDownloadPanel } from "../ModelDownloadPanel";
import { ModalActions, ModalShell, Note, Row, StatusDot } from "./SettingsKit";
import type { Translate } from "../../onboarding/flow";

const settings = window.autorag.settings;

function adoptionTone(adoption: EmbeddingSourceStatus["adoption"]): "ok" | "off" {
	return adoption === "not-configured" || adoption === "not-applicable" ? "off" : "ok";
}

interface ByokFields {
	readonly baseUrl: string;
	readonly protocol: "openai" | "tei";
	readonly apiKey: string;
}

/** Profiles whose document text leaves this computer unless the server the user typed is on it. */
function sendsOffComputer(profileId: string, byok: ByokFields): boolean {
	if (profileId === "dazzi") return true;
	if (profileId !== "byok") return false;
	try {
		return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(byok.baseUrl.trim()).hostname.toLowerCase());
	} catch {
		return true;
	}
}

/** Build the apply/plan request. The model is fixed, so the user's own server is only an address, a type and a key. */
function buildRequest(profileId: string, byok: ByokFields, acknowledgeRemote: boolean): EmbeddingChangeRequest {
	return {
		profileId,
		...(acknowledgeRemote ? { acknowledgeRemote: true } : {}),
		...(profileId === "byok" ? { byok: { baseUrl: byok.baseUrl.trim(), protocol: byok.protocol, ...(byok.apiKey.length > 0 ? { apiKey: byok.apiKey } : {}) } } : {}),
	};
}

export function EmbeddingPicker(): ReactElement {
	const { t } = useTranslation();
	const [state, setState] = useState<EmbeddingSettingsSnapshot | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const [profileId, setProfileId] = useState<string>("");
	const [planned, setPlanned] = useState<EmbeddingSettingsSnapshot | null>(null);
	const [result, setResult] = useState<EmbeddingChangeResult | null>(null);
	const [consent, setConsent] = useState(false);
	const [busy, setBusy] = useState(false);
	const [byok, setByok] = useState<ByokFields>({ baseUrl: "", protocol: "openai", apiKey: "" });
	const modelDownload = useModelDownload();

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
	const rawEmbedderId = typeof state?.current.embedder.id === "string" && state.current.embedder.id.length > 0 ? state.current.embedder.id : null;
	const currentLabel = currentProfile?.label ?? rawEmbedderId;

	function openModal(): void {
		setOpen(true);
		setProfileId(current ?? profiles[0]?.id ?? "");
		setPlanned(null);
		setResult(null);
		setConsent(false);
		setError(null);
		const stored = state?.current.embedder;
		// Opening on the user's own server shows its address, never a key.
		if (current === "byok" && stored !== undefined && typeof stored.baseUrl === "string") {
			setByok({ baseUrl: stored.baseUrl, protocol: typeof stored.id === "string" && stored.id.startsWith("tei:") ? "tei" : "openai", apiKey: "" });
		}
	}

	async function preview(): Promise<void> {
		const request = buildRequest(profileId, byok, consent);
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
		const request = buildRequest(profileId, byok, consent);
		setBusy(true);
		setError(null);
		try {
			const change = await settings.embeddingApply(request);
			setResult(change);
			// The key lives in the keyring now; do not keep it in the form.
			if (change.applied) setByok((prev) => ({ ...prev, apiKey: "" }));
			await load();
			// After the reload: it reports the stored config's own error and would otherwise erase why this change was refused.
			setError(change.error);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}

	const previewSources = planned?.sources ?? [];
	const needsConsent = sendsOffComputer(profileId, byok);
	const needsModel = localModelNeeded(profileId, modelDownload.status);
	const applyBlocked = busy || profileId.length === 0 || result?.applied === true || (needsConsent && !consent) || (profileId === "byok" && byok.baseUrl.trim().length === 0) || needsModel;

	return (
		<>
			<Row name={t("settingsCore.embedding.title")} hint={t("settingsCore.embedding.hint")}>
				<button type="button" className="settings-trigger" onClick={openModal} aria-haspopup="dialog">
					<span className={`settings-trigger-label${currentLabel === null ? " is-muted" : ""}`}>{currentLabel ?? t("settingsCore.common.notSet")}</span>
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
								<input
									type="radio"
									name="embedding-profile"
									checked={profileId === profile.id}
									aria-disabled={profile.unavailable !== null}
									onChange={() => {
										if (profile.unavailable !== null) {
											// Explain instead of selecting: the machine is below the minimum spec for this model.
											setError(profile.unavailable);
											return;
										}
										setProfileId(profile.id);
										setPlanned(null);
										setResult(null);
										setError(null);
										setConsent(false);
									}}
									style={{ width: "auto", margin: 0 }}
								/>
								<span className="settings-list-body" style={profile.unavailable === null ? undefined : { opacity: 0.6 }}>
									<span className="settings-list-title">{profile.label}</span>
									<span className="settings-list-meta">{profile.description}{profile.dimension > 0 ? ` · ${t("settingsCore.embedding.dimension", { count: profile.dimension })}` : ""}</span>
									{profile.unavailable === null ? null : <span className="settings-list-meta" data-role="embedding-unavailable" style={{ color: "var(--error, #d33)", whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}>{profile.unavailable}</span>}
								</span>
							</label>
						))}
					</div>
					{profileId !== "none" && profileId.length > 0 ? <Note>{t("settingsCore.embedding.dimensionFixed")}</Note> : null}
					{profileId === "local" ? (
						<ModelDownloadPanel status={modelDownload.status} t={t as unknown as Translate} onStart={modelDownload.start} onCancel={modelDownload.cancel} />
					) : null}
					{profileId === "dazzi" ? <Note>{t("settingsCore.embedding.signInNote")}</Note> : null}
					{profileId === "byok" ? (
						<>
							<label>{t("settingsCore.embedding.serverUrl")}<input name="embedding-server-url" value={byok.baseUrl} placeholder={t("settingsCore.embedding.serverUrlPlaceholder")} onChange={(event) => { setByok((prev) => ({ ...prev, baseUrl: event.target.value })); setPlanned(null); }} /></label>
							<label>{t("settingsCore.embedding.serverType")}
								<select name="embedding-server-type" value={byok.protocol} onChange={(event) => { setByok((prev) => ({ ...prev, protocol: event.target.value === "tei" ? "tei" : "openai" })); setPlanned(null); }}>
									<option value="openai">{t("settingsCore.embedding.typeOpenai")}</option>
									<option value="tei">{t("settingsCore.embedding.typeTei")}</option>
								</select>
							</label>
							<label>{t("settingsCore.embedding.apiKey")}<input name="embedding-api-key" type="password" autoComplete="off" value={byok.apiKey} placeholder={t("settingsCore.embedding.apiKeyPlaceholder")} onChange={(event) => setByok((prev) => ({ ...prev, apiKey: event.target.value }))} /></label>
							<Note>{t("settingsCore.embedding.apiKeyHint")}</Note>
						</>
					) : null}
					{needsConsent ? (
						<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
							<input type="checkbox" name="embedding-consent-remote" checked={consent} onChange={(event) => setConsent(event.target.checked)} style={{ width: "auto", margin: 0 }} />
							{t("settingsCore.embedding.consentRemote")}
						</label>
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
						<button type="button" className="linear-btn settings-btn-primary" onClick={() => void apply()} disabled={applyBlocked}>{t("settingsCore.embedding.apply")}</button>
					</ModalActions>
				</ModalShell>
			) : null}
		</>
	);
}
