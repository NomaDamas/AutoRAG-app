/**
 * Model configuration panels for Settings → Models.
 *
 * Three provider-centric panels edit the shared AutoRAG config (the same file
 * the CLI/TUI resolve). Ordinary settings auto-save through leaf-level
 * `configPatch` writes that never clobber sibling/unknown leaves; only the
 * rerank enable/disable transition replaces the block (a `false` marker cannot
 * hold leaves). Discrete selects/toggles write immediately, text/number fields
 * debounce and flush on blur, and all writes are serialized so a tab switch
 * cannot drop or double-apply an edit:
 *
 * - `llm`       → `model` (Pi runtime catalog + custom provider/endpoint)
 * - `embedding` → `minSync.embedder` (built-in local profiles or a local HTTP
 *                 endpoint; never a remote corpus embedder). Identity
 *                 (profile/id/baseUrl) keeps an explicit save plus reindex
 *                 warning; advanced tuning auto-saves without touching it.
 * - `reranker`  → `rerank` (OpenRouter is the only provider supported by v2.7)
 *
 * Secrets never live in the config: `apiKeyEnv` is an env-var name, and the
 * secret itself goes through the encrypted credential bridge keyed by that
 * env var. The bridge returns only stored/env presence, never the value.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	ConfigRefreshResult,
	JsonObject,
	JsonValue,
	ModelCatalogEntry,
	ModelCatalogProvider,
	ModelCatalogSnapshot,
	ProviderCredentialStatus,
} from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";
import { useAutoSave, useLatestConfig } from "./useAutoSave";

const autorag = window.autorag;

/* ------------------------------------------------------------------ types -- */

export type ModelSettingsKind = "llm" | "embedding" | "reranker";

/* ---------------------------------------------------------------- helpers -- */

function getAt(root: JsonObject, path: readonly string[]): JsonValue | undefined {
	let current: JsonValue | undefined = root;
	for (const segment of path) {
		if (current === undefined || !isJsonObject(current)) return undefined;
		current = (current as JsonObject)[segment];
	}
	return current;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
	return value !== undefined && isJsonObject(value) ? (value as JsonObject) : null;
}

function stringOf(value: JsonValue | undefined): string {
	return typeof value === "string" ? value : "";
}

