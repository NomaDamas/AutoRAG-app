import { existsSync } from "node:fs";
import { readRawConfigObject, resolveConfigPath } from "@autorag/librarian/core";
import type { AutoRagConfigService } from "./autorag-config-service";
import type { DataSourceStatusService } from "./datasource-status";
import type { EmbeddingSettingsService } from "./settings-service";
import { ensureEmbeddingForConfig } from "./embedding-daemon";
import { readDazziPlanCredential } from "./dazzi-plan-credential";
import type { ProviderCredentialService } from "./provider-credentials";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_ACCOUNT_BASE_URL } from "../shared/account-contract";
import { isJsonObject } from "../shared/settings-contract";
import { readAppIndexing } from "./app-indexing";
import { t, tByName } from "../shared/i18n/core";
import { localSpecMessage, type LocalSpecVerdict } from "../shared/local-embedding-spec";
import type {
	AutoRagConfigUpdate,
	ByokEmbeddingServer,
	DataSourceRow,
	DataSourceSyncResult,
	EmbeddingAdoption,
	EmbeddingChangeRequest,
	EmbeddingChangeResult,
	EmbeddingProfile,
	EmbeddingSettingsSnapshot,
	EmbeddingSourceStatus,
	JsonObject,
} from "../shared/settings-contract";

/**
 * Settings > Models > 문서 이해 (the global corpus embedder).
 *
 * `minSync.embedder` is the one setting the app agent, `autorag` refresh, and
 * the AutoRAGLite runtime all resolve. Changing it must reach every configured
 * datasource that can adopt the new model — not just MinSync — so this service
 * validates the choice, reports exactly which sources can and cannot follow,
 * writes the shared config, and then runs the real per-source index/rebuild
 * pipelines.
 *
 * Nothing is written into a datasource for the embedder: the librarian points
 * mailcrawl, lazykatok, discrawl and the chat sidecars at the one endpoint
 * `minSync.embedder` selects (the `minsync serve` server the app runs, or the
 * server the user configured) every time they index or search.
 *
 * Honesty rules enforced here:
 * - no remote egress: a local server must be loopback, and is probed for real
 *   vectors before any write (no fake success).
 */
export interface EmbeddingSettingsDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly config: AutoRagConfigService;
	readonly dataSources: DataSourceStatusService;
	/** Where the embedding API key of the Dazzi cloud and of the user's own server is kept (the OS keyring). */
	readonly credentials: ProviderCredentialService;
	/** Whether the on-device model's weights are downloaded; choosing the local profile needs them. */
	readonly modelReady: () => boolean;
	/** Whether this machine meets the minimum spec for the on-device model (the "spec guard"). */
	readonly localSpec: () => Promise<LocalSpecVerdict>;
	/** Test seam for the server probe. */
	readonly fetchImpl?: typeof fetch;
	/**
	 * Whether the signed-in plan includes cloud embeddings (Pro and Max): `null` while signed out or before the
	 * server confirmed the plan (the sign-in check reports that), `false` for Free and Air.
	 */
	readonly cloudEmbeddings: () => Promise<boolean | null>;
}

/** The model is fixed: Qwen3-Embedding-0.6B at 1024 dimensions, whichever server runs it. Changing it is not offered. */
const MODEL = "Qwen/Qwen3-Embedding-0.6B";
const DIMENSION = 1024;
const LOCAL_ID = `native:${MODEL}`;
/** The hosted model the Dazzi cloud serves for the same Qwen3-Embedding-0.6B. */
const DAZZI_MODEL = "qwen/qwen3-embedding-0.6b";
const DAZZI_KEY_ENV = "OPENAI_API_KEY";
const BYOK_KEY_ENV = "AUTORAG_EMBEDDING_API_KEY";
const PROBE_TIMEOUT_MS = 30_000;

