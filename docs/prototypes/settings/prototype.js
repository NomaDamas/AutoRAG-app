/* AutoRAG settings prototype — pure front-end demo.
 *
 * Structure keeps the polished IA (기본/AI/검색/연결된 앱/고급) and the
 * plain-language copy, but the visual language now follows the shipped
 * Settings tab: `linear-row`-style rows (label + hint left, control right,
 * hairline divider), section headers instead of boxed cards, and app tokens
 * for every color. */
"use strict";

const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
	String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

/* ------------------------------------------------------------- UI atoms -- */

/* Icon names map to lucide slugs; the markup comes from ./lucide-icons.js,
 * generated from the same `lucide-react` the app pins. */
const ICONS = {
	gear: "settings",
	sparkles: "sparkles",
	search: "search",
	globe: "globe",
	folder: "folder",
	file: "file-text",
	copy: "copy",
	plug: "plug",
	sliders: "sliders-horizontal",
	chevron: "chevron-right",
	chevronDown: "chevron-down",
	check: "check",
	plus: "plus",
	x: "x",
	info: "info",
	alert: "triangle-alert",
	more: "ellipsis",
	external: "external-link",
};

/** The app's SearchIcon draws lucide `search` at stroke 2.2; every other glyph uses 1.8. */
const svg = (name, extraClass = "") => {
	const markup = LUCIDE[ICONS[name] ?? ""] ?? "";
	return `<svg class="icon${extraClass}" viewBox="0 0 24 24" aria-hidden="true">${markup}</svg>`;
};


const switchControl = (id, on) =>
	`<button class="switch" data-toggle="${esc(id)}" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${esc(id)}"></button>`;

const selectControl = (id, options, selected) =>
	`<span class="select-wrap">${svg("chevronDown")}<select class="select" data-select="${esc(id)}">${options
		.map((option) => `<option value="${esc(option)}"${option === selected ? " selected" : ""}>${esc(option)}</option>`)
		.join("")}</select></span>`;

const fieldControl = (id, kind, placeholder, value) =>
	`<input class="field${kind === "number" ? " number" : ""}" type="${kind === "number" ? "number" : "text"}" data-field="${esc(id)}" placeholder="${esc(placeholder)}" value="${esc(value ?? "")}">`;

const chipsControl = (id, items) =>
	`<div class="chips">${items
		.map((item, index) => `<span class="chip">${esc(item)}<button type="button" data-chip-remove="${esc(id)}:${index}" aria-label="삭제">${svg("x")}</button></span>`)
		.join("")}<button type="button" class="chip-add" data-chip-add="${esc(id)}">+ 추가</button></div>`;

/* ---------------------------------------------------------- Demo state -- */

const state = {
	page: "general",
	appearance: "light",
	notes: false,
	/** Connected provider ids in connection order. The AutoRAG plan is always present. */
	providers: ["autorag"],
	/** Role → `{ provider, model }` or `{ special }`; filled from each role's AutoRAG default below. */
	roles: {},
	/** Reasoning level per LLM role (`thinking.final` for the answer model; a proposal for decomposition). */
	thinking: { answer: "high", decomposition: "off" },
	/** Open floating menu: `{ type, arg, anchor, query }` or null. */
	menu: null,
	/** Choice waiting on the reindex confirmation. */
	pendingChoice: null,
	customCount: 0,
	values: {
		appearance: "라이트",
		language: "한국어",
		poll: "15분",
		dupes: "1시간",
		ocr: false,
		media: false,
		ocrmode: "자동 (권장)",
		ocrlang: "문서 언어와 같게",
		sync: "자동 선택",
		cloudprovider: "Google Drive",
	},
	chips: {
		langs: ["한국어", "English"],
		excludes: ["node_modules", ".git", "dist"],
		devfolders: ["node_modules", ".git", "dist"],
		order: ["Perplexity", "DuckDuckGo", "Google"],
		tags: ["문서", "파일"],
		chatrooms: ["스터디 채팅방"],
		exts: [".pdf", ".docx", ".md"],
		repos: ["NomaDamas/AutoRAG-app"],
		feeds: ["https://example.com/feed.xml"],
	},
	searchPaths: ["~/Documents", "~/Desktop/업무"],
	connections: [
		{ id: "slack", type: "slack", label: "Slack", hint: "채널과 메시지 검색 · 도우미 프로그램 미설치", installed: false, access: false, enabled: true, indexed: false, meta: "1,240개 문서" },
		{ id: "kakao", type: "kakao", label: "카카오톡", hint: "카카오톡 대화 검색 · AI 접근 허용 필요", installed: false, access: false, enabled: true, indexed: true, meta: "812개 문서" },
		{ id: "drive", type: "cloud-drive", label: "클라우드 드라이브", hint: "Google Drive·OneDrive 파일 검색 · 동기화 예약", installed: false, access: false, enabled: true, indexed: false, meta: "동기화 예약" },
		{ id: "spotlight", type: "spotlight", label: "Spotlight", hint: "Mac 파일 이름 검색 · 사용 중", installed: true, access: true, enabled: true, indexed: true, meta: "1,284개 문서 · 오늘 09:42" },
	],
	advancedOpen: {},
};

/* ------------------------------------------------------- AI providers -- */

/**
 * Provider catalog. `kind` picks the connect flow: builtin (the AutoRAG plan,
 * always connected, the default for every role), subscription (browser sign-in), api (key plus optional fields),
 * local (loopback server), custom (OpenAI-compatible endpoint). `models` lists
 * what each provider offers per capability; a role only offers providers that
 * have models for its capability.
 */
