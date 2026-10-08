import { existsSync } from "node:fs";
import { readRawConfigObject, resolveConfigPath } from "@autorag/librarian/core";
import type { AutoRagConfigService } from "./autorag-config-service";
import type { DataSourceStatusService } from "./datasource-status";
import type { EmbeddingSettingsService } from "./settings-service";
import { startEmbeddingLoopbackAdapter, type EmbeddingLoopbackAdapter } from "./embedding-loopback-adapter";
import { isJsonObject } from "../shared/settings-contract";
import type {
	AutoRagConfigUpdate,
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
 * The discrawl embedding runtime the app hands to the discrawl skill so an
 * index run rewrites the managed config and rebuilds embeddings.
 *
 * An app-owned structural copy: `@autorag/librarian` constructs this shape but
 * does not re-export the type from its public entry, so the app declares the
 * exact fields it passes instead of importing a guessed internal module.
 */
export interface DiscrawlEmbeddingRuntime {
	readonly provider: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly dimensions: number;
	readonly identity?: string;
}

/**
 * Settings > Models > 문서 이해 (the global corpus embedder).
 *
 * `minSync.embedder` is the one setting the app agent, `autorag` refresh, and
 * the AutoRAGLite runtime all resolve. Changing it must reach every configured
 * datasource that can adopt the new model — not just MinSync — so this service
 * validates the choice, reports exactly which sources can and cannot follow,
 * writes the shared config (plus every reachable per-CLI override), and then
 * runs the real per-source index/rebuild pipelines.
 *
 * Honesty rules enforced here:
 * - no remote egress: a local server must be loopback, and is probed for real
 *   vectors before any write (no fake success);
 * - an incompatible configured source blocks the change unless the caller
 *   explicitly acknowledges it, and is always reported;
 * - unreachable upstream prerequisites (e.g. the AutoRAG embedding runtime is
 *   not a public export, `lazykatok` reads its own config) are reported as
 *   incompatibilities instead of silently applying MinSync only.
 */
export interface EmbeddingSettingsDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	readonly config: AutoRagConfigService;
	readonly dataSources: DataSourceStatusService;
	/** Test seam for the local-server probe and the loopback adapter upstream. */
	readonly fetchImpl?: typeof fetch;
}

/**
 * The embedding surface plus the app-lifecycle hooks the host needs.
 *
 * `refresh()` MUST run at startup: a persisted local-server embedder stores the
 * app adapter's loopback URL in the mailcrawl env, and that ephemeral port only
 * exists for the current process lifetime, so the adapter and the URL are
 * re-established on every launch.
 */
export interface EmbeddingSettingsRuntime extends EmbeddingSettingsService {
	/** Restart the configured loopback adapter and refresh the persisted mailcrawl URL; call at startup. */
	refresh(): Promise<void>;
}

interface LocalServer {
	readonly id: string;
	readonly baseUrl: string;
	readonly dimension: number;
	readonly queryPrefix?: string;
	readonly passagePrefix?: string;
}

interface EmbeddingChoice {
	readonly profile: EmbeddingProfile;
	readonly localServer?: LocalServer;
}

const QWEN3_GGUF = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const GEMMA_GGUF = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const MAILCRAWL_NATIVE_MODEL = "Qwen/Qwen3-Embedding-0.6B";

/** Mailcrawl env keys this service owns; any not set for the choice are removed. */
const MAILCRAWL_KEYS = [
	"MAILCRAWL_EMBEDDER_PROVIDER",
	"MAILCRAWL_NATIVE_MODEL",
	"MAILCRAWL_NATIVE_DEVICE",
	"MAILCRAWL_EMBED_URL",
	"MAILCRAWL_EMBED_MODEL",
	"MAILCRAWL_EMBED_DIM",
] as const;

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

/**
 * The global embedder choices. The AutoRAG plan and local servers are the only
 * sources the prototype lists; corpus text never goes to a remote embedder.
 */