function numberOf(value: JsonValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolOf(value: JsonValue | undefined): boolean | null {
	return typeof value === "boolean" ? value : null;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function defaultEnvName(provider: string): string {
	const base = provider.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase();
	return base.length === 0 ? "" : `${base}_API_KEY`;
}

function parsePositiveInt(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed.length === 0) return null;
	const value = Number(trimmed);
	return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Numeric text compared by parsed value so "01" and "1" are the same edit and
 * never leave a panel stuck dirty after the normalized value is written.
 */
function numericKey(text: string): string {
	const parsed = parsePositiveInt(text);
	return parsed === null ? text.trim() : String(parsed);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Wire protocols accepted by the shared AutoRAG config for `model.api` (upstream
 * `AGENT_MODEL_APIS`). Other Pi catalog protocols (e.g. google-generative-ai)
 * are supported by omitting `api` and letting the catalog model supply its own
 * transport — the config `api` is only an override and must be one of these.
 */
const ALLOWED_AGENT_APIS: readonly string[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"openai-codex-responses",
	"azure-openai-responses",
];

function isAllowedAgentApi(api: string): boolean {
	return ALLOWED_AGENT_APIS.includes(api);
}

/* ------------------------------------------------------------ primitives -- */

function Row({ name, hint, children }: { readonly name: string; readonly hint: string; readonly children: ReactNode }): ReactElement {
	return (
		<div className="linear-row">
			<div className="linear-row-label">
				<span className="linear-row-name">{name}</span>
				<small>{hint}</small>
			</div>
			<div className="linear-control">{children}</div>
		</div>
	);
}

function TextField({
	value,
	onChange,
	ariaLabel,
	placeholder,
	type = "text",
	list,
	disabled = false,
	width = 260,
	onBlur,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly ariaLabel: string;
	readonly placeholder?: string | undefined;
	readonly type?: string | undefined;
	readonly list?: string | undefined;
	readonly disabled?: boolean | undefined;
	readonly width?: number | undefined;
	/** Flush a debounced auto-save as soon as the field loses focus. */
	readonly onBlur?: (() => void) | undefined;
}): ReactElement {
	return (
		<input
			className="settings-source-desc__input"
			style={{ width }}
			type={type}
			list={list}
			value={value}
			placeholder={placeholder}
			disabled={disabled}
			aria-label={ariaLabel}
			spellCheck={false}
			autoComplete="off"
			onChange={(event) => onChange(event.target.value)}
			onBlur={onBlur}
		/>
	);
}

function SelectField({
	value,
	onChange,
	options,
	ariaLabel,
	disabled = false,
	width = 260,
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly options: readonly { readonly value: string; readonly label: string }[];
	readonly ariaLabel: string;
	readonly disabled?: boolean | undefined;
	readonly width?: number | undefined;
}): ReactElement {
	return (
		<select
			className="linear-select"
			style={{ width }}
			value={value}
			disabled={disabled}
			aria-label={ariaLabel}
			onChange={(event) => onChange(event.target.value)}
		>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	);
}

/** Encrypted per-env-var API key control. Never echoes a stored secret. */
function CredentialField({ envName, hint, onChanged }: { readonly envName: string; readonly hint: string; readonly onChanged?: (() => void) | undefined }): ReactElement {
	const [status, setStatus] = useState<ProviderCredentialStatus | null>(null);
	const [secret, setSecret] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		if (envName.length === 0) {
			setStatus(null);
			return;
		}
		try {
			const list = await autorag.settings.credentialsList([envName]);
			setStatus(list.find((row) => row.envName === envName) ?? null);
			setError(null);
		} catch (cause) {
			setStatus(null);
			setError(errorMessage(cause));
		}
	}, [envName]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function save(): Promise<void> {
		if (busy) return;
		const trimmed = secret.trim();
		if (trimmed.length === 0) {
			setError("Enter an API key value before saving.");
			return;
		}
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await autorag.settings.credentialsSet(envName, trimmed);
			setSecret("");
			setNotice("Encrypted key saved.");
			await refresh();
			onChanged?.();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	async function remove(): Promise<void> {
		if (busy) return;
		setBusy(true);
		setError(null);
		setNotice(null);
		try {
			await autorag.settings.credentialsRemove(envName);
			setNotice("Stored key removed.");
			await refresh();
			onChanged?.();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	}

	const statusLabel =
		status === null
			? envName.length === 0
				? "Set an env var name first"
				: "Unknown"
			: status.source === "stored"
				? "Encrypted key stored"
				: status.source === "env"
					? "Provided by environment"
					: "No key set";
	const connected = status !== null && status.source !== "none";

	return (
		<>
			<Row name={`API key · ${envName.length > 0 ? envName : "—"}`} hint={hint}>
				<span className={`provider-status ${connected ? "is-connected" : "is-disconnected"}`}>{statusLabel}</span>
			</Row>
			{envName.length === 0 ? (
				<div className="linear-section-desc">Choose an API key environment variable name, then save the secret here.</div>
			) : (
				<Row name="Set / replace key" hint="Stored encrypted by the OS keychain and injected as this environment variable when the librarian starts. The value is never read back.">
					<TextField
						type="password"
						ariaLabel={`${envName} API key`}
						placeholder="Paste API key"
						value={secret}
						disabled={busy}
						onChange={setSecret}
					/>
					<button type="button" className="linear-btn" disabled={busy || secret.trim().length === 0} onClick={() => void save()}>
						{busy ? "Saving…" : "Save key"}
					</button>
					<button
						type="button"
						className="linear-btn is-danger"
						disabled={busy || status === null || !status.stored}
						onClick={() => void remove()}
					>
						Remove
					</button>
				</Row>
			)}
			{notice !== null ? <div className="linear-section-desc">{notice}</div> : null}
			{error !== null ? (
				<div className="settings-error" role="alert">
					{error}
				</div>
			) : null}
		</>
	);
}

/* =================================================================== LLM == */

interface LlmDraft {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly apiKeyEnv: string;
}

function llmDraftFrom(snapshot: AutoRagConfigSnapshot): LlmDraft {
	const model = asRecord(getAt(snapshot.config, ["model"]));
	return {
		provider: model ? stringOf(model.provider) : "",
		id: model ? stringOf(model.id) : "",
		name: model ? stringOf(model.name) : "",
		api: model ? stringOf(model.api) : "",
		baseUrl: model ? stringOf(model.baseUrl) : "",
		apiKeyEnv: model ? stringOf(model.apiKeyEnv) : "",
	};
}

/**
 * Semantic identity of an LLM draft. Trims values and drops a non-overridable
 * `api` so whitespace or an ignored protocol never leaves the panel "dirty"
 * (which would otherwise re-save forever).
 */
function llmKey(draft: LlmDraft): string {
	return JSON.stringify([
		draft.provider.trim(),
		draft.id.trim(),
		draft.name.trim(),
		isAllowedAgentApi(draft.api.trim()) ? draft.api.trim() : "",
		draft.baseUrl.trim(),
		draft.apiKeyEnv.trim(),
	]);
}

function LlmPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const [draft, setDraft] = useState<LlmDraft>(() => llmDraftFrom(snapshot));
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const [catalog, setCatalog] = useState<ModelCatalogSnapshot | null>(null);
	const [credentials, setCredentials] = useState<readonly ProviderCredentialStatus[]>([]);
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const savedDraft = useMemo(() => llmDraftFrom(snapshot), [snapshot]);
	const dirty = llmKey(draft) !== llmKey(savedDraft);
	const immediateRef = useRef(false);
	const lastSavedKeyRef = useRef(llmKey(savedDraft));
	const configRef = useLatestConfig(snapshot);

	const autoSave = useAutoSave<LlmDraft>({
		key: llmKey,
		perform: async (value) => {
			const problems: string[] = [];
			const provider = value.provider.trim();
			const id = value.id.trim();
			const api = value.api.trim();
			const apiKeyEnv = value.apiKeyEnv.trim();
			if (provider.length === 0) problems.push("Provider is required.");
			if (id.length === 0) problems.push("Model id is required.");
			if (api.length > 0 && !isAllowedAgentApi(api)) problems.push(`API protocol "${api}" is not supported by AutoRAG.`);
			if (apiKeyEnv.length > 0 && !ENV_NAME_PATTERN.test(apiKeyEnv)) problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
			if (problems.length > 0) {
				const message = problems.join(" ");
				setError(message);
				throw new Error(message);
			}
			// Diff against the freshest known config so a follow-up write that
			// drained before the previous response re-rendered still converges.
			// Write only the leaves this panel owns so unknown model leaves survive.
			const record = asRecord(getAt(configRef.current, ["model"]));
			const updates: AutoRagConfigUpdate[] = [];
			const put = (leaf: string, desired: string, removable: boolean): void => {
				const current = record === null ? "" : stringOf(record[leaf]);
				if (desired === current) return;
				if (desired.length === 0 && removable) updates.push({ path: ["model", leaf], remove: true });
				else updates.push({ path: ["model", leaf], value: desired });
			};
			put("provider", provider, false);
			put("id", id, false);
			put("name", value.name.trim(), true);
			put("api", api, true);
			put("baseUrl", value.baseUrl.trim(), true);
			put("apiKeyEnv", apiKeyEnv, true);
			if (updates.length === 0) {
				setError(null);
				return;
			}
			try {
				const next = await autorag.settings.configPatch(updates);
				configRef.record(next.config);
				onSaved(next);
				setError(null);
			} catch (cause) {
				setError(errorMessage(cause));
				throw cause;
			}
		},
	});
	const { queue: queueSave, flush: flushSave, cancel: cancelSave, drain: drainSave, busy: autoSaving } = autoSave;
	const setDraftLatest = (next: LlmDraft): void => {
		draftRef.current = next;
		setDraft(next);
	};

	// Adopt a new snapshot only while the draft still matches the previously saved
	// value, so external updates apply but a late response never clobbers typing.
	useEffect(() => {
		const previousSavedKey = lastSavedKeyRef.current;
		lastSavedKeyRef.current = llmKey(savedDraft);
		if (llmKey(draft) === previousSavedKey) setDraftLatest(savedDraft);
	}, [savedDraft]);

	// Text edits debounce; selects/toggles flip `immediateRef` and flush; a draft
	// back at the saved value cancels any stale queued write.
	useEffect(() => {
		const immediate = immediateRef.current;
		immediateRef.current = false;
		if (!dirty) {
			if (autoSaving) queueSave(draft);
			else cancelSave();
			return;
		}
		if (immediate) flushSave(draft);
		else queueSave(draft);
	}, [draft, dirty, autoSaving, cancelSave, flushSave, queueSave]);

	function editText(mutate: (current: LlmDraft) => LlmDraft): void {
		const next = mutate(draftRef.current);
		setDraftLatest(next);
		queueSave(next);
	}

	function editNow(mutate: (current: LlmDraft) => LlmDraft): void {
		immediateRef.current = true;
		const next = mutate(draftRef.current);
		setDraftLatest(next);
		flushSave(next);
	}

	const loadCatalog = useCallback(async (): Promise<void> => {
		try {
			setCatalog(await autorag.settings.modelsCatalog());
		} catch (cause) {
			setCatalog({ error: errorMessage(cause), providers: [] });
		}
	}, []);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	const providers = catalog?.providers ?? [];
	const providerEnvNames = useMemo(
		() => (catalog?.providers ?? []).map((provider) => provider.apiKeyEnv ?? defaultEnvName(provider.id)).filter((name) => name.length > 0),
		[catalog],
	);

	const loadCredentials = useCallback(async (): Promise<void> => {
		try {
			setCredentials(
				providerEnvNames.length > 0 ? await autorag.settings.credentialsList(providerEnvNames) : await autorag.settings.credentialsList(),
			);
		} catch {
			setCredentials([]);
		}
	}, [providerEnvNames]);

	useEffect(() => {
		void loadCredentials();
	}, [loadCredentials]);

	const credentialByEnv = useMemo(() => {
		const map: Record<string, ProviderCredentialStatus> = {};
		for (const row of credentials) map[row.envName] = row;
		return map;
	}, [credentials]);

	const selectedProvider = providers.find((provider) => provider.id === draft.provider) ?? null;
	const modelOptions = selectedProvider?.models ?? [];
	const providerIsKnown = selectedProvider !== null;
	const modelIsKnown = modelOptions.some((model) => model.id === draft.id);
	const selectedCatalogModel = modelOptions.find((model) => model.id === draft.id) ?? null;
	const catalogApiNotice =
		selectedCatalogModel !== null && !isAllowedAgentApi(selectedCatalogModel.api) && draft.api.length === 0
			? `This catalog model uses the ${selectedCatalogModel.api} protocol. AutoRAG reads that from the catalog model, so the explicit config api override stays empty.`
			: null;

	const effectiveEnv =
		draft.apiKeyEnv.trim().length > 0
			? draft.apiKeyEnv.trim()
			: selectedProvider !== null
				? (selectedProvider.apiKeyEnv ?? defaultEnvName(selectedProvider.id))
				: defaultEnvName(draft.provider);

	const catalogError = catalog?.error ?? null;

	const selectedKeyRow =
		selectedProvider === null ? null : (credentialByEnv[selectedProvider.apiKeyEnv ?? defaultEnvName(selectedProvider.id)] ?? null);
	const selectedKeyConnected = selectedKeyRow !== null && selectedKeyRow.source !== "none";
	const selectedKeyLabel =
		selectedKeyRow === null
			? "No key detected"
			: selectedKeyRow.source === "stored"
				? "Stored key"
				: selectedKeyRow.source === "env"
					? "Environment key"
					: "No key";

	function selectProvider(provider: ModelCatalogProvider): void {
		editNow((current) => ({
			...current,
			provider: provider.id,
			id: "",
			name: "",
			api: "",
			baseUrl: "",
			apiKeyEnv: provider.apiKeyEnv ?? "",
		}));
	}

	function selectModel(model: ModelCatalogEntry): void {
		editNow((current) => ({
			...current,
			provider: model.provider,
			id: model.id,
			name: model.name,
			api: isAllowedAgentApi(model.api) ? model.api : "",
		}));
	}

	async function reset(): Promise<void> {
		// Drop any debounced write, wait for an in-flight one, then remove the block.
		cancelSave();
		await drainSave();
		setResetting(true);
		setError(null);
		try {
			const next = await autorag.settings.configRemove(["model"]);
			configRef.record(next.config);
			onSaved(next);
			setDraftLatest(llmDraftFrom(next));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setResetting(false);
		}
	}

	return (
		<>
			<div className="linear-header">
				<h2 className="linear-title">LLM Models Configuration</h2>
				<p className="linear-desc">
					Choose the provider and model used by AutoRAG. Model capabilities and token limits come from the provider catalog or the model runtime.
				</p>
			</div>

			{snapshot.error !== null ? (
				<div className="settings-error" role="alert">
					{snapshot.error}
				</div>
			) : null}
			{error !== null ? (
				<div className="settings-error" role="alert">
					{error}
				</div>
			) : null}
			{catalogError !== null ? (
				<div className="settings-error" role="alert">
					Model catalog unavailable: {catalogError}
				</div>
			) : null}

			<div className="linear-section-title">Provider Connection</div>
			{catalog === null ? (
				<p className="linear-section-desc">Loading the model catalog…</p>
			) : (
				<>
					<Row name="Provider" hint="Catalog provider, or a custom provider namespace. Endpoint, api, and key env form the connection reused by every model and role that references this env var.">
						<SelectField
							ariaLabel="Provider"
							value={providerIsKnown ? draft.provider : "__custom__"}
							options={[
								{ value: "__custom__", label: "Custom provider…" },
								...providers.map((provider) => {
									const row = credentialByEnv[provider.apiKeyEnv ?? defaultEnvName(provider.id)];
									const key = row?.source === "stored" ? "key stored" : row?.source === "env" ? "env key" : "no key";
									return { value: provider.id, label: `${provider.name} (${provider.id}) · ${key}` };
								}),
							]}
							onChange={(value) => {
								if (value === "__custom__") {
									editNow((current) => ({ ...current, provider: "", id: "", name: "", api: "", baseUrl: "", apiKeyEnv: "" }));
									return;
								}
								const provider = providers.find((item) => item.id === value);
								if (provider !== undefined) selectProvider(provider);
							}}
						/>
					</Row>
					{!providerIsKnown ? (
						<Row name="Custom provider id" hint="Provider namespace used for auth lookup, e.g. openrouter, ollama, fireworks.">
							<TextField
								ariaLabel="Custom provider id"
								placeholder="provider"
								value={draft.provider}
								onChange={(value) => editText((current) => ({ ...current, provider: value }))}
								onBlur={() => flushSave()}
							/>
						</Row>
					) : null}
					{selectedProvider !== null ? (
						<div className="provider-row">
							<span className="provider-icon">{(selectedProvider.name[0] ?? selectedProvider.id[0] ?? "?").toUpperCase()}</span>
							<span className="provider-body">
								<span className="provider-name">
									{selectedProvider.name}
									<span className="provider-tag">{selectedProvider.id}</span>
								</span>
								<span className="provider-models">
									{selectedProvider.models.length} model{selectedProvider.models.length === 1 ? "" : "s"} · {selectedProvider.baseUrl ?? "catalog endpoint"}
								</span>
							</span>
							<span className={`provider-status ${selectedKeyConnected ? "is-connected" : "is-disconnected"}`}>{selectedKeyLabel}</span>
						</div>
					) : null}
					<Row name="Base URL" hint="Endpoint override for this provider connection, e.g. a gateway or local server. Blank uses the catalog endpoint.">
						<TextField ariaLabel="Base URL" placeholder="https://…" value={draft.baseUrl} onChange={(value) => editText((current) => ({ ...current, baseUrl: value }))} onBlur={() => flushSave()} />
					</Row>
					<Row name="API" hint="Optional wire-protocol override; only AutoRAG-recognized protocols can be stored. Catalog models use their own protocol when blank.">
						<SelectField
							ariaLabel="API"
							value={isAllowedAgentApi(draft.api) ? draft.api : ""}
							options={[{ value: "", label: "Catalog / default" }, ...ALLOWED_AGENT_APIS.map((api) => ({ value: api, label: api }))]}
							onChange={(value) => editNow((current) => ({ ...current, api: value }))}
						/>
					</Row>
					<Row name="API key env var" hint="Env var holding this provider's key; blank defaults to ${PROVIDER}_API_KEY. Reused across models and roles that reference it.">
						<TextField
							ariaLabel="API key env var"
							placeholder={defaultEnvName(draft.provider) || "PROVIDER_API_KEY"}
							value={draft.apiKeyEnv}
							onChange={(value) => editText((current) => ({ ...current, apiKeyEnv: value }))}
							onBlur={() => flushSave()}
						/>
					</Row>
					{catalogApiNotice !== null ? <div className="linear-section-desc">{catalogApiNotice}</div> : null}
				</>
			)}

			<div className="linear-section-title">Model</div>
			<Row name="Model id" hint="Catalog model, or a custom wire id sent to the provider.">
				<SelectField
					ariaLabel="Model id"
					value={modelIsKnown ? draft.id : "__custom__"}
					options={[
						{ value: "__custom__", label: "Custom model id…" },
						...modelOptions.map((model) => ({
							value: model.id,
							label: `${model.name}${isAllowedAgentApi(model.api) ? "" : ` · ${model.api}`}`,
						})),
					]}
					onChange={(value) => {
						if (value === "__custom__") editNow((current) => ({ ...current, id: "", name: "" }));
						else {
							const model = modelOptions.find((item) => item.id === value);
							if (model !== undefined) selectModel(model);
						}
					}}
				/>
			</Row>
			{!modelIsKnown ? (
				<Row name="Custom model id" hint="Wire id sent to the provider API, e.g. deepseek/deepseek-v4.1-flash.">
					<TextField
						ariaLabel="Custom model id"
						placeholder="provider/model"
						value={draft.id}
						onChange={(value) => editText((current) => ({ ...current, id: value }))}
						onBlur={() => flushSave()}
					/>
				</Row>
			) : null}
			<Row name="Display name" hint="Human-readable label; defaults to the model id when blank.">
				<TextField ariaLabel="Display name" placeholder="(defaults to id)" value={draft.name} onChange={(value) => editText((current) => ({ ...current, name: value }))} onBlur={() => flushSave()} />
			</Row>

			<div className="linear-section-title">Credentials</div>
			<CredentialField
				envName={effectiveEnv}
				hint="The secret is stored encrypted and injected as this env var; the config keeps only the env var name. Reused wherever this env var is referenced."
				onChanged={() => {
					void loadCatalog();
					void loadCredentials();
				}}
			/>


			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={resetting || autoSaving} onClick={() => void reset()}>Reset to catalog default</button>
				{resetting || autoSaving ? <span className="settings-inline-status">Saving…</span> : <span className="settings-inline-status">Changes save automatically</span>}
			</div>
		</>
	);
}

/* ============================================================= Embedding == */

type EmbedMode = "profile" | "endpoint";

const EMBED_PROFILES: readonly {
	readonly id: "qwen3-embedding-0.6b" | "embeddinggemma-300m";
	readonly provider: string;
	readonly label: string;
	readonly dimension: number;
}[] = [
	{
		id: "qwen3-embedding-0.6b",
		provider: "Qwen",
		label: "Qwen3-Embedding-0.6B (local runtime)",
		dimension: 1024,
	},
	{
		id: "embeddinggemma-300m",
		provider: "Google",
		label: "EmbeddingGemma-300M (local runtime)",
		dimension: 768,
	},
];

interface EmbedDraft {
	readonly mode: EmbedMode;
	readonly profile: "qwen3-embedding-0.6b" | "embeddinggemma-300m";
	readonly id: string;
	readonly baseUrl: string;
	readonly apiKeyEnv: string;
	readonly timeoutMs: string;
	readonly batchSize: string;
	readonly maxConcurrent: string;
}

function embedDraftFrom(snapshot: AutoRagConfigSnapshot): EmbedDraft {
	const embedder = asRecord(getAt(snapshot.config, ["minSync", "embedder"]));
	const profileRaw = embedder ? stringOf(embedder.profile) : "";
	const profile = profileRaw === "embeddinggemma-300m" ? "embeddinggemma-300m" : "qwen3-embedding-0.6b";
	const baseUrl = embedder ? stringOf(embedder.baseUrl) : "";
	const mode: EmbedMode = baseUrl.trim().length > 0 ? "endpoint" : "profile";
	const timeoutMs = embedder ? numberOf(embedder.timeoutMs) : null;
	const batchSize = embedder ? numberOf(embedder.batchSize) : null;
	const maxConcurrent = embedder ? numberOf(embedder.maxConcurrent) : null;
	return {
		mode,
		profile,
		id: embedder ? stringOf(embedder.id) : "",
		baseUrl,
		apiKeyEnv: embedder ? stringOf(embedder.apiKeyEnv) : "",
		timeoutMs: timeoutMs === null ? "" : String(timeoutMs),
		batchSize: batchSize === null ? "" : String(batchSize),
		maxConcurrent: maxConcurrent === null ? "" : String(maxConcurrent),
	};
}

/**
 * Identity whose reindex was requested but not yet confirmed by an explicit
 * refresh result. Module-scoped so the warning survives the panel unmount a
 * Settings tab switch causes; cleared only by a successful reindex.
 */
let modulePendingReindexIdentity: string | null = null;

/** Identity leaves (provider/profile/id/baseUrl) that force a reindex. */
function embedIdentityKey(draft: EmbedDraft): string {
	return draft.mode === "endpoint"
		? JSON.stringify(["endpoint", draft.id.trim(), draft.baseUrl.trim()])
		: JSON.stringify(["profile", draft.profile]);
}

/** Advanced leaves that auto-save without touching the embedding identity. */
function embedAdvancedKey(draft: EmbedDraft): string {
	return JSON.stringify([draft.apiKeyEnv.trim(), numericKey(draft.timeoutMs), numericKey(draft.batchSize), numericKey(draft.maxConcurrent)]);
}

/** Combined draft signature used to detect local edits across identity + advanced. */
function embedDraftKey(draft: EmbedDraft): string {
	return `${embedIdentityKey(draft)}\u0000${embedAdvancedKey(draft)}`;
}

function EmbeddingPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const [draft, setDraft] = useState<EmbedDraft>(() => embedDraftFrom(snapshot));
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshResult, setRefreshResult] = useState<ConfigRefreshResult | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [resetting, setResetting] = useState(false);
	const [identitySaving, setIdentitySaving] = useState(false);
	const [pendingReindexIdentity, setPendingReindexIdentity] = useState<string | null>(() => modulePendingReindexIdentity);

	const saved = useMemo(() => embedDraftFrom(snapshot), [snapshot]);
	const identityChanged = embedIdentityKey(draft) !== embedIdentityKey(saved);
	const advancedChanged = embedAdvancedKey(draft) !== embedAdvancedKey(saved);
	const lastSavedKeyRef = useRef(embedDraftKey(saved));
	const configRef = useLatestConfig(snapshot);

	const autoSave = useAutoSave<EmbedDraft>({
		key: embedAdvancedKey,
		// Advanced timeout/batch/concurrency/API-env leaves save on their own,
		// even while an unrelated identity (profile/id/baseUrl) draft is pending.
		// This never touches an identity leaf, so the pending identity is not applied.
		perform: async (value) => {
			const problems: string[] = [];
			const apiKeyEnv = value.apiKeyEnv.trim();
			if (apiKeyEnv.length > 0 && !ENV_NAME_PATTERN.test(apiKeyEnv)) problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
			const numeric: readonly { readonly key: "timeoutMs" | "batchSize" | "maxConcurrent"; readonly label: string }[] = [
				{ key: "timeoutMs", label: "Timeout" },
				{ key: "batchSize", label: "Batch size" },
				{ key: "maxConcurrent", label: "Max concurrency" },
			];
			const parsed: Record<string, number | null> = {};
			for (const field of numeric) {
				const text = value[field.key].trim();
				const parsedValue = parsePositiveInt(text);
				if (text.length > 0 && parsedValue === null) problems.push(`${field.label} must be a positive integer.`);
				parsed[field.key] = parsedValue;
			}
			if (problems.length > 0) {
				const message = problems.join(" ");
				setError(message);
				throw new Error(message);
			}
			const record = asRecord(getAt(configRef.current, ["minSync", "embedder"]));
			const updates: AutoRagConfigUpdate[] = [];
			const apiKeyEnvCurrent = record === null ? "" : stringOf(record.apiKeyEnv);
			if (apiKeyEnv !== apiKeyEnvCurrent) {
				updates.push(apiKeyEnv.length === 0 ? { path: ["minSync", "embedder", "apiKeyEnv"], remove: true } : { path: ["minSync", "embedder", "apiKeyEnv"], value: apiKeyEnv });
			}
			for (const field of numeric) {
				const desired = parsed[field.key] ?? null;
				const current = record === null ? null : numberOf(record[field.key]);
				if (desired === null) {
					if (current !== null) updates.push({ path: ["minSync", "embedder", field.key], remove: true });
					continue;
				}
				if (current === desired) continue;
				updates.push({ path: ["minSync", "embedder", field.key], value: desired });
			}
			if (updates.length === 0) {
				setError(null);
				return;
			}
			try {
				const next = await autorag.settings.configPatch(updates);
				configRef.record(next.config);
				onSaved(next);
				setError(null);
			} catch (cause) {
				setError(errorMessage(cause));
				throw cause;
			}
		},
	});
	const { queue: queueSave, flush: flushSave, cancel: cancelSave, drain: drainSave, busy: autoSaving } = autoSave;
	const setDraftLatest = (next: EmbedDraft): void => {
		draftRef.current = next;
		setDraft(next);
	};

	// Adopt a new snapshot only while the draft still matches the previously saved
	// value, so external updates apply but a pending identity draft is preserved.
	useEffect(() => {
		const previousSavedKey = lastSavedKeyRef.current;
		lastSavedKeyRef.current = embedDraftKey(saved);
		if (embedDraftKey(draft) === previousSavedKey) setDraftLatest(saved);
	}, [saved]);

	// Advanced edits debounce; a draft back at the saved value cancels a stale
	// queued advanced write. The select is an explicit identity draft, never auto-saved.
	useEffect(() => {
		if (!advancedChanged) {
			if (autoSaving) queueSave(draft);
			else cancelSave();
			return;
		}
		queueSave(draft);
	}, [draft, advancedChanged, autoSaving, cancelSave, queueSave]);
	function editDraft(mutate: (current: EmbedDraft) => EmbedDraft, queueAdvanced = false): void {
		const next = mutate(draftRef.current);
		setDraftLatest(next);
		if (queueAdvanced) queueSave(next);
	}

	function selectMode(value: string): void {
		// The selector edits the explicit identity draft only; other advanced
		// leaves (timeout/batch/concurrency/apiKeyEnv) are preserved as-is.
		if (value === "endpoint") {
			editDraft((current) => ({ ...current, mode: "endpoint" }));
			return;
		}
		const profile = EMBED_PROFILES.find((item) => item.id === value) ?? EMBED_PROFILES[0]!;
		editDraft((current) => ({ ...current, mode: "profile", profile: profile.id }));
	}

	/** Explicit identity save; advanced leaves auto-save and are not rewritten here. */
	async function saveIdentity(): Promise<void> {
		if (!identityChanged || identitySaving) return;
		// Flush pending advanced edits, then wait: the identity write must be the
		// only thing in flight so its snapshot is the newest response.
		flushSave();
		await drainSave();
		const problems: string[] = [];
		const id = draft.id.trim();
		const baseUrl = draft.baseUrl.trim();
		if (draft.mode === "endpoint") {
			if (id.length === 0) problems.push("Embedder id is required for a local endpoint.");
			if (baseUrl.length === 0) problems.push("Endpoint base URL is required for a local endpoint.");
		}
		if (problems.length > 0) {
			setError(problems.join(" "));
			return;
		}
		const record = asRecord(getAt(configRef.current, ["minSync", "embedder"]));
		const updates: AutoRagConfigUpdate[] = [];
		if (draft.mode === "profile") {
			const preset = EMBED_PROFILES.find((item) => item.id === draft.profile) ?? EMBED_PROFILES[0]!;
			updates.push({ path: ["minSync", "embedder", "profile"], value: draft.profile });
			updates.push({ path: ["minSync", "embedder", "dimension"], value: preset.dimension });
			if (record !== null && record.id !== undefined) updates.push({ path: ["minSync", "embedder", "id"], remove: true });
			if (record !== null && record.baseUrl !== undefined) updates.push({ path: ["minSync", "embedder", "baseUrl"], remove: true });
		} else {
			updates.push({ path: ["minSync", "embedder", "id"], value: id });
			updates.push({ path: ["minSync", "embedder", "baseUrl"], value: baseUrl });
			if (record !== null && record.profile !== undefined) updates.push({ path: ["minSync", "embedder", "profile"], remove: true });
			if (record !== null && record.dimension !== undefined) updates.push({ path: ["minSync", "embedder", "dimension"], remove: true });
		}
		setIdentitySaving(true);
		setError(null);
		try {
			const next = await autorag.settings.configPatch(updates);
			configRef.record(next.config);
			onSaved(next);
			const nextDraft = embedDraftFrom(next);
			setDraftLatest(nextDraft);
			const fingerprint = embedIdentityKey(nextDraft);
			modulePendingReindexIdentity = fingerprint;
			setPendingReindexIdentity(fingerprint);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setIdentitySaving(false);
		}
	}

	async function reindex(): Promise<void> {
		setRefreshing(true);
		setRefreshError(null);
		try {
			const result = await autorag.settings.configRefresh(["minsync"]);
			setRefreshResult(result);
			if (result.ok) {
				modulePendingReindexIdentity = null;
				setPendingReindexIdentity(null);
			}
		} catch (cause) {
			setRefreshResult(null);
			setRefreshError(errorMessage(cause));
		} finally {
			setRefreshing(false);
		}
	}

	async function reset(): Promise<void> {
		cancelSave();
		await drainSave();
		setResetting(true);
		setError(null);
		try {
			const next = await autorag.settings.configRemove(["minSync", "embedder"]);
			configRef.record(next.config);
			onSaved(next);
			const nextDraft = embedDraftFrom(next);
			setDraftLatest(nextDraft);
			// Removing the embedder reverts to the default identity; when that
			// differs from what was saved it still needs a reindex, so retain the
			// warning instead of clearing it.
			const resetIdentity = embedIdentityKey(nextDraft);
			if (resetIdentity !== embedIdentityKey(saved)) {
				modulePendingReindexIdentity = resetIdentity;
				setPendingReindexIdentity(resetIdentity);
			}
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setResetting(false);
		}
	}

	const selectedPreset = EMBED_PROFILES.find((item) => item.id === draft.profile) ?? EMBED_PROFILES[0]!;

	return (
		<>
			<div className="linear-header">
				<h2 className="linear-title">Embedding Configuration</h2>
				<p className="linear-desc">
					MinSync semantic indexing uses AutoRAG's local embedding runtime. Choose a built-in profile, or point at an explicit local
					HTTP endpoint. Corpus text is never sent to a remote embedder.
				</p>
			</div>

			{snapshot.error !== null ? (
				<div className="settings-error" role="alert">
					{snapshot.error}
				</div>
			) : null}
			{error !== null ? (
				<div className="settings-error" role="alert">
					{error}
				</div>
			) : null}
			<div className="linear-section-desc">
				This shared runtime powers MinSync. Native datasources such as discrawl and mailcrawl keep their own embedding identity and
				vector store.
			</div>

			<div className="linear-section-title">Provider</div>
			<Row name="Embedding provider" hint="Built-in AutoRAG local runtime profiles, or an explicit local HTTP endpoint.">
				<SelectField
					ariaLabel="Embedding provider"
					value={draft.mode === "profile" ? draft.profile : "endpoint"}
					options={[
						...EMBED_PROFILES.map((profile) => ({ value: profile.id, label: `${profile.label} · ${profile.dimension}d` })),
						{ value: "endpoint", label: "Local HTTP endpoint (custom)" },
					]}
					onChange={selectMode}
				/>
			</Row>

			{identityChanged || (pendingReindexIdentity !== null && pendingReindexIdentity === embedIdentityKey(saved)) ? (
				<div className="settings-error" role="alert" style={{ borderColor: "var(--warn-border, var(--border-strong))", background: "var(--warn-bg-soft, var(--bg-input))", color: "var(--warn-text, var(--text-primary))" }}>
					Changing the embedding identity (provider/profile, endpoint, or id) selects its automatic dimension and forces a full MinSync reindex before
					existing vectors can be reused. Run the reindex below after saving the identity.
				</div>
			) : null}

			{draft.mode === "profile" ? (
				<>
					<div className="linear-section-title">Profile</div>
					<Row name="Model profile" hint="Embedding identity includes provider, model revision, automatic dimension, prefixes, and runtime build.">
						<span className="linear-value">
							{selectedPreset.provider} · {selectedPreset.id}
						</span>
					</Row>
				</>
			) : (
				<>
					<div className="linear-section-title">Local Endpoint</div>
					<Row name="Embedder id" hint="Endpoint embedder id, e.g. native:Qwen/Qwen3-Embedding-0.6B.">
						<TextField ariaLabel="Embedder id" placeholder="native:model/id" value={draft.id} onChange={(value) => editDraft((current) => ({ ...current, id: value }))} />
					</Row>
					<Row name="Base URL" hint="Loopback HTTP endpoint that serves embeddings. Non-loopback URLs are rejected.">
						<TextField ariaLabel="Embedder base URL" placeholder="http://127.0.0.1:…" value={draft.baseUrl} onChange={(value) => editDraft((current) => ({ ...current, baseUrl: value }))} />
					</Row>
					<Row name="API key env var" hint="Optional env var holding the endpoint key. The secret is stored encrypted below.">
						<TextField
							ariaLabel="Embedder API key env var"
							placeholder="EMBEDDER_API_KEY"
							value={draft.apiKeyEnv}
							onChange={(value) => editDraft((current) => ({ ...current, apiKeyEnv: value }), true)}
							onBlur={() => flushSave()}
						/>
					</Row>
				</>
			)}

			<div className="linear-section-title">Advanced</div>
			<div className="linear-section-desc">These tuning values save automatically and do not change the embedding identity.</div>
			<Row name="Timeout (ms)" hint="Per-request timeout in milliseconds.">
				<TextField ariaLabel="Embedding timeout" type="number" placeholder="(default)" value={draft.timeoutMs} onChange={(value) => editDraft((current) => ({ ...current, timeoutMs: value }), true)} onBlur={() => flushSave()} />
			</Row>
			<Row name="Batch size" hint="Texts sent per embedding request.">
				<TextField ariaLabel="Embedding batch size" type="number" placeholder="(default)" value={draft.batchSize} onChange={(value) => editDraft((current) => ({ ...current, batchSize: value }), true)} onBlur={() => flushSave()} />
			</Row>
			<Row name="Max concurrency" hint="Concurrent embedding requests.">
				<TextField ariaLabel="Embedding max concurrency" type="number" placeholder="(default)" value={draft.maxConcurrent} onChange={(value) => editDraft((current) => ({ ...current, maxConcurrent: value }), true)} onBlur={() => flushSave()} />
			</Row>

			{draft.mode === "endpoint" ? (
				<>
					<div className="linear-section-title">Credentials</div>
					<CredentialField envName={draft.apiKeyEnv.trim()} hint="Stored encrypted and injected as the endpoint API key env var." />
				</>
			) : null}

			<div className="linear-section-title">Reindex</div>
			<div className="linear-section-desc">
				Re-embeds the MinSync corpus with the saved identity. Required after an identity change before queries reuse existing vectors.
			</div>
			{refreshError !== null ? (
				<div className="settings-error" role="alert">
					{refreshError}
				</div>
			) : null}
			{refreshResult !== null ? (
				<div className="linear-section-desc">
					{refreshResult.ok ? "Reindex complete" : "Reindex finished with diagnostics"} · scanned {refreshResult.scanned}, written{" "}
					{refreshResult.written}, deleted {refreshResult.deleted}, skipped {refreshResult.skipped}
					{refreshResult.error !== null ? ` · ${refreshResult.error}` : ""}
				</div>
			) : null}
			{refreshResult !== null && refreshResult.diagnostics.length > 0 ? (
				<ul className="linear-section-desc">
					{refreshResult.diagnostics.map((diagnostic, index) => (
						<li key={`${diagnostic.code}-${index}`}>
							{diagnostic.severity}: {diagnostic.message}
						</li>
					))}
				</ul>
			) : null}
			<button type="button" className="linear-btn" disabled={refreshing || resetting || autoSaving || identitySaving || identityChanged} onClick={() => void reindex()}>
				{refreshing ? "Reindexing…" : "Reindex MinSync vectors"}
			</button>

			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={resetting || autoSaving} onClick={() => void reset()}>
					Reset to defaults
				</button>
				<button type="button" className="linear-btn" disabled={identitySaving || autoSaving || !identityChanged} onClick={() => void saveIdentity()}>
					{identitySaving ? "Saving…" : "Save embedding identity"}
				</button>
				{autoSaving ? <span className="settings-inline-status">Saving advanced…</span> : <span className="settings-inline-status">Advanced settings save automatically</span>}
			</div>
		</>
	);
}

/* ============================================================== Reranker == */

const RERANK_PROVIDER = "openrouter";
const DEFAULT_RERANK_MODEL = "voyageai/rerank-3-lite";
const DEFAULT_RERANK_ENV = "OPENROUTER_API_KEY";

/** OpenRouter-hosted rerank wire ids (Voyage and Cohere); any wire id may be typed. */
const RERANK_MODEL_CHOICES: readonly string[] = [
	"voyageai/rerank-3-lite",
	"voyageai/rerank-3",
	"voyageai/rerank-2.5-lite",
	"cohere/rerank-v3.5",
	"cohere/rerank-4-fast",
];

interface RerankDraft {
	readonly enabled: boolean;
	readonly model: string;
	readonly apiKeyEnv: string;
	readonly baseUrl: string;
	readonly topN: string;
	readonly timeoutMs: string;
}

function rerankDraftFrom(snapshot: AutoRagConfigSnapshot): { readonly draft: RerankDraft; readonly unsupportedProvider: string | null } {
	const raw = getAt(snapshot.config, ["rerank"]);
	if (raw === false || raw === undefined) {
		return {
			draft: { enabled: false, model: DEFAULT_RERANK_MODEL, apiKeyEnv: DEFAULT_RERANK_ENV, baseUrl: "", topN: "", timeoutMs: "" },
			unsupportedProvider: null,
		};
	}
	const record = isJsonObject(raw) ? (raw as JsonObject) : null;
	if (record === null) {
		return {
			draft: { enabled: false, model: DEFAULT_RERANK_MODEL, apiKeyEnv: DEFAULT_RERANK_ENV, baseUrl: "", topN: "", timeoutMs: "" },
			unsupportedProvider: null,
		};
	}
	const provider = stringOf(record.provider);
	const topN = numberOf(record.topN);
	const timeoutMs = numberOf(record.timeoutMs);
	return {
		draft: {
			enabled: boolOf(record.enabled) !== false,
			model: stringOf(record.model).length > 0 ? stringOf(record.model) : DEFAULT_RERANK_MODEL,
			apiKeyEnv: stringOf(record.apiKeyEnv).length > 0 ? stringOf(record.apiKeyEnv) : DEFAULT_RERANK_ENV,
			baseUrl: stringOf(record.baseUrl),
			topN: topN === null ? "" : String(topN),
			timeoutMs: timeoutMs === null ? "" : String(timeoutMs),
		},
		unsupportedProvider: provider.length > 0 && provider !== RERANK_PROVIDER ? provider : null,
	};
}

/** Semantic identity of a rerank draft; trims values and parses numerics so a
 * whitespace-only or "01" vs "1" difference never re-saves. */
function rerankKey(draft: RerankDraft): string {
	return JSON.stringify([draft.enabled, draft.model.trim(), draft.apiKeyEnv.trim(), draft.baseUrl.trim(), numericKey(draft.topN), numericKey(draft.timeoutMs)]);
}

function RerankerPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const parsed = useMemo(() => rerankDraftFrom(snapshot), [snapshot]);
	const savedDraft = parsed.draft;
	const [draft, setDraft] = useState<RerankDraft>(savedDraft);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const [resetting, setResetting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const dirty = rerankKey(draft) !== rerankKey(savedDraft);
	const immediateRef = useRef(false);
	const lastSavedKeyRef = useRef(rerankKey(savedDraft));
	const configRef = useLatestConfig(snapshot);

	const autoSave = useAutoSave<RerankDraft>({
		key: rerankKey,
		perform: async (value) => {
			// Diff against the freshest known config: a queued re-enable can drain
			// before the previous disable's snapshot re-rendered, and a `false`
			// marker cannot hold leaves.
			const raw = getAt(configRef.current, ["rerank"]);
			// Disabling is an intended block transition: store `false`, not leaves.
			if (!value.enabled) {
				if (raw === false || raw === undefined) {
					setError(null);
					return;
				}
				try {
					const next = await autorag.settings.configSet(["rerank"], false);
					configRef.record(next.config);
					onSaved(next);
					setDraftLatest(rerankDraftFrom(next).draft);
					setError(null);
				} catch (cause) {
					setError(errorMessage(cause));
					throw cause;
				}
				return;
			}
			const problems: string[] = [];
			const model = value.model.trim();
			if (model.length === 0) problems.push("Rerank model wire id is required.");
			const apiKeyEnv = value.apiKeyEnv.trim();
			if (apiKeyEnv.length > 0 && !ENV_NAME_PATTERN.test(apiKeyEnv)) problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
			const topNText = value.topN.trim();
			const topN = parsePositiveInt(topNText);
			if (topNText.length > 0 && topN === null) problems.push("Top N must be a positive integer.");
			const timeoutText = value.timeoutMs.trim();
			const timeoutMs = parsePositiveInt(timeoutText);
			if (timeoutText.length > 0 && timeoutMs === null) problems.push("Timeout must be a positive integer.");
			if (problems.length > 0) {
				const message = problems.join(" ");
				setError(message);
				throw new Error(message);
			}
			const record = isJsonObject(raw) ? (raw as JsonObject) : null;
			if (record === null) {
				// Enabling is an intended block transition: `false` cannot hold leaves.
				const rerank: Record<string, JsonValue> = { provider: RERANK_PROVIDER, model };
				if (apiKeyEnv.length > 0) rerank.apiKeyEnv = apiKeyEnv;
				if (value.baseUrl.trim().length > 0) rerank.baseUrl = value.baseUrl.trim();
				if (topN !== null) rerank.topN = topN;
				if (timeoutMs !== null) rerank.timeoutMs = timeoutMs;
				try {
					const next = await autorag.settings.configSet(["rerank"], rerank);
					configRef.record(next.config);
					onSaved(next);
					setDraftLatest(rerankDraftFrom(next).draft);
					setError(null);
				} catch (cause) {
					setError(errorMessage(cause));
					throw cause;
				}
				return;
			}
			// Enabled object: write only the leaves this panel owns so unknown
			// rerank leaves survive.
			const updates: AutoRagConfigUpdate[] = [];
			const put = (leaf: string, desired: string, removable: boolean): void => {
				const current = stringOf(record[leaf]);
				if (desired === current) return;
				if (desired.length === 0 && removable) updates.push({ path: ["rerank", leaf], remove: true });
				else updates.push({ path: ["rerank", leaf], value: desired });
			};
			put("provider", RERANK_PROVIDER, false);
			put("model", model, false);
			put("apiKeyEnv", apiKeyEnv, true);
			put("baseUrl", value.baseUrl.trim(), true);
			const putNumber = (leaf: string, desired: number | null): void => {
				const current = numberOf(record[leaf]);
				if (desired === null) {
					if (current !== null) updates.push({ path: ["rerank", leaf], remove: true });
					return;
				}
				if (current === desired) return;
				updates.push({ path: ["rerank", leaf], value: desired });
			};
			putNumber("topN", topN);
			putNumber("timeoutMs", timeoutMs);
			if (boolOf(record.enabled) === false) updates.push({ path: ["rerank", "enabled"], value: true });
			if (updates.length === 0) {
				setError(null);
				return;
			}
			try {
				const next = await autorag.settings.configPatch(updates);
				configRef.record(next.config);
				onSaved(next);
				setError(null);
			} catch (cause) {
				setError(errorMessage(cause));
				throw cause;
			}
		},
	});
	const { queue: queueSave, flush: flushSave, cancel: cancelSave, drain: drainSave, busy: autoSaving } = autoSave;
	const setDraftLatest = (next: RerankDraft): void => {
		draftRef.current = next;
		setDraft(next);
	};

	// Adopt a new snapshot only while the draft still matches the previously saved
	// value, so external updates apply but a local edit is never clobbered.
	useEffect(() => {
		const previousSavedKey = lastSavedKeyRef.current;
		lastSavedKeyRef.current = rerankKey(savedDraft);
		if (rerankKey(draft) === previousSavedKey) setDraftLatest(savedDraft);
	}, [savedDraft]);

	// Selects/toggles flush immediately; text/number debounce; a draft back at the
	// saved value cancels any stale queued write.
	useEffect(() => {
		const immediate = immediateRef.current;
		immediateRef.current = false;
		if (!dirty) {
			if (autoSaving) queueSave(draft);
			else cancelSave();
			return;
		}
		if (immediate) flushSave(draft);
		else queueSave(draft);
	}, [draft, dirty, autoSaving, cancelSave, flushSave, queueSave]);

	function editText(mutate: (current: RerankDraft) => RerankDraft): void {
		const next = mutate(draftRef.current);
		setDraftLatest(next);
		queueSave(next);
	}

	function editNow(mutate: (current: RerankDraft) => RerankDraft): void {
		immediateRef.current = true;
		const next = mutate(draftRef.current);
		setDraftLatest(next);
		flushSave(next);
	}

	async function reset(): Promise<void> {
		cancelSave();
		await drainSave();
		setResetting(true);
		setError(null);
		try {
			const next = await autorag.settings.configRemove(["rerank"]);
			configRef.record(next.config);
			onSaved(next);
			setDraftLatest(rerankDraftFrom(next).draft);
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setResetting(false);
		}
	}

	return (
		<>
			<div className="linear-header">
				<h2 className="linear-title">Reranker Configuration</h2>
				<p className="linear-desc">
					Reorders merged retrieval evidence after dedup. v2.7 supports the OpenRouter rerank provider only; it can route to a
					Cohere-compatible endpoint via a base URL override.
				</p>
			</div>

			{snapshot.error !== null ? (
				<div className="settings-error" role="alert">
					{snapshot.error}
				</div>
			) : null}
			{error !== null ? (
				<div className="settings-error" role="alert">
					{error}
				</div>
			) : null}
			{parsed.unsupportedProvider !== null ? (
				<div className="settings-error" role="alert">
					The config specifies an unsupported rerank provider “{parsed.unsupportedProvider}”. v2.7 only supports openrouter; saving will
					restore openrouter.
				</div>
			) : null}

			<div className="linear-section-title">Reranking</div>
			<Row name="Enabled" hint="When off, the config stores rerank: false and the stage is skipped.">
				<Switch checked={draft.enabled} onChange={() => editNow((current) => ({ ...current, enabled: !current.enabled }))} ariaLabel="Reranking enabled" />
			</Row>
			{draft.enabled ? (
				<>
					<Row name="Provider" hint="v2.7 provider support: OpenRouter only.">
						<SelectField
							ariaLabel="Rerank provider"
							value={RERANK_PROVIDER}
							options={[{ value: RERANK_PROVIDER, label: "OpenRouter (openrouter)" }]}
							onChange={() => undefined}
						/>
					</Row>
					<Row name="Model wire id" hint="OpenRouter wire model id; Voyage or Cohere rerank models.">
						<>
							<datalist id="rerank-model-options">
								{RERANK_MODEL_CHOICES.map((model) => (
									<option key={model} value={model} />
								))}
							</datalist>
							<TextField
								ariaLabel="Rerank model wire id"
								list="rerank-model-options"
								placeholder={DEFAULT_RERANK_MODEL}
								value={draft.model}
								onChange={(value) => editText((current) => ({ ...current, model: value }))}
								onBlur={() => flushSave()}
							/>
						</>
					</Row>
					<Row name="Base URL" hint="Optional override, e.g. a Cohere-compatible /v1/rerank gateway. Blank uses OpenRouter.">
						<TextField ariaLabel="Rerank base URL" placeholder="https://…" value={draft.baseUrl} onChange={(value) => editText((current) => ({ ...current, baseUrl: value }))} onBlur={() => flushSave()} />
					</Row>
					<Row name="API key env var" hint="Env var holding the OpenRouter key; defaults to OPENROUTER_API_KEY.">
						<TextField
							ariaLabel="Rerank API key env var"
							placeholder={DEFAULT_RERANK_ENV}
							value={draft.apiKeyEnv}
							onChange={(value) => editText((current) => ({ ...current, apiKeyEnv: value }))}
							onBlur={() => flushSave()}
						/>
					</Row>
					<Row name="Top N" hint="Return only the top N merged results; blank reorders all.">
						<TextField ariaLabel="Rerank top N" type="number" placeholder="(all results)" value={draft.topN} onChange={(value) => editText((current) => ({ ...current, topN: value }))} onBlur={() => flushSave()} />
					</Row>
					<Row name="Timeout (ms)" hint="Per-request timeout in milliseconds; blank uses the SDK default.">
						<TextField ariaLabel="Rerank timeout" type="number" placeholder="(default)" value={draft.timeoutMs} onChange={(value) => editText((current) => ({ ...current, timeoutMs: value }))} onBlur={() => flushSave()} />
					</Row>

					<div className="linear-section-title">Credentials</div>
					<CredentialField
						envName={draft.apiKeyEnv.trim().length > 0 ? draft.apiKeyEnv.trim() : DEFAULT_RERANK_ENV}
						hint="Stored encrypted and injected as the reranker API key env var; never written to the config."
					/>
				</>
			) : null}

			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={resetting || autoSaving} onClick={() => void reset()}>Remove rerank settings</button>
				{resetting || autoSaving ? <span className="settings-inline-status">Saving…</span> : <span className="settings-inline-status">Changes save automatically</span>}
			</div>
		</>
	);
}

/* ============================================================== export === */

export function ModelSettings({
	kind,
	snapshot,
	onSaved,
}: {
	readonly kind: ModelSettingsKind;
	readonly snapshot: AutoRagConfigSnapshot;
	readonly onSaved: (snapshot: AutoRagConfigSnapshot) => void;
}): ReactElement {
	if (kind === "llm") return <LlmPanel snapshot={snapshot} onSaved={onSaved} />;
	if (kind === "embedding") return <EmbeddingPanel snapshot={snapshot} onSaved={onSaved} />;
	return <RerankerPanel snapshot={snapshot} onSaved={onSaved} />;
}