const PROVIDERS = {
	autorag: { label: "AutoRAG", letter: "A", kind: "builtin", models: {
		llm: [["autorag/deepseek-v4.1-flash", "DeepSeek V4.1 Flash"], ["autorag/claude-sonnet-4.5", "Claude Sonnet 4.5"], ["autorag/gpt-5", "GPT-5"], ["autorag/gemini-2.5-pro", "Gemini 2.5 Pro"], ["autorag/qwen3.7-flash", "Qwen3.7 Flash", "빠름"]],
		jev: [["autorag/jev-1.13", "Jev 1.13"]],
		rerank: [["autorag/cohere-rerank-v3.5", "Cohere Rerank 3.5"], ["autorag/cohere-rerank-4-fast", "Cohere Rerank 4 Fast"], ["autorag/voyage-rerank-3-lite", "Voyage Rerank 3 Lite"]],
		embed: [["qwen3-embedding-0.6b", "Qwen3 Embedding 0.6B"], ["embeddinggemma-300m", "EmbeddingGemma 300M", "가벼움"]],
	} },
	chatgpt: { label: "ChatGPT", letter: "C", kind: "subscription", models: {
		llm: [["openai-codex/gpt-5", "GPT-5"], ["openai-codex/gpt-5-mini", "GPT-5 Mini"], ["openai-codex/o3", "o3"]],
	} },
	claude: { label: "Claude", letter: "C", kind: "subscription", models: {
		llm: [["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"], ["anthropic/claude-opus-4.1", "Claude Opus 4.1"], ["anthropic/claude-haiku-4.5", "Claude Haiku 4.5"]],
	} },
	copilot: { label: "GitHub Copilot", letter: "G", kind: "subscription", models: {
		llm: [["github-copilot/gpt-5", "GPT-5"], ["github-copilot/claude-sonnet-4.5", "Claude Sonnet 4.5"]],
	} },
	openrouter: { label: "OpenRouter", letter: "O", kind: "api", placeholder: "sk-or-…", keyHint: "openrouter.ai의 Keys 메뉴에서 만든 키를 붙여 넣으세요.", models: {
		llm: [["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "추천"], ["openai/gpt-5", "GPT-5", "추천"], ["google/gemini-2.5-pro", "Gemini 2.5 Pro"], ["deepseek/deepseek-v3.2", "DeepSeek V3.2"], ["qwen/qwen3.7-flash", "Qwen3.7 Flash", "빠름"], ["qwen/qwen3-max", "Qwen3 Max"]],
		jev: [["typesafe/jev-1.13", "Jev 1.13", "권장"]],
		rerank: [["voyageai/rerank-3-lite", "Voyage Rerank 3 Lite", "권장"], ["voyageai/rerank-3", "Voyage Rerank 3"], ["cohere/rerank-v3.5", "Cohere Rerank 3.5"], ["cohere/rerank-4-fast", "Cohere Rerank 4 Fast"]],
	} },
	openai: { label: "OpenAI", letter: "O", kind: "api", placeholder: "sk-…", models: {
		llm: [["openai/gpt-5", "GPT-5"], ["openai/gpt-5-mini", "GPT-5 Mini"], ["openai/o3", "o3"]],
	} },
	anthropic: { label: "Anthropic", letter: "A", kind: "api", placeholder: "sk-ant-…", models: {
		llm: [["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"], ["anthropic/claude-opus-4.1", "Claude Opus 4.1"], ["anthropic/claude-haiku-4.5", "Claude Haiku 4.5"]],
	} },
	google: { label: "Google Gemini", letter: "G", kind: "api", placeholder: "AIza…", models: {
		llm: [["google/gemini-2.5-pro", "Gemini 2.5 Pro"], ["google/gemini-2.5-flash", "Gemini 2.5 Flash"]],
	} },
	fireworks: { label: "Fireworks", letter: "F", kind: "api", placeholder: "fw_…", models: {
		llm: [["fireworks/kimi-k2", "Kimi K2"], ["fireworks/glm-4.6", "GLM 4.6"]],
	} },
	groq: { label: "Groq", letter: "G", kind: "api", placeholder: "gsk_…", models: {
		llm: [["groq/llama-3.3-70b", "Llama 3.3 70B"], ["groq/qwen3-32b", "Qwen3 32B"]],
	} },
	deepseek: { label: "DeepSeek", letter: "D", kind: "api", placeholder: "sk-…", models: {
		llm: [["deepseek/deepseek-chat", "DeepSeek V3.2"], ["deepseek/deepseek-reasoner", "DeepSeek R1"]],
	} },
	mistral: { label: "Mistral", letter: "M", kind: "api", placeholder: "키 붙여 넣기", models: {
		llm: [["mistral/mistral-large", "Mistral Large"], ["mistral/mistral-small", "Mistral Small"]],
	} },
	xai: { label: "xAI Grok", letter: "X", kind: "api", placeholder: "xai-…", models: {
		llm: [["xai/grok-4", "Grok 4"], ["xai/grok-4-fast", "Grok 4 Fast"]],
	} },
	typesafe: { label: "TypeSafe", letter: "T", kind: "api", placeholder: "ts_…", keyHint: "Jev 판단 모델 전용 키입니다.", models: {
		jev: [["jev-latest", "Jev (최신)", "권장"]],
	} },
	vercel: { label: "Vercel AI Gateway", letter: "V", kind: "api", placeholder: "vck_…", models: {
		llm: [["vercel/anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5"], ["vercel/openai/gpt-5", "GPT-5"]],
		jev: [["typesafe/jev-latest", "Jev (최신)"]],
	} },
	cloudflare: { label: "Cloudflare AI Gateway", letter: "C", kind: "api",
		intro: "AI Gateway 권한이 있는 Cloudflare API 토큰을 만든 뒤, 계정 ID와 게이트웨이 이름을 입력하세요.",
		fields: [
			{ name: "token", label: "API 토큰", placeholder: "예: cf_…", type: "password", required: true },
			{ name: "account", label: "계정 ID", placeholder: "예: 023e…", required: true },
			{ name: "gateway", label: "게이트웨이 ID", placeholder: "default", value: "default", required: true },
		],
		models: { llm: [["cloudflare/llama-3.3-70b", "Llama 3.3 70B"], ["cloudflare/qwen3-30b", "Qwen3 30B"]] } },
	local: { label: "내 컴퓨터 서버", letter: "L", kind: "local", url: "http://127.0.0.1:11434", models: {
		llm: [["local/llama3.1", "Llama 3.1"], ["local/qwen3", "Qwen3"]],
		embed: [["native:Qwen/Qwen3-Embedding-0.6B", "Qwen3 Embedding (내 서버)"]],
	} },
};

const CONNECT_GROUPS = [
	{ title: "구독 계정", ids: ["chatgpt", "claude", "copilot"] },
	{ title: "API 키", ids: ["openrouter", "openai", "anthropic", "google", "fireworks", "groq", "deepseek", "mistral", "xai", "typesafe", "vercel", "cloudflare"] },
	{ title: "내 컴퓨터", ids: ["local"] },
];

/**
 * The five model roles the agent splits work into. `capability` filters which
 * providers a role can pick from; `specials` are non-model choices. Every role
 * defaults to the AutoRAG plan (`fallback`), and returns there when the provider
 * it used is disconnected. Embedding only lists the AutoRAG plan and local
 * servers, and both run on this Mac: corpus text never goes to a remote embedder.
 * Only LLM roles carry `thinking` (the ⋯ reasoning menu); Jev, reranking, and
 * embedding models have no reasoning step.
 */
const ROLES = {
	answer: { label: "답변 모델", short: "답변", capability: "llm", path: "model", thinking: true,
		hint: "질문에 답하고 문서를 요약합니다.",
		fallback: { provider: "autorag", model: "autorag/deepseek-v4.1-flash" } },
	decomposition: { label: "질문 나누기", short: "질문 나누기", capability: "llm", path: "queryDecomposition.model", thinking: true,
		hint: "긴 질문을 검색어 여러 개로 나눕니다. 빠르고 저렴한 모델이 잘 맞습니다.",
		specials: [["same", "답변 모델과 같게"]],
		fallback: { provider: "autorag", model: "autorag/qwen3.7-flash" } },
	jev: { label: "판단 모델 (Jev)", short: "Jev", capability: "jev", path: "jev.backend · jev.model",
		hint: "자료를 더 찾을지, 웹을 검색할지 판단합니다.",
		specials: [["off", "사용 안 함"]],
		fallback: { provider: "autorag", model: "autorag/jev-1.13" } },
	rerank: { label: "검색 결과 정렬", short: "정렬", capability: "rerank", path: "rerank",
		hint: "관련 높은 결과를 위로 올립니다. 답변이 조금 느려질 수 있습니다.",
		specials: [["off", "사용 안 함"]],
		fallback: { provider: "autorag", model: "autorag/cohere-rerank-v3.5" } },
	embed: { label: "문서 이해 모델", short: "문서 이해", capability: "embed", path: "minSync.embedder", reindex: true,
		hint: "문서의 의미를 분석합니다. 문서 내용은 이 Mac 밖으로 나가지 않습니다.",
		fallback: { provider: "autorag", model: "qwen3-embedding-0.6b" } },
};

// Every role starts on the AutoRAG plan.
for (const [roleId, role] of Object.entries(ROLES)) state.roles[roleId] = { ...role.fallback };

/** pi-ai thinking levels, trimmed to the five an office user can tell apart. */
const THINKING_LEVELS = [
	["off", "생각 안 함", "가장 빠름"],
	["low", "낮음"],
	["medium", "보통"],
	["high", "높음", "정확도 우선"],
	["max", "최대", "가장 느림"],
];

const ROLE_GROUPS = [
	{ title: "답변", roles: ["answer"] },
	{ title: "검색 보조", roles: ["decomposition", "jev", "rerank"] },
	{ title: "문서 이해", roles: ["embed"] },
];

const TEMPLATES = {
	telegram: { label: "Telegram", desc: "Telegram 대화를 검색합니다.", letter: "T" },
	whatsapp: { label: "WhatsApp", desc: "WhatsApp 대화를 검색합니다.", letter: "W" },
	slack: { label: "Slack", desc: "채널과 메시지를 검색합니다.", letter: "S" },
	discord: { label: "Discord", desc: "서버 채널과 메시지를 검색합니다.", letter: "D" },
	clawgallery: { label: "ClawGallery", desc: "이미지 보관함을 검색합니다.", letter: "C" },
	notion: { label: "Notion", desc: "페이지와 데이터베이스를 검색합니다.", letter: "N" },
	lark: { label: "Lark", desc: "Lark 메시지와 문서를 검색합니다.", letter: "L" },
	kakao: { label: "카카오톡", desc: "카카오톡 대화를 검색합니다.", letter: "K" },
	github: { label: "GitHub", desc: "이슈와 PR을 검색합니다.", letter: "G" },
	"github-gist": { label: "GitHub Gist", desc: "인증된 계정의 Gist를 검색합니다.", letter: "G" },
	"cloud-drive": { label: "클라우드 드라이브", desc: "Google Drive·OneDrive 파일을 검색합니다.", letter: "C" },
	"mail-export": { label: "메일 백업", desc: "eml·mbox 보관 파일을 검색합니다.", letter: "M" },
	mailcrawl: { label: "메일 (mailcrawl)", desc: "메일함을 검색합니다.", letter: "M" },
	obsidian: { label: "Obsidian", desc: "노트 보관함을 검색합니다.", letter: "O" },
	rss: { label: "RSS·뉴스", desc: "뉴스와 블로그 피드를 검색합니다.", letter: "R" },
	spotlight: { label: "Spotlight", desc: "Mac의 파일 이름을 검색합니다.", letter: "S" },
};

const GALLERY_GROUPS = [
	{ title: "메신저", ids: ["slack", "kakao", "discord", "telegram", "whatsapp", "lark"] },
	{ title: "문서·노트", ids: ["notion", "obsidian", "clawgallery"] },
	{ title: "메일", ids: ["mailcrawl", "mail-export"] },
	{ title: "클라우드·개발", ids: ["cloud-drive", "github", "github-gist"] },
	{ title: "뉴스·기타", ids: ["rss", "spotlight"] },
];

/* ------------------------------------------------------------ Row model -- */

const data = {
	general: {
		group: "기본", label: "일반", icon: "gear",
		title: "일반",
		desc: "AutoRAG의 화면과 시작 방식을 설정합니다.",
		notes: ["Display & General의 영문 라벨을 정리하고 한국어로 다시 썼습니다.", "문서 언어와 중복 검사는 각각 문서 읽기·중복 파일로 옮겼습니다.", "템플릿 안내 문구(workspacePath, memoryPath)를 제거했습니다.", "익명 사용 통계를 일반로 옮겼습니다."],
		sections: [
			{ title: "화면", rows: [
				{ id: "appearance", label: "화면 모드", hint: "전체 화면에 같은 테마를 적용합니다.", control: selectControl("appearance", ["라이트", "다크"], state.values.appearance), path: "app.appearance" },
				{ id: "language", label: "앱 언어", hint: "메뉴와 설정에 사용할 언어입니다.", control: selectControl("language", ["한국어", "English", "日本語", "简体中文"], state.values.language), path: "app.language" },
			] },
			{ title: "Finder", rows: [
				{ id: "hidden", label: "숨김 파일 보기", hint: "점(.)으로 시작하는 시스템 파일을 Finder에 표시합니다.", control: switchControl("hidden", false), path: "app.showHiddenFiles" },
			] },
			{ title: "시작 및 업데이트", rows: [
				{ id: "launch", label: "로그인할 때 자동 실행", hint: "컴퓨터를 켤 때 AutoRAG를 백그라운드에서 시작합니다.", control: switchControl("launch", false), path: "app.launchAtLogin" },
				{ id: "updates", label: "업데이트 자동 설치", hint: "새 버전을 다음 앱 시작 때 자동으로 적용합니다.", control: switchControl("updates", true), path: "app.autoInstallUpdates" },
			] },
			{ title: "개인정보", rows: [
				{ id: "telemetry", label: "익명 사용 통계 보내기", hint: "문서 내용을 제외한 성능 정보만 전송합니다.", control: switchControl("telemetry", false), path: "app.telemetry" },
			] },
		],
	},
	ai: {
		group: "AI", label: "AI 모델", icon: "sparkles",
		title: "AI 모델",
		desc: "AI 서비스를 연결하고, 역할마다 쓸 모델을 고릅니다.",
		keywords: "LLM 임베딩 embedding 리랭커 reranker rerank Jev 질문 나누기 decomposition provider API 키 구독",
		notes: [
			"공급자 select 하나에 모델·키·주소를 몰아넣던 구조를 '연결된 서비스'와 '역할별 모델'로 나눴습니다.",
			"LLM·Embedding·Reranker 탭과 Jev·질문 나누기 설정을 한 화면의 역할 목록으로 합쳤습니다. 검색 품질 메뉴는 없앴습니다.",
			"서비스마다 다른 연결 방식(구독 로그인·API 키·추가 필드·내 컴퓨터 서버)은 연결 창에서 처리하고, 서버 주소·통신 방식·키 환경 변수는 화면에서 뺐습니다.",
			"모든 역할의 기본값은 AutoRAG 요금제입니다. 다른 서비스를 해제하면 그 서비스를 쓰던 역할은 AutoRAG 기본 모델로 돌아가므로 '모델 선택 필요' 상태가 없습니다.",
			"문서 이해 모델은 AutoRAG 요금제 또는 내 컴퓨터 서버만 고를 수 있고, 둘 다 이 Mac에서 실행합니다(원격 임베딩 금지).",
			"역할 옆 ⋯는 생각 깊이(reasoning level) 설정입니다. 추론 단계가 있는 답변 모델·질문 나누기에만 둡니다. Jev·검색 결과 정렬·문서 이해 모델에는 없습니다.",
			"생각 깊이는 아직 config 필드가 없는 제안입니다. 답변 모델은 업스트림 thinking.final(기본 높음)에, 질문 나누기는 현재 off로 고정된 값을 여는 새 옵션에 대응합니다.",
			"구독 로그인·연결 확인·커스텀 서비스 모델 목록은 현재 브리지에 없는 제안 기능입니다.",
		],
		sections: [
			{ title: "연결된 서비스", desc: "기본은 AutoRAG 요금제입니다. 다른 서비스를 연결하면 아래 역할에서 그 서비스의 모델도 고를 수 있습니다.", rows: "providerRows" },
			{ title: "역할별 모델", desc: "AutoRAG는 일을 역할별로 나눠 처리합니다. 역할마다 맞는 모델을 고르세요.", rows: "taskRows" },
			{ title: "문서 이해 세부 조정", advanced: true, rows: [
				{ id: "etime", label: "요청 시간 제한", hint: "문서 분석 요청 하나를 기다리는 최대 시간입니다.", control: fieldControl("etime", "number", "기본값 (초)"), path: "minSync.embedder.timeoutMs" },
				{ id: "batch", label: "한 번에 분석할 문서 수", hint: "한 요청에 묶는 문서 수입니다.", control: fieldControl("batch", "number", "기본값"), path: "minSync.embedder.batchSize" },
				{ id: "concurrent", label: "동시 분석 수", hint: "동시에 실행할 분석 개수입니다.", control: fieldControl("concurrent", "number", "기본값"), path: "minSync.embedder.maxConcurrent" },
			] },
		],
	},
	scope: {
		group: "검색", label: "검색 범위", icon: "folder",
		title: "검색 범위",
		desc: "AutoRAG가 읽고 검색할 폴더와 제외할 항목을 정합니다.",
		notes: ["검색 폴더와 제외 폴더를 한 화면에 모았습니다.", "textarea로 입력하던 경로 목록을 목록 형태로 바꿨습니다."],
		sections: [
			{ title: "검색할 폴더", desc: "이 폴더의 내용을 AI 검색에 포함합니다.", rows: "pathRows" },
			{ title: "제외할 항목", desc: "검색하지 않을 폴더와 파일입니다.", rows: [
				{ id: "excludes", label: "제외 목록", hint: "이름이 일치하는 폴더·파일은 건너뜁니다.", control: chipsControl("excludes", state.chips.excludes), stack: true, path: "excludePaths" },
			] },
			{ title: "파일 포함 범위", rows: [
				{ id: "devexclude", label: "개발용 폴더 자동 제외", hint: "node_modules, .git, dist처럼 검색에 불필요한 폴더를 건너뜁니다.", control: switchControl("devexclude", true), path: "appIndexing.excludeCodeFolders" },
				{ id: "watch", label: "변경 자동 감지", hint: "파일이 바뀌면 검색 목록을 즉시 갱신합니다.", control: switchControl("watch", true), path: "fsearch.watch" },
				{ id: "media", label: "사진·영상 색인", hint: "미디어 파일의 정보를 검색에 포함합니다.", control: switchControl("media", state.values.media), path: "jikji.enableMediaIndex" },
				...(state.values.media ? [{ id: "mediasize", label: "미디어 최대 크기", hint: "이 크기를 넘는 파일은 건너뜁니다.", control: selectControl("mediasize", ["10MB", "50MB", "100MB", "제한 없음"], "50MB"), path: "jikji.mediaIndexMaxMb" }] : []),
			] },
			{ title: "자동 제외 폴더 이름", desc: "개발용 폴더 자동 제외에 사용하는 이름입니다.", advanced: true, rows: [
				{ id: "devfolders", label: "폴더 이름", hint: "한 줄에 하나씩 입력합니다.", control: chipsControl("devfolders", state.chips.devfolders), stack: true, path: "appIndexing.codeFolderNames" },
			] },
		],
	},
	reading: {
		group: "검색", label: "문서 읽기", icon: "file",
		title: "문서 읽기",
		desc: "문서와 이미지에서 글자를 읽는 언어와 방식을 설정합니다.",
		notes: ["OCR·파서 언어 설정을 하나로 합쳤습니다.", "Kordoc OCR 방식의 기술 문구를 정리했습니다."],
		sections: [
			{ title: "문서 언어", desc: "문서 내용을 읽고 검색할 때 우선 사용할 언어입니다.", rows: [
				{ id: "langs", label: "문서 언어", hint: "여러 개를 선택할 수 있습니다.", control: chipsControl("langs", state.chips.langs), stack: true, path: "languages" },
			] },
			{ title: "이미지 속 글자 읽기", desc: "사진이나 스캔 PDF 안의 글자도 검색할 수 있게 합니다.", rows: [
				{ id: "ocr", label: "OCR 사용", hint: "처음 분석할 때 시간이 더 걸립니다.", control: switchControl("ocr", state.values.ocr), path: "parserOptions.ocr.enabled" },
				...(state.values.ocr ? [{ id: "ocrlang", label: "인식 언어", hint: "기본값은 문서 언어를 따라갑니다.", control: selectControl("ocrlang", ["문서 언어와 같게", "직접 선택"], state.values.ocrlang), path: "parserOptions.ocr.languages" }] : []),
			] },
			{ title: "세부 설정", desc: "바꿀 필요가 없는 값들입니다.", advanced: true, rows: [
				{ id: "ocrmode", label: "한글 문서 처리 방식", hint: "HWP·스캔 문서를 읽는 방법입니다.", control: selectControl("ocrmode", ["자동 (권장)", "내장 방식", "항상 인식", "사용 안 함"], state.values.ocrmode), path: "parserOptions.kordoc.ocr" },
				{ id: "ocrtime", label: "이미지 인식 시간 제한", hint: "이미지 한 장을 기다리는 최대 시간입니다.", control: fieldControl("ocrtime", "number", "기본값 (초)"), path: "parserOptions.ocr.timeoutMs" },
				{ id: "ocrsize", label: "이미지 최대 크기", hint: "이 크기를 넘는 이미지는 건너뜁니다.", control: fieldControl("ocrsize", "number", "기본값 (MB)"), path: "parserOptions.ocr.maxBytes" },
				{ id: "parselangs", label: "문서 언어 (개별 설정)", hint: "비워두면 위의 문서 언어를 따릅니다.", control: chipsControl("parselangs", []), stack: true, path: "parserOptions.languages" },
			] },
		],
	},
	duplicates: {
		group: "검색", label: "중복 파일 정리", icon: "copy",
		title: "중복 파일 정리",
		desc: "검색 결과에 같은 내용이 반복해서 나타나지 않도록 정리합니다.",
		notes: ["General·Other Apps에 나뉘어 있던 중복 관련 설정을 한 곳으로 모았습니다.", "dupey 버전 패밀리라는 용어를 비슷한 버전 묶기로 바꿨습니다."],
		sections: [
			{ title: "검색 결과 정리", rows: [
				{ id: "exact", label: "완전히 같은 파일은 하나만", hint: "내용이 같은 파일은 가장 최근 것만 보여줍니다.", control: switchControl("exact", true), path: "excludeExactDuplicates" },
				{ id: "versions", label: "비슷한 버전 묶기", hint: "보고서_최종, 보고서_최종2처럼 관련 파일을 묶어 보여줍니다.", control: switchControl("versions", true), path: "dupey.enabled" },
				{ id: "dupes", label: "검사 주기", hint: "파일 변화를 다시 확인하는 주기입니다.", control: selectControl("dupes", ["15분", "30분", "1시간", "3시간", "6시간", "12시간", "하루"], state.values.dupes), path: "app.dupeyScanIntervalMinutes" },
			] },
			{ title: "고급", advanced: true, rows: [
				{ id: "dupepath", label: "검사 도구 위치", hint: "비워두면 자동으로 찾습니다.", control: fieldControl("dupepath", "text", "자동"), path: "dupey.binaryPath" },
				{ id: "dupetime", label: "검사 시간 제한", hint: "한 번의 중복 검사를 기다리는 최대 시간입니다.", control: fieldControl("dupetime", "number", "기본값 (초)"), path: "dupey.timeoutMs" },
			] },
		],
	},
	web: {
		group: "AI", label: "웹 검색", icon: "globe",
		title: "웹 검색",
		desc: "최신 정보가 필요한 질문에 인터넷 검색 결과를 답변에 사용합니다.",
		notes: ["web_search·web_fetch라는 도구 이름 대신 쓰임을 설명하는 문구로 바꿨습니다.", "검색 서비스 목록도 한국어 라벨을 붙였습니다."],
		sections: [
			{ title: "웹 검색 사용", rows: [
				{ id: "web", label: "웹 검색 사용", hint: "질문이 검색 서비스로 전송될 수 있습니다.", control: switchControl("web", true), path: "webSearch.enabled" },
				{ id: "sync", label: "검색 서비스", hint: "자동 선택을 권장합니다.", control: selectControl("sync", ["자동 선택", "Google", "DuckDuckGo", "Perplexity", "Startpage", "SearXNG"], state.values.sync), path: "webSearch.provider" },
				{ id: "fetch", label: "웹페이지 내용 읽기", hint: "검색 결과 링크의 본문을 답변에 참고합니다.", control: switchControl("fetch", true), path: "webSearch.fetch.enabled" },
			] },
			{ title: "고급", advanced: true, rows: [
				{ id: "order", label: "검색 서비스 우선순위", hint: "자동 선택 시 먼저 시도할 순서입니다.", control: chipsControl("order", state.chips.order), stack: true, path: "webSearch.order" },
				{ id: "excludes", label: "사용하지 않을 서비스", hint: "목록에 있는 서비스는 시도하지 않습니다.", control: chipsControl("webexclude", []), stack: true, path: "webSearch.exclude" },
				{ id: "timeout", label: "검색 시간 제한", hint: "검색 서비스 응답을 기다리는 최대 시간입니다.", control: fieldControl("timeout", "number", "기본값 (초)"), path: "webSearch.timeoutSeconds" },
				{ id: "fetchtime", label: "페이지 읽기 시간 제한", hint: "페이지 본문을 기다리는 최대 시간입니다.", control: fieldControl("fetchtime", "number", "기본값 (초)"), path: "webSearch.fetch.timeoutSeconds" },
			] },
		],
	},
	apps: {
		group: "연결된 앱", label: "모든 연결", icon: "plug",
		title: "연결된 앱",
		desc: "메신저, 메일, 클라우드의 자료를 AutoRAG에서 함께 검색합니다.",
		notes: ["템플릿 카드의 CLI 이름·연결 수 배지를 제거했습니다.", "16개 템플릿을 쓰임별로 묶어 배치했습니다."],
		sections: [
			{ title: "내 연결", rows: "sourceRows" },
			{ title: "앱 연결하기", desc: "추가할 앱을 선택하세요.", rows: "galleryRows" },
		],
	},
	advanced: {
		group: "고급", label: "고급 설정", icon: "sliders",
		title: "고급 설정",
		desc: "문제 해결이나 안내를 받을 때만 변경하세요.",
		notes: ["MinSync·Jikji·FSearch·Dupey의 엔진 이름을 한글 기능명으로 바꿨습니다.", "ms·bytes 단위를 초·MB로 표시합니다.", "AGENTS.md 규칙 쓰기를 개발자 옵션으로 옮겼습니다."],
		sections: [
			{ title: "주의", rows: [
				{ id: "notice", html: `<p class="note warn">${svg("alert")}<span><strong>대부분의 사용자는 바꿀 필요가 없습니다.</strong> 잘못된 값은 검색 속도와 색인 동작에 영향을 줄 수 있습니다.</span></p>` },
			] },
			{ title: "문서 내용 색인", rows: [
				{ id: "minsync", label: "문서 내용 색인 사용", hint: "의미가 비슷한 문서를 찾는 기능입니다.", control: switchControl("minsync", true), path: "minSync.enabled" },
				{ id: "minchunk", label: "문서 조각 최대 크기", hint: "문서를 나누는 최대 글자 수입니다.", control: fieldControl("minchunk", "number", "기본값"), path: "minSync.maxChunkSize" },
			] },
			{ title: "파일 정보 색인", rows: [
				{ id: "jikji", label: "파일 정보 색인 사용", hint: "파일 이름과 문서 정보를 빠르게 찾습니다.", control: switchControl("jikji", true), path: "jikji" },
				{ id: "includehidden", label: "숨김 파일 포함", hint: "점(.)으로 시작하는 파일도 색인합니다.", control: switchControl("includehidden", false), path: "jikji.includeHidden" },
				{ id: "jmax", label: "최대 파일 수", hint: "0이면 제한 없이 처리합니다.", control: fieldControl("jmax", "number", "0 = 제한 없음"), path: "jikji.maxFiles" },
				{ id: "jtimeout", label: "실행 시간 제한", hint: "파일 정보 색인을 기다리는 최대 시간입니다.", control: fieldControl("jtimeout", "number", "기본값 (초)"), path: "jikji.timeoutMs" },
				{ id: "parse", label: "문서 읽기 시간 제한", hint: "문서 하나를 분석하는 최대 시간입니다.", control: fieldControl("parse", "number", "기본값 (초)"), path: "jikji.parseTimeout" },
				{ id: "excludepatterns", label: "제외 패턴", hint: "한 줄에 하나씩 제외할 경로를 입력합니다.", control: chipsControl("jikjiexclude", []), stack: true, path: "jikji.exclude" },
			] },
			{ title: "파일 이름 검색", desc: `현재 운영체제에 맞는 검색 방식(FSearch)을 자동으로 사용합니다.`, rows: [
				{ id: "ftime", label: "검색 시간 제한", hint: "검색을 기다리는 최대 시간입니다.", control: fieldControl("ftime", "number", "기본값 (초)"), path: "fsearch.timeoutMs" },
				{ id: "fstart", label: "색인 시작 시간 제한", hint: "검색 준비를 기다리는 최대 시간입니다.", control: fieldControl("fstart", "number", "기본값 (초)"), path: "fsearch.startupTimeoutMs" },
				{ id: "findex", label: "색인 시간 제한", hint: "파일 목록을 만드는 최대 시간입니다.", control: fieldControl("findex", "number", "기본값 (초)"), path: "fsearch.indexTimeoutMs" },
				{ id: "fpath", label: "검색 도구 위치", hint: "비워두면 자동으로 찾습니다.", control: fieldControl("fpath", "text", "자동"), path: "fsearch.binaryPath" },
			] },
			{ title: "개발자 옵션", advanced: true, rows: [
				{ id: "rules", label: "AI 안내 파일 수정 허용", hint: "AGENTS.md·CLAUDE.md에 AutoRAG 안내 블록을 추가합니다.", control: switchControl("rules", false), path: "jikji.writeAgentRules" },
				{ id: "buffer", label: "출력 버퍼 크기", hint: "분석 결과를 임시로 담는 최대 크기입니다.", control: fieldControl("buffer", "number", "기본값 (MB)"), path: "jikji.maxBufferBytes" },
				{ id: "hashbytes", label: "해시 계산 최대 크기", hint: "이 크기까지만 읽어 파일을 비교합니다.", control: fieldControl("hashbytes", "number", "기본값 (MB)"), path: "jikji.maxHashBytes" },
				{ id: "textmax", label: "문서 텍스트 최대 길이", hint: "문서 하나에서 읽는 최대 글자 수입니다.", control: fieldControl("textmax", "number", "기본값"), path: "jikji.docTextMaxChars" },
				{ id: "textchunk", label: "문서 텍스트 조각 크기", hint: "텍스트를 나누는 글자 수입니다.", control: fieldControl("textchunk", "number", "기본값"), path: "jikji.docTextChunkChars" },
				{ id: "tags", label: "허용 태그", hint: "AI가 사용할 수 있는 연결의 분류입니다.", control: chipsControl("tags", state.chips.tags), stack: true, path: "datasourceAccess.allowedTags" },
				{ id: "scopes", label: "허용 범위", hint: "AI가 접근할 수 있는 경로 목록입니다.", control: chipsControl("scopes", []), stack: true, path: "datasourceAccess.allowedScopes" },
			] },
		],
	},
};

/* -------------------------------------------------------- Dynamic rows -- */

const KIND_META = {
	builtin: "요금제 · 기본 제공",
	subscription: "구독 계정",
	api: "API 키",
	local: "내 컴퓨터",
	custom: "직접 추가",
};

const appIcon = (providerId, size = "") => `<span class="app-icon${size}">${esc(PROVIDERS[providerId]?.letter ?? "·")}</span>`;

function modelLabel(providerId, capability, modelId) {
	const entry = (PROVIDERS[providerId]?.models[capability] ?? []).find(([id]) => id === modelId);
	return entry ? entry[1] : modelId;
}

/** Roles currently served by `providerId`, as short labels. */
function rolesUsing(providerId) {
	return Object.entries(state.roles)
		.filter(([, choice]) => choice?.provider === providerId)
		.map(([role]) => ROLES[role].short);
}

/** Connected providers offering at least one model for `capability`. */
function providersFor(capability) {
	return state.providers.filter((id) => (PROVIDERS[id]?.models[capability] ?? []).length > 0);
}

/** Catalog providers that could serve `capability` but are not connected yet. */
function connectableFor(capability) {
	return CONNECT_GROUPS.flatMap((group) => group.ids).filter((id) => !state.providers.includes(id) && (PROVIDERS[id].models[capability] ?? []).length > 0);
}

function providerRows() {
	const rows = state.providers.map((id) => {
		const provider = PROVIDERS[id];
		const used = rolesUsing(id);
		const detail = provider.url ? `${KIND_META[provider.kind]} · ${provider.url}` : KIND_META[provider.kind];
		const meta = used.length ? `${detail} · ${used.join(", ")}에 사용 중` : detail;
		const trailing = provider.kind === "builtin"
			? `<span class="status">${svg("check")}항상 사용 가능</span>`
			: `<button type="button" class="icon-btn" data-menu="provider-more" data-provider="${esc(id)}" aria-label="${esc(provider.label)} 메뉴">${svg("more")}</button>`;
		return { id: `provider:${id}`, html: `<div class="list-row provider-row" data-provider-row="${esc(id)}">${appIcon(id)}<span class="list-body"><span class="list-title">${esc(provider.label)}</span><span class="list-meta">${esc(meta)}</span></span>${trailing}</div>` };
	});
	rows.push({ id: "provider:add", html: `<button type="button" class="list-row add-row" data-menu="connect" data-menu-align="start">${svg("plus")}<span>서비스 연결</span></button>` });
	return rows;
}

function roleControl(roleId) {
	const role = ROLES[roleId];
	const choice = state.roles[roleId];
	const label = choice.special
		? `<span class="trigger-label muted">${esc(role.specials.find(([value]) => value === choice.special)[1])}</span>`
		: `${appIcon(choice.provider, " sm")}<span class="trigger-label">${esc(modelLabel(choice.provider, role.capability, choice.model))}</span>`;
	const trigger = `<button type="button" class="trigger" data-menu="picker" data-role="${esc(roleId)}">${label}${svg("chevronDown")}</button>`;
	if (!role.thinking) return `<span class="split solo">${trigger}</span>`;
	// "답변 모델과 같게" inherits the answer model's level.
	const inherits = Boolean(choice.special);
	return `<span class="split">${trigger}<button type="button" class="icon-btn" data-menu="thinking" data-role="${esc(roleId)}" aria-label="${esc(role.label)} 생각 깊이" title="${inherits ? "답변 모델의 생각 깊이를 따릅니다" : "생각 깊이"}"${inherits ? " disabled" : ""}>${svg("more")}</button></span>`;
}

function roleRows(roleIds) {
	return roleIds.map((roleId) => ({ id: `role:${roleId}`, label: ROLES[roleId].label, hint: ROLES[roleId].hint, control: roleControl(roleId), path: ROLES[roleId].path }));
}

function pathRows() {

	return [
		{ id: "paths", stack: true, control: `<div class="path-list">${state.searchPaths.map((path, index) => `<div class="path-line">${svg("folder")}<span>${esc(path)}</span><button class="btn quiet" data-action="path-remove" data-index="${index}">삭제</button></div>`).join("")}<button class="btn quiet" data-action="path-add">${svg("plus")}폴더 추가</button></div>`, path: "searchPaths" },
	];
}

function sourceRows() {
	if (state.connections.length === 0) return [{ id: "empty", html: `<p class="note">${svg("info")}<span>연결된 앱이 없습니다. 아래에서 추가하세요.</span></p>` }];
	return state.connections.map((connection) => ({
		id: `open:${connection.id}`,
		html: `<button class="list-row" data-nav="source/${esc(connection.id)}"><span class="app-icon">${esc((TEMPLATES[connection.type] ?? {}).letter ?? "·")}</span><span class="list-body"><span class="list-title">${esc(connection.label)}</span><span class="list-meta">${esc(connection.hint)}</span></span><span class="dot ${connection.installed && connection.access ? "ok" : "warn"}"></span>${svg("chevron")}</button>`,
	}));
}

function galleryRows() {
	const connected = new Set(state.connections.map((connection) => connection.type));
	return GALLERY_GROUPS.flatMap((group) => [
		{ id: `group:${group.title}`, html: `<p class="subsection-title">${esc(group.title)}</p>` },
		...group.ids
			.filter((id) => !connected.has(id))
			.map((id) => {
				const template = TEMPLATES[id];
				return { id: `add:${id}`, html: `<div class="list-row"><span class="app-icon">${esc(template.letter)}</span><span class="list-body"><span class="list-title">${esc(template.label)}</span><span class="list-meta">${esc(template.desc)}</span></span><button class="btn" data-add="${esc(id)}">${svg("plus")}연결</button></div>` };
			}),
	]);
}

const DYNAMIC_ROWS = {
	providerRows,
	taskRows: () => ROLE_GROUPS.flatMap((group) => [{ id: `group:${group.title}`, html: `<p class="subsection-title">${esc(group.title)}</p>` }, ...roleRows(group.roles)]),
	pathRows,
	sourceRows,
	galleryRows,
};


function rowHtml(row) {
	if (row.html) return `<div class="row" data-row="${esc(row.id ?? "")}">${row.html}</div>`;
	const notes = state.notes;
	const configPath = notes && row.path ? `<span class="config-path">${esc(row.path)}</span>` : "";
	const proposal = notes && row.proposal ? `<span class="proposal">${esc(row.proposal)}</span>` : "";
	const hint = row.hint ? `<small class="row-hint">${esc(row.hint)}</small>` : "";
	return `<div class="row${row.stack ? " stack" : ""}" data-row="${esc(row.id)}">
		<div class="row-label"><span class="row-name">${esc(row.label)}${proposal}</span>${hint}${configPath}</div>
		<div class="control">${row.control ?? ""}</div>
	</div>`;
}

function sectionHtml(section) {
	const rows = Array.isArray(section.rows) ? section.rows : (DYNAMIC_ROWS[section.rows] ?? (() => []))();
	const body = section.desc ? `<p class="section-desc">${esc(section.desc)}</p>` : "";
	const content = rows.map(rowHtml).join("");
	if (section.advanced) {
		const open = state.advancedOpen[section.title] ?? false;
		return `<details class="disclosure" data-advanced="${esc(section.title)}"${open ? " open" : ""}><summary>${svg("chevron")}${esc(section.title)}</summary><div class="disclosure-body">${content}</div></details>`;
	}
	return `<section class="section"><h2 class="section-title">${esc(section.title)}</h2>${body}${content}</section>`;
}

function pageHead(page) {
	const notes = state.notes && page.notes?.length
		? `<div class="notes"><strong>변경 메모</strong><ul>${page.notes.map((note) => `<li>${esc(note)}</li>`).join("")}</ul></div>`
		: "";
	return `<div class="page-head"><div><h1>${esc(page.title)}</h1><p>${esc(page.desc)}</p></div></div>${notes}`;
}

/* --------------------------------------------------------- Floating menus -- */

function openMenu(type, anchor, arg = null) {
	state.menu = { type, arg, anchor, query: "" };
	renderMenu();
}

function closeMenu() {
	state.menu = null;
	$("#menu-root").innerHTML = "";
}

const menuSearch = (placeholder) =>
	`<label class="menu-search">${svg("search", " icon-search")}<input type="text" data-menu-search placeholder="${esc(placeholder)}" value="${esc(state.menu?.query ?? "")}" autocomplete="off"></label>`;

function menuBody() {
	const { type, arg } = state.menu;
	const query = state.menu.query.trim().toLowerCase();
	const match = (text) => !query || text.toLowerCase().includes(query);

	if (type === "connect") {
		const groups = CONNECT_GROUPS.map((group) => {
			const items = group.ids.filter((id) => !state.providers.includes(id) && match(PROVIDERS[id].label));
			if (!items.length) return "";
			return `<p class="menu-group">${esc(group.title)}</p>` + items.map((id) => `<button type="button" class="menu-item" data-connect-provider="${esc(id)}">${appIcon(id, " sm")}<span>${esc(PROVIDERS[id].label)}</span></button>`).join("");
		}).join("");
		return menuSearch("서비스 검색") + `<div class="menu-list">${groups || `<p class="menu-empty">일치하는 서비스가 없습니다.</p>`}</div><div class="menu-sep"></div><button type="button" class="menu-item" data-connect-provider="custom">${svg("plus")}<span>직접 추가 (OpenAI 호환)</span></button>`;
	}

	if (type === "picker") {
		const role = ROLES[arg];
		const choice = state.roles[arg];
		const special = (role.specials ?? []).map(([value, label]) => `<button type="button" class="menu-item" data-choose="${esc(arg)}" data-special="${esc(value)}"><span>${esc(label)}</span>${choice?.special === value ? svg("check") : ""}</button>`).join("");
		const providerItems = providersFor(role.capability).map((providerId) => {
			const models = PROVIDERS[providerId].models[role.capability].filter(([, name]) => match(name) || match(PROVIDERS[providerId].label));
			if (!models.length) return "";
			const current = choice?.provider === providerId ? `<small>${esc(modelLabel(providerId, role.capability, choice.model))}</small>` : "";
			const items = models.map(([modelId, name, tag]) => {
				const badge = providerId === role.fallback.provider && modelId === role.fallback.model ? "기본" : tag;
				const selected = choice?.provider === providerId && choice.model === modelId;
				return `<button type="button" class="menu-item" data-choose="${esc(arg)}" data-provider="${esc(providerId)}" data-model="${esc(modelId)}"><span>${esc(name)}</span>${badge ? `<small>${esc(badge)}</small>` : ""}${selected ? svg("check") : ""}</button>`;
			}).join("");
			return `<div class="menu-sub"><button type="button" class="menu-item has-sub" data-sub="${esc(providerId)}">${appIcon(providerId, " sm")}<span>${esc(PROVIDERS[providerId].label)}</span>${current}${svg("chevron")}</button><div class="menu submenu" role="menu">${items}</div></div>`;
		}).join("");
		const connectable = connectableFor(role.capability);
		const reindex = role.reindex ? `<div class="menu-sep"></div><button type="button" class="menu-item" data-reindex-now>${svg("sparkles")}<span>지금 문서 다시 분석</span></button>` : "";
		const footer = (connectable.length ? `<div class="menu-sep"></div><button type="button" class="menu-item" data-menu-swap="connect">${svg("plus")}<span>다른 서비스 연결</span></button>` : "") + reindex;
		const body = providerItems || `<p class="menu-empty">${query ? "일치하는 모델이 없습니다." : "이 역할에 쓸 수 있는 서비스가 아직 연결되지 않았습니다."}</p>`;
		return menuSearch("모델 검색") + `<div class="menu-list">${special}${special && providerItems ? `<div class="menu-sep"></div>` : ""}${body}</div>${footer}`;
	}

	if (type === "provider-more") {
		const provider = PROVIDERS[arg];
		const manage = provider.kind === "subscription"
			? `<button type="button" class="menu-item" data-provider-action="reauth" data-provider="${esc(arg)}">${svg("external")}<span>다시 로그인</span></button>`
			: `<button type="button" class="menu-item" data-provider-action="edit" data-provider="${esc(arg)}">${svg("gear")}<span>연결 정보 수정</span></button>`;
		return `<div class="menu-list">${manage}<button type="button" class="menu-item" data-provider-action="test" data-provider="${esc(arg)}">${svg("check")}<span>연결 확인</span></button><div class="menu-sep"></div><button type="button" class="menu-item danger" data-provider-action="disconnect" data-provider="${esc(arg)}">${svg("x")}<span>연결 해제</span></button></div>`;
	}

	if (type === "thinking") {
		const current = state.thinking[arg];
		return `<p class="menu-group">생각 깊이</p><div class="menu-list">${THINKING_LEVELS.map(([value, label, note]) => `<button type="button" class="menu-item" data-thinking="${esc(arg)}" data-level="${esc(value)}"><span>${esc(label)}</span>${note ? `<small>${esc(note)}</small>` : ""}${current === value ? svg("check") : ""}</button>`).join("")}</div>`;
	}
	return "";
}

/** Pin the open menu to its anchor: below it, flipped above when it would overflow. */
function positionMenu() {
	const menu = $("#menu-root .menu");
	if (!state.menu || !menu) return;
	const anchorEl = state.menu.anchor;
	const pane = $("#content").getBoundingClientRect();
	const anchor = anchorEl.getBoundingClientRect();
	// Close once the anchor is gone or scrolled out of the settings pane.
	if (!anchorEl.isConnected || (anchorEl.closest("#content") && (anchor.bottom < pane.top || anchor.top > pane.bottom))) {
		closeMenu();
		return;
	}
	const width = menu.offsetWidth;
	const height = menu.offsetHeight;
	const below = anchor.bottom + 6;
	// A left-anchored trigger (e.g. the full-width "서비스 연결" row) opens from its visible
	// content's left edge; right-side controls (role pickers, ⋯) open aligned to their right edge.
	const leftAnchored = anchorEl.dataset.menuAlign === "start";
	const content = leftAnchored ? (anchorEl.querySelector(".icon") ?? anchorEl).getBoundingClientRect() : anchor;
	const preferred = leftAnchored ? content.left - 8 : anchor.right - width;
	menu.style.left = `${Math.max(12, Math.min(preferred, window.innerWidth - width - 12))}px`;
	menu.style.top = `${below + height > window.innerHeight - 12 ? Math.max(12, anchor.top - 6 - height) : below}px`;
}

function renderMenu() {
	if (!state.menu) return;
	const width = state.menu.type === "connect" || state.menu.type === "picker" ? 280 : 200;
	$("#menu-root").innerHTML = `<div class="menu" role="menu" data-menu-type="${esc(state.menu.type)}" style="width:${width}px;visibility:hidden">${menuBody()}</div>`;
	positionMenu();
	const menu = $("#menu-root .menu");
	if (!menu) return;
	menu.style.visibility = "";
	const input = $("#menu-root [data-menu-search]");
	if (input) {
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
	}
}

/* ----------------------------------------------------------- Connect flow -- */

function connectForm(providerId) {
	if (providerId === "custom") {
		return {
			title: "OpenAI 호환 서비스 추가",
			intro: "회사 게이트웨이나 OpenAI 호환 서버를 연결합니다. 키는 운영체제의 보안 저장소에 암호화해 보관합니다.",
			fields: [
				{ name: "label", label: "이름", placeholder: "예: 사내 게이트웨이", required: true },
				{ name: "url", label: "서버 주소", placeholder: "https://…/v1", required: true },
				{ name: "key", label: "API 키", placeholder: "선택 사항", type: "password" },
			],
			submit: "추가",
		};
	}
	const provider = PROVIDERS[providerId];
	if (provider.kind === "subscription") {
		return { title: `${provider.label}로 연결`, intro: `AutoRAG가 ${provider.label} 구독으로 지원 모델을 사용합니다. 브라우저에서 ${provider.label}에 로그인해 계정을 연결하세요.`, fields: [], submit: "브라우저에서 연결", external: true };
	}
	if (provider.kind === "local") {
		return { title: "내 컴퓨터 서버 연결", intro: "Ollama, LM Studio처럼 이 Mac에서 실행 중인 서버만 연결할 수 있습니다.", fields: [{ name: "url", label: "서버 주소", placeholder: "http://127.0.0.1:11434", value: provider.url, required: true }], submit: "연결" };
	}
	return {
		title: `${provider.label} 연결`,
		intro: provider.intro ?? `${provider.keyHint ?? `${provider.label}에서 발급한 API 키를 붙여 넣으세요.`} 키는 운영체제의 보안 저장소에 암호화해 보관하며 다시 표시하지 않습니다.`,
		fields: provider.fields ?? [{ name: "key", label: "API 키", placeholder: `예: ${provider.placeholder}`, type: "password", required: true }],
		submit: "연결",
	};
}

function openConnect(providerId, { editing = false } = {}) {
	const form = connectForm(providerId);
	const fields = form.fields.map((field, index) => `<label>${esc(field.label)}<input class="field" data-connect-field="${esc(field.name)}"${field.required ? " required" : ""} type="${field.type ?? "text"}" placeholder="${esc(field.placeholder)}" value="${esc(editing && field.type === "password" ? "" : field.value ?? "")}"${index === 0 ? " autofocus" : ""}></label>`).join("");
	const icon = providerId === "custom" ? `<span class="app-icon">+</span>` : appIcon(providerId);
	modal(`<button type="button" class="modal-close" data-action="close-modal" aria-label="닫기">${svg("x")}</button>${icon}<h2 id="dialog-title">${esc(editing ? `${PROVIDERS[providerId].label} 연결 정보 수정` : form.title)}</h2><p>${esc(form.intro)}</p>${fields}<p class="modal-error" hidden></p><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">취소</button><button type="button" class="btn primary" data-submit-connect="${esc(providerId)}"${editing ? ' data-editing="true"' : ""}>${esc(editing ? "저장" : form.submit)}${form.external ? svg("external") : ""}</button></div>`);
	$("#modal-root input")?.focus();
}

function submitConnect(button) {
	const providerId = button.dataset.submitConnect;
	const missing = [...document.querySelectorAll("#modal-root [data-connect-field][required]")].filter((input) => !input.value.trim());
	if (missing.length) {
		const error = $("#modal-root .modal-error");
		error.textContent = `${missing.map((input) => input.closest("label").firstChild.textContent).join(", ")}을(를) 입력하세요.`;
		error.hidden = false;
		missing[0].focus();
		return;
	}
	if (button.dataset.editing) {
		closeModal();
		toast(`${PROVIDERS[providerId].label} 연결 정보를 저장했습니다.`);
		return;
	}
	let id = providerId;
	if (providerId === "custom") {
		state.customCount += 1;
		id = `custom-${state.customCount}`;
		const value = (name) => $(`#modal-root [data-connect-field="${name}"]`).value.trim();
		PROVIDERS[id] = { label: value("label"), letter: value("label").slice(0, 1).toUpperCase(), kind: "custom", url: value("url"), models: { llm: [[`${id}/default`, "기본 모델"]] } };
	}
	const external = PROVIDERS[id].kind === "subscription";
	button.disabled = true;
	button.textContent = external ? "브라우저에서 로그인 중…" : "연결 확인 중…";
	setTimeout(() => {
		state.providers.push(id);
		closeModal();
		render({ keepScroll: true });
		toast(`${PROVIDERS[id].label}을(를) 연결했습니다. 역할별 모델에서 고를 수 있습니다.`);
	}, external ? 900 : 500);
}

function disconnectProvider(providerId) {
	const affected = Object.entries(state.roles).filter(([, choice]) => choice.provider === providerId).map(([role]) => role);
	const detail = affected.length
		? `${affected.map((role) => ROLES[role].label).join(", ")}은(는) AutoRAG 요금제의 기본 모델로 돌아갑니다.${affected.includes("embed") ? " 문서 이해 모델이 바뀌므로 문서를 다시 분석합니다." : ""}`
		: "이 서비스를 쓰는 역할은 없습니다.";
	modal(`<h2 id="dialog-title">${esc(PROVIDERS[providerId].label)} 연결을 해제할까요?</h2><p>저장된 키를 지우고 목록에서 제거합니다. ${esc(detail)}</p><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">취소</button><button type="button" class="btn danger" data-confirm-disconnect="${esc(providerId)}">연결 해제</button></div>`);
}

function applyChoice(roleId, choice) {
	state.roles[roleId] = choice;
	render({ keepScroll: true });
}

function chooseRole(roleId, choice) {
	const current = state.roles[roleId];
	const same = current && choice && current.provider === choice.provider && current.model === choice.model && current.special === choice.special;
	closeMenu();
	if (same) return;
	if (ROLES[roleId].reindex) {
		state.pendingChoice = { roleId, choice };
		modal(`<h2 id="dialog-title">문서를 다시 분석해야 합니다</h2><p>문서 이해 모델이 바뀌면 기존 분석 결과를 새 모델로 다시 만들어야 합니다. 문서 수에 따라 시간이 걸리고, 끝나기 전에는 의미 검색 결과가 비어 있을 수 있습니다.</p><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">취소</button><button type="button" class="btn primary" data-confirm-choice>변경하고 다시 분석</button></div>`);
		return;
	}
	applyChoice(roleId, choice);
}

function sourcePage(id) {
	const connection = state.connections.find((item) => item.id === id);
	const template = TEMPLATES[connection?.type] ?? {};
	const basic = [];
	if (connection?.type === "slack") basic.push({ id: "workspace", label: "워크스페이스 ID", hint: "Slack 주소창의 T로 시작하는 값입니다.", control: fieldControl("workspace", "text", "예: T0435JHH63Z"), path: `datasources.${id}.connector.workspace` });
	if (connection?.type === "kakao") basic.push({ id: "chatrooms", label: "검색할 채팅방", hint: "비워두면 모든 채팅방을 검색합니다.", control: chipsControl("chatrooms", state.chips.chatrooms), stack: true, path: `datasources.${id}.channels.names` });
	if (connection?.type === "cloud-drive") {
		basic.push({ id: "cloudprovider", label: "클라우드 서비스", hint: "사용 중인 서비스를 선택합니다.", control: selectControl("cloudprovider", ["Google Drive", "OneDrive", "Dropbox", "Box"], state.values.cloudprovider), path: `datasources.${id}.connector.provider` });
		basic.push({ id: "remote", label: "rclone 원격 이름", hint: "클라우드 연결 설정에 등록된 이름입니다.", control: fieldControl("remote", "text", "예: my-drive"), path: `datasources.${id}.connector.remote` });
		basic.push({ id: "exts", label: "가져올 파일 종류", hint: "비워두면 지원하는 문서를 모두 가져옵니다.", control: chipsControl("exts", state.chips.exts), stack: true, path: `datasources.${id}.connector.extensions` });
		basic.push({ id: "cloudocr", label: "사진 속 글자 인식", hint: "스캔 문서의 내용도 검색할 수 있습니다.", control: switchControl("cloudocr", false), path: `datasources.${id}.connector.parserOptions.ocr.enabled` });
	}
	if (connection?.type === "spotlight") basic.push({ id: "onlyin", label: "검색할 폴더", hint: "비워두면 Mac 전체를 검색합니다.", control: fieldControl("onlyin", "text", "예: ~/Documents"), path: `datasources.${id}.connector.onlyIn` });
	if (connection?.type === "github") basic.push({ id: "repos", label: "저장소", hint: "owner/repo 형태로 입력합니다.", control: chipsControl("repos", state.chips.repos), stack: true, path: `datasources.${id}.connector.repos` });
	if (connection?.type === "github-gist") basic.push({ id: "gisttoken", label: "GitHub 토큰", hint: "운영체제의 보안 저장소에 보관합니다.", control: `<span class="status">${svg("check")}저장됨</span><button class="btn quiet" data-action="keychange">키 변경</button>`, path: `datasources.${id}.connector.tokenEnv` });
	if (connection?.type === "obsidian") basic.push({ id: "vault", label: "보관함 폴더", hint: "Obsidian 보관함이 있는 폴더입니다.", control: fieldControl("vault", "text", "예: ~/Documents/Notes"), path: `datasources.${id}.connector.vaultPath` });
	if (connection?.type === "mailcrawl") {
		basic.push({ id: "account", label: "메일 계정", hint: "가져올 계정의 이름입니다.", control: fieldControl("account", "text", "예: gmail"), path: `datasources.${id}.connector.account` });
		basic.push({ id: "mailbox", label: "메일함", hint: "가져올 메일함입니다.", control: fieldControl("mailbox", "text", "INBOX"), path: `datasources.${id}.connector.mailbox` });
	}
	if (connection?.type === "mail-export") basic.push({ id: "mailpaths", label: "메일 파일 위치", hint: "내보낸 .eml·.mbox 파일이 있는 폴더입니다.", control: fieldControl("mailpaths", "text", "예: ~/Documents/mail-backup"), path: `datasources.${id}.connector.paths` });
	if (connection?.type === "rss") basic.push({ id: "feeds", label: "피드 주소", hint: "가져올 RSS·Atom 피드입니다.", control: chipsControl("feeds", state.chips.feeds), stack: true, path: `datasources.${id}.connector.feeds` });
	if (connection?.type === "discord") basic.push({ id: "guild", label: "서버 ID", hint: "Discord 개발자 모드에서 복사한 값입니다.", control: fieldControl("guild", "text", "예: 1234567890"), path: `datasources.${id}.connector.guildId` });
	if (connection?.type === "clawgallery") {
		basic.push({ id: "clawpath", label: "보관함 폴더", hint: "ClawGallery 보관함 위치입니다.", control: fieldControl("clawpath", "text", "예: ~/Pictures/ClawGallery"), path: `datasources.${id}.connector.path` });
		basic.push({ id: "clawsync", label: "사진 정보 함께 분석", hint: "사진의 시각 정보도 검색에 사용합니다.", control: switchControl("clawsync", true), path: `datasources.${id}.connector.syncVisual` });
	}

	const statusRows = [
		{ id: "enabled", label: "사용 여부", hint: "끄면 이 연결을 검색에서 잠시 제외합니다.", control: switchControl(`enabled:${id}`, connection?.enabled ?? true), path: `datasources.${id}.enabled` },
		{ id: "install", label: "도우미 프로그램", hint: connection?.installed ? "설치되어 있습니다." : "이 앱의 내용을 가져오려면 도우미 프로그램이 필요합니다.", control: `<span class="status"><span class="dot ${connection?.installed ? "ok" : "warn"}"></span>${connection?.installed ? "준비됨" : "설치 필요"}</span><button class="btn quiet" data-action="install-help">설치 방법</button>`, path: `install.${connection?.type}` },
		{ id: "agent", label: "AI 검색 허용", hint: connection?.access ? "AI 답변이 이 연결을 참고합니다." : "허용하면 AI 답변이 이 앱의 내용을 참고할 수 있습니다.", control: switchControl(`access:${id}`, connection?.access ?? false), path: "datasourceAccess.allowedTags" },
		{ id: "index", label: "검색 준비", hint: connection?.indexed ? `문서 ${esc(connection.meta ?? "")}` : "지금 동기화를 눌러 내용을 가져오세요.", control: `<span class="status"><span class="dot ${connection?.indexed ? "ok" : "warn"}"></span>${connection?.indexed ? "최신 상태" : "동기화 필요"}</span><button class="btn quiet" data-action="sync" data-id="${esc(id)}">지금 동기화</button>`, path: `datasources.${id}.index`, proposal: "제안" },
	];

	const advancedRows = [
		{ id: "alias", label: "연결 ID", hint: "설정 파일에서 이 연결을 구분하는 이름입니다.", control: fieldControl("alias", "text", "", id), path: `datasources.${id}` },
		{ id: "instance", label: "인스턴스 ID", hint: "내부 경로에 사용되는 값입니다.", control: fieldControl("instance", "text", "기본값"), path: `datasources.${id}.instanceId` },
		{ id: "tags", label: "분류 태그", hint: "AI 접근 정책을 연결하는 분류입니다.", control: chipsControl("tags", state.chips.tags), stack: true, path: `datasources.${id}.tags` },
		{ id: "timeout", label: "검색 시간 제한", hint: "도우미 프로그램을 기다리는 최대 시간입니다.", control: fieldControl("timeout", "number", "기본값 (초)"), path: `datasources.${id}.connector.timeoutMs` },
		{ id: "bin", label: "도우미 프로그램 위치", hint: "비워두면 자동으로 찾습니다.", control: fieldControl("bin", "text", "자동"), path: `datasources.${id}.connector.binaryPath` },
		{ id: "env", label: "환경 변수", hint: "비밀번호나 토큰은 여기에 넣지 마세요.", control: fieldControl("env", "text", "KEY=value"), path: `datasources.${id}.connector.env` },
		...(basic.length && connection?.type === "slack" ? [{ id: "channels", label: "채널 목록", hint: "채널 ID로 검색 범위를 좁힙니다.", control: chipsControl("channels", []), stack: true, path: `datasources.${id}.channels.ids` }] : []),
	];

	return {
		group: "연결된 앱", label: connection?.label ?? id, icon: "plug",
		title: connection?.label ?? id,
		desc: template.desc ?? "",
		notes: ["Needs attention 같은 영문 배지를 준비 단계로 다시 썼습니다.", "연결 ID·인스턴스 ID·실행 환경은 고급 설정으로 옮겼습니다.", "템플릿(유형) 변경 항목을 제거했습니다. 연결을 새로 만드는 흐름으로 대체합니다."],
		sections: [
			{ title: "연결 상태", rows: statusRows },
			...(basic.length ? [{ title: `${template.label} 설정`, rows: basic }] : []),
			{ title: "기본 설정", rows: [
				{ id: "name", label: "연결 이름", hint: "왼쪽 목록에 표시됩니다.", control: fieldControl("name", "text", "", connection?.label ?? ""), path: `datasources.${id}` },
				{ id: "desc", label: "AI에게 알려줄 설명", hint: "이 연결을 언제 참고하면 좋은지 적어주세요.", control: `<textarea class="field" data-field="desc" placeholder="예: 우리 팀의 업무 대화와 공지입니다."></textarea>`, stack: true, path: `datasources.${id}.description` },
				{ id: "poll", label: "동기화 주기", hint: "새로운 내용을 확인하는 간격입니다.", control: selectControl("poll", ["5분", "15분", "30분", "1시간", "6시간", "하루", "수동"], state.values.poll), path: `datasources.${id}.pollingIntervalMs` },
			] },
			{ title: "고급 설정", advanced: true, rows: advancedRows },
			{ title: "연결 해제", rows: [
				{ id: "danger", label: "연결 해제", hint: "AutoRAG 검색에서만 제거되며 원본 앱의 데이터는 지워지지 않습니다.", control: `<button class="btn danger" data-action="delete" data-id="${esc(id)}">연결 해제</button>`, path: `datasources.${id}` },
			] },
		],
	};
}

/* --------------------------------------------------------------- Sidebar -- */

function connectionDot(connection) {
	return `<span class="dot ${connection.installed && connection.access && connection.indexed ? "ok" : connection.enabled ? "warn" : ""}"></span>`;
}

function navItems() {
	const pages = Object.entries(data).map(([id, page]) => ({ id, label: page.label, icon: page.icon, group: page.group }));
	const connections = state.connections.map((connection) => ({ id: `source/${connection.id}`, label: connection.label, icon: null, group: "연결된 앱", extra: connectionDot(connection) }));
	return [...pages, ...connections];
}

function pageSearchText(page) {
	const parts = [page.label, page.title, page.desc, page.keywords ?? ""];
	for (const section of page.sections ?? []) {
		parts.push(section.title, section.desc);
		const rows = Array.isArray(section.rows) ? section.rows : (DYNAMIC_ROWS[section.rows] ?? (() => []))();
		for (const row of rows) {
			if (row.label) parts.push(row.label, row.hint ?? "");
			else if (row.html) parts.push(row.html.replace(/<[^>]*>/g, " "));
		}
	}
	return parts.join(" ").toLowerCase();
}

function renderNav() {
	const query = ($("#settings-search")?.value ?? "").trim().toLowerCase();
	const groups = new Map();
	for (const item of navItems()) {
		if (!groups.has(item.group)) groups.set(item.group, []);
		groups.get(item.group).push(item);
	}
	const html = [...groups.entries()]
		.map(([group, items]) => {
			const visible = items.filter((item) => {
				if (!query) return true;
				if (item.label.toLowerCase().includes(query)) return true;
				if (item.id.startsWith("source/")) return item.label.toLowerCase().includes(query);
				const page = data[item.id];
				return page ? pageSearchText(page).includes(query) : false;
			});
			if (visible.length === 0) return "";
			return `<p class="nav-group">${esc(group)}</p>` + visible.map((item) => {
				const active = state.page === item.id ? " active" : "";
				const icon = item.icon ? `<span class="icon-slot">${svg(item.icon)}</span>` : "";
				return `<button class="nav-item${active}" data-nav="${esc(item.id)}">${icon}<span class="nav-label">${esc(item.label)}</span>${item.extra ?? ""}</button>`;
			}).join("");
		})
		.join("");
	$("#nav").innerHTML = query && !html ? `<p class="nav-empty">일치하는 설정이 없습니다.</p>` : html;
}

/* ---------------------------------------------------------------- Render -- */

function render({ keepScroll = false } = {}) {
	const content = $("#content");
	const scrollTop = keepScroll ? content.scrollTop : 0;
	renderNav();
	if (state.page.startsWith("source/")) {
		const page = sourcePage(state.page.slice("source/".length));
		content.innerHTML = `<div class="content-inner">${pageHead(page)}${page.sections.map(sectionHtml).join("")}</div>`;
	} else {
		const page = data[state.page] ?? data.general;
		content.innerHTML = `<div class="content-inner">${pageHead(page)}${page.sections.map(sectionHtml).join("")}</div>`;
	}
	content.scrollTop = scrollTop;
}

/* ----------------------------------------------------------- Feedback UI -- */

let toastTimer;
function toast(message) {
	const element = $("#toast");
	element.textContent = message;
	element.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => element.classList.remove("show"), 2200);
}

function modal(html) {
	$("#modal-root").innerHTML = `<div class="modal-backdrop" data-close-modal><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
	$("#modal-root input")?.focus();
}

function closeModal() {
	$("#modal-root").innerHTML = "";
}

/* ---------------------------------------------------------------- Events -- */

document.addEventListener("click", (event) => {
	const nav = event.target.closest("[data-nav]");
	if (nav) {
		state.page = nav.dataset.nav;
		history.replaceState(null, "", `#${state.page}`);
		render();
		return;
	}

	if (event.target.closest("#theme-toggle")) {
		state.appearance = state.appearance === "light" ? "dark" : "light";
		document.documentElement.dataset.appearance = state.appearance;
		$("#theme-toggle").textContent = state.appearance === "dark" ? "라이트 모드" : "다크 모드";
		return;
	}

	if (event.target.closest("#notes-toggle")) {
		state.notes = !state.notes;
		document.body.classList.toggle("show-notes", state.notes);
		$("#notes-toggle").setAttribute("aria-pressed", String(state.notes));
		render({ keepScroll: true });
		return;
	}

	const switchButton = event.target.closest("[data-toggle]");
	if (switchButton) {
		const id = switchButton.dataset.toggle;
		const on = switchButton.getAttribute("aria-checked") !== "true";
		switchButton.setAttribute("aria-checked", String(on));
		if (id === "ocr") state.values.ocr = on;
		if (id === "media") state.values.media = on;
		if (id.startsWith("access:")) {
			const connection = state.connections.find((item) => item.id === id.slice(7));
			if (connection) connection.access = on;
		}
		if (id.startsWith("enabled:")) {
			const connection = state.connections.find((item) => item.id === id.slice(8));
			if (connection) connection.enabled = on;
		}
		if (["ocr", "media"].includes(id)) render({ keepScroll: true });
		return;
	}

	const add = event.target.closest("[data-add]");
	if (add) {
		const id = add.dataset.add;
		const template = TEMPLATES[id];
		modal(`<h2>${esc(template.label)} 연결</h2><p>${esc(template.desc)} 연결 이름을 정하고 추가하세요.</p><label>연결 이름<input class="field" id="new-name" value="${esc(template.label)}"></label><div class="modal-actions"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" data-connect="${esc(id)}">연결 추가</button></div>`);
		return;
	}

	const connect = event.target.closest("[data-connect]");
	if (connect) {
		const type = connect.dataset.connect;
		const label = $("#new-name").value.trim() || TEMPLATES[type].label;
		const id = `${type}-${Date.now().toString(36).slice(-3)}`;
		state.connections.push({ id, type, label, hint: "연결 추가됨 · 도우미 프로그램 확인 필요", installed: false, access: false, enabled: true, indexed: false, meta: "" });
		closeModal();
		state.page = `source/${id}`;
		history.replaceState(null, "", `#${state.page}`);
		render();
		toast("연결이 추가되었습니다.");
		return;
	}

	const chipRemove = event.target.closest("[data-chip-remove]");
	if (chipRemove) {
		const [listId, index] = chipRemove.dataset.chipRemove.split(":");
		state.chips[listId]?.splice(Number(index), 1);
		render({ keepScroll: true });
		return;
	}

	const chipAdd = event.target.closest("[data-chip-add]");
	if (chipAdd) {
		const listId = chipAdd.dataset.chipAdd;
		modal(`<h2>항목 추가</h2><p>추가할 값을 입력하세요.</p><label>값<input class="field" id="chip-value"></label><div class="modal-actions"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" data-action="chip-save" data-list="${esc(listId)}">추가</button></div>`);
		return;
	}

	const chipSave = event.target.closest('[data-action="chip-save"]');
	if (chipSave) {
		const value = $("#chip-value").value.trim();
		const listId = chipSave.dataset.list;
		if (value) {
			state.chips[listId] = state.chips[listId] ?? [];
			state.chips[listId].push(value);
			closeModal();
			render({ keepScroll: true });
		}
		return;
	}

	const action = event.target.closest("[data-action]");
	if (action) {
		switch (action.dataset.action) {
			case "close-modal":
				closeModal();
				return;
			case "keychange":
				toast("실제 구현에서는 보안 저장소에 저장합니다.");
				return;
			case "install-help":
				modal(`<h2>도우미 프로그램 설치</h2><p>이 연결은 내용을 가져오는 도우미 프로그램이 필요합니다. 설치 안내 문서를 열어 단계를 따라 진행하세요.</p><div class="modal-actions"><button class="btn primary" data-action="close-modal">확인</button></div>`);
				return;
			case "sync": {
				const connection = state.connections.find((item) => item.id === action.dataset.id);
				if (connection && !connection.installed) {
					toast("도우미 프로그램을 먼저 설치해야 합니다.");
					return;
				}
				if (connection) {
					connection.indexed = true;
					connection.meta = "방금 동기화됨";
					connection.hint = `${connection.label} 검색 · 사용 중`;
				}
				render({ keepScroll: true });
				toast("동기화를 시작했습니다.");
				return;
			}
			case "delete": {
				const id = action.dataset.id;
				const connection = state.connections.find((item) => item.id === id);
				modal(`<h2>연결을 해제할까요?</h2><p>${esc(connection?.label ?? "")} 연결이 AutoRAG 검색에서 제거됩니다. 원본 앱의 데이터는 지워지지 않습니다.</p><div class="modal-actions"><button class="btn" data-action="close-modal">취소</button><button class="btn danger" data-action="delete-confirm" data-id="${esc(id)}">연결 해제</button></div>`);
				return;
			}
			case "delete-confirm": {
				state.connections = state.connections.filter((item) => item.id !== action.dataset.id);
				closeModal();
				state.page = "apps";
				history.replaceState(null, "", "#apps");
				render();
				toast("연결을 해제했습니다.");
				return;
			}
			case "path-add":
				state.searchPaths.push(`~/Documents/새 폴더 ${state.searchPaths.length + 1}`);
				render({ keepScroll: true });
				return;
			case "path-remove":
				state.searchPaths.splice(Number(action.dataset.index), 1);
				render({ keepScroll: true });
				return;
		}
	}

	if (event.target.matches("[data-close-modal]")) closeModal();
});