/** A choice resolved from a request: the profile, and for the user's own server the validated server. */
interface EmbeddingChoice {
	readonly profile: EmbeddingProfile;
	readonly byok?: ByokEmbeddingServer;
}

/** Keyword-only search: nothing is embedded (`appIndexing.semanticSearch: false`). */
const NONE_PROFILE_ID = "none";

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

/** Datasource templates whose read-only sidecar embeds with the shared embedder. */
const SIDECAR_TEMPLATES: Record<string, true> = { kakao: true, slack: true, telegram: true, whatsapp: true };

/**
 * The embedding choices. The model is the same in all of them (Qwen3-Embedding-0.6B, 1024 dimensions); what
 * differs is where it runs: nowhere (keyword-only), on this computer through MinSync, in the Dazzi cloud, or on
 * a server the user runs or pays for.
 */
export function embeddingProfiles(spec: LocalSpecVerdict = { eligible: true }, cloudEmbeddings: boolean | null = true): readonly EmbeddingProfile[] {
	const fixed = { model: MODEL, dimension: DIMENSION, queryPrefix: "", passagePrefix: "" } as const;
	return [
		{
			id: NONE_PROFILE_ID,
			kind: "none",
			label: t("main.embedding.profiles.none.label"),
			description: t("main.embedding.profiles.none.description"),
			model: "",
			dimension: 0,
			queryPrefix: "",
			passagePrefix: "",
			baseUrl: null,
			unavailable: null,
		},
		{
			id: "local",
			kind: "local",
			label: t("main.embedding.profiles.local.label"),
			description: t("main.embedding.profiles.local.description"),
			baseUrl: null,
			unavailable: spec.eligible ? null : localSpecMessage(spec, tByName),
			...fixed,
		},
		{ id: "dazzi", kind: "dazzi", label: t("main.embedding.profiles.dazzi.label"), description: t("main.embedding.profiles.dazzi.description"), baseUrl: DEFAULT_ACCOUNT_BASE_URL, unavailable: cloudEmbeddings === false ? t("main.embedding.profiles.dazzi.planRequired") : null, ...fixed },
		{ id: "byok", kind: "byok", label: t("main.embedding.profiles.byok.label"), description: t("main.embedding.profiles.byok.description"), baseUrl: null, unavailable: null, ...fixed },
	];
}

function findProfile(profileId: string, spec?: LocalSpecVerdict, cloudEmbeddings?: boolean | null): EmbeddingProfile | undefined {
	return embeddingProfiles(spec, cloudEmbeddings).find((profile) => profile.id === profileId);
}

function isLoopbackUrl(value: string): boolean {
	try {
		return LOOPBACK_HOSTS[new URL(value).hostname.toLowerCase()] === true;
	} catch {
		return false;
	}
}

/** The user's own server, or the reason it cannot be used. */
function checkByok(server: ByokEmbeddingServer | undefined): string | null {
	if (server === undefined) return t("main.embedding.errors.serverRequired");
	let url: URL;
	try {
		url = new URL(server.baseUrl);
	} catch {
		return t("main.embedding.errors.badUrl");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return t("main.embedding.errors.badUrl");
	if (server.protocol !== "openai" && server.protocol !== "tei") return t("main.embedding.errors.badProtocol");
	return null;
}

/** The base URL as the config stores it: no trailing slash, and no `/v1` the route adds itself. */
function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/u, "").replace(/\/v1$/u, "");
}

/** The `minSync.embedder` value the shared config should hold for a choice. */
function deriveEmbedder(choice: EmbeddingChoice, accountBaseUrl: string): JsonObject {
	switch (choice.profile.kind) {
		case "dazzi":
			return { id: `openai:${DAZZI_MODEL}`, baseUrl: accountBaseUrl, dimension: DIMENSION, apiKeyEnv: DAZZI_KEY_ENV };
		case "byok": {
			const server = choice.byok;
			if (server === undefined) return { id: LOCAL_ID, dimension: DIMENSION };
			return {
				id: `${server.protocol}:${MODEL}`,
				baseUrl: normalizeBaseUrl(server.baseUrl),
				dimension: DIMENSION,
				...(isLoopbackUrl(server.baseUrl) && server.apiKey === undefined ? {} : { apiKeyEnv: BYOK_KEY_ENV }),
			};
		}
		default:
			return { id: LOCAL_ID, dimension: DIMENSION };
	}
}