export const EMBEDDING_PROFILES: readonly EmbeddingProfile[] = [
	{
		id: "native-qwen3",
		kind: "native",
		label: "Qwen3 Embedding 0.6B",
		description: "이 Mac에서 직접 도는 기본 문서 이해 모델(1024차원). 별도 서버가 필요 없습니다.",
		model: "native:Qwen/Qwen3-Embedding-0.6B",
		dimension: 1024,
		queryPrefix: "",
		passagePrefix: "",
		baseUrl: null,
		requiresLocalServer: false,
	},
	{
		id: "qwen3-embedding-0.6b",
		kind: "profile",
		label: "Qwen3 Embedding 0.6B (AutoRAG 런타임)",
		description: "AutoRAG 임베딩 런타임이 loopback에서 llama-server로 서빙하는 1024차원 모델입니다.",
		model: "qwen3-embedding-0.6b",
		dimension: 1024,
		queryPrefix: "",
		passagePrefix: "",
		baseUrl: null,
		requiresLocalServer: false,
	},
	{
		id: "embeddinggemma-300m",
		kind: "profile",
		label: "EmbeddingGemma 300M",
		description: "가벼운 다국어 모델(768차원). 카카오톡·메일이 기본으로 쓰는 모델과 같습니다.",
		model: "embeddinggemma-300m",
		dimension: 768,
		queryPrefix: "task: search result | query: ",
		passagePrefix: "title: none | text: ",
		baseUrl: null,
		requiresLocalServer: false,
	},
	{
		id: "local-server",
		kind: "local-server",
		label: "내 컴퓨터 임베딩 서버",
		description: "loopback에서 도는 OpenAI 호환 임베딩 서버를 씁니다. 모델·차원·접두어를 직접 지정하세요.",
		model: "",
		dimension: 0,
		queryPrefix: "",
		passagePrefix: "",
		baseUrl: null,
		requiresLocalServer: true,
	},
];

function findProfile(profileId: string): EmbeddingProfile | undefined {
	return EMBEDDING_PROFILES.find((profile) => profile.id === profileId);
}

function assertLocalServer(local: LocalServer): void {
	if (local.id.trim().length === 0) throw new Error("임베딩 서버 모델 이름이 비어 있습니다");
	if (!Number.isInteger(local.dimension) || local.dimension <= 0) throw new Error("임베딩 서버 차원은 양의 정수여야 합니다");
	let host: string;
	try {
		host = new URL(local.baseUrl).hostname.toLowerCase();
	} catch {
		throw new Error("임베딩 서버 주소가 올바른 URL이 아닙니다");
	}
	if (LOOPBACK_HOSTS[host] !== true) throw new Error("임베딩 서버는 loopback 주소여야 합니다(문서는 이 Mac을 벗어나지 않습니다)");
}

/** The `minSync.embedder` value the shared config should hold for a choice. */
function deriveEmbedder(choice: EmbeddingChoice): JsonObject {
	const { profile } = choice;
	if (profile.kind === "local-server" && choice.localServer !== undefined) {
		const local = choice.localServer;
		return {
			id: local.id,
			baseUrl: local.baseUrl,
			dimension: local.dimension,
			...(local.queryPrefix !== undefined && local.queryPrefix.length > 0 ? { queryPrefix: local.queryPrefix } : {}),
			...(local.passagePrefix !== undefined && local.passagePrefix.length > 0 ? { passagePrefix: local.passagePrefix } : {}),
		};
	}
	if (profile.kind === "profile") {
		return {
			profile: profile.model,
			dimension: profile.dimension,
			...(profile.queryPrefix.length > 0 ? { queryPrefix: profile.queryPrefix } : {}),
			...(profile.passagePrefix.length > 0 ? { passagePrefix: profile.passagePrefix } : {}),
		};
	}
	return { id: profile.model, dimension: profile.dimension };
}

function currentProfileId(embedder: unknown): string | null {
	if (!isJsonObject(embedder)) return null;
	const profile = embedder.profile;
	if (profile === "qwen3-embedding-0.6b" || profile === "embeddinggemma-300m") return profile;
	const id = embedder.id;
	if (typeof id === "string") {
		if (id.startsWith("native:")) return "native-qwen3";
		if (typeof embedder.baseUrl === "string" && embedder.baseUrl.length > 0) return "local-server";
	}
	return null;
}

/** The qmd `QMD_EMBED_MODEL` GGUF URI for the choice, or null when qmd cannot use it. */
function qmdModelFor(choice: EmbeddingChoice): string | null {
	const id = choice.profile.id;
	if (id === "embeddinggemma-300m") return GEMMA_GGUF;
	if (id === "native-qwen3" || id === "qwen3-embedding-0.6b") return QWEN3_GGUF;
	return null;
}

