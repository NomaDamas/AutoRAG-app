/* Dazzi mobile remote prototype — every Settings page.
 *
 * Each desktop page (components/SettingsView.tsx + settings/*.tsx) becomes an
 * iOS settings list: the page title is the large title, a desktop Section is an
 * inset group with its description as the footer, a Row is a cell with the
 * hint as its subtitle, a <select> becomes a cell whose value opens a choice
 * menu, and a modal becomes a sheet. Labels are the desktop's ko.json strings.
 * Pages that only make sense with a keyboard and mouse (단축키) are drawn but
 * read-only; pages whose action opens the desktop's own browser (로그인, 결제)
 * say where it happens. */
"use strict";

const SET = {
	theme: "light", language: "한국어", hidden: false, remote: true, launch: true, shellMenu: true, autoUpdate: true,
	crash: true, stats: false, docLangs: ["한국어", "English"], web: true, webProvider: "자동 선택", webRead: true,
	exact: true, near: true, dupInterval: "1시간", watch: true, localInterval: "15분",
	scopeFolders: ["~/Documents", "~/Desktop", "D:\\KBO_ost", "D:\\EDAI 영상"], excludes: ["node_modules", "dist", "*.tmp"],
	thinking: "보통", answerModel: "Claude Opus 5.5", split: "답변 모델과 같게", judge: "기본값 (Jev)", rerank: "사용 안 함",
	sidebar: { favorites: true, cloud: true, connections: true, locations: true, tags: true },
	sidebarItems: { "최근 항목": true, "홈": true, "데스크탑": true, "문서": true, "다운로드": true, "음악": false, "동영상": false, "사진": true, "휴지통": true },
	menuSections: { "열기 및 미리보기": true, "매직 액션": true, "인덱싱": true, "클립보드 및 이름 변경": true, "파일 작업 (폴더·압축·공유)": true, "시스템 서비스": false, "태그": true, "휴지통": true },
	magic: { pdf3: true, sha: true, imgtable: true, lyrics: false },
	mcpReadOnly: false,
	mcpServers: [
		{ name: "filesystem", kind: "명령 실행", expose: "필요할 때 불러오기", on: true },
		{ name: "linear", kind: "HTTP", expose: "모델에 직접 제공", on: false },
	],
	sources: [
		{ id: "discord", label: "Discord", alias: "NomaDamas", status: "ok", meta: "메시지 12,480개 · 자동 3분 전 성공", interval: "5분", on: true, icon: "message-circle", tint: "#5865F2" },
		{ id: "mail", label: "Mail", alias: "Gmail", status: "ok", meta: "메일 2,310개 · 자동 41분 전 성공", interval: "1시간", on: true, icon: "mail", tint: "#EA4335" },
		{ id: "kakao", label: "KakaoTalk", alias: "kakao", status: "warn", meta: "KakaoTalk 컴퓨터 앱 필요", interval: "15분", on: true, icon: "message-circle", tint: "#FAE100", ink: "#3C1E1E" },
		{ id: "rss", label: "RSS / News", alias: "news", status: "off", meta: "꺼짐", interval: "하루", on: false, icon: "rss", tint: "#F26522" },
	],
};

const INTERVALS = ["직접", "5분", "15분", "30분", "1시간", "6시간", "하루"];
const CHOICES = {
	theme: { title: "화면 모드", options: [["light", "라이트"], ["dark", "다크"]] },
	language: { title: "앱 언어", options: ["한국어", "English", "日本語", "简体中文"].map((x) => [x, x]) },
	webProvider: { title: "검색 서비스", options: ["자동 선택", "Parallel", "DuckDuckGo", "Gemini", "Anthropic", "OpenAI", "xAI", "Perplexity", "SearXNG", "Startpage", "Ecosia", "Google", "Mojeek", "Public Web"].map((x) => [x, x]) },
	dupInterval: { title: "검사 주기", options: ["15분", "30분", "1시간", "3시간", "6시간", "12시간", "하루"].map((x) => [x, x]) },
	localInterval: { title: "로컬 폴더 최신화 주기", options: INTERVALS.map((x) => [x, x]) },
	thinking: { title: "생각 깊이", options: [["생각 안 함", "생각 안 함", "가장 빠름"], ["낮음", "낮음"], ["보통", "보통"], ["높음", "높음", "정확도 우선"], ["최대", "최대", "가장 느림"]] },
	answerModel: { title: "답변 모델", options: [["Claude Opus 5.5", "Claude Opus 5.5", "Anthropic · 구독 계정"], ["GPT-6", "GPT-6", "OpenAI · API 키"], ["Dazzi 관리형", "Dazzi 관리형", "Dazzi 요금제"]] },
	split: { title: "질문 나누기", options: [["답변 모델과 같게", "답변 모델과 같게"], ["기본값 (OpenRouter Qwen3.7 Flash)", "기본값 (OpenRouter Qwen3.7 Flash)"]] },
	judge: { title: "판단 모델 (Jev)", options: [["기본값 (Jev)", "기본값 (Jev)"], ["답변 모델과 같게", "답변 모델과 같게"], ["사용 안 함", "사용 안 함"]] },
	rerank: { title: "검색 결과 정렬", options: [["사용 안 함", "사용 안 함"], ["기본값", "기본값"]] },
	docLangAdd: { title: "문서 언어", options: ["한국어", "English", "日本語", "简体中文", "繁體中文", "Français", "Deutsch", "Español", "Русский", "Italiano", "Português", "Tiếng Việt", "ไทย", "العربية", "हिन्दी"].map((x) => [x, x]) },
};