document.addEventListener("change", (event) => {
	const select = event.target.closest("[data-select]");
	if (!select) return;
	const id = select.dataset.select;
	const value = select.value;
	state.values[id] = value;

	if (id === "appearance") {
		state.appearance = value === "다크" ? "dark" : "light";
		document.documentElement.dataset.appearance = state.appearance;
		$("#theme-toggle").textContent = state.appearance === "dark" ? "라이트 모드" : "다크 모드";
	}
});

document.addEventListener("input", (event) => {
	if (event.target.id === "settings-search") {
		renderNav();
		return;
	}
});

document.addEventListener("toggle", (event) => {
	const details = event.target.closest("[data-advanced]");
	if (details) state.advancedOpen[details.dataset.advanced] = details.open;
}, true);

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		closeModal();
	}
	if (event.key === "Enter" && event.target.id === "chip-value") {
		document.querySelector('[data-action="chip-save"]')?.click();
	}
	if (event.key === "Enter" && event.target.id === "new-name") {
		document.querySelector("[data-connect]")?.click();
	}
});

/* ---------------------------------------------------- AI page events -- */

document.addEventListener("click", (event) => {
	const menuTrigger = event.target.closest("[data-menu]");
	if (menuTrigger) {
		const type = menuTrigger.dataset.menu;
		const arg = menuTrigger.dataset.role ?? menuTrigger.dataset.provider ?? null;
		if (state.menu && state.menu.type === type && state.menu.arg === arg) closeMenu();
		else openMenu(type, menuTrigger, arg);
		return;
	}

	const swap = event.target.closest("[data-menu-swap]");
	if (swap) {
		openMenu(swap.dataset.menuSwap, state.menu.anchor);
		return;
	}

	const connectProvider = event.target.closest("[data-connect-provider]");
	if (connectProvider) {
		closeMenu();
		openConnect(connectProvider.dataset.connectProvider);
		return;
	}

	const submit = event.target.closest("[data-submit-connect]");
	if (submit) {
		submitConnect(submit);
		return;
	}

	const choose = event.target.closest("[data-choose]");
	if (choose) {
		const choice = choose.dataset.special ? { special: choose.dataset.special } : { provider: choose.dataset.provider, model: choose.dataset.model };
		chooseRole(choose.dataset.choose, choice);
		return;
	}

	if (event.target.closest("[data-confirm-choice]")) {
		const { roleId, choice } = state.pendingChoice;
		state.pendingChoice = null;
		closeModal();
		applyChoice(roleId, choice);
		toast("모델을 바꾸고 문서를 다시 분석합니다.");
		return;
	}

	const providerAction = event.target.closest("[data-provider-action]");
	if (providerAction) {
		const id = providerAction.dataset.provider;
		closeMenu();
		if (providerAction.dataset.providerAction === "edit") openConnect(id, { editing: true });
		if (providerAction.dataset.providerAction === "reauth") openConnect(id);
		if (providerAction.dataset.providerAction === "test") toast(`${PROVIDERS[id].label}: 연결 정상`);
		if (providerAction.dataset.providerAction === "disconnect") disconnectProvider(id);
		return;
	}

	const confirmDisconnect = event.target.closest("[data-confirm-disconnect]");
	if (confirmDisconnect) {
		const id = confirmDisconnect.dataset.confirmDisconnect;
		state.providers = state.providers.filter((item) => item !== id);
		for (const [role, choice] of Object.entries(state.roles)) if (choice.provider === id) state.roles[role] = { ...ROLES[role].fallback };
		closeModal();
		render({ keepScroll: true });
		toast(`${PROVIDERS[id].label} 연결을 해제했습니다.`);
		return;
	}

	const thinking = event.target.closest("[data-thinking]");
	if (thinking) {
		state.thinking[thinking.dataset.thinking] = thinking.dataset.level;
		closeMenu();
		toast(`${ROLES[thinking.dataset.thinking].label} 생각 깊이: ${THINKING_LEVELS.find(([value]) => value === thinking.dataset.level)[1]}`);
		return;
	}

	if (event.target.closest('[data-reindex-now]')) {
		closeMenu();
		toast("문서를 다시 분석합니다. 몇 분 정도 걸릴 수 있습니다.");
		return;
	}

	if (state.menu && !event.target.closest("#menu-root")) closeMenu();
});

document.addEventListener("input", (event) => {
	if (!event.target.matches("[data-menu-search]") || !state.menu) return;
	state.menu.query = event.target.value;
	renderMenu();
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && state.menu) closeMenu();
	if (event.key === "Enter" && event.target.matches("[data-connect-field]")) $("#modal-root [data-submit-connect]")?.click();
});

// The menu is fixed-positioned, so it follows its anchor when the pane scrolls or the window resizes.
window.addEventListener("resize", positionMenu);
document.addEventListener("scroll", (event) => { if (!event.target.closest?.(".menu")) positionMenu(); }, true);

/* ------------------------------------------------------------------ Init -- */

window.addEventListener("hashchange", () => {
	state.page = location.hash.slice(1) || "general";
	render();
});

state.page = (location.hash.slice(1) || "general") || "general";
document.documentElement.dataset.appearance = state.appearance;
$("#theme-toggle").textContent = state.appearance === "dark" ? "라이트 모드" : "다크 모드";
$("#search-icon").innerHTML = svg("search", " icon-search");
render();
