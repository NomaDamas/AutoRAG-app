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
function buildRequest(profileId: string, local: { readonly id: string; readonly baseUrl: string; readonly dimension: string }, acknowledge: boolean): EmbeddingChangeRequest | string {
	const base: EmbeddingChangeRequest = { profileId, ...(acknowledge ? { acknowledgeIncompatible: true } : {}) };
	if (profileId !== "local-server") return base;
	const model = local.id.trim();
	const dimension = Number(local.dimension);
	if (model.length === 0) return "임베딩 서버 모델 이름을 입력하세요.";
	if (!Number.isInteger(dimension) || dimension <= 0) return "임베딩 서버 차원은 양의 정수여야 합니다.";
	return { ...base, localServer: { id: model, baseUrl: local.baseUrl.trim(), dimension } };
}

export function EmbeddingPicker(): ReactElement {
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
		const request = buildRequest(profileId, local, acknowledge);
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
		const request = buildRequest(profileId, local, acknowledge);
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
			<Row name="문서 이해 모델" hint="문서의 의미를 분석합니다. 문서 내용은 이 Mac 밖으로 나가지 않습니다.">
				<button type="button" className="settings-trigger" onClick={openModal} aria-haspopup="dialog">
					<span className={`settings-trigger-label${currentProfile === null ? " is-muted" : ""}`}>{currentProfile?.label ?? "설정 안 됨"}</span>
					<ChevronDown size={14} aria-hidden="true" focusable="false" />
				</button>
			</Row>
			{open ? (
				<ModalShell onClose={() => setOpen(false)}>
					<h2>문서 이해 모델</h2>
					<p>문서의 의미를 분석하는 임베딩 모델입니다. Dazzi 런타임과 내 컴퓨터 서버만 고를 수 있고, 문서 내용은 이 Mac 밖으로 나가지 않습니다.</p>
					<div className="settings-list">
						{profiles.map((profile) => (
							<label key={profile.id} className="settings-list-row" style={{ cursor: "pointer" }}>
								<input type="radio" name="embedding-profile" checked={profileId === profile.id} onChange={() => { setProfileId(profile.id); setPlanned(null); setResult(null); }} style={{ width: "auto", margin: 0 }} />
								<span className="settings-list-body">
									<span className="settings-list-title">{profile.label}</span>
									<span className="settings-list-meta">{profile.description}{profile.dimension > 0 ? ` · ${profile.dimension}차원` : ""}</span>
								</span>
							</label>
						))}
					</div>
					{profileId === "local-server" ? (
						<>
							<label>모델 이름<input value={local.id} placeholder="예: nomic-embed-text" onChange={(event) => setLocal((prev) => ({ ...prev, id: event.target.value }))} /></label>
							<label>서버 주소<input value={local.baseUrl} onChange={(event) => setLocal((prev) => ({ ...prev, baseUrl: event.target.value }))} /></label>
							<label>차원<input inputMode="numeric" value={local.dimension} placeholder="예: 768" onChange={(event) => setLocal((prev) => ({ ...prev, dimension: event.target.value }))} /></label>
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
							<Note>{incompatible.length}개 데이터소스가 이 프로필과 호환되지 않습니다. 계속하면 해당 소스는 그대로 두고 나머지만 바뀝니다.</Note>
							<label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
								<input type="checkbox" checked={acknowledge} onChange={(event) => setAcknowledge(event.target.checked)} style={{ width: "auto", margin: 0 }} />
								호환되지 않는 소스도 함께 적용
							</label>
						</>
					) : null}
					{result !== null ? (
						<div className="settings-note" style={{ marginTop: 12 }}>
							<span>
								{result.applied ? "적용했습니다." : "적용되지 않았습니다."} config {result.written.length}개 항목 기록
								{result.rebuilds.length > 0 ? ` · ${result.rebuilds.length}개 소스 재색인` : ""}
							</span>
						</div>
					) : null}
					{error !== null ? <p className="settings-modal-error">{error}</p> : null}
					<ModalActions>
						<button type="button" className="linear-btn" onClick={() => setOpen(false)} disabled={busy}>닫기</button>
						<button type="button" className="linear-btn" onClick={() => void preview()} disabled={busy || profileId.length === 0}>계획 확인</button>
						<button type="button" className="linear-btn settings-btn-primary" onClick={() => void apply()} disabled={busy || profileId.length === 0 || result?.applied === true}>적용</button>
					</ModalActions>
				</ModalShell>
			) : null}
		</>
	);
}