const SETTINGS_PAGES = [
	{ group: "계정", items: [["account", "내 계정", "user", "#8E8E93"], ["plan", "구독 및 사용량", "credit-card", "#34C759"]] },
	{ group: "기본", items: [["general", "일반", "settings", "#8E8E93"], ["sidebar", "사이드바", "panel-left", "#0A84FF"], ["contextMenu", "우클릭 메뉴", "mouse-pointer-click", "#5E5CE6"], ["shortcuts", "단축키", "keyboard", "#636366"]] },
	{ group: "AI", items: [["ai", "AI 모델", "cpu", "#AF52DE"], ["web", "웹 검색", "globe", "#007AFF"], ["mcp", "MCP 서버", "plug", "#FF9500"]] },
	{ group: "검색", items: [["indexing", "인덱싱", "database", "#30B0C7"], ["scope", "검색 범위", "folder-sync", "#0A84FF"], ["reading", "문서 읽기", "languages", "#FF2D55"], ["duplicates", "중복 파일 정리", "files", "#FF9500"]] },
];
const PAGE_TITLE = Object.fromEntries(SETTINGS_PAGES.flatMap((g) => g.items.map(([id, label]) => [id, label])));
PAGE_TITLE.apps = "연결된 앱";

/* ---------------------------------------------------------------- Pieces -- */

const iconTile = (icon, tint, ink = "#fff") => `<span class="cell-icon"><span class="tile" style="background:${tint};color:${ink}">${svg(icon, 17, 2.2)}</span></span>`;
const sw = (key, on, label) => `<button class="switch ${on ? "is-on" : ""}" data-act="set-toggle" data-arg="${key}" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}"></button>`;
/** A settings row: label, hint under it, and a trailing control (switch, value, button).
 * A tappable row is a div with role=button: its tail may hold a real <button>. */
const srow = ({ title, hint = "", tail = "", act = "", arg = "", cls = "", icon = "", chev = false }) =>
	`<div class="cell srow ${cls}" ${act ? `role="button" tabindex="0" data-act="${act}" data-arg="${esc(arg)}"` : ""}>${icon}<span class="cell-main"><b>${title}</b>${hint ? `<small class="wrap">${hint}</small>` : ""}</span>${tail}${chev ? svg("chevron-right", 18, 2.4).replace('class="icon"', 'class="icon chev-r"') : ""}</div>`;
const toggleRow = (key, title, hint) => srow({ title, hint, tail: sw(key, SET[key], title) });
const choiceRow = (key, title, hint = "", { disabled = false } = {}) => {
	const value = CHOICES[key]?.options.find((o) => o[0] === SET[key])?.[1] ?? SET[key];
	return srow({ title, hint, tail: `<span class="cell-value">${esc(value)}</span>${svg("chevrons-up-down", 16, 2.2).replace('class="icon"', 'class="icon chev-r"')}`, act: disabled ? "" : "set-choice", arg: key, cls: disabled ? "is-disabled" : "" });
};
const btnRow = (title, hint, label, act, arg = "", cls = "") => srow({ title, hint, tail: `<button class="pill-btn ${cls}" data-act="${act}" data-arg="${esc(arg)}">${label}</button>` });
const group = (title, rows, foot = "") => `<section class="section"><div class="section-head"><span>${esc(title)}</span></div><div class="group">${rows.join("")}</div>${foot ? `<div class="section-foot">${foot}</div>` : ""}</section>`;
const plainGroup = (rows, foot = "") => `<section class="section"><div class="group">${rows.join("")}</div>${foot ? `<div class="section-foot">${foot}</div>` : ""}</section>`;
const note = (text, tone = "") => `<div class="snote ${tone}">${svg(tone === "warn" ? "triangle-alert" : "info", 16, 2.2)}<span>${text}</span></div>`;
const pageHead = (title, desc) => `<div class="large"><h1><span class="h1-text">${esc(title)}</span></h1><div class="sub wrap">${esc(desc)}</div></div>`;
const statusDot = (s) => `<span class="status-dot ${s === "ok" ? "ok" : s === "warn" ? "fail" : "never"}"></span>`;
const aiHero = (title, desc, arg) => `<div class="ai-hero"><img src="../../../src/renderer/src/assets/dazzi-mark.png" alt=""><div><b>${esc(title)}</b><small>${esc(desc)}</small></div><button class="pill-btn is-primary" data-act="set-ai-custom" data-arg="${esc(arg)}">${svg("sparkles", 15, 2.2)}AI로 커스텀하기</button></div>`;
const presets = (items) => `<div class="toolbar-row">${items.map((p) => `<button class="chip" data-act="set-preset" data-arg="${esc(p)}">${esc(p)}</button>`).join("")}</div>`;

/* ----------------------------------------------------------------- Index -- */

function settingsIndex() {
	const account = `<section class="section"><div class="group"><button class="cell account-card" data-act="set-page" data-arg="account"><img class="acct-mark" src="../../../src/renderer/src/assets/dazzi-mark.png" alt=""><span class="cell-main"><b>Dazzi 계정</b><small>dongkyu@example.com</small></span><span class="plan-badge">Pro</span>${svg("chevron-right", 18, 2.4).replace('class="icon"', 'class="icon chev-r"')}</button><button class="cell usage-cell" data-act="set-page" data-arg="plan"><span class="cell-main"><b>이번 달 AI 사용량</b><span class="cap-bar"><i style="width:38%"></i></span><small>38% · 다음 초기화까지 12일 6시간</small></span>${svg("chevron-right", 18, 2.4).replace('class="icon"', 'class="icon chev-r"')}</button></div></section>`;
	const connected = `<div class="conn-strip"><span class="live-dot"></span><div><b>${esc(PC_NAME)}</b><small>원격 접속 · 192.168.0.12:47833 · Dazzi 2.8.0</small></div></div>`;
	const groups = SETTINGS_PAGES.filter((g) => g.group !== "계정").map((g) =>
		group(g.group, g.items.map(([id, label, icon, tint]) => srow({ title: label, icon: iconTile(icon, tint), act: "set-page", arg: id, chev: true, tail: indexValue(id) }))),
	).join("");
	const apps = group("연결된 앱", [
		srow({ title: "모든 연결", icon: iconTile("puzzle", "#34C759"), act: "set-page", arg: "apps", chev: true, tail: `<span class="cell-value">${SET.sources.length}개</span>` }),
		...SET.sources.map((s) => srow({ title: `${esc(s.label)} · ${esc(s.alias)}`, hint: esc(s.meta), icon: iconTile(s.icon, s.tint, s.ink), act: "set-source", arg: s.id, chev: true, tail: statusDot(s.status) })),
	]);
	return { nav: `${backBtn()}${navTitle("설정")}`, body: `${large("설정")}${connected}${account}${groups}${apps}` };
}
function indexValue(id) {
	const v = { general: SET.theme === "dark" ? "다크" : "라이트", web: SET.web ? "켬" : "끔", ai: SET.answerModel, indexing: "인덱싱 중 2/3", scope: `폴더 ${SET.scopeFolders.length}개`, mcp: `${SET.mcpServers.filter((s) => s.on).length}개 사용 중` }[id];
	return v ? `<span class="cell-value">${esc(v)}</span>` : "";
}