/** Mailcrawl env the choice maps to, or null when mailcrawl cannot adopt it. */
function mailcrawlEnvFor(choice: EmbeddingChoice, adapterUrl: string | null): Record<string, string> | null {
	const id = choice.profile.id;
	if (id === "native-qwen3" || id === "qwen3-embedding-0.6b") {
		return { MAILCRAWL_EMBEDDER_PROVIDER: "native", MAILCRAWL_NATIVE_MODEL, MAILCRAWL_NATIVE_DEVICE: "auto" };
	}
	if (id === "embeddinggemma-300m") return { MAILCRAWL_EMBEDDER_PROVIDER: "legacy-onnx" };
	if (id === "local-server" && choice.localServer !== undefined && adapterUrl !== null) {
		return {
			MAILCRAWL_EMBEDDER_PROVIDER: "loopback-http",
			MAILCRAWL_EMBED_URL: `${adapterUrl}/mailcrawl/embeddings`,
			MAILCRAWL_EMBED_MODEL: choice.localServer.id,
			MAILCRAWL_EMBED_DIM: String(choice.localServer.dimension),
		};
	}
	return null;
}

function discrawlRuntimeFor(choice: EmbeddingChoice): DiscrawlEmbeddingRuntime | undefined {
	if (choice.profile.kind !== "local-server" || choice.localServer === undefined) return undefined;
	const local = choice.localServer;
	let provider = "openai_compatible";
	try {
		const url = new URL(local.baseUrl);
		if (LOOPBACK_HOSTS[url.hostname.toLowerCase()] === true && url.port === "11434") provider = "ollama";
	} catch {
		return undefined;
	}
	return { provider, model: local.id, baseUrl: local.baseUrl, dimensions: local.dimension };
}

function adoptionFor(
	type: string,
	choice: EmbeddingChoice,
	adapterAvailable: boolean,
): { adoption: EmbeddingAdoption; reason: string; action: string | null } {
	switch (type) {
		case "mailcrawl":
			return !(choice.profile.id === "local-server" ? adapterAvailable : mailcrawlEnvFor(choice, null) !== null)
				? {
						adoption: "incompatible",
						reason: "mailcrawl은 내장 Qwen3/EmbeddingGemma만 지원하고 임의의 HTTP 임베딩 서버는 쓸 수 없습니다",
						action: null,
					}
				: {
						adoption: "propagated",
						reason: "connector.env에 임베딩 프로바이더를 기록합니다(모델이 바뀌면 mailcrawl이 자동으로 다시 색인합니다)",
						action: "datasources.<id>.connector.env.MAILCRAWL_*",
					};
		case "obsidian":
			return qmdModelFor(choice) === null
				? {
						adoption: "incompatible",
						reason: "qmd(obsidian)는 로컬 GGUF 모델만 쓸 수 있어 HTTP 임베딩 서버를 사용할 수 없습니다",
						action: null,
					}
				: {
						adoption: "propagated",
						reason: "qmd 자식 프로세스에 QMD_EMBED_MODEL을 설정하고 `qmd embed -f`로 다시 색인합니다",
						action: `QMD_EMBED_MODEL=${qmdModelFor(choice)}`,
					};
		case "discord":
			return discrawlRuntimeFor(choice) === undefined
				? {
						adoption: "incompatible",
						reason:
							"이 앱은 AutoRAG 임베딩 런타임을 loopback으로 서빙할 수 없습니다(공개 export 아님). 임베딩 서버를 골라야 discrawl에 전달할 수 있습니다",
						action: null,
					}
				: {
						adoption: "propagated",
						reason: "AutoRAG 관리 discrawl config를 다시 쓰고 `discrawl embed --rebuild`로 다시 색인합니다",
						action: "datasources.<id>이 관리하는 discrawl config.toml",
					};
		case "kakao":
			return choice.profile.id === "embeddinggemma-300m"
				? {
						adoption: "native",
						reason: "lazykatok은 EmbeddingGemma 300M을 in-process로 내장하고 있어 그대로 일치합니다",
						action: null,
					}
				: {
						adoption: "incompatible",
						reason:
							"lazykatok은 EmbeddingGemma 300M만 내장 지원합니다. 다른 모델은 AutoRAG 공유 config로 지정할 수 없습니다(네이티브 설정이 소유)",
						action: null,
					};
		case "github-gist":
			return {
				adoption: "incompatible",
				reason: "GitHubGistSkill이 @autorag/librarian 공개 export가 아니라 임베더를 앱에서 지정할 수 없습니다(런타임 게이트웨이 프로필 고정)",
				action: null,
			};
		case "clawgallery":
			return { adoption: "not-applicable", reason: "ClawGallery는 이미지(VDR) 색인이며 텍스트 임베딩을 쓰지 않습니다", action: null };
		case "lark":
			return { adoption: "not-applicable", reason: "Lark은 원격 API 검색만 사용하고 로컬 임베딩을 거부합니다", action: null };
		default:
			return { adoption: "not-applicable", reason: "이 데이터소스는 자체 키워드/파싱 색인을 쓰며 전역 임베더를 사용하지 않습니다", action: null };
	}
}

