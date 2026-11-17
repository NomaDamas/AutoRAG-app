/**
 * Settings → AI 모델 / 웹 검색 helper agent (`ai-customizer`).
 *
 * It edits the shared AutoRAG config through the same service the pages write
 * through, so a model/role change is byte-identical to a click in `AiPage` and a
 * web-search change matches `WebPage`. It cannot connect providers, touch API
 * keys, or change the embedding model: those belong to the page's own buttons.
 */

import { defineTool, type AgentToolResult, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import { JEV_SLLM_BACKEND, jevModelsFor, rerankModelsFor } from "../../../shared/ai-roles";
import {
	catalogModelEntry,
	connectedProviders,
	roleSelectionFromConfig,
	staticCatalogEntry,
	thinkingLevelOf,
	webSearchStateOf,
	webSearchUpdates,
	type RoleId,
} from "../../../shared/ai-role-state";
import { decompositionConfigUpdates, jevConfigUpdates, jevSllmConfigUpdates, modelConfigUpdates, rerankConfigUpdates } from "../../../shared/model-config";
import { THINKING_LEVELS, WEBSEARCH_PROVIDERS } from "../../../shared/settings-options";
import type { AutoRagConfigUpdate, ModelCatalogEntry } from "../../../shared/settings-contract";
import { intentPromptLine, withIntentTools } from "../profile-progress";
import {
	createCustomizerKit,
	REPLY_LANGUAGE_NAME,
	textResult,
	type ConfigCustomizerDeps,
	type ConfigCustomizerProfileInput,
	type CustomizerToolkit,
	type Localized,
} from "./customizer-kit";

export interface AiCustomizerToolkitDeps extends ConfigCustomizerDeps {
	readonly platform?: NodeJS.Platform;
}

function localized(ko: string, en: string, ja: string, zh: string): Localized {
	return { ko, en, ja, zh };
}

export function createAiCustomizerToolkit(deps: AiCustomizerToolkitDeps): CustomizerToolkit {
	const kit = createCustomizerKit(deps);

	async function apply(
		updates: readonly AutoRagConfigUpdate[],
		summary: Localized,
		fields: readonly string[],
		warnings: readonly string[] = [],
	): Promise<AgentToolResult> {
		kit.ensureLive();
		try {
			await deps.settings.configPatch(updates);
		} catch (error) {
			return textResult({ ok: false, error: error instanceof Error ? error.message : String(error), warnings });
		}
		kit.record({ kind: "ai", summary, fields, ...(warnings.length > 0 ? { warnings } : {}) });
		return textResult({ ok: true, applied: fields, warnings });
	}

	const getAiSettings = defineTool({
		name: "get_ai_settings",
		label: "Inspect AI Models & Web Search",
		description:
			"Read which providers are connected (their model ids and names), the current answer / question-decomposition / Jev / rerank selections, the answer model's thinking depth, and the web-search state. Never returns API keys or any secret.",
		parameters: Type.Object({}),
		execute: async () => {
			kit.ensureLive();
			const snapshot = await deps.settings.configGet();
			const connected = connectedProviders(await deps.settings.providersList());
			const modelChoices = connected.flatMap((provider) => provider.models.map((model) => `${provider.id}:${model.id}`));
			const jevChoices = connected.flatMap((provider) => jevModelsFor(provider.id).map((model) => `${provider.id}:${model.id}`));
			const rerankChoices = connected.flatMap((provider) => rerankModelsFor(provider.id).map((model) => `${provider.id}:${model.id}`));
			return textResult({
				ok: true,
				providers: connected.map((provider) => ({
					id: provider.id,
					name: provider.name,
					models: provider.models.map((model) => ({ id: model.id, name: model.name })),
				})),
				roles: {
					answer: { current: roleSelectionFromConfig("answer", snapshot.config, connected), choices: modelChoices },
					decomposition: { current: roleSelectionFromConfig("decomposition", snapshot.config, connected), choices: modelChoices, specials: ["same", "default"] },
					jev: { current: roleSelectionFromConfig("jev", snapshot.config, connected), choices: jevChoices, specials: [JEV_SLLM_BACKEND] },
					rerank: { current: roleSelectionFromConfig("rerank", snapshot.config, connected), choices: rerankChoices, specials: ["off"] },
				},
				thinking: { current: thinkingLevelOf(snapshot.config), levels: THINKING_LEVELS.map((level) => level.value) },
				webSearch: { ...webSearchStateOf(snapshot.config), providers: WEBSEARCH_PROVIDERS.map((provider) => provider.id) },
			});
		},
	});

	const setModelRole = defineTool({
		name: "set_model_role",
		label: "Set a Model Role",
		description:
			"Point one of the four AI roles (answer, decomposition, jev, rerank) at a model of a CONNECTED provider, or use one of its specials (decomposition `same`/`default`, jev `sllm`, rerank `off`). Model ids must come from `get_ai_settings`; unconnected providers and unknown ids are refused with the valid choices.",
		parameters: Type.Object({
			role: Type.Union([Type.Literal("answer"), Type.Literal("decomposition"), Type.Literal("jev"), Type.Literal("rerank")], {
				description: "Which role to change.",
			}),
			provider: Type.Optional(
				Type.String({ description: "A connected provider id from `get_ai_settings`; the provider must actually serve the role for jev/rerank." }),
			),
			modelId: Type.Optional(Type.String({ description: "The exact model id from that provider's catalog (or its jev/rerank list)." })),
			special: Type.Optional(
				Type.Union([Type.Literal("same"), Type.Literal("default"), Type.Literal("sllm"), Type.Literal("off")], {
					description:
						"A non-model choice: decomposition `same` (decompose with the answer model), decomposition `default` (the documented default), jev `sllm` (use the small chat model as the decision model), rerank `off` (no reranker).",
				}),
			),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const warnings: string[] = [];
			const snapshot = await deps.settings.configGet();
			const connected = connectedProviders(await deps.settings.providersList());
			const role: RoleId = params.role;

			if (params.special !== undefined) {
				const special = params.special;
				if (role === "decomposition" && special === "same") {
					return apply(
						[{ path: ["queryDecomposition"], value: false }],
						localized("질문 분해를 답변 모델과 동일하게 설정", "Set decomposition to the answer model", "質問分解を回答モデルと同じに設定", "已将问题分解设为与回答模型相同"),
						["queryDecomposition"],
						warnings,
					);
				}
				if (role === "decomposition" && special === "default") {
					return apply(
						[{ path: ["queryDecomposition"], remove: true }],
						localized("질문 분해 모델을 기본값으로 복원", "Reset the decomposition model to its default", "質問分解モデルを既定に戻しました", "已将问题分解模型重置为默认"),
						["queryDecomposition"],
						warnings,
					);
				}
				if (role === "jev" && special === JEV_SLLM_BACKEND) {
					return apply(
						jevSllmConfigUpdates(),
						localized("판단 모델을 소형 채팅 모델로 설정", "Set the decision model to the small chat model", "判定モデルを小型チャットモデルに設定", "已将判定模型设为小型聊天模型"),
						["jev.backend"],
						warnings,
					);
				}
				if (role === "rerank" && special === "off") {
					return apply(
						[{ path: ["rerank"], value: false }],
						localized("리랭커를 사용 안 함으로 설정", "Turned the reranker off", "リランカーをオフに設定", "已停用重排器"),
						["rerank"],
						warnings,
					);
				}
				warnings.push(`'${special}' is not a valid option for the '${role}' role.`);
				if (params.provider === undefined || params.modelId === undefined) {
					return textResult({ ok: false, error: `'${special}' is not a valid option for the '${role}' role.`, warnings });
				}
			}

			const providerId = params.provider;
			const modelId = params.modelId;
			if (providerId === undefined || modelId === undefined) {
				return textResult({ ok: false, error: "Provide either a special, or both provider and modelId.", warnings });
			}
			const provider = connected.find((item) => item.id === providerId);
			if (provider === undefined) {
				const roleChoices =
					role === "jev"
						? connected.flatMap((item) => jevModelsFor(item.id).map((model) => `${item.id}:${model.id}`))
						: role === "rerank"
							? connected.flatMap((item) => rerankModelsFor(item.id).map((model) => `${item.id}:${model.id}`))
							: connected.flatMap((item) => item.models.map((model) => `${item.id}:${model.id}`));
				return textResult({
					ok: false,
					error: `Provider '${providerId}' is not connected. Connect it from the AI models page, then try again.`,
					choices: roleChoices,
					warnings,
				});
			}

			let entry: ModelCatalogEntry;
			let updates: readonly AutoRagConfigUpdate[];
			let summary: Localized;
			if (role === "jev" || role === "rerank") {
				const models = role === "jev" ? jevModelsFor(providerId) : rerankModelsFor(providerId);
				const match = models.find((model) => model.id === modelId);
				if (match === undefined) {
					return textResult({
						ok: false,
						error: `Provider '${providerId}' does not serve ${role} model '${modelId}'.`,
						choices: models.map((model) => `${providerId}:${model.id}`),
						warnings,
					});
				}
				entry = staticCatalogEntry(provider, match.id, match.label);
				updates = role === "jev" ? jevConfigUpdates(entry) : rerankConfigUpdates(entry);
				summary =
					role === "jev"
						? localized(`Jev 모델을 ${match.label}로 변경`, `Changed the Jev model to ${match.label}`, `Jev モデルを ${match.label} に変更`, `已将 Jev 模型更改为 ${match.label}`)
						: localized(`리랭커를 ${match.label}로 설정`, `Set the reranker to ${match.label}`, `リランカーを ${match.label} に設定`, `已将重排器设为 ${match.label}`);
			} else {
				const match = catalogModelEntry(provider, modelId);
				if (match === null) {
					return textResult({
						ok: false,
						error: `Provider '${providerId}' does not offer model '${modelId}'.`,
						choices: provider.models.map((model) => `${providerId}:${model.id}`),
						warnings,
					});
				}
				entry = match;
				updates = role === "answer" ? modelConfigUpdates(entry) : decompositionConfigUpdates(entry);
				const name = entry.name.trim().length > 0 ? entry.name.trim() : entry.id;
				summary =
					role === "answer"
						? localized(`답변 모델을 ${name}로 변경`, `Changed the answer model to ${name}`, `回答モデルを ${name} に変更`, `已将回答模型更改为 ${name}`)
						: localized(`질문 분해 모델을 ${name}로 변경`, `Changed the decomposition model to ${name}`, `質問分解モデルを ${name} に変更`, `已将问题分解模型更改为 ${name}`);
			}
			return apply(
				updates,
				summary,
				updates.map((update) => update.path.join(".")),
				warnings,
			);
		},
	});

	const setThinkingLevel = defineTool({
		name: "set_thinking_level",
		label: "Set the Answer Model's Thinking Depth",
		description: "Set the answer model's thinking depth (`thinking.final`) to one of the page's fixed levels.",
		parameters: Type.Object({
			level: Type.String({ description: "One of: off, low, medium, high, max." }),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const level = THINKING_LEVELS.find((item) => item.value === params.level);
			if (level === undefined) {
				return textResult({ ok: false, error: `'${params.level}' is not a thinking level.`, choices: THINKING_LEVELS.map((item) => item.value) });
			}
			return apply(
				[{ path: ["thinking", "final"], value: level.value }],
				localized(`사고 깊이를 ${level.value}로 변경`, `Changed the thinking depth to ${level.value}`, `思考の深さを ${level.value} に変更`, `已将思考深度更改为 ${level.value}`),
				["thinking.final"],
			);
		},
	});

	const updateWebSearch = defineTool({
		name: "update_web_search",
		label: "Update Web Search",
		description:
			"Turn web search on or off, pin the provider (or pass `auto` to clear it), and turn web-page fetching on or off. Writes the same `webSearch` shapes as the web-search page.",
		parameters: Type.Object({
			enabled: Type.Optional(Type.Boolean({ description: "Whether web search is used at all." })),
			provider: Type.Optional(Type.String({ description: "A provider id from the page's list, or `auto` to remove the pinned provider." })),
			fetchEnabled: Type.Optional(Type.Boolean({ description: "Whether search results may be fetched and read as pages." })),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			if (params.enabled === undefined && params.provider === undefined && params.fetchEnabled === undefined) {
				return textResult({ ok: false, error: "Provide at least one of enabled, provider, fetchEnabled." });
			}
			const snapshot = await deps.settings.configGet();
			const fields: string[] = [];
			const fragments: Localized[] = [];
			let provider: string | undefined;
			if (params.provider !== undefined && params.provider !== "auto") {
				const known = WEBSEARCH_PROVIDERS.find((item) => item.id === params.provider);
				if (known === undefined) {
					return textResult({ ok: false, error: `'${params.provider}' is not a supported web-search provider.`, choices: WEBSEARCH_PROVIDERS.map((item) => item.id) });
				}
				provider = known.id;
				fields.push("webSearch.provider");
				fragments.push(localized(`웹 검색 공급자를 ${known.label}로 변경`, `Changed the web search provider to ${known.label}`, `ウェブ検索プロバイダーを ${known.label} に変更`, `已将网页搜索提供方更改为 ${known.label}`));
			} else if (params.provider === "auto") {
				provider = "auto";
				fields.push("webSearch.provider");
				fragments.push(localized("웹 검색 공급자를 자동으로 설정", "Reset the web search provider to automatic", "ウェブ検索プロバイダーを自動に設定", "已将网页搜索提供方设为自动"));
			}
			if (params.enabled !== undefined) {
				fields.push("webSearch.enabled");
				fragments.push(params.enabled ? localized("웹 검색을 사용하도록 설정", "Enabled web search", "ウェブ検索を有効化", "已启用网页搜索") : localized("웹 검색을 사용하지 않도록 설정", "Disabled web search", "ウェブ検索を無効化", "已停用网页搜索"));
			}
			if (params.fetchEnabled !== undefined) {
				fields.push("webSearch.fetch.enabled");
				fragments.push(params.fetchEnabled ? localized("웹 페이지 가져오기를 사용하도록 설정", "Enabled web page fetching", "ウェブページ取得を有効化", "已启用网页抓取") : localized("웹 페이지 가져오기를 사용하지 않도록 설정", "Disabled web page fetching", "ウェブページ取得を無効化", "已停用网页抓取"));
			}
			const summary: Localized = {
				ko: fragments.map((fragment) => fragment.ko).join(", "),
				en: fragments.map((fragment) => fragment.en).join(", "),
				ja: fragments.map((fragment) => fragment.ja).join(", "),
				zh: fragments.map((fragment) => fragment.zh).join(", "),
			};
			const updates = webSearchUpdates(snapshot.config, {
				...(params.enabled === undefined ? {} : { enabled: params.enabled }),
				...(provider === undefined ? {} : { provider }),
				...(params.fetchEnabled === undefined ? {} : { fetchEnabled: params.fetchEnabled }),
			});
			return apply(updates, summary, fields);
		},
	});

	const tools: readonly ToolDefinition[] = [getAiSettings, setModelRole, setThinkingLevel, updateWebSearch];
	return kit.toolkit(tools);
}

function systemPrompt(language: ConfigCustomizerProfileInput["language"], surface: ConfigCustomizerProfileInput["surface"]): string {
	const replyLang = REPLY_LANGUAGE_NAME[language];
	const page = surface === "web" ? "Settings → Web Search (웹 검색)" : "Settings → AI Models (AI 모델)";
	const levels = THINKING_LEVELS.map((level) => level.value).join(", ");
	const webProviders = WEBSEARCH_PROVIDERS.map((provider) => `${provider.id} (${provider.label})`).join(", ");

	return [
		`You are Dazzi's dedicated AI Models & Web Search Customization Assistant (\`ai-customizer\`), embedded inside ${page}.`,
		`Always reply in ${replyLang}, concisely and warmly.`,
		"",
		"## Role & Scope",
		"- You edit the shared AutoRAG config for the AI roles and web search only, through the same validated writer the Settings pages use.",
		"- Roles: `answer` (the main model), `decomposition` (question decomposition), `jev` (the decision model), `rerank` (the reranker).",
		`- Closed option lists: thinking depth is one of ${levels}; web-search providers are ${webProviders} (or \`auto\` to clear the pin).`,
		"",
		"## Non-Negotiable Invariants",
		"1. **Providers & credentials**: You cannot connect or disconnect providers, cannot read/write/remove API keys, and cannot sign in. There is no tool for it. If asked, tell the person to use the connect (서비스 연결) button and the provider menus on the AI models page.",
		"2. **Embedding model**: You cannot change the embedding model — that profile triggers a corpus re-index and belongs to the embedding picker. Say so and leave it alone.",
		"3. **Never invent ids**: A model id must come from `get_ai_settings` for a CONNECTED provider (and, for jev/rerank, from that role's own list). Never guess a provider or model id, and never reference a provider that is not connected.",
		"4. **Exact page writes**: Apply the page's own write shapes; one atomic config write per tool call. Model changes come from the same builders a click uses.",
		"",
		"## Workflow",
		"1. Call `get_ai_settings` first when you are unsure which providers/models or options exist.",
		"2. Apply with `set_model_role`, `set_thinking_level`, or `update_web_search`.",
		"3. Summarize in 1-3 short sentences what changed. If a request was refused, explain why and name the valid choices.",
		"",
		intentPromptLine(language),
	].join("\n");
}

export function aiCustomizerProfile(input: ConfigCustomizerProfileInput): AgentProfile {
	return {
		id: "ai-customizer",
		systemPrompt: systemPrompt(input.language, input.surface),
		tools: [],
		customTools: withIntentTools(input.toolkit.tools, { language: input.language }),
		thinking: "low",
	};
}