/* ----------------------------------------------------------------- Pages -- */

function settingsPage(id) {
	const page = {
		account: accountPage, plan: planPage, general: generalPage, sidebar: sidebarPage, contextMenu: contextMenuPage,
		shortcuts: shortcutsPage, ai: aiPage, web: webPage, mcp: mcpPage, indexing: indexingPage, scope: scopePage,
		reading: readingPage, duplicates: duplicatesPage, apps: appsPage,
	}[id]();
	return { nav: `${backBtn()}${navTitle(PAGE_TITLE[id])}`, body: page };
}

function accountPage() {
	return `${pageHead("내 계정", "Dazzi 계정과 로그인 상태입니다.")}
${group("프로필", [
		srow({ title: "Dazzi 계정", hint: "dongkyu@example.com", icon: `<span class="cell-icon"><img class="acct-mark sm" src="../../../src/renderer/src/assets/dazzi-mark.png" alt=""></span>`, tail: `<button class="pill-btn" data-act="set-desktop" data-arg="로그아웃">로그아웃</button>` }),
		btnRow("관리형 모델 사용", "AI 검색에 이 계정의 모델을 사용합니다.", "계정 모델로 설정", "set-managed"),
	], "로그인과 로그아웃은 데스크탑의 브라우저에서 진행돼요. 비밀번호는 Dazzi에 입력되지 않습니다.")}
${group("약관 및 정책", ["서비스 약관", "개인정보처리방침", "수용 가능한 사용 정책", "하위 처리자"].map((t) => srow({ title: t, cls: "is-accent", act: "set-link", arg: t, tail: svg("external-link", 16, 2.2).replace('class="icon"', 'class="icon chev-r"') })))}`;
}
function planPage() {
	return `${pageHead("구독 및 사용량", "현재 요금제와 AI 사용량입니다.")}
<div class="plan-hero"><div class="ring-big"><svg viewBox="0 0 120 120" width="120" height="120"><circle cx="60" cy="60" r="50" fill="none" stroke="var(--m-fill-2)" stroke-width="12"/><circle cx="60" cy="60" r="50" fill="none" stroke="var(--m-accent)" stroke-width="12" stroke-linecap="round" stroke-dasharray="314.16" stroke-dashoffset="${(314.16 * 0.62).toFixed(1)}" transform="rotate(-90 60 60)"/></svg><b>38%</b></div><div><small>현재 요금제</small><b>Pro</b><small>다음 초기화까지 12일 6시간</small></div></div>
${group("현재 요금제", [
		srow({ title: "현재 요금제", tail: `<span class="cell-value strong">Pro</span>` }),
		srow({ title: "결제·요금제 관리", hint: "대시보드는 이 기기의 브라우저에서 열려요.", cls: "is-accent", act: "set-link", arg: "대시보드", tail: `<span class="cell-value accent">대시보드 열기</span>${svg("external-link", 16, 2.2).replace('class="icon"', 'class="icon chev-r"')}` }),
	])}
${group("사용량", [
		srow({ title: "AI 사용량", tail: `<span class="cell-value strong">38%</span>` }),
		srow({ title: "다음 초기화까지", tail: `<span class="cell-value strong">12일 6시간</span>` }),
		srow({ title: "초기화 일시", tail: `<span class="cell-value">2026. 11. 15. 오전 9:00</span>` }),
	])}`;
}
function generalPage() {
	return `${pageHead("일반", "Dazzi의 화면과 시작 방식을 설정합니다.")}
${group("화면", [choiceRow("theme", "화면 모드", "전체 화면에 같은 테마를 적용합니다."), choiceRow("language", "앱 언어", "메뉴와 설정에 사용할 언어입니다.")])}
${group("Finder", [toggleRow("hidden", "숨김 파일 보기", "점(.)으로 시작하는 시스템 파일을 목록에 표시합니다.")], "파일 탐색 화면의 동작입니다.")}
${group("원격 접속", [
		srow({ title: "원격 접속 허용", hint: "다른 기기의 브라우저에서 이 Dazzi를 엽니다.", tail: `<span class="lock-badge">${svg("lock", 13, 2.4)}지금 사용 중</span>` }),
		srow({ title: "브라우저 주소", hint: "http://192.168.0.12:47833", tail: `<button class="pill-btn" data-act="set-copy-address">주소 복사</button>` }),
		srow({ title: "포트", tail: `<span class="cell-value">47833</span>` }),
	], "HTTP는 암호화되지 않습니다. 신뢰할 수 있는 네트워크나 암호화된 터널에서만 사용하세요. 원격 접속을 끄거나 포트를 바꾸면 이 연결이 끊기므로, 이 화면에서는 바꿀 수 없어요.")}
${group("시작 및 업데이트", [
		toggleRow("launch", "로그인할 때 자동 실행", ""),
		toggleRow("shellMenu", "파일 우클릭 메뉴에 추가", ""),
		toggleRow("autoUpdate", "업데이트 자동 설치", ""),
		srow({ title: "앱 업데이트", hint: "현재 버전 2.8.0 · 최신 버전입니다", tail: `<button class="pill-btn" data-act="set-desktop" data-arg="업데이트 확인">업데이트 확인</button>` }),
	], "업데이트 설치와 재시작은 데스크탑에서 해요.")}
${group("개인정보", [toggleRow("crash", "오류 보고서 보내기", "앱 오류가 나면 오류 위치와 기기 정보를 보냅니다. 파일 내용은 보내지 않습니다."), toggleRow("stats", "사용 통계 보내기", "어떤 기능을 쓰는지만 익명으로 보냅니다.")])}
${docLanguageGroup("문서를 읽고 검색할 때 우선 사용할 언어입니다.")}`;
}
function docLanguageGroup(foot) {
	const chips = SET.docLangs.map((l) => `<span class="lang-chip">${esc(l)}<button data-act="set-lang-remove" data-arg="${esc(l)}" aria-label="${esc(l)} 빼기">${svg("x", 12, 3)}</button></span>`).join("");
	return group("문서 언어", [
		srow({ title: "문서 언어", hint: "여러 개를 선택할 수 있습니다." }),
		`<div class="chip-wrap">${chips}<button class="lang-chip is-add" data-act="set-lang-add">${svg("plus", 13, 2.6)}언어 선택…</button></div>`,
		srow({ title: "기본값으로 되돌리기", cls: "is-accent", act: "set-lang-reset" }),
	], foot);
}
function sidebarPage() {
	const items = Object.entries(SET.sidebarItems).map(([label, on]) => srow({ title: label, icon: `<span class="cell-icon grip">${svg("grip-vertical", 18, 2)}</span>`, tail: sw(`sidebarItems.${label}`, on, label) }));
	const locked = ["AI 검색", "자동화"].map((label) => srow({ title: label, icon: `<span class="cell-icon grip off">${svg("lock", 16, 2.2)}</span>`, tail: `<span class="lock-badge">항상 표시</span>` }));
	const sections = [["cloud", "클라우드", "연결된 클라우드 드라이브가 없습니다."], ["connections", "연결 앱 첨부 폴더", "Discord 첨부 파일"], ["locations", "위치", "Local Disk (C:) · Python (D:)"], ["tags", "태그", "빨간색 · 주황색 · 파란색 외 2개"]];
	return `${pageHead("사이드바", "둘러보기 탭에 표시할 항목과 섹션 순서를 구성하거나 AI 어시스턴트에게 말로 요청합니다.")}
${aiHero("AI로 사이드바 및 앱 커스텀", "“음악과 동영상은 숨기고 다운로드를 맨 위로 올려줘”", "sidebar")}
${presets(["전체 표시", "핵심만 표시", "기본값으로 복원"])}
${group(`즐겨찾기 · ${Object.values(SET.sidebarItems).filter(Boolean).length + 2}/${Object.keys(SET.sidebarItems).length + 2} 표시`, [...locked, ...items, srow({ title: "폴더 추가…", cls: "is-accent", icon: `<span class="cell-icon">${svg("plus", 20, 2.2)}</span>`, act: "set-sheet", arg: "addFavorite" })], "AI 검색과 자동화는 필수 항목으로 숨길 수 없습니다. 길게 눌러 끌면 순서를 바꿀 수 있어요.")}
${group("섹션", sections.map(([key, label, hint]) => srow({ title: label, hint, icon: `<span class="cell-icon grip">${svg("grip-vertical", 18, 2)}</span>`, tail: sw(`sidebar.${key}`, SET.sidebar[key], label) })), "즐겨찾기 섹션은 항상 표시됩니다.")}`;
}
function contextMenuPage() {
	const badge = { agent: "AI 분석", script: "스크립트" };
	const magic = MAGIC_ACTIONS.map((a) => srow({ title: `${esc(a.label)} <span class="mini-badge ${a.mode}">${a.id === "imgtable" ? "AI 작업" : badge[a.mode]}</span>`, hint: a.exts ? `파일만 · ${a.exts.map((e) => `.${e}`).join(" ")}` : "단일·복수 모두 · 파일·폴더", icon: iconTile(a.mode === "agent" ? "sparkles" : "terminal", a.mode === "agent" ? "#AF52DE" : "#636366"), act: "set-sheet", arg: `magic:${a.id}`, tail: sw(`magic.${a.id}`, SET.magic[a.id], a.label) }));
	const sections = Object.entries(SET.menuSections).map(([label, on]) => label === "태그"
		? srow({ title: label, hint: "태그 색상 및 목록", icon: `<span class="cell-icon grip off">${svg("lock", 16, 2.2)}</span>`, tail: `<span class="lock-badge">항상 표시</span>` })
		: srow({ title: label, hint: MENU_SECTION_ITEMS[label], icon: `<span class="cell-icon grip">${svg("grip-vertical", 18, 2)}</span>`, tail: sw(`menuSections.${label}`, on, label) }));
	return `${pageHead("우클릭 메뉴", "파일을 길게 누르거나 우클릭했을 때 표시할 메뉴 항목과 나만의 매직 액션(스크립트 및 AI 에이전트 루프)을 구성합니다.")}
${aiHero("AI로 우클릭 메뉴 및 매직 액션 커스텀", "“이미지 여러 개 우클릭하면 해상도랑 용량 표로 정리해주는 매직 액션 만들어줘”", "contextMenu")}
${presets(["전체 표시", "핵심만 표시", "기본값으로 복원"])}
${group("나만의 매직 액션", [...magic, srow({ title: "매직 액션 추가…", cls: "is-accent", icon: `<span class="cell-icon">${svg("plus", 20, 2.2)}</span>`, act: "set-sheet", arg: "magic:new" })], "우클릭한 파일을 입력으로 받아 스크립트나 AI 에이전트를 실행합니다.")}
${group("메뉴 섹션 및 항목", sections, "각 섹션의 순서와 기본 메뉴 항목의 표시 여부를 정합니다. 휴대폰 메뉴에서는 자주 쓰는 항목이 위쪽 버튼으로 모입니다.")}`;
}
const MENU_SECTION_ITEMS = {
	"열기 및 미리보기": "훑어보기 · 열기 · 상위 폴더에서 보기",
	"매직 액션": "나만의 매직 액션 목록",
	"인덱싱": "인덱싱 포함 / 제외",
	"클립보드 및 이름 변경": "복사 · 붙여넣기 · 잘라내기 · 복제 · 이름 변경 · 경로 복사",
	"파일 작업 (폴더·압축·공유)": "새 폴더 · 압축 해제 · 압축 (ZIP) · 7z로 압축",
	"시스템 서비스": "서비스 하위 메뉴 · 데스크탑 전용",
	"휴지통": "휴지통으로 이동 / 복원",
};
function shortcutsPage() {
	const groups = [
		["창 및 탐색", [["검색창 포커스", "⌘ F"], ["AI 검색 열기", "⌘ K"], ["설정 열기", "⌘ ,"], ["새 탭", "⌘ T"], ["탭 닫기", "⌘ W"], ["상위 폴더로 이동", "⌘ ↑"]]],
		["보기 전환", [["아이콘 보기", "⌘ 1"], ["목록 보기", "⌘ 2"], ["계층 보기", "⌘ 3"]]],
		["파일 작업", [["훑어보기 (Quick Look)", "Space"], ["새 폴더", "⇧ ⌘ N"], ["이름 변경", "↩"], ["복사", "⌘ C"], ["붙여넣기", "⌘ V"], ["휴지통으로 이동", "⌘ ⌫"], ["실행 취소", "⌘ Z"]]],
		["AI 검색", [["새 대화 시작", "⌘ N"], ["대화 기록 토글", "⌘ Y"]]],
	];
	return `${pageHead("단축키", "Dazzi의 기본 단축키를 키보드 녹화, UI 선택, 또는 AI 대화로 편집합니다.")}
${note("단축키는 키보드로 녹화해 바꿔요. 이 기기에서는 목록만 볼 수 있고, AI에게 말로 바꿔 달라고 할 수 있어요.")}
${aiHero("AI로 단축키 커스텀", "“이름 변경은 F2로 바꾸고 검색창 포커스는 커맨드 P로 해줘”", "shortcuts")}
${groups.map(([title, rows]) => group(title, rows.map(([label, keys]) => srow({ title: label, tail: `<span class="kbd">${keys.split(" ").map((k) => `<kbd>${esc(k)}</kbd>`).join("")}</span>` })))).join("")}
<div class="section-foot" style="padding-top:12px">${MAGIC_ACTIONS.length + 22}개 동작 · 2개 사용자 지정</div>`;
}
function aiPage() {
	const services = [
		{ name: "Anthropic", meta: "구독 계정 · 답변에 사용 중", letter: "A", tint: "#D97757" },
		{ name: "OpenAI", meta: "API 키 · 사용 안 함", letter: "O", tint: "#10A37F" },
		{ name: "Dazzi", meta: "Dazzi 요금제 · 검색 보조에 사용 중", letter: "D", tint: "#0A84FF" },
	];
	return `${pageHead("AI 모델", "AI 서비스를 연결하고, 역할마다 쓸 모델을 고릅니다.")}
${group("연결된 서비스", [...services.map((s) => srow({ title: s.name, hint: s.meta, icon: `<span class="cell-icon"><span class="tile letter" style="background:${s.tint}">${s.letter}</span></span>`, tail: `<button class="row-more" data-act="set-service" data-arg="${esc(s.name)}" aria-label="${esc(s.name)} 메뉴">${svg("ellipsis", 20)}</button>` })), srow({ title: "서비스 연결", cls: "is-accent", icon: `<span class="cell-icon">${svg("plus", 20, 2.2)}</span>`, act: "set-sheet", arg: "connectService" })], "연결한 서비스의 모델을 아래 역할에서 고를 수 있습니다.")}
${group("답변", [choiceRow("answerModel", "답변 모델", "질문에 답하고 문서를 요약합니다."), choiceRow("thinking", "생각 깊이", "")])}
${group("검색 보조", [choiceRow("split", "질문 나누기", "긴 질문을 검색어 여러 개로 나눕니다."), choiceRow("judge", "판단 모델 (Jev)", "바로 답할지, 내 자료를 검색할지 판단합니다."), choiceRow("rerank", "검색 결과 정렬", "관련 높은 결과를 위로 올립니다.")], "Dazzi는 일을 역할별로 나눠 처리합니다.")}
${group("문서 이해", [srow({ title: "문서 이해 모델", hint: "이 컴퓨터 · Qwen3 Embedding 0.6B (1024차원)", tail: `<span class="cell-value">내 컴퓨터</span>` })], "모델은 바꿀 수 없습니다. 문서 내용은 이 컴퓨터 밖으로 보내지 않아요.")}`;
}
function webPage() {
	return `${pageHead("웹 검색", "최신 정보가 필요한 질문에 인터넷 검색 결과를 답변에 사용합니다.")}
${group("웹 검색 사용", [
		toggleRow("web", "웹 검색 사용", "질문이 검색 서비스로 전송될 수 있습니다."),
		choiceRow("webProvider", "검색 서비스", SET.web ? "기본값은 자동 선택입니다." : "웹 검색을 켜야 선택할 수 있습니다.", { disabled: !SET.web }),
		SET.web ? toggleRow("webRead", "웹페이지 내용 읽기", "검색 결과 링크의 본문을 답변에 참고합니다.") : srow({ title: "웹페이지 내용 읽기", hint: "웹 검색을 켜야 선택할 수 있습니다.", cls: "is-disabled" }),
	])}`;
}
function mcpPage() {
	const servers = SET.mcpServers.map((s, i) => srow({ title: esc(s.name), hint: `${s.kind} · ${s.expose}`, icon: iconTile(s.kind === "HTTP" ? "globe" : "terminal", s.on ? "#FF9500" : "#8E8E93"), act: "set-sheet", arg: `mcp:${i}`, tail: sw(`mcp.${i}`, s.on, s.name) }));
	return `${pageHead("MCP 서버", "Dazzi를 다른 에이전트에 연결하고, 외부 MCP 서버를 Dazzi에 연결합니다.")}
${group("다른 에이전트에 연결", [
		`<div class="seg-wrap"><div class="seg">${["Claude", "Codex", "Gemini", "Cursor", "직접 입력"].map((t, i) => `<button class="${i === 0 ? "is-on" : ""}">${t}</button>`).join("")}</div></div>`,
		srow({ title: "명령어", hint: `<code>autorag mcp serve</code>`, tail: `<button class="pill-btn" data-act="set-copied">복사</button>` }),
		toggleRow("mcpReadOnly", "읽기 전용", "색인 새로고침과 리포트 저장 도구를 숨겨 검색만 할 수 있게 합니다."),
	])}
${group("Dazzi에 연결된 서버", [...servers, srow({ title: "서버 추가", cls: "is-accent", icon: `<span class="cell-icon">${svg("plus", 20, 2.2)}</span>`, act: "set-sheet", arg: "mcp:new" })], "MCP 서버는 이 컴퓨터에서 명령을 실행하거나 파일에 접근할 수 있어요. 믿을 수 있는 서버만 추가하세요.")}`;
}
function indexingPage() {
	const sources = SET.sources.map((s) => srow({ title: `${esc(s.label)} · ${esc(s.alias)}`, hint: esc(s.meta), icon: iconTile(s.icon, s.tint, s.ink), act: "set-source", arg: s.id, chev: true, tail: `<span class="cell-value">${s.on ? s.interval : "꺼짐"}</span>` }));
	return `${pageHead("인덱싱", "검색할 폴더와 연결된 앱의 내용이 최신인지 확인하고, 바뀐 부분만 다시 가져옵니다.")}
${group("진행 상황", [`<div class="act">${ringHtml(S.activity.find((a) => a.kind === "index") ?? ACTIVITY[0])}<div><b>인덱싱 중 2/3</b><small>문서 읽는 중 · Python (D:)</small><span class="cap-bar"><i style="width:62%"></i></span></div></div>`])}
${group("최신화 상태", [
		srow({ title: "로컬 폴더", hint: "문서 1,284개 · 폴더 6개 · 자동 3분 전 성공", icon: iconTile("hard-drive", "#0A84FF"), tail: `<button class="cell-value-btn" data-act="set-choice" data-arg="localInterval">${esc(SET.localInterval)}${svg("chevrons-up-down", 14, 2.2)}</button><button class="icon-pill" data-act="set-refresh" aria-label="지금 새로 고침">${svg("refresh-cw", 17, 2.2)}</button>` }),
		...sources,
	], "바뀐 파일과 메시지만 다시 읽습니다. 처음 연결한 앱은 전체를 가져옵니다.")}
<div class="btn-row"><button class="is-primary" data-act="set-refresh">${svg("refresh-cw", 18, 2.2)}모두 지금 최신화</button></div>
<div class="section-foot" style="padding-top:10px;text-align:center">스캔 1,284 · 기록 12 · 삭제 0 · 건너뜀 3</div>`;
}
function scopePage() {
	const folders = SET.scopeFolders.map((p) => srow({ title: esc(p), icon: `<span class="cell-icon">${folderSvg(24)}</span>`, tail: `<button class="icon-pill danger" data-act="set-scope-remove" data-arg="${esc(p)}" aria-label="${esc(p)} 삭제">${svg("circle-minus", 18, 2.2)}</button>` }));
	const chips = SET.excludes.map((x) => `<span class="lang-chip">${esc(x)}<button data-act="set-exclude-remove" data-arg="${esc(x)}" aria-label="${esc(x)} 빼기">${svg("x", 12, 3)}</button></span>`).join("");
	return `${pageHead("검색 범위", "Dazzi가 읽고 검색할 폴더와 제외할 항목을 정합니다.")}
${group("검색할 폴더", [...folders, srow({ title: "폴더 추가", cls: "is-accent", icon: `<span class="cell-icon">${svg("plus", 20, 2.2)}</span>`, act: "set-sheet", arg: "addScope" })], "이 폴더의 내용을 AI 검색에 포함합니다.")}
${group("제외할 항목", [srow({ title: "제외 목록", hint: "이름이 일치하는 폴더·파일을 더 제외합니다." }), `<div class="chip-wrap">${chips}<button class="lang-chip is-add" data-act="set-sheet" data-arg="addExclude">${svg("plus", 13, 2.6)}추가</button></div>`], "개발용 폴더(node_modules, .git 등)와 .으로 시작하는 모든 폴더(.idea, .vscode, .cache 등)는 자동으로 제외되어 있습니다.")}
${group("파일 포함 범위", [toggleRow("watch", "변경 자동 감지", "파일 이름 검색 목록을 파일이 바뀔 때 갱신합니다.")])}`;
}
function readingPage() {
	return `${pageHead("문서 읽기", "문서를 읽고 검색할 때 우선 사용할 언어를 설정합니다.")}${docLanguageGroup("문서 내용을 읽고 검색할 때 우선 사용할 언어입니다.")}`;
}
function duplicatesPage() {
	return `${pageHead("중복 파일 정리", "검색 결과에 같은 내용이 반복해서 나타나지 않도록 정리합니다.")}
${group("검색 결과 정리", [toggleRow("exact", "완전히 같은 파일은 하나만", "내용이 같은 파일은 가장 최근 것만 보여줍니다."), toggleRow("near", "비슷한 버전 묶기", "보고서_최종, 보고서_최종2처럼 이름과 내용이 비슷한 파일을 하나로 묶습니다."), choiceRow("dupInterval", "검사 주기", "파일 변화를 다시 확인하는 주기입니다.")])}`;
}
function appsPage() {
	const mine = SET.sources.map((s) => srow({ title: `${esc(s.label)} · ${esc(s.alias)}`, hint: esc(s.meta), icon: iconTile(s.icon, s.tint, s.ink), act: "set-source", arg: s.id, chev: true, tail: statusDot(s.status) }));
	const gallery = [
		["메신저", [["Slack", "#4A154B", "message-circle"], ["Telegram", "#229ED9", "send"], ["WhatsApp", "#25D366", "message-circle"], ["Lark", "#3370FF", "message-circle"]]],
		["문서·노트", [["Notion", "#000000", "file-text"], ["Obsidian", "#7C3AED", "file-text"]]],
		["클라우드·개발", [["Cloud Drive", "#0A84FF", "cloud"], ["GitHub", "#24292F", "file-code"]]],
		["뉴스·기타", [["Hister", "#FF9500", "globe"], ["Spotlight", "#8E8E93", "search"]]],
	];
	return `${pageHead("연결된 앱", "메신저, 메일, 클라우드의 자료를 Dazzi에서 함께 검색합니다.")}
${group("내 연결", mine)}
${gallery.map(([title, apps]) => group(title, apps.map(([name, tint, icon]) => srow({ title: name, icon: iconTile(icon, tint), tail: `<button class="pill-btn" data-act="set-connect" data-arg="${esc(name)}">${svg("plus", 14, 2.6)}연결</button>` })))).join("")}
<div class="section-foot" style="padding-top:12px">추가할 앱을 선택하세요. 컴퓨터 앱이 필요한 연결은 데스크탑에 설치되어 있어야 해요.</div>`;
}
function sourcePage(id) {
	const s = SET.sources.find((x) => x.id === id);
	const title = `${s.label} · ${s.alias}`;
	const needsApp = s.id === "kakao";
	return {
		nav: `${backBtn()}${navTitle(title)}`,
		body: `<div class="src-hero">${iconTile(s.icon, s.tint, s.ink).replace("cell-icon", "src-icon")}<h1>${esc(title)}</h1><small>${esc(s.meta)}</small></div>
${group("연결 상태", [
		srow({ title: "사용 여부", hint: "끄면 이 연결을 검색에서 잠시 제외합니다.", tail: sw(`source.${s.id}`, s.on, "사용 여부") }),
		needsApp ? srow({ title: "KakaoTalk 컴퓨터 앱", hint: "KakaoTalk 내용을 가져오려면 이 컴퓨터에 KakaoTalk 앱이 설치되어 있어야 합니다.", tail: `<span class="status-text warn">${statusDot("warn")}필요</span>` }) : "",
		srow({ title: "최신화", hint: s.on ? "마지막 최신화 오늘 14:17" : "아직 내용을 가져오지 않았습니다.", tail: `<button class="pill-btn" data-act="set-refresh" ${s.on ? "" : "disabled"}>지금 최신화</button>` }),
		srow({ title: "최신화 주기", hint: "이 앱이 닫혀 있어도 컴퓨터가 정해진 간격으로 가져옵니다. 직접으로 두면 직접 누를 때만 가져옵니다.", tail: `<button class="cell-value-btn" data-act="set-interval" data-arg="${s.id}">${esc(s.interval)}${svg("chevrons-up-down", 14, 2.2)}</button>` }),
	].filter(Boolean))}
${group("기본 설정", [srow({ title: "AI에게 알려줄 설명", hint: "이 연결을 언제 참고하면 좋은지 적어주세요." }), `<div class="field-wrap"><textarea rows="3" class="sfield" placeholder="예: 팀 공지와 서버 운영 이야기를 찾을 때 참고해 줘">팀 GPU 클러스터와 NFS 운영 대화. 서버 장애나 배포 이야기를 찾을 때 참고해 줘.</textarea></div>`])}
${group(`${s.label} 설정`, [srow({ title: "실행 파일 경로", hint: "/usr/local/bin/discrawl" }), srow({ title: "데이터베이스 경로", hint: "~/.autorag/discord/NomaDamas.db" }), srow({ title: "검색 타임아웃 (ms)", tail: `<span class="cell-value">15000</span>` })], "고급 설정은 데스크탑에서 바꾸는 것을 권장해요.")}
${group("연결 해제", [srow({ title: "연결 해제", cls: "is-danger", act: "set-disconnect", arg: s.id })], "Dazzi 검색에서만 제거되며 원본 앱의 데이터는 지워지지 않습니다.")}`,
	};
}

