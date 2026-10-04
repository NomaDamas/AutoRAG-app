/**
 * Model configuration panels for Settings → Models.
 *
 * Three provider-centric panels edit the shared AutoRAG config (the same file
 * the CLI/TUI resolve) through narrow `configSet`/`configRemove` writes:
 *
 * - `llm`       → `model` (Pi runtime catalog + custom provider/endpoint)
 * - `embedding` → `minSync.embedder` (built-in local profiles or a local HTTP
 *                 endpoint; never a remote corpus embedder)
 * - `reranker`  → `rerank` (OpenRouter is the only provider supported by v2.7)
 *
 * Secrets never live in the config: `apiKeyEnv` is an env-var name, and the
 * secret itself goes through the encrypted credential bridge keyed by that
 * env var. The bridge returns only stored/env presence, never the value.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type {
	AutoRagConfigSnapshot,
	ConfigRefreshResult,
	ConfiguredModelSnapshot,
	JsonObject,
	JsonValue,
	ModelCatalogEntry,
	ModelCatalogProvider,
	ModelCatalogSnapshot,
	ProviderCredentialStatus,
} from "../../../../shared/settings-contract";
import { isJsonObject } from "../../../../shared/settings-contract";
import { Switch } from "../primitives/Switch";

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
}: {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly ariaLabel: string;
	readonly placeholder?: string | undefined;
	readonly type?: string | undefined;
	readonly list?: string | undefined;
	readonly disabled?: boolean | undefined;
	readonly width?: number | undefined;
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
	readonly reasoning: boolean;
	readonly inputText: boolean;
	readonly inputImage: boolean;
	readonly contextWindow: string;
	readonly maxTokens: string;
}

function llmDraftFrom(snapshot: AutoRagConfigSnapshot): LlmDraft {
	const model = asRecord(getAt(snapshot.config, ["model"]));
	const rawInput = model?.input;
	const inputs = Array.isArray(rawInput) ? rawInput.filter((value): value is string => typeof value === "string") : [];
	const contextWindow = model ? numberOf(model.contextWindow) : null;
	const maxTokens = model ? numberOf(model.maxTokens) : null;
	return {
		provider: model ? stringOf(model.provider) : "",
		id: model ? stringOf(model.id) : "",
		name: model ? stringOf(model.name) : "",
		api: model ? stringOf(model.api) : "",
		baseUrl: model ? stringOf(model.baseUrl) : "",
		apiKeyEnv: model ? stringOf(model.apiKeyEnv) : "",
		reasoning: model ? boolOf(model.reasoning) === true : false,
		inputText: inputs.length === 0 ? true : inputs.includes("text"),
		inputImage: inputs.includes("image"),
		contextWindow: contextWindow === null ? "" : String(contextWindow),
		maxTokens: maxTokens === null ? "" : String(maxTokens),
	};
}

function LlmPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const signature = useMemo(() => JSON.stringify(snapshot.config), [snapshot.config]);
	const [draft, setDraft] = useState<LlmDraft>(() => llmDraftFrom(snapshot));
	const [catalog, setCatalog] = useState<ModelCatalogSnapshot | null>(null);
	const [resolved, setResolved] = useState<ConfiguredModelSnapshot | null>(null);
	const [credentials, setCredentials] = useState<readonly ProviderCredentialStatus[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setDraft(llmDraftFrom(snapshot));
	}, [signature, snapshot]);

	const loadCatalog = useCallback(async (): Promise<void> => {
		try {
			setCatalog(await autorag.settings.modelsCatalog());
		} catch (cause) {
			setCatalog({ error: errorMessage(cause), providers: [] });
		}
	}, []);

	const loadResolved = useCallback(async (): Promise<void> => {
		try {
			setResolved(await autorag.settings.modelsResolve());
		} catch (cause) {
			setResolved({ configPath: snapshot.configPath, configExists: snapshot.configExists, error: errorMessage(cause), model: null });
		}
	}, [snapshot.configExists, snapshot.configPath]);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	useEffect(() => {
		void loadResolved();
	}, [loadResolved]);

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
	const resolvedError = resolved?.error ?? null;

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
		setDraft((current) => ({
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
		setDraft((current) => ({
			...current,
			provider: model.provider,
			id: model.id,
			name: model.name,
			api: isAllowedAgentApi(model.api) ? model.api : "",
		}));
	}

	async function commit(path: readonly string[], value: JsonValue): Promise<boolean> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configSet(path, value));
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function save(): Promise<void> {
		const provider = draft.provider.trim();
		const id = draft.id.trim();
		const problems: string[] = [];
		if (provider.length === 0) problems.push("Provider is required.");
		if (id.length === 0) problems.push("Model id is required.");
		if (draft.apiKeyEnv.trim().length > 0 && !ENV_NAME_PATTERN.test(draft.apiKeyEnv.trim())) {
			problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
		}
		const contextWindow = parsePositiveInt(draft.contextWindow);
		if (draft.contextWindow.trim().length > 0 && contextWindow === null) problems.push("Context window must be a positive integer.");
		const maxTokens = parsePositiveInt(draft.maxTokens);
		if (draft.maxTokens.trim().length > 0 && maxTokens === null) problems.push("Max tokens must be a positive integer.");
		if (problems.length > 0) {
			setError(problems.join(" "));
			return;
		}
		const model: Record<string, JsonValue> = { provider, id };
		if (draft.name.trim().length > 0) model.name = draft.name.trim();
		if (draft.api.trim().length > 0) model.api = draft.api.trim();
		if (draft.baseUrl.trim().length > 0) model.baseUrl = draft.baseUrl.trim();
		if (draft.apiKeyEnv.trim().length > 0) model.apiKeyEnv = draft.apiKeyEnv.trim();
		if (draft.reasoning) model.reasoning = true;
		const inputs: string[] = [];
		if (draft.inputText) inputs.push("text");
		if (draft.inputImage) inputs.push("image");
		if (inputs.length > 0) model.input = inputs;
		if (contextWindow !== null) model.contextWindow = contextWindow;
		if (maxTokens !== null) model.maxTokens = maxTokens;
		if (await commit(["model"], model)) void loadResolved();
	}

	async function reset(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configRemove(["model"]));
			void loadResolved();
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
		}
	}

	return (
		<>
			<div className="linear-header">
				<h2 className="linear-title">LLM Models Configuration</h2>
				<p className="linear-desc">
					The provider and model the AutoRAG agent resolves. Pick a Pi catalog provider/model, or configure a custom provider id and
					endpoint. Writes go to the shared AutoRAG config.
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
									setDraft((current) => ({ ...current, provider: "", id: "", name: "", api: "", baseUrl: "", apiKeyEnv: "" }));
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
								onChange={(value) => setDraft((current) => ({ ...current, provider: value }))}
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
						<TextField ariaLabel="Base URL" placeholder="https://…" value={draft.baseUrl} onChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))} />
					</Row>
					<Row name="API" hint="Optional wire-protocol override; only AutoRAG-recognized protocols can be stored. Catalog models use their own protocol when blank.">
						<SelectField
							ariaLabel="API"
							value={isAllowedAgentApi(draft.api) ? draft.api : ""}
							options={[{ value: "", label: "Catalog / default" }, ...ALLOWED_AGENT_APIS.map((api) => ({ value: api, label: api }))]}
							onChange={(value) => setDraft((current) => ({ ...current, api: value }))}
						/>
					</Row>
					<Row name="API key env var" hint="Env var holding this provider's key; blank defaults to ${PROVIDER}_API_KEY. Reused across models and roles that reference it.">
						<TextField
							ariaLabel="API key env var"
							placeholder={defaultEnvName(draft.provider) || "PROVIDER_API_KEY"}
							value={draft.apiKeyEnv}
							onChange={(value) => setDraft((current) => ({ ...current, apiKeyEnv: value }))}
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
						if (value === "__custom__") setDraft((current) => ({ ...current, id: "", name: "" }));
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
						onChange={(value) => setDraft((current) => ({ ...current, id: value }))}
					/>
				</Row>
			) : null}
			<Row name="Display name" hint="Human-readable label; defaults to the model id when blank.">
				<TextField ariaLabel="Display name" placeholder="(defaults to id)" value={draft.name} onChange={(value) => setDraft((current) => ({ ...current, name: value }))} />
			</Row>
			<Row name="Reasoning model" hint="Advertise reasoning/thinking support for this model.">
				<Switch checked={draft.reasoning} onChange={() => setDraft((current) => ({ ...current, reasoning: !current.reasoning }))} ariaLabel="Reasoning model" />
			</Row>
			<Row name="Accepts text input" hint="Text modality is available to the agent.">
				<Switch checked={draft.inputText} onChange={() => setDraft((current) => ({ ...current, inputText: !current.inputText }))} ariaLabel="Accepts text input" />
			</Row>
			<Row name="Accepts image input" hint="Image modality is available to the agent.">
				<Switch checked={draft.inputImage} onChange={() => setDraft((current) => ({ ...current, inputImage: !current.inputImage }))} ariaLabel="Accepts image input" />
			</Row>
			<Row name="Context window" hint="Tokens the model can attend to; blank uses the catalog/default value.">
				<TextField
					ariaLabel="Context window"
					type="number"
					placeholder="e.g. 200000"
					value={draft.contextWindow}
					onChange={(value) => setDraft((current) => ({ ...current, contextWindow: value }))}
				/>
			</Row>
			<Row name="Max output tokens" hint="Cap on generated tokens; blank uses the catalog/default value.">
				<TextField
					ariaLabel="Max output tokens"
					type="number"
					placeholder="e.g. 8192"
					value={draft.maxTokens}
					onChange={(value) => setDraft((current) => ({ ...current, maxTokens: value }))}
				/>
			</Row>

			<div className="linear-section-title">Credentials</div>
			<CredentialField
				envName={effectiveEnv}
				hint="The secret is stored encrypted and injected as this env var; the config keeps only the env var name. Reused wherever this env var is referenced."
				onChanged={() => {
					void loadResolved();
					void loadCatalog();
					void loadCredentials();
				}}
			/>

			<div className="linear-section-title">Resolved for the agent</div>
			{resolvedError !== null ? (
				<div className="settings-error" role="alert">
					{resolvedError}
				</div>
			) : null}
			{resolved?.model !== null && resolved?.model !== undefined ? (
				<>
					<Row name="Status" hint="Live resolution from the shared AutoRAG config.">
						<span className={`provider-status ${resolved.model.auth.present ? "is-connected" : "is-disconnected"}`}>
							{resolved.model.auth.present ? "Credentials present" : "No credentials"}
						</span>
					</Row>
					<Row name="Provider" hint="Resolved provider namespace.">
						<span className="linear-value">{resolved.model.provider}</span>
					</Row>
					<Row name="Model ID" hint="The id the agent sends to the provider.">
						<span className="linear-value">{resolved.model.modelId}</span>
					</Row>
					<Row name="Display name" hint="Human-readable label for this model.">
						<span className="linear-value">{resolved.model.displayName}</span>
					</Row>
					<Row name="API" hint="Wire protocol the librarian uses.">
						<span className="linear-value">{resolved.model.api}</span>
					</Row>
					<Row name="Base URL" hint="Endpoint the librarian resolves.">
						<span className="linear-value">{resolved.model.baseUrl ?? "—"}</span>
					</Row>
					<Row name="Resolution source" hint="Where the librarian read this identity from.">
						<span className="linear-value">{resolved.model.resolutionSource}</span>
					</Row>
					<Row name="API key" hint="Credential source the agent authenticates with.">
						<span className="linear-value">
							{[resolved.model.auth.source, resolved.model.auth.envName ?? ""].filter((part) => part.length > 0).join(" · ")}
						</span>
					</Row>
				</>
			) : (
				<p className="linear-section-desc">No model is resolved from the shared AutoRAG config; the catalog default applies.</p>
			)}

			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void reset()}>
					Reset to catalog default
				</button>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void save()}>
					{saving ? "Saving…" : "Save model"}
				</button>
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
	readonly queryPrefix: string;
	readonly passagePrefix: string;
}[] = [
	{
		id: "qwen3-embedding-0.6b",
		provider: "Qwen",
		label: "Qwen3-Embedding-0.6B (local runtime)",
		dimension: 1024,
		queryPrefix: "",
		passagePrefix: "",
	},
	{
		id: "embeddinggemma-300m",
		provider: "Google",
		label: "EmbeddingGemma-300M (local runtime)",
		dimension: 768,
		queryPrefix: "task: search result | query: ",
		passagePrefix: "title: none | text: ",
	},
];

interface EmbedDraft {
	readonly mode: EmbedMode;
	readonly profile: "qwen3-embedding-0.6b" | "embeddinggemma-300m";
	readonly id: string;
	readonly baseUrl: string;
	readonly apiKeyEnv: string;
	readonly dimension: string;
	readonly queryPrefix: string;
	readonly passagePrefix: string;
	readonly timeoutMs: string;
	readonly batchSize: string;
	readonly maxRetries: string;
	readonly maxConcurrent: string;
}

function embedDraftFrom(snapshot: AutoRagConfigSnapshot): EmbedDraft {
	const embedder = asRecord(getAt(snapshot.config, ["minSync", "embedder"]));
	const profileRaw = embedder ? stringOf(embedder.profile) : "";
	const profile = profileRaw === "embeddinggemma-300m" ? "embeddinggemma-300m" : "qwen3-embedding-0.6b";
	const preset = EMBED_PROFILES.find((item) => item.id === profile) ?? EMBED_PROFILES[0]!;
	const baseUrl = embedder ? stringOf(embedder.baseUrl) : "";
	const mode: EmbedMode = baseUrl.trim().length > 0 ? "endpoint" : "profile";
	const dimension = embedder ? numberOf(embedder.dimension) : null;
	const timeoutMs = embedder ? numberOf(embedder.timeoutMs) : null;
	const batchSize = embedder ? numberOf(embedder.batchSize) : null;
	const maxRetries = embedder ? numberOf(embedder.maxRetries) : null;
	const maxConcurrent = embedder ? numberOf(embedder.maxConcurrent) : null;
	return {
		mode,
		profile,
		id: embedder ? stringOf(embedder.id) : "",
		baseUrl,
		apiKeyEnv: embedder ? stringOf(embedder.apiKeyEnv) : "",
		dimension: dimension === null ? String(preset.dimension) : String(dimension),
		queryPrefix: embedder && stringOf(embedder.queryPrefix).length > 0 ? stringOf(embedder.queryPrefix) : "",
		passagePrefix: embedder && stringOf(embedder.passagePrefix).length > 0 ? stringOf(embedder.passagePrefix) : "",
		timeoutMs: timeoutMs === null ? "" : String(timeoutMs),
		batchSize: batchSize === null ? "" : String(batchSize),
		maxRetries: maxRetries === null ? "" : String(maxRetries),
		maxConcurrent: maxConcurrent === null ? "" : String(maxConcurrent),
	};
}

function EmbeddingPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const signature = useMemo(() => JSON.stringify(snapshot.config), [snapshot.config]);
	const [draft, setDraft] = useState<EmbedDraft>(() => embedDraftFrom(snapshot));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [refreshResult, setRefreshResult] = useState<ConfigRefreshResult | null>(null);
	const [refreshError, setRefreshError] = useState<string | null>(null);

	useEffect(() => {
		setDraft(embedDraftFrom(snapshot));
	}, [signature, snapshot]);

	const saved = useMemo(() => embedDraftFrom(snapshot), [signature, snapshot]);
	const identityChanged =
		draft.mode !== saved.mode ||
		draft.profile !== saved.profile ||
		draft.id.trim() !== saved.id.trim() ||
		draft.baseUrl.trim() !== saved.baseUrl.trim() ||
		draft.dimension !== saved.dimension;

	async function commit(path: readonly string[], value: JsonValue): Promise<boolean> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configSet(path, value));
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			setSaving(false);
		}
	}

	function selectMode(value: string): void {
		if (value === "endpoint") {
			setDraft((current) => ({ ...current, mode: "endpoint", profile: "qwen3-embedding-0.6b" }));
			return;
		}
		const profile = EMBED_PROFILES.find((item) => item.id === value) ?? EMBED_PROFILES[0]!;
		setDraft((current) => ({
			...current,
			mode: "profile",
			profile: profile.id,
			id: "",
			baseUrl: "",
			apiKeyEnv: "",
			dimension: String(profile.dimension),
			queryPrefix: profile.queryPrefix,
			passagePrefix: profile.passagePrefix,
		}));
	}

	async function save(): Promise<void> {
		const problems: string[] = [];
		const id = draft.id.trim();
		const baseUrl = draft.baseUrl.trim();
		if (draft.mode === "endpoint") {
			if (id.length === 0) problems.push("Embedder id is required for a local endpoint.");
			if (baseUrl.length === 0) problems.push("Endpoint base URL is required for a local endpoint.");
		}
		if (draft.apiKeyEnv.trim().length > 0 && !ENV_NAME_PATTERN.test(draft.apiKeyEnv.trim())) {
			problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
		}
		const dimension = parsePositiveInt(draft.dimension);
		if (draft.dimension.trim().length > 0 && dimension === null) problems.push("Dimension must be a positive integer.");
		const numeric: readonly { readonly key: "timeoutMs" | "batchSize" | "maxRetries" | "maxConcurrent"; readonly label: string }[] = [
			{ key: "timeoutMs", label: "Timeout" },
			{ key: "batchSize", label: "Batch size" },
			{ key: "maxRetries", label: "Max retries" },
			{ key: "maxConcurrent", label: "Max concurrency" },
		];
		const parsed: Record<string, number | null> = {};
		for (const field of numeric) {
			const value = parsePositiveInt(draft[field.key]);
			if (draft[field.key].trim().length > 0 && value === null) problems.push(`${field.label} must be a positive integer.`);
			parsed[field.key] = value;
		}
		if (problems.length > 0) {
			setError(problems.join(" "));
			return;
		}
		const embedder: Record<string, JsonValue> = {};
		if (draft.mode === "profile") embedder.profile = draft.profile;
		else {
			embedder.id = id;
			embedder.baseUrl = baseUrl;
		}
		if (draft.apiKeyEnv.trim().length > 0) embedder.apiKeyEnv = draft.apiKeyEnv.trim();
		if (dimension !== null) embedder.dimension = dimension;
		if (draft.queryPrefix.length > 0) embedder.queryPrefix = draft.queryPrefix;
		if (draft.passagePrefix.length > 0) embedder.passagePrefix = draft.passagePrefix;
		for (const field of numeric) {
			const value = parsed[field.key];
			if (value !== null && value !== undefined) embedder[field.key] = value;
		}
		await commit(["minSync", "embedder"], embedder);
	}

	async function reindex(): Promise<void> {
		setRefreshing(true);
		setRefreshError(null);
		try {
			setRefreshResult(await autorag.settings.configRefresh(["minsync"]));
		} catch (cause) {
			setRefreshResult(null);
			setRefreshError(errorMessage(cause));
		} finally {
			setRefreshing(false);
		}
	}

	async function reset(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configRemove(["minSync", "embedder"]));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
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

			{identityChanged ? (
				<div className="settings-error" role="alert" style={{ borderColor: "var(--warn-border, var(--border-strong))", background: "var(--warn-bg-soft, var(--bg-input))", color: "var(--warn-text, var(--text-primary))" }}>
					Changing the embedding identity (provider/profile, endpoint, id, or dimension) forces a full MinSync reindex before
					existing vectors can be reused.
				</div>
			) : null}

			{draft.mode === "profile" ? (
				<>
					<div className="linear-section-title">Profile</div>
					<Row name="Model profile" hint="Embedding identity includes provider, model revision, dimension, prefixes, and runtime build.">
						<span className="linear-value">
							{selectedPreset.provider} · {selectedPreset.id}
						</span>
					</Row>
				</>
			) : (
				<>
					<div className="linear-section-title">Local Endpoint</div>
					<Row name="Embedder id" hint="Endpoint embedder id, e.g. native:Qwen/Qwen3-Embedding-0.6B.">
						<TextField ariaLabel="Embedder id" placeholder="native:model/id" value={draft.id} onChange={(value) => setDraft((current) => ({ ...current, id: value }))} />
					</Row>
					<Row name="Base URL" hint="Loopback HTTP endpoint that serves embeddings. Non-loopback URLs are rejected.">
						<TextField ariaLabel="Embedder base URL" placeholder="http://127.0.0.1:…" value={draft.baseUrl} onChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))} />
					</Row>
					<Row name="API key env var" hint="Optional env var holding the endpoint key. The secret is stored encrypted below.">
						<TextField
							ariaLabel="Embedder API key env var"
							placeholder="EMBEDDER_API_KEY"
							value={draft.apiKeyEnv}
							onChange={(value) => setDraft((current) => ({ ...current, apiKeyEnv: value }))}
						/>
					</Row>
				</>
			)}

			<div className="linear-section-title">Advanced</div>
			<Row name="Dimension" hint="Vector dimension; must match the embedder output or reuse is refused.">
				<TextField ariaLabel="Embedding dimension" type="number" placeholder="1024" value={draft.dimension} onChange={(value) => setDraft((current) => ({ ...current, dimension: value }))} />
			</Row>
			<Row name="Query prefix" hint="Prepended to query text; blank uses the profile default.">
				<TextField ariaLabel="Query prefix" placeholder="(profile default)" value={draft.queryPrefix} onChange={(value) => setDraft((current) => ({ ...current, queryPrefix: value }))} />
			</Row>
			<Row name="Passage prefix" hint="Prepended to indexed passages; blank uses the profile default.">
				<TextField ariaLabel="Passage prefix" placeholder="(profile default)" value={draft.passagePrefix} onChange={(value) => setDraft((current) => ({ ...current, passagePrefix: value }))} />
			</Row>
			<Row name="Timeout (ms)" hint="Per-request timeout in milliseconds.">
				<TextField ariaLabel="Embedding timeout" type="number" placeholder="(default)" value={draft.timeoutMs} onChange={(value) => setDraft((current) => ({ ...current, timeoutMs: value }))} />
			</Row>
			<Row name="Batch size" hint="Texts sent per embedding request.">
				<TextField ariaLabel="Embedding batch size" type="number" placeholder="(default)" value={draft.batchSize} onChange={(value) => setDraft((current) => ({ ...current, batchSize: value }))} />
			</Row>
			<Row name="Max retries" hint="Retries per embedding request.">
				<TextField ariaLabel="Embedding max retries" type="number" placeholder="(default)" value={draft.maxRetries} onChange={(value) => setDraft((current) => ({ ...current, maxRetries: value }))} />
			</Row>
			<Row name="Max concurrency" hint="Concurrent embedding requests.">
				<TextField ariaLabel="Embedding max concurrency" type="number" placeholder="(default)" value={draft.maxConcurrent} onChange={(value) => setDraft((current) => ({ ...current, maxConcurrent: value }))} />
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
			<button type="button" className="linear-btn" disabled={refreshing || saving} onClick={() => void reindex()}>
				{refreshing ? "Reindexing…" : "Reindex MinSync vectors"}
			</button>

			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void reset()}>
					Reset to defaults
				</button>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void save()}>
					{saving ? "Saving…" : "Save embedder"}
				</button>
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

function RerankerPanel({ snapshot, onSaved }: { readonly snapshot: AutoRagConfigSnapshot; readonly onSaved: (next: AutoRagConfigSnapshot) => void }): ReactElement {
	const signature = useMemo(() => JSON.stringify(snapshot.config), [snapshot.config]);
	const parsed = useMemo(() => rerankDraftFrom(snapshot), [signature, snapshot]);
	const [draft, setDraft] = useState<RerankDraft>(parsed.draft);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setDraft(rerankDraftFrom(snapshot).draft);
	}, [signature, snapshot]);

	async function commit(path: readonly string[], value: JsonValue): Promise<boolean> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configSet(path, value));
			return true;
		} catch (cause) {
			setError(errorMessage(cause));
			return false;
		} finally {
			setSaving(false);
		}
	}

	async function save(): Promise<void> {
		if (!draft.enabled) {
			await commit(["rerank"], false);
			return;
		}
		const problems: string[] = [];
		const model = draft.model.trim();
		if (model.length === 0) problems.push("Rerank model wire id is required.");
		if (draft.apiKeyEnv.trim().length > 0 && !ENV_NAME_PATTERN.test(draft.apiKeyEnv.trim())) {
			problems.push("API key env var must match /^[A-Za-z_][A-Za-z0-9_]*$/.");
		}
		const topN = parsePositiveInt(draft.topN);
		if (draft.topN.trim().length > 0 && topN === null) problems.push("Top N must be a positive integer.");
		const timeoutMs = parsePositiveInt(draft.timeoutMs);
		if (draft.timeoutMs.trim().length > 0 && timeoutMs === null) problems.push("Timeout must be a positive integer.");
		if (problems.length > 0) {
			setError(problems.join(" "));
			return;
		}
		const rerank: Record<string, JsonValue> = { provider: RERANK_PROVIDER, model };
		if (draft.apiKeyEnv.trim().length > 0) rerank.apiKeyEnv = draft.apiKeyEnv.trim();
		if (draft.baseUrl.trim().length > 0) rerank.baseUrl = draft.baseUrl.trim();
		if (topN !== null) rerank.topN = topN;
		if (timeoutMs !== null) rerank.timeoutMs = timeoutMs;
		await commit(["rerank"], rerank);
	}

	async function reset(): Promise<void> {
		setSaving(true);
		setError(null);
		try {
			onSaved(await autorag.settings.configRemove(["rerank"]));
		} catch (cause) {
			setError(errorMessage(cause));
		} finally {
			setSaving(false);
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
				<Switch checked={draft.enabled} onChange={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))} ariaLabel="Reranking enabled" />
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
								onChange={(value) => setDraft((current) => ({ ...current, model: value }))}
							/>
						</>
					</Row>
					<Row name="Base URL" hint="Optional override, e.g. a Cohere-compatible /v1/rerank gateway. Blank uses OpenRouter.">
						<TextField ariaLabel="Rerank base URL" placeholder="https://…" value={draft.baseUrl} onChange={(value) => setDraft((current) => ({ ...current, baseUrl: value }))} />
					</Row>
					<Row name="API key env var" hint="Env var holding the OpenRouter key; defaults to OPENROUTER_API_KEY.">
						<TextField
							ariaLabel="Rerank API key env var"
							placeholder={DEFAULT_RERANK_ENV}
							value={draft.apiKeyEnv}
							onChange={(value) => setDraft((current) => ({ ...current, apiKeyEnv: value }))}
						/>
					</Row>
					<Row name="Top N" hint="Return only the top N merged results; blank reorders all.">
						<TextField ariaLabel="Rerank top N" type="number" placeholder="(all results)" value={draft.topN} onChange={(value) => setDraft((current) => ({ ...current, topN: value }))} />
					</Row>
					<Row name="Timeout (ms)" hint="Per-request timeout in milliseconds; blank uses the SDK default.">
						<TextField ariaLabel="Rerank timeout" type="number" placeholder="(default)" value={draft.timeoutMs} onChange={(value) => setDraft((current) => ({ ...current, timeoutMs: value }))} />
					</Row>

					<div className="linear-section-title">Credentials</div>
					<CredentialField
						envName={draft.apiKeyEnv.trim().length > 0 ? draft.apiKeyEnv.trim() : DEFAULT_RERANK_ENV}
						hint="Stored encrypted and injected as the reranker API key env var; never written to the config."
					/>
				</>
			) : null}

			<div className="settings-source-desc__actions" style={{ marginTop: 16 }}>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void reset()}>
					Remove rerank settings
				</button>
				<button type="button" className="linear-btn" disabled={saving} onClick={() => void save()}>
					{saving ? "Saving…" : "Save reranker"}
				</button>
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
