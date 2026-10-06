/* Dazzi settings prototype — pure front-end demo.
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

const ICONS = {
	gear: '<path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M10.6 2.7a1 1 0 0 1 .9-.6h1a1 1 0 0 1 .9.6l.3 1.7 1.7 1 .6.7 1.8-.2a1 1 0 0 1 1 .6l.5.9a1 1 0 0 1 0 1l-1.2 1.4.1 1.9.1 2-1.2 1.4a1 1 0 0 0 0 1l.5.9a1 1 0 0 1-1 1.4l-1.8-.2-.6.7-1.7 1-.3 1.7a1 1 0 0 1-1 .6h-1a1 1 0 0 1-.9-.6l-.3-1.7-1.7-1-.6-.7-1.8.2a1 1 0 0 1-1-.6l-.5-.9a1 1 0 0 1 0-1l1.2-1.4-.1-2 .1-1.9-1.2-1.4a1 1 0 0 1 0-1l.5-.9a1 1 0 0 1 1-.6l1.8.2.6-.7 1.7-1Z" transform="translate(0 1.5)"/>',
	shield: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6Z"/><path d="m9.2 12 2 2.2 3.6-4"/>',
	sparkles: '<path d="M12 4.6c.2 3 2 4.8 5 5-3 .2-4.8 2-5 5-.2-3-2-4.8-5-5 3-.2 4.8-2 5-5Z"/><path d="M19.4 13.4c.1 1.5 1 2.4 2.5 2.5-1.5.1-2.4 1-2.5 2.5-.1-1.5-1-2.4-2.5-2.5 1.5-.1 2.4-1 2.5-2.5Z"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4.5-4.5"/>',
	globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.9 5.7 3.9 9S14.5 18.4 12 21c-2.5-2.6-3.9-5.7-3.9-9S9.5 5.6 12 3Z"/>',
	folder: '<path d="M3.5 7.2c0-1 .8-1.7 1.7-1.7H9c.5 0 1 .2 1.4.6l1.2 1.2h7.2c1 0 1.7.8 1.7 1.7v8.8c0 1-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7Z"/>',
	file: '<path d="M6 3.5h8L19 8v11.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h5M8.5 13h7M8.5 16.5h4"/>',
	copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="1.5"/><path d="M5.5 14.5h-1a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1"/>',
	plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5ZM12 16v5"/>',
	sliders: '<path d="M5 3.5v6M5 14v6.5M12 3.5v9M12 17.5v3M19 3.5v3M19 10v10.5"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="8" r="2"/>',
	chevron: '<path d="m9 6 6 6-6 6"/>',
	chevronDown: '<path d="m6 9 6 6 6-6"/>',
	check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
	plus: '<path d="M12 5v14M5 12h14"/>',
	x: '<path d="M6 6l12 12M18 6 6 18"/>',
	info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.4"/>',
	alert: '<path d="M12 4 3 20h18Z"/><path d="M12 10v4.5M12 17.4v.4"/>',
};

const svg = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;

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
	embed: "balanced",
	rerank: false,
	provider: "openrouter",
	model: "anthropic/claude-sonnet-4.5",
	modelQuery: "",
	values: {
		appearance: "라이트",
		language: "한국어",
		poll: "15분",
		dupes: "1시간",
		provider: "OpenRouter",
		embed: "균형",
		ocr: false,
		media: false,
		ocrmode: "자동 (권장)",
		ocrlang: "문서 언어와 같게",
		sync: "자동 선택",
		rerankmodel: "voyageai / rerank-3-lite",
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

const PROVIDER_MODELS = {
	openrouter: [
		["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "추천"],
		["openai/gpt-5", "GPT-5", "추천"],
		["google/gemini-2.5-pro", "Gemini 2.5 Pro"],
		["deepseek/deepseek-v3.2", "DeepSeek V3.2"],
		["qwen/qwen3-max", "Qwen3 Max"],
	],
	openai: [["openai/gpt-5", "GPT-5", "추천"], ["openai/gpt-5-mini", "GPT-5 Mini"], ["openai/o3", "o3"]],
	anthropic: [["anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "추천"], ["anthropic/claude-opus-4", "Claude Opus 4"], ["anthropic/claude-haiku-4.5", "Claude Haiku 4.5"]],
	google: [["google/gemini-2.5-pro", "Gemini 2.5 Pro", "추천"], ["google/gemini-2.5-flash", "Gemini 2.5 Flash"]],
	custom: [],
};

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
		desc: "Dazzi의 화면과 시작 방식을 설정합니다.",
		notes: ["Display & General의 영문 라벨을 정리하고 한국어로 다시 썼습니다.", "문서 언어와 중복 검사는 각각 문서 읽기·중복 파일로 옮겼습니다.", "템플릿 안내 문구(workspacePath, memoryPath)를 제거했습니다."],
		sections: [
			{ title: "화면", rows: [
				{ id: "appearance", label: "화면 모드", hint: "전체 화면에 같은 테마를 적용합니다.", control: selectControl("appearance", ["라이트", "다크"], state.values.appearance), path: "app.appearance" },
				{ id: "language", label: "앱 언어", hint: "메뉴와 설정에 사용할 언어입니다.", control: selectControl("language", ["한국어", "English", "日本語", "简体中文"], state.values.language), path: "app.language" },
			] },
			{ title: "Finder", rows: [
				{ id: "hidden", label: "숨김 파일 보기", hint: "점(.)으로 시작하는 시스템 파일을 Finder에 표시합니다.", control: switchControl("hidden", false), path: "app.showHiddenFiles" },
			] },
			{ title: "시작 및 업데이트", rows: [
				{ id: "launch", label: "로그인할 때 자동 실행", hint: "컴퓨터를 켤 때 Dazzi를 백그라운드에서 시작합니다.", control: switchControl("launch", false), path: "app.launchAtLogin" },
				{ id: "updates", label: "업데이트 자동 설치", hint: "새 버전을 다음 앱 시작 때 자동으로 적용합니다.", control: switchControl("updates", true), path: "app.autoInstallUpdates" },
			] },
		],
	},
	privacy: {
		group: "기본", label: "개인정보 및 보안", icon: "shield",
		title: "개인정보 및 보안",
		desc: "Dazzi가 어떤 정보에 접근하고 무엇을 외부로 보내는지 관리합니다.",
		notes: ["AI 접근 허용과 익명 통계를 한 화면에 모았습니다.", "datasourceAccess.allowedTags·allowedScopes는 고급 설정으로 옮겼습니다."],
		sections: [
			{ title: "AI가 읽을 수 있는 연결", desc: "처음 연결한 앱은 기본적으로 AI 답변에 사용하지 않습니다.", rows: "privacyConnections" },
			{ title: "데이터 처리", rows: [
				{ id: "telemetry", label: "익명 사용 통계 보내기", hint: "문서 내용을 제외한 성능 정보만 전송합니다.", control: switchControl("telemetry", false), path: "app.telemetry" },
				{ id: "sensitive", label: "민감한 파일 색인", hint: "비밀번호·인증서·개인 키와 같은 파일도 분석합니다. 필요할 때만 사용하세요.", control: switchControl("sensitive", false), path: "jikji.includeSensitive" },
			] },
		],
	},
	ai: {
		group: "AI", label: "AI 모델", icon: "sparkles",
		title: "AI 모델",
		desc: "질문에 답하고 문서를 요약할 AI 서비스를 설정합니다.",
		notes: ["Provider Connection의 영문 설명을 줄이고 자주 쓰는 서비스만 먼저 보여줍니다.", "416개 모델 select는 검색 가능한 목록으로 바꿨습니다.", "API 키·서버 주소·통신 방식은 고급 연결 설정으로 접었습니다.", "연결 확인은 현재 브리지에 없는 제안 기능입니다."],
		sections: [
			{ title: "답변 AI", rows: "aiRows" },
			{ title: "고급 연결 설정", desc: "회사 게이트웨이나 자체 서버를 사용할 때만 바꿉니다.", advanced: true, rows: [
				{ id: "base", label: "서버 주소", hint: "비워두면 선택한 서비스의 기본 주소를 사용합니다.", control: fieldControl("base", "text", "https://…"), path: "model.baseUrl" },
				{ id: "protocol", label: "통신 방식", hint: "비워두면 서비스의 기본 방식을 따릅니다.", control: selectControl("protocol", ["자동 (권장)", "OpenAI 호환", "Anthropic 호환"], "자동 (권장)"), path: "model.api" },
				{ id: "keyenv", label: "API 키 환경 변수", hint: "키를 읽어올 환경 변수 이름입니다.", control: fieldControl("keyenv", "text", "OPENROUTER_API_KEY"), path: "model.apiKeyEnv" },
				{ id: "displayname", label: "표시 이름", hint: "모델 목록에 표시할 이름입니다.", control: fieldControl("displayname", "text", "기본값은 모델 이름"), path: "model.name" },
			] },
		],
	},
	quality: {
		group: "AI", label: "검색 품질", icon: "search",
		title: "검색 품질",
		desc: "문서의 의미를 이해하고 검색 결과를 정돈하는 방식을 설정합니다.",
		notes: ["Embedding·Reranker 두 탭을 검색 품질 한 화면으로 합쳤습니다.", "모델 저장과 재색인 버튼을 확인 창 하나로 합쳤습니다.", "문서 분석은 이 컴퓨터에서만 이루어진다는 안내를 항상 표시합니다."],
		sections: [
			{ title: "문서 이해 모델", desc: "문서 내용은 이 Mac 안에서만 분석되며 외부로 전송되지 않습니다.", rows: "embedRows" },
			{ title: "검색 결과 다듬기", desc: "가장 관련 있는 결과를 위로 재정렬합니다. 설정 시 일부 검색 결과가 OpenRouter로 전송됩니다.", rows: [
				{ id: "rerank", label: "검색 결과 다듬기", hint: "정확도가 올라가는 대신 답변이 조금 느려집니다.", control: switchControl("rerank", state.rerank), path: "rerank" },
				...(state.rerank
					? [
						{ id: "rerankmodel", label: "모델", hint: "재정렬에 사용할 모델입니다.", control: selectControl("rerankmodel", ["voyageai / rerank-3-lite", "cohere / rerank-v3.5", "voyageai / rerank-3"], state.values.rerankmodel), path: "rerank.model" },
						{ id: "rerankkey", label: "API 키", hint: "OpenRouter 키를 함께 사용합니다.", control: `<span class="status">${svg("check")}저장됨</span>`, path: "credentials.openrouter" },
					]
					: []),
			] },
			{ title: "고급 조정", desc: "바꿀 필요가 없는 성능 값들입니다.", advanced: true, rows: [
				{ id: "etime", label: "요청 시간 제한", hint: "문서 분석 요청 하나를 기다리는 최대 시간입니다.", control: fieldControl("etime", "number", "기본값 (초)"), path: "minSync.embedder.timeoutMs" },
				{ id: "batch", label: "한 번에 분석할 문서 수", hint: "한 요청에 묶는 문서 수입니다.", control: fieldControl("batch", "number", "기본값"), path: "minSync.embedder.batchSize" },
				{ id: "concurrent", label: "동시 분석 수", hint: "동시에 실행할 분석 개수입니다.", control: fieldControl("concurrent", "number", "기본값"), path: "minSync.embedder.maxConcurrent" },
				{ id: "chunk", label: "문서 조각 크기", hint: "긴 문서를 나누는 글자 수입니다.", control: fieldControl("chunk", "number", "기본값"), path: "minSync.maxChunkSize" },
			] },
		],
	},
	scope: {
		group: "검색", label: "검색 범위", icon: "folder",
		title: "검색 범위",
		desc: "Dazzi가 읽고 검색할 폴더와 제외할 항목을 정합니다.",
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
		desc: "메신저, 메일, 클라우드의 자료를 Dazzi에서 함께 검색합니다.",
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
				{ id: "rules", label: "AI 안내 파일 수정 허용", hint: "AGENTS.md·CLAUDE.md에 Dazzi 안내 블록을 추가합니다.", control: switchControl("rules", false), path: "jikji.writeAgentRules" },
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

function privacyConnections() {
	return state.connections.map((connection) => ({
		id: `access:${connection.id}`,
		label: connection.label,
		hint: connection.access ? "AI 답변에 이 연결의 내용이 사용됩니다." : "허용하기 전에는 AI가 이 앱을 읽지 않습니다.",
		control: switchControl(`access:${connection.id}`, connection.access),
		path: `datasourceAccess.allowedTags`,
	}));
}

function modelName(id) {
	const entry = Object.values(PROVIDER_MODELS).flat().find(([modelId]) => modelId === id);
	return entry ? entry[1] : id;
}

function aiRows() {
	const custom = state.provider === "custom";
	return [
		{ id: "provider", label: "AI 서비스", hint: "키를 붙여 넣으면 안전한 저장소에 보관합니다.", control: selectControl("provider", ["OpenRouter", "OpenAI", "Anthropic", "Google", "직접 입력", "— 그 외 사전 등록 서비스"], state.values.provider), path: "model.provider" },
		...(custom ? [{ id: "customid", label: "서비스 ID", hint: "직접 연결하는 서비스의 영문 ID입니다.", control: fieldControl("customid", "text", "예: ollama"), path: "model.provider" }] : []),
		{ id: "model", label: "모델", hint: "자주 쓰는 모델을 먼저 보여줍니다.", control: `<span class="combo"><button type="button" class="trigger" data-action="combo"><span>${esc(modelName(state.model))}</span>${svg("chevronDown")}</button><div class="popover" id="model-list" hidden><input id="model-input" type="text" placeholder="모델 이름 검색" autocomplete="off"><div class="option-list" id="model-options"></div></div></span>`, path: "model.id", proposal: "제안" },
		{ id: "apikey", label: "API 키", hint: "운영체제의 보안 저장소에 암호화하여 보관합니다.", control: `<span class="status">${svg("check")}저장됨</span><button class="btn quiet" data-action="keychange">키 변경</button><button class="btn quiet" data-action="test">연결 확인</button>`, path: "credentials.openrouter", proposal: "제안" },
	];
}

function embedRows() {
	const endpoint = state.embed === "local";
	return [
		{ id: "embed", label: "문서 분석 모델", hint: "균형은 정확도를, 가벼움은 속도를 우선합니다.", control: selectControl("embed", ["균형 (권장)", "가벼움", "직접 연결"], { balanced: "균형 (권장)", light: "가벼움", local: "직접 연결" }[state.embed]), path: "minSync.embedder" },
		...(endpoint ? [
			{ id: "embedbase", label: "서버 주소", hint: "이 컴퓨터에서 실행 중인 서버만 연결할 수 있습니다.", control: fieldControl("embedbase", "text", "http://127.0.0.1:…"), path: "minSync.embedder.baseUrl" },
			{ id: "embedid", label: "모델 ID", hint: "서버가 안내하는 모델 ID입니다.", control: fieldControl("embedid", "text", "native:Model/id"), path: "minSync.embedder.id" },
		] : []),
		{ id: "embedstatus", label: "분석 상태", hint: "마지막 분석: 오늘 09:42 · 1,284개 문서", control: `<button class="btn" data-action="reindex">${svg("sparkles")}다시 분석</button>`, path: "configRefresh(minsync)" },
	];
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

const DYNAMIC_ROWS = { privacyConnections, aiRows, embedRows, pathRows, sourceRows, galleryRows };


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

function renderModelOptions(filter = "") {
	const query = filter.trim().toLowerCase();
	const pool = state.provider === "custom" ? PROVIDER_MODELS.openrouter : PROVIDER_MODELS[state.provider] ?? [];
	const matches = pool.filter(([id, name]) => !query || id.toLowerCase().includes(query) || name.toLowerCase().includes(query));
	const options = matches.length
		? matches.map(([id, name, tag]) => `<button type="button" class="option" data-model="${esc(id)}"><span>${esc(name)}</span>${tag ? `<small>${esc(tag)}</small>` : ""}</button>`).join("")
		: `<p class="option-empty">일치하는 모델이 없습니다. 아래에 직접 입력할 수도 있습니다.</p>`;
	$("#model-options").innerHTML = options;
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
				{ id: "danger", label: "연결 해제", hint: "Dazzi 검색에서만 제거되며 원본 앱의 데이터는 지워지지 않습니다.", control: `<button class="btn danger" data-action="delete" data-id="${esc(id)}">연결 해제</button>`, path: `datasources.${id}` },
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
	const parts = [page.label, page.title, page.desc];
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
		if (id === "rerank") state.rerank = on;
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
		if (["rerank", "ocr", "media"].includes(id)) render({ keepScroll: true });
		return;
	}

	const comboTrigger = event.target.closest('[data-action="combo"]');
	if (comboTrigger) {
		const popover = $("#model-list");
		popover.hidden = false;
		renderModelOptions($("#model-input").value);
		$("#model-input").focus();
		return;
	}

	const modelOption = event.target.closest("[data-model]");
	if (modelOption) {
		state.model = modelOption.dataset.model;
		closeCombo();
		render({ keepScroll: true });
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
			case "test":
				toast("연결 확인: 정상 (0.4초)");
				return;
			case "reindex":
				toast("문서를 다시 분석합니다. 몇 분 정도 걸릴 수 있습니다.");
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
				modal(`<h2>연결을 해제할까요?</h2><p>${esc(connection?.label ?? "")} 연결이 Dazzi 검색에서 제거됩니다. 원본 앱의 데이터는 지워지지 않습니다.</p><div class="modal-actions"><button class="btn" data-action="close-modal">취소</button><button class="btn danger" data-action="delete-confirm" data-id="${esc(id)}">연결 해제</button></div>`);
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

function closeCombo() {
	const popover = $("#model-list");
	if (popover) popover.hidden = true;
}

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
	if (id === "provider") {
		state.provider = { "OpenRouter": "openrouter", "OpenAI": "openai", "Anthropic": "anthropic", "Google": "google", "직접 입력": "custom" }[value] ?? "openrouter";
		state.values.provider = value;
		render({ keepScroll: true });
	}
	if (id === "embed" && value !== { balanced: "균형 (권장)", light: "가벼움", local: "직접 연결" }[state.embed]) {
		modal(`<h2>모델을 바꾸면 문서를 다시 분석합니다</h2><p>문서 이해 모델이 바뀌면 기존 분석 결과를 새 모델로 다시 만들어야 합니다. 문서 수에 따라 시간이 걸릴 수 있고, 완료 전까지는 의미 검색 결과가 비어 있을 수 있습니다.</p><div class="modal-actions"><button class="btn" data-action="close-modal">취소</button><button class="btn primary" data-action="embed-confirm" data-value="${esc(value)}">변경하고 다시 분석</button></div>`);
		select.value = { balanced: "균형 (권장)", light: "가벼움", local: "직접 연결" }[state.embed];
		return;
	}
});

document.addEventListener("click", (event) => {
	const embedConfirm = event.target.closest('[data-action="embed-confirm"]');
	if (!embedConfirm) return;
	state.embed = { "균형 (권장)": "balanced", "가벼움": "light", "직접 연결": "local" }[embedConfirm.dataset.value] ?? "balanced";
	state.values.embed = embedConfirm.dataset.value;
	closeModal();
	render({ keepScroll: true });
	toast("모델을 바꾸고 문서를 다시 분석합니다.");
});

document.addEventListener("input", (event) => {
	if (event.target.id === "settings-search") {
		renderNav();
		return;
	}
	if (event.target.id === "model-input") {
		renderModelOptions(event.target.value);
	}
});

document.addEventListener("toggle", (event) => {
	const details = event.target.closest("[data-advanced]");
	if (details) state.advancedOpen[details.dataset.advanced] = details.open;
}, true);

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		closeModal();
		closeCombo();
	}
	if (event.key === "Enter" && event.target.id === "chip-value") {
		document.querySelector('[data-action="chip-save"]')?.click();
	}
	if (event.key === "Enter" && event.target.id === "new-name") {
		document.querySelector("[data-connect]")?.click();
	}
});

document.addEventListener("click", (event) => {
	if (!event.target.closest(".combo") && !event.target.closest("[data-model]")) closeCombo();
}, true);

/* ------------------------------------------------------------------ Init -- */

window.addEventListener("hashchange", () => {
	state.page = location.hash.slice(1) || "general";
	render();
});

state.page = (location.hash.slice(1) || "general") || "general";
document.documentElement.dataset.appearance = state.appearance;
$("#theme-toggle").textContent = state.appearance === "dark" ? "라이트 모드" : "다크 모드";
render();