/* ---------------------------------------------------------------- Sheets -- */

function settingsSheet(o) {
	const arg = o.arg ?? "";
	if (arg.startsWith("magic:")) {
		const a = MAGIC_ACTIONS.find((x) => x.id === arg.slice(6));
		const isNew = !a;
		const fieldRow = (label, value, ph = "") => `<div class="form-row"><label>${label}</label><input class="sfield" value="${esc(value)}" placeholder="${esc(ph)}"></div>`;
		const pick = (label, value) => srow({ title: label, tail: `<span class="cell-value">${esc(value)}</span>${svg("chevrons-up-down", 16, 2.2).replace('class="icon"', 'class="icon chev-r"')}` });
		return {
			title: isNew ? "매직 액션 추가" : "매직 액션 편집", solid: true, height: "calc(100% - var(--sa-top) - 8px)",
			left: gtext("취소", "dismiss"), right: gtext("저장", "set-save", "is-prominent"),
			body: `<div class="section"><div class="group form">${fieldRow("버튼 이름", a?.label ?? "", "예: PDF 핵심 3줄 요약, SHA-256 해시 계산")}${fieldRow("설명 (선택)", "", "설정 화면에 표시할 간단한 메모")}</div></div>
${group("실행", [pick("실행 방식", a?.mode === "script" ? "셸 스크립트" : "AI 에이전트 루프"), a?.mode === "script" ? "" : pick("에이전트 권한", "읽기 및 분석 전용")].filter(Boolean))}
<div class="section"><div class="section-head"><span>${a?.mode === "script" ? "실행할 명령어 / 스크립트" : "AI 에이전트 지시문"}</span></div><div class="group"><div class="field-wrap"><textarea rows="5" class="sfield ${a?.mode === "script" ? "mono" : ""}" placeholder="예: 선택한 문서의 핵심 내용을 항목별로 요약하고 주요 일정을 표로 정리해줘.">${a?.mode === "script" ? 'shasum -a 256 "$@"' : a ? "선택한 문서의 핵심 내용을 세 줄로 요약해줘." : ""}</textarea></div></div></div>
${group("조건", [pick("선택 개수 조건", "단일·복수 모두"), pick("대상 종류", "파일만"), `<div class="form-row"><label>확장자 필터 (선택)</label><input class="sfield" value="${esc(a?.exts?.join(", ") ?? "")}" placeholder="비워두면 전체 허용 · 예: pdf, docx, md"></div>`])}
${a?.mode === "script" ? "" : group("허용", [srow({ title: "스킬(Skills) 공유 허용", tail: `<button class="switch is-on" role="switch" aria-checked="true" aria-label="스킬 공유 허용"></button>` }), srow({ title: "연결된 MCP 서버 허용", tail: `<button class="switch" role="switch" aria-checked="false" aria-label="MCP 서버 허용"></button>` })])}
${isNew ? "" : `<div class="section"><div class="group">${srow({ title: "매직 액션 삭제", cls: "is-danger", act: "set-desktop", arg: "삭제" })}</div></div>`}`,
		};
	}
	if (arg.startsWith("mcp:")) {
		const s = SET.mcpServers[Number(arg.slice(4))];
		return {
			title: s ? s.name : "서버 추가", solid: true, height: "calc(100% - var(--sa-top) - 8px)",
			left: gtext("취소", "dismiss"), right: gtext("저장", "set-save", "is-prominent"),
			body: `<div class="section"><div class="group form"><div class="form-row"><label>이름</label><input class="sfield" value="${esc(s?.name ?? "")}" placeholder="예: filesystem"></div></div></div>
${group("연결 방식", [`<div class="seg-wrap"><div class="seg wide"><button class="${s?.kind !== "HTTP" ? "is-on" : ""}">명령 실행(stdio)</button><button class="${s?.kind === "HTTP" ? "is-on" : ""}">HTTP 주소</button></div></div>`, `<div class="form-row"><label>${s?.kind === "HTTP" ? "주소" : "실행 명령"}</label><input class="sfield mono" value="${s?.kind === "HTTP" ? "https://mcp.linear.app/mcp" : s ? "npx -y @modelcontextprotocol/server-filesystem" : ""}" placeholder="${s?.kind === "HTTP" ? "https://example.com/mcp" : "npx"}"></div>`])}
${group("도구", [srow({ title: "도구 노출 방식", tail: `<span class="cell-value">${esc(s?.expose ?? "필요할 때 불러오기")}</span>${svg("chevrons-up-down", 16, 2.2).replace('class="icon"', 'class="icon chev-r"')}` }), `<div class="form-row"><label>설명(모델이 언제 쓸지 알 수 있게)</label><input class="sfield" placeholder="예: 내 프로젝트 폴더의 파일을 읽을 때"></div>`])}
${s ? `<div class="section"><div class="group">${srow({ title: "서버 삭제", cls: "is-danger", act: "set-desktop", arg: "삭제" })}</div></div>` : ""}`,
		};
	}
	if (arg === "connectService") {
		const opt = (title, hint, icon, tint) => srow({ title, hint, icon: iconTile(icon, tint), chev: true, act: "set-desktop", arg: title });
		return { title: "서비스 연결", medium: true, height: "auto", body: `<div class="section" style="margin-top:4px"><div class="group">${opt("Dazzi 요금제", "계정의 관리형 모델", "sparkles", "#0A84FF")}${opt("API 키로 연결", "OpenAI · Anthropic · Gemini · OpenRouter …", "key-round", "#636366")}${opt("내 컴퓨터", "Ollama · LM Studio", "monitor", "#34C759")}${opt("직접 추가 (OpenAI 호환)", "서버 주소와 API 키", "server", "#FF9500")}</div></div>` };
	}
	const simple = {
		addFavorite: ["즐겨찾기에 폴더 추가", "폴더 경로", "~/Projects 또는 /Users/me/Work"],
		addScope: ["검색 폴더 추가", "폴더 경로", "예: ~/Documents"],
		addExclude: ["제외 항목 추가", "항목", "예: node_modules"],
	}[arg];
	if (simple) {
		return {
			title: simple[0], medium: true, height: "auto", left: gtext("취소", "dismiss"), right: gtext("추가", "set-add", "is-prominent"),
			body: `<div class="section" style="margin-top:4px"><div class="group form"><div class="form-row"><label>${simple[1]}</label><input id="set-input" class="sfield" placeholder="${esc(simple[2])}" autocomplete="off"></div></div></div>${arg === "addExclude" ? "" : `<div class="btn-row"><button data-act="set-browse">${svg("folder", 18, 2.2)}${esc(PC_NAME)}에서 고르기</button></div>`}`,
		};
	}
	return { title: "", body: "" };
}

function choiceMenu(key) {
	const c = CHOICES[key];
	return `<div class="menu-label">${esc(c.title)}</div>` + c.options.map(([value, label, sub]) => mi("", esc(label), "set-pick", `${key}\n${value}`, { check: SET[key] === value, sub: sub ?? "" })).join("");
}
function intervalMenu(id) {
	const s = SET.sources.find((x) => x.id === id);
	return `<div class="menu-label">최신화 주기</div>` + INTERVALS.map((v) => mi("", v, "set-pick-interval", `${id}\n${v}`, { check: s.interval === v })).join("");
}