/** Which profile the stored `minSync.embedder` is. A server the config names that is not the Dazzi cloud is the user's own. */
function currentProfileId(embedder: unknown, semantic: boolean, accountBaseUrl: string): string | null {
	if (!semantic) return NONE_PROFILE_ID;
	if (!isJsonObject(embedder)) return null;
	if (embedder.profile !== undefined && embedder.id === undefined) return "local";
	const id = typeof embedder.id === "string" ? embedder.id : "";
	const baseUrl = typeof embedder.baseUrl === "string" ? embedder.baseUrl : "";
	if (baseUrl.length === 0) return id.startsWith("native:") ? "local" : null;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		if (host === new URL(accountBaseUrl).hostname.toLowerCase() && id.startsWith("openai:")) return "dazzi";
	} catch {
		return null;
	}
	return "byok";
}

function adoptionFor(type: string, choice: EmbeddingChoice): { adoption: EmbeddingAdoption; reason: string; action: string | null } {
	if (choice.profile.kind === "none") return { adoption: "not-applicable", reason: t("main.embedding.reasons.keywordOnly"), action: null };
	if (type === "mailcrawl") return { adoption: "native", reason: t("main.embedding.reasons.mailcrawlSharedEmbedder"), action: null };
	if (SIDECAR_TEMPLATES[type] === true) return { adoption: "native", reason: t("main.embedding.reasons.sidecarSharedEmbedder"), action: null };
	switch (type) {
		case "obsidian":
			return { adoption: "native", reason: t("main.embedding.reasons.obsidianSharedEmbedder"), action: null };
		case "discord":
			return { adoption: "propagated", reason: t("main.embedding.reasons.discordPropagated"), action: t("main.embedding.actions.discordConfig") };
		case "github-gist":
			return { adoption: "native", reason: t("main.embedding.reasons.githubGistSharedEmbedder"), action: null };
		case "clawgallery":
			return { adoption: "not-applicable", reason: t("main.embedding.reasons.clawgalleryNotApplicable"), action: null };
		case "lark":
			return { adoption: "not-applicable", reason: t("main.embedding.reasons.larkNotApplicable"), action: null };
		default:
			return { adoption: "not-applicable", reason: t("main.embedding.reasons.defaultNotApplicable"), action: null };
	}
}

function buildPlan(rows: readonly DataSourceRow[], choice: EmbeddingChoice): EmbeddingSourceStatus[] {
	return rows.map((row) => {
		const { adoption, reason, action } = adoptionFor(row.type, choice);
		return { id: row.id, type: row.type, adoption, reason, action };
	});
}

const EMPTY_RESULT = (profileId: string, plan: readonly EmbeddingSourceStatus[] = []): EmbeddingChangeResult => ({
	ok: false,
	applied: false,
	profileId,
	plan,
	written: [],
	rebuilds: [],
	error: null,
});

/** Config values are JSON by construction; present a redacted/read value as a JSON object. */
function asJsonObject(value: unknown): JsonObject {
	return isJsonObject(value) ? (value as JsonObject) : {};
}

/** Read `minSync.embedder` straight from the shared config file. */
function readEmbedder(env: NodeJS.ProcessEnv, cwd: string): unknown {
	const path = resolveConfigPath({ flags: {}, env, cwd }).configPath;
	if (!existsSync(path)) return undefined;
	const raw = readRawConfigObject(path);
	if (!isJsonObject(raw.minSync)) return undefined;
	return raw.minSync.embedder;
}
/** False when the shared config switched semantic search off (keyword-only mode). */
function readSemantic(env: NodeJS.ProcessEnv, cwd: string): boolean {
	const path = resolveConfigPath({ flags: {}, env, cwd }).configPath;
	if (!existsSync(path)) return true;
	return readAppIndexing(readRawConfigObject(path)).semanticSearch;
}