function buildPlan(rows: readonly DataSourceRow[], choice: EmbeddingChoice, adapterAvailable: boolean): EmbeddingSourceStatus[] {
	return rows.map((row) => {
		const { adoption, reason, action } = adoptionFor(row.type, choice, adapterAvailable);
		return { id: row.id, type: row.type, adoption, reason, action };
	});
}

const EMPTY_RESULT = (profileId: string, plan: readonly EmbeddingSourceStatus[] = []): EmbeddingChangeResult => ({
	ok: false,
	applied: false,
	profileId,
	plan,
	incompatibilities: [],
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
/** Rebuild a choice from the persisted embedder so `get` can plan without a request. */
function findChoiceFromConfig(embedder: unknown, profileId: string): EmbeddingChoice | undefined {
	const profile = findProfile(profileId);
	if (profile === undefined) return undefined;
	if (profile.kind !== "local-server" || !isJsonObject(embedder)) return { profile };
	if (typeof embedder.id !== "string" || typeof embedder.baseUrl !== "string" || typeof embedder.dimension !== "number") return undefined;
	return {
		profile,
		localServer: {
			id: embedder.id,
			baseUrl: embedder.baseUrl,
			dimension: embedder.dimension,
			...(typeof embedder.queryPrefix === "string" ? { queryPrefix: embedder.queryPrefix } : {}),
			...(typeof embedder.passagePrefix === "string" ? { passagePrefix: embedder.passagePrefix } : {}),
		},
	};
}

function qmdModelForConfig(embedder: unknown): string | null {
	if (!isJsonObject(embedder)) return null;
	if (embedder.profile === "embeddinggemma-300m") return GEMMA_GGUF;
	if (embedder.profile === "qwen3-embedding-0.6b") return QWEN3_GGUF;
	if (typeof embedder.id === "string" && embedder.id.startsWith("native:")) return QWEN3_GGUF;
	return null;
}

export function createEmbeddingSettingsService(deps: EmbeddingSettingsDeps): EmbeddingSettingsRuntime {
	const doFetch = deps.fetchImpl ?? fetch;
	let adapter: EmbeddingLoopbackAdapter | null = null;

	const configPath = (): string => resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;

	const resolveChoice = (request: EmbeddingChangeRequest): { choice: EmbeddingChoice } | { error: string } => {
		const profile = findProfile(request.profileId);
		if (profile === undefined) return { error: `알 수 없는 임베딩 프로필: ${request.profileId}` };
		if (!profile.requiresLocalServer) return { choice: { profile } };
		const local = request.localServer;
		if (local === undefined) return { error: "임베딩 서버 정보(id, baseUrl, dimension)가 필요합니다" };
		try {
			assertLocalServer(local);
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
		return { choice: { profile, localServer: local } };
	};

	const stopAdapter = async (): Promise<void> => {
		if (adapter === null) return;
		const closing = adapter;
		adapter = null;
		await closing.close();
	};

	const startAdapter = async (choice: EmbeddingChoice): Promise<string> => {
		if (choice.localServer === undefined) throw new Error("임베딩 서버 정보가 필요합니다");
		await stopAdapter();
		const started = await startEmbeddingLoopbackAdapter({
			upstreamBaseUrl: choice.localServer.baseUrl,
			model: choice.localServer.id,
			dimension: choice.localServer.dimension,
			...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
		});
		adapter = started;
		return started.url;
	};

	/** Probe the real upstream for a vector of the declared dimension; never fabricate. */
	const probeLocalServer = async (local: LocalServer): Promise<string | null> => {
		let response: Response;
		try {
			response = await doFetch(`${local.baseUrl.replace(/\/+$/u, "")}/v1/embeddings`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: local.id, input: ["ping"] }),
			});
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		if (!response.ok) return `임베딩 서버가 HTTP ${response.status}로 응답했습니다`;
		let parsed: unknown;
		try {
			parsed = await response.json();
		} catch {
			return "임베딩 서버 응답을 JSON으로 읽지 못했습니다";
		}
		const first = isJsonObject(parsed) && Array.isArray(parsed.data) ? parsed.data[0] : undefined;
		const embedding = isJsonObject(first) ? first.embedding : undefined;
		if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number")) {
			return "임베딩 서버가 벡터를 반환하지 않았습니다";
		}
		if (embedding.length !== local.dimension) {
			return `임베딩 서버 차원이 ${embedding.length}인데 ${local.dimension}로 지정했습니다`;
		}
		return null;
	};

	/** Plan result as a snapshot: `current` previews the requested profile, `sources` its adoption. */
	const snapshotFor = async (
		choice: EmbeddingChoice,
		adapterAvailable: boolean,
		error: string | null,
	): Promise<EmbeddingSettingsSnapshot> => {
		const path = configPath();
		const base: EmbeddingSettingsSnapshot = {
			configPath: path,
			configExists: existsSync(path),
			error,
			current: { profileId: choice.profile.id, embedder: deriveEmbedder(choice) },
			profiles: EMBEDDING_PROFILES,
			sources: [],
		};
		const sources = await deps.dataSources.list();
		if (sources.error !== null) return { ...base, error: base.error ?? sources.error };
		return { ...base, sources: buildPlan(sources.sources, choice, adapterAvailable) };
	};

	return {
		get: async () => {
			const path = configPath();
			const embedder = readEmbedder(deps.env, deps.cwd);
			const profileId = currentProfileId(embedder);
			const base: EmbeddingSettingsSnapshot = {
				configPath: path,
				configExists: existsSync(path),
				error: null,
				current: { profileId, embedder: asJsonObject(embedder) },
				profiles: EMBEDDING_PROFILES,
				sources: [],
			};
			const sources = await deps.dataSources.list();
			if (sources.error !== null) return { ...base, error: sources.error };
			const choice = profileId === null ? undefined : findChoiceFromConfig(embedder, profileId);
			if (choice === undefined) return base;
			return { ...base, sources: buildPlan(sources.sources, choice, adapter !== null) };
		},
		plan: async (request) => {
			const resolved = resolveChoice(request);
			if ("error" in resolved) {
				const embedder = readEmbedder(deps.env, deps.cwd);
				return {
					configPath: configPath(),
					configExists: existsSync(configPath()),
					error: resolved.error,
					current: { profileId: currentProfileId(embedder), embedder: asJsonObject(embedder) },
					profiles: EMBEDDING_PROFILES,
					sources: [],
				};
			}
			const choice = resolved.choice;
			if (choice.profile.kind === "local-server" && choice.localServer !== undefined) {
				const probeError = await probeLocalServer(choice.localServer);
				// The mailcrawl overlay URL exists only once the adapter starts; the
				// plan reports mailcrawl as reachable when the probe already passed.
				return snapshotFor(choice, probeError === null, probeError);
			}
			return snapshotFor(choice, false, null);
		},
		apply: async (request) => {
			const resolved = resolveChoice(request);
			if ("error" in resolved) return { ...EMPTY_RESULT(request.profileId), error: resolved.error };
			const choice = resolved.choice;
			const snapshot = await deps.dataSources.list();
			if (snapshot.error !== null) return { ...EMPTY_RESULT(request.profileId), error: snapshot.error };
			const enabledById = new Map(snapshot.sources.map((row) => [row.id, row.enabled] as const));

			let adapterUrl: string | null = null;
			if (choice.profile.kind === "local-server" && choice.localServer !== undefined) {
				const probeError = await probeLocalServer(choice.localServer);
				if (probeError !== null) {
					return { ...EMPTY_RESULT(request.profileId, buildPlan(snapshot.sources, choice, false)), error: probeError };
				}
				try {
					adapterUrl = await startAdapter(choice);
				} catch (error) {
					return { ...EMPTY_RESULT(request.profileId), error: error instanceof Error ? error.message : String(error) };
				}
			} else {
				await stopAdapter();
			}

			const plan = buildPlan(snapshot.sources, choice, adapterUrl !== null);
			const incompatibilities = plan.filter((status) => enabledById.get(status.id) === true && status.adoption === "incompatible");
			const result: EmbeddingChangeResult = { ...EMPTY_RESULT(request.profileId, plan), incompatibilities };
			if (incompatibilities.length > 0 && request.acknowledgeIncompatible !== true) {
				return {
					...result,
					error: `이 모델을 따를 수 없는 데이터소스가 있습니다: ${incompatibilities.map((status) => status.id).join(", ")}`,
				};
			}

			const updates: AutoRagConfigUpdate[] = [{ path: ["minSync", "embedder"], value: deriveEmbedder(choice) }];
			const written: string[][] = [["minSync", "embedder"]];
			const toRebuild: string[] = [];

			for (const status of plan) {
				if (enabledById.get(status.id) !== true) continue;
				if (status.type === "mailcrawl") {
					const target = mailcrawlEnvFor(choice, adapterUrl);
					if (target === null) continue;
					for (const key of MAILCRAWL_KEYS) {
						const value = target[key];
						if (value === undefined) updates.push({ path: ["datasources", status.id, "connector", "env", key], remove: true });
						else {
							updates.push({ path: ["datasources", status.id, "connector", "env", key], value });
							written.push(["datasources", status.id, "connector", "env", key]);
						}
					}
				}
				if (status.adoption === "propagated" || status.adoption === "native") toRebuild.push(status.id);
			}

			try {
				await deps.config.patch(updates);
			} catch (error) {
				return { ...result, error: error instanceof Error ? error.message : String(error) };
			}

			// qmd reads QMD_EMBED_MODEL from the inherited process env; keep it in sync.
			const qmdModel = qmdModelFor(choice);
			if (qmdModel === null) delete deps.env.QMD_EMBED_MODEL;
			else deps.env.QMD_EMBED_MODEL = qmdModel;

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
		discrawlRuntime: () => {
			const embedder = readEmbedder(deps.env, deps.cwd);
			if (currentProfileId(embedder) !== "local-server" || !isJsonObject(embedder)) return undefined;
			const profile = findProfile("local-server");
			if (profile === undefined || typeof embedder.id !== "string" || typeof embedder.baseUrl !== "string" || typeof embedder.dimension !== "number") {
				return undefined;
			}
			return discrawlRuntimeFor({ profile, localServer: { id: embedder.id, baseUrl: embedder.baseUrl, dimension: embedder.dimension } });
		},
		applyProcessEnv: () => {
			const model = qmdModelForConfig(readEmbedder(deps.env, deps.cwd));
			if (model === null) delete deps.env.QMD_EMBED_MODEL;
			else deps.env.QMD_EMBED_MODEL = model;
		},
		dispose: stopAdapter,
		refresh: async () => {
			const embedder = readEmbedder(deps.env, deps.cwd);
			const profile = findProfile("local-server");
			if (
				profile === undefined ||
				currentProfileId(embedder) !== "local-server" ||
				!isJsonObject(embedder) ||
				typeof embedder.id !== "string" ||
				typeof embedder.baseUrl !== "string" ||
				typeof embedder.dimension !== "number"
			) {
				await stopAdapter();
				return;
			}
			const local: LocalServer = {
				id: embedder.id,
				baseUrl: embedder.baseUrl,
				dimension: embedder.dimension,
				...(typeof embedder.queryPrefix === "string" ? { queryPrefix: embedder.queryPrefix } : {}),
				...(typeof embedder.passagePrefix === "string" ? { passagePrefix: embedder.passagePrefix } : {}),
			};
			// The persisted config may point at a server that is no longer running.
			if ((await probeLocalServer(local)) !== null) {
				await stopAdapter();
				return;
			}
			let url: string;
			try {
				url = await startAdapter({ profile, localServer: local });
			} catch {
				await stopAdapter();
				return;
			}
			const snapshot = await deps.dataSources.list();
			if (snapshot.error !== null) return;
			const target = mailcrawlEnvFor({ profile, localServer: local }, url);
			if (target === null) return;
			const updates: AutoRagConfigUpdate[] = [];
			for (const row of snapshot.sources) {
				if (!row.enabled || row.type !== "mailcrawl") continue;
				for (const key of MAILCRAWL_KEYS) {
					const value = target[key];
					if (value === undefined) updates.push({ path: ["datasources", row.id, "connector", "env", key], remove: true });
					else updates.push({ path: ["datasources", row.id, "connector", "env", key], value });
				}
			}
			if (updates.length > 0) await deps.config.patch(updates);
		},
	};
}