/** The switch itself, or its whole block when it is the block's only setting, so no empty `appIndexing` is left behind. */
function semanticSwitchPath(path: string): string[] {
	const block = existsSync(path) ? readRawConfigObject(path).appIndexing : undefined;
	return isJsonObject(block) && Object.keys(block).every((key) => key === "semanticSearch") ? ["appIndexing"] : ["appIndexing", "semanticSearch"];
}

export function createEmbeddingSettingsService(deps: EmbeddingSettingsDeps): EmbeddingSettingsService {
	const doFetch = deps.fetchImpl ?? fetch;

	const configPath = (): string => resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;
	const accountBaseUrl = (): string => {
		const configured = deps.env.AUTORAG_BASE_URL?.trim();
		return (configured !== undefined && configured.length > 0 ? configured : DEFAULT_ACCOUNT_BASE_URL).replace(/\/+$/u, "");
	};

	const resolveChoice = async (request: EmbeddingChangeRequest): Promise<{ choice: EmbeddingChoice } | { error: string }> => {
		const profile = findProfile(request.profileId, await deps.localSpec(), await deps.cloudEmbeddings());
		if (profile === undefined) return { error: t("main.embedding.errors.unknownProfile", { id: request.profileId }) };
		// The spec guard: a machine below the minimum never gets the on-device model, however the request arrived.
		if (profile.unavailable !== null) return { error: profile.unavailable };
		if (profile.kind !== "byok") return { choice: { profile } };
		const problem = checkByok(request.byok);
		if (problem !== null || request.byok === undefined) return { error: problem ?? t("main.embedding.errors.serverRequired") };
		return { choice: { profile, byok: request.byok } };
	};

	/** The key a request would send: what the user typed, else the one already stored for this slot. */
	const keyFor = (choice: EmbeddingChoice, token: string | null): { readonly env: string | null; readonly value: string | null } => {
		if (choice.profile.kind === "dazzi") return { env: DAZZI_KEY_ENV, value: token };
		if (choice.profile.kind !== "byok") return { env: null, value: null };
		return { env: BYOK_KEY_ENV, value: choice.byok?.apiKey ?? deps.env[BYOK_KEY_ENV] ?? null };
	};

	/** True when sending document text to this choice leaves the computer. */
	const isRemote = (choice: EmbeddingChoice): boolean => choice.profile.kind === "dazzi" || (choice.profile.kind === "byok" && choice.byok !== undefined && !isLoopbackUrl(choice.byok.baseUrl));

	/**
	 * Ask the real server for one Qwen3 vector and check its size. Nothing is invented: any other answer is
	 * reported with what the server said.
	 */
	const probe = async (choice: EmbeddingChoice, key: string | null): Promise<string | null> => {
		const dazzi = choice.profile.kind === "dazzi";
		const server = choice.byok;
		const protocol = dazzi ? "openai" : (server?.protocol ?? "openai");
		const root = dazzi ? accountBaseUrl() : normalizeBaseUrl(server?.baseUrl ?? "");
		const model = dazzi ? DAZZI_MODEL : MODEL;
		const url = protocol === "tei" ? `${root}/embed` : `${root}/v1/embeddings`;
		let response: Response;
		try {
			response = await doFetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
				body: JSON.stringify(protocol === "tei" ? { inputs: ["ping"] } : { model, input: ["ping"] }),
				signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
			});
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		if (response.status === 401 || response.status === 403) return t("main.embedding.errors.unauthorized", { status: response.status });
		if (!response.ok) return t("main.embedding.errors.httpStatus", { status: response.status });
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			return t("main.embedding.errors.badJson");
		}
		const first = protocol === "tei" ? (Array.isArray(parsed) ? parsed[0] : undefined) : isJsonObject(parsed) && Array.isArray(parsed.data) && isJsonObject(parsed.data[0]) ? parsed.data[0].embedding : undefined;
		if (!Array.isArray(first) || first.some((value) => typeof value !== "number")) return t("main.embedding.errors.noVector");
		if (first.length !== DIMENSION) return t("main.embedding.errors.dimensionMismatch", { actual: first.length, expected: DIMENSION });
		return null;
	};

	/** What stops this choice before anything is sent or written, or null. */
	const preflight = async (choice: EmbeddingChoice, request: EmbeddingChangeRequest): Promise<{ readonly error: string | null; readonly key: string | null }> => {
		if (choice.profile.kind === "local" && !deps.modelReady()) return { error: t("main.embedding.errors.modelMissing"), key: null };
		if (choice.profile.kind === "dazzi") {
			const token = await readDazziPlanCredential(deps.env.PI_CODING_AGENT_DIR ?? getAgentDir());
			if (token === null) return { error: t("main.embedding.errors.dazziSignIn"), key: null };
			if (request.acknowledgeRemote !== true) return { error: t("main.embedding.errors.consentRequired"), key: token };
			return { error: await probe(choice, token), key: token };
		}
		if (choice.profile.kind === "byok") {
			if (isRemote(choice) && request.acknowledgeRemote !== true) return { error: t("main.embedding.errors.consentRequired"), key: null };
			const { value } = keyFor(choice, null);
			if (isRemote(choice) && value === null) return { error: t("main.embedding.errors.keyRequired"), key: null };
			return { error: await probe(choice, value), key: value };
		}
		return { error: null, key: null };
	};

	/** Plan result as a snapshot: `current` previews the requested profile, `sources` its adoption. */
	const snapshotFor = async (choice: EmbeddingChoice, error: string | null): Promise<EmbeddingSettingsSnapshot> => {
		const path = configPath();
		const base: EmbeddingSettingsSnapshot = {
			configPath: path,
			configExists: existsSync(path),
			error,
			current: { profileId: choice.profile.id, embedder: choice.profile.kind === "none" ? asJsonObject(readEmbedder(deps.env, deps.cwd)) : deriveEmbedder(choice, accountBaseUrl()) },
			profiles: embeddingProfiles(await deps.localSpec(), await deps.cloudEmbeddings()),
			sources: [],
		};
		const sources = await deps.dataSources.list();
		if (sources.error !== null) return { ...base, error: base.error ?? sources.error };
		return { ...base, sources: buildPlan(sources.sources, choice) };
	};

	return {
		get: async () => {
			const path = configPath();
			const embedder = readEmbedder(deps.env, deps.cwd);
			const profileId = currentProfileId(embedder, readSemantic(deps.env, deps.cwd), accountBaseUrl());
			const base: EmbeddingSettingsSnapshot = {
				configPath: path,
				configExists: existsSync(path),
				error: null,
				current: { profileId, embedder: asJsonObject(embedder) },
				profiles: embeddingProfiles(await deps.localSpec(), await deps.cloudEmbeddings()),
				sources: [],
			};
			const sources = await deps.dataSources.list();
			if (sources.error !== null) return { ...base, error: sources.error };
			const profile = profileId === null ? undefined : findProfile(profileId);
			return profile === undefined ? base : { ...base, sources: buildPlan(sources.sources, { profile }) };
		},
		plan: async (request) => {
			const resolved = await resolveChoice(request);
			if ("error" in resolved) {
				const embedder = readEmbedder(deps.env, deps.cwd);
				return {
					configPath: configPath(),
					configExists: existsSync(configPath()),
					error: resolved.error,
					current: { profileId: currentProfileId(embedder, readSemantic(deps.env, deps.cwd), accountBaseUrl()), embedder: asJsonObject(embedder) },
					profiles: embeddingProfiles(await deps.localSpec(), await deps.cloudEmbeddings()),
					sources: [],
				};
			}
			const { choice } = resolved;
			// A preview only reads: it asks the server, but sends nothing the user has not consented to and stores nothing.
			return snapshotFor(choice, choice.profile.kind === "dazzi" || choice.profile.kind === "byok" ? (await preflight(choice, { ...request, acknowledgeRemote: true })).error : null);
		},
		apply: async (request) => {
			const resolved = await resolveChoice(request);
			if ("error" in resolved) return { ...EMPTY_RESULT(request.profileId), error: resolved.error };
			const { choice } = resolved;
			const snapshot = await deps.dataSources.list();
			if (snapshot.error !== null) return { ...EMPTY_RESULT(request.profileId), error: snapshot.error };
			const enabledById = new Map(snapshot.sources.map((row) => [row.id, row.enabled] as const));
			const plan = buildPlan(snapshot.sources, choice);

			const checked = await preflight(choice, request);
			if (checked.error !== null) return { ...EMPTY_RESULT(request.profileId, plan), error: checked.error };
			const result: EmbeddingChangeResult = EMPTY_RESULT(request.profileId, plan);

			// Keyword-only keeps the configured embedder so choosing a model again needs no re-entry.
			const updates: AutoRagConfigUpdate[] =
				choice.profile.kind === "none"
					? [{ path: ["appIndexing", "semanticSearch"], value: false }]
					: [{ path: ["minSync", "embedder"], value: deriveEmbedder(choice, accountBaseUrl()) }, { path: semanticSwitchPath(configPath()), remove: true }];
			const written: string[][] = [choice.profile.kind === "none" ? ["appIndexing", "semanticSearch"] : ["minSync", "embedder"]];
			const toRebuild = plan.filter((status) => enabledById.get(status.id) === true && (status.adoption === "propagated" || status.adoption === "native")).map((status) => status.id);

			// The key goes to the OS keyring first, so a config that names its variable never points at nothing.
			try {
				await storeKeys(choice, checked.key);
				await deps.config.patch(updates);
			} catch (error) {
				return { ...result, error: error instanceof Error ? error.message : String(error) };
			}

			// The rebuilds embed through whatever the new config selects: the local server has to be up (or gone) first.
			await ensureEmbeddingForConfig(readRawConfigObject(configPath()));

			const rebuilds: DataSourceSyncResult[] = [];
			for (const id of toRebuild) {
				try {
					rebuilds.push(await deps.dataSources.sync(id));
				} catch (error) {
					rebuilds.push({
						id,
						ok: false,
						state: "failed",
						chunkCount: null,
						indexedAt: null,
						durationMs: 0,
						diagnostics: [],
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			return { ...result, ok: true, applied: true, written, rebuilds };
		},
	};

	/**
	 * Keep exactly the keys the chosen profile needs. A key the user put in their own shell is never touched: only
	 * what this app stored is removed, and the Dazzi plan key is replaced only when it is the plan token.
	 */
	async function storeKeys(choice: EmbeddingChoice, key: string | null): Promise<void> {
		const stored = new Set((await deps.credentials.list([DAZZI_KEY_ENV, BYOK_KEY_ENV])).filter((entry) => entry.stored).map((entry) => entry.envName));
		if (choice.profile.kind === "dazzi" && key !== null) await deps.credentials.set(DAZZI_KEY_ENV, key);
		else if (stored.has(DAZZI_KEY_ENV)) await deps.credentials.remove(DAZZI_KEY_ENV);
		if (choice.profile.kind === "byok" && key !== null && choice.byok?.apiKey !== undefined) await deps.credentials.set(BYOK_KEY_ENV, key);
		else if (choice.profile.kind !== "byok" && stored.has(BYOK_KEY_ENV)) await deps.credentials.remove(BYOK_KEY_ENV);
	}
}
