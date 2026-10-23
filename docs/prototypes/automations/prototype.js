/* Dazzi file-automations prototype — pure front-end demo.
 *
 * Rules are seen in two places and changed in one:
 *   · 자동화 tab (sidebar Favorites): every rule as Finder rows; the inspector
 *     summarizes the selected rule; Space opens it in Quick Look.
 *   · A folder (다운로드): the inspector's "자동화" section lists the rules that
 *     watch it, and a file shows the rule that handled it.
 * 편집 and 추가 always open a new AI 검색 tab seeded with the request, so every
 * conversation about a rule lives with the other AI conversations. 삭제 asks
 * once and offers undo. Rules carry exactly the librarian's automations.json
 * fields (src/automation/config.ts) plus the last-run record from its jsonl log. */
"use strict";

const esc = (value) =>
	String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Lucide glyph markup from ../settings/lucide-icons.js (a script-scope `LUCIDE`); `size`/`stroke` follow icons.tsx. */
const svg = (slug, size = 14, stroke = 1.8) =>
	`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" stroke-width="${stroke}" aria-hidden="true">${LUCIDE[slug] ?? ""}</svg>`;

/** icons.tsx FolderGlyph: lucide has no filled folder. */
const folderGlyph = (size = 16) =>
	`<svg class="folder-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="currentColor"/></svg>`;

/* ------------------------------------------------------------ Demo data -- */

const MIN = 60_000;
const ago = (minutes) => Date.now() - minutes * MIN;
const ok = (minutes, eventCount = 1) => ({ startedAt: ago(minutes), durationMs: 21_000, eventCount, exitCode: 0, signal: null, timedOut: false });

const seedRules = () => [
	{
		id: "downloads-pdf-summary",
		paths: ["~/Downloads"],
		events: ["create"],
		include: ["**/*.pdf"],
		exclude: [],
		run: ["autorag", "search", "이 문서를 세 줄로 요약해서 같은 폴더에 <원본명>-요약.md로 저장해줘"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: ok(3),
	},
	{
		id: "notes-index-refresh",
		paths: ["~/Documents/Notes", "~/Documents/Projects"],
		events: ["create", "update", "delete"],
		include: ["**/*.md"],
		exclude: ["**/archive/**"],
		run: ["autorag", "refresh"],
		appendFiles: false,
		debounceMs: 5000,
		timeoutMs: 600_000,
		lastRun: ok(41, 3),
	},
	{
		id: "hwp-to-pdf",
		paths: ["~/Downloads"],
		events: ["create"],
		include: ["**/*.hwp", "**/*.hwpx"],
		exclude: [],
		run: ["hwp5", "--to", "pdf"],
		appendFiles: true,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: { startedAt: ago(19 * 60), durationMs: 800, eventCount: 1, exitCode: null, signal: null, timedOut: false, error: "spawn hwp5 ENOENT" },
	},
	{
		id: "screenshot-tidy",
		paths: ["~/Desktop"],
		events: ["create"],
		include: ["Screen Shot*.png"],
		exclude: [],
		run: ["autorag", "search", "스크린샷 내용에 맞게 이름을 바꾸고 ~/Pictures/Screenshots로 옮겨줘"],
		appendFiles: true,
		debounceMs: 2000,
		timeoutMs: 600_000,
		lastRun: undefined,
	},
];

/** The 다운로드 folder's contents; `rule` names the rule whose last run handled the file. */
const DOWNLOADS = [
	{ name: "2026 3분기 실적.pdf", date: "오늘 오후 2:14", size: "1.2 MB", kind: "PDF 문서", tile: "pdf", rule: "downloads-pdf-summary" },
	{ name: "2026 3분기 실적-요약.md", date: "오늘 오후 2:15", size: "2 KB", kind: "Markdown 문서", tile: "md" },
	{ name: "감사결과통보서.hwp", date: "어제 오후 7:02", size: "48 KB", kind: "한글 문서", tile: "docx", rule: "hwp-to-pdf" },
	{ name: "견적서_v3.xlsx", date: "10월 18일", size: "88 KB", kind: "Excel 통합 문서", tile: "xlsx" },
	{ name: "Dazzi-2.11.1.dmg", date: "10월 17일", size: "132 MB", kind: "디스크 이미지", tile: "zip" },
	{ name: "회의 사진.png", date: "10월 15일", size: "820 KB", kind: "PNG 이미지", tile: "png" },
];

/* ---------------------------------------------------- Plain-language summary -- */

const FOLDER_NAMES = { Downloads: "다운로드", Documents: "문서", Desktop: "데스크탑", Pictures: "사진", Movies: "동영상", Music: "음악" };
const KIND_NAMES = { pdf: "PDF", md: "Markdown", hwp: "HWP", hwpx: "HWP", docx: "Word", xlsx: "Excel", pptx: "PowerPoint", png: "이미지", jpg: "이미지", txt: "텍스트" };
const EVENT_NAMES = { create: "생성", update: "수정", delete: "삭제" };

function folderName(path) {
	const last = path.replace(/\/+$/, "").split("/").pop() ?? path;
	return FOLDER_NAMES[last] ?? last;
}
function foldersText(paths) {
	return paths.length === 1 ? folderName(paths[0]) : `${folderName(paths[0])} 외 ${paths.length - 1}곳`;
}
function kindsText(include) {
	if (include.some((p) => /screen ?shot/i.test(p))) return "스크린샷";
	if (include.includes("**")) return "모든 파일";
	const names = include.map((p) => KIND_NAMES[p.match(/\*\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? ""] ?? p);
	return [...new Set(names)].join("·");
}
function eventsText(events) {
	const on = (e) => events.includes(e);
	if (on("create") && on("update") && on("delete")) return "바뀔 때마다";
	if (on("create") && on("update")) return "생기거나 수정되면";
	return events.map((e) => ({ create: "새로 생기면", update: "수정되면", delete: "지워지면" })[e]).join(" · ");
}
function kindNoun(rule) {
	const kinds = kindsText(rule.include);
	return kinds === "모든 파일" ? "파일" : `${kinds} 파일`;
}
function shortInstruction(text, max = 22) {
	return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** "새 PDF → Dazzi에게 맡기기": the name a person reads in a list. */
function titleOf(rule) {
	const kinds = kindsText(rule.include);
	const trigger = rule.events.length === 1 && rule.events[0] === "create" ? `새 ${kinds}` : `${kinds} 변경`;
	return `${trigger} → ${actionShort(rule)}`;
}
function actionShort(rule) {
	const [bin, sub] = rule.run;
	if (bin === "autorag" && sub === "refresh") return "검색 색인 최신화";
	if (bin === "autorag" && sub === "search") return "Dazzi에게 맡기기";
	return `${bin.split("/").pop()} 실행`;
}
function whenText(rule) {
	return `${foldersText(rule.paths)}에 ${kindNoun(rule)}이 ${eventsText(rule.events)}`;
}
/** `full` keeps the whole instruction: Quick Look and the AI card have room, the inspector does not. */
function whatText(rule, { full = false } = {}) {
	const [bin, sub, instruction] = rule.run;
	if (bin === "autorag" && sub === "refresh") return "검색 색인을 최신으로 맞춤";
	if (bin === "autorag" && sub === "search") return `“${full ? instruction ?? "" : shortInstruction(instruction ?? "")}”`;
	return `${bin.split("/").pop()} 프로그램으로 처리`;
}

function relTime(ts) {
	const m = Math.round((Date.now() - ts) / MIN);
	if (m < 1) return "방금";
	if (m < 60) return `${m}분 전`;
	if (m < 24 * 60) return `${Math.round(m / 60)}시간 전`;
	return `${Math.round(m / 1440)}일 전`;
}
function runTone(run) {
	if (run === undefined) return "never";
	return run.timedOut || run.error !== undefined || run.exitCode !== 0 ? "fail" : "ok";
}
function failReason(run) {
	if (run.timedOut) return "시간 초과";
	const missing = run.error?.match(/spawn (\S+) ENOENT/);
	if (missing) return `‘${missing[1]}’ 프로그램을 찾을 수 없음`;
	return run.error ?? `오류 코드 ${run.exitCode}`;
}
function lastRunText(rule) {
	const run = rule.lastRun;
	if (run === undefined) return "아직 실행 안 됨";
	return runTone(run) === "ok" ? `${relTime(run.startedAt)} · 성공` : `${relTime(run.startedAt)} · 실패`;
}
const dot = (rule) => `<i class="dot ${runTone(rule.lastRun)}"></i>`;

/* ------------------------------------------------------------------ State -- */

/** Tabs follow the real strip: folder tabs plus AI 검색 tabs, one of them focused. */
const freshState = () => ({
	tabs: [
		{ id: 1, kind: "folder" },
		{ id: 2, kind: "automations" },
	],
	active: 2,
	nextTab: 3,
	newTab: null, // id of the tab that just opened, for the slide-in
	rules: seedRules(),
	daemon: true,
	selected: "downloads-pdf-summary",
	fileSel: null,
	details: false,
	preview: null, // rule id shown in Quick Look
	confirm: null, // rule id
	menu: null, // { id | null, x, y } — null id: the list background
	toast: null, // { text, undo?: { rule, index } }
	flash: null, // { id, fields: string[] }
});
let state = freshState();
const timers = new Set();
const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
const ruleById = (id) => state.rules.find((r) => r.id === id);
const activeTab = () => state.tabs.find((t) => t.id === state.active);

/* -------------------------------------------------------------- App chrome -- */

const FAVORITES = [
	{ id: "ai", label: "AI 검색", icon: "sparkles" },
	{ id: "automations", label: "자동화", icon: "zap" },
	{ id: "recents", label: "최근 항목", icon: "clock" },
	{ id: "home", label: "홈", icon: "house" },
	{ id: "apps", label: "응용 프로그램", icon: "app-window" },
	{ id: "desktop", label: "데스크탑", icon: "monitor" },
	{ id: "documents", label: "문서", icon: "file" },
	{ id: "folder", label: "다운로드", icon: "download" },
	{ id: "music", label: "음악", icon: "music" },
	{ id: "movies", label: "동영상", icon: "film" },
	{ id: "pictures", label: "사진", icon: "image" },
	{ id: "trash", label: "휴지통", icon: "trash" },
];

function sidebar() {
	const kind = activeTab().kind;
	const item = (f) => {
		const nav = f.id === "automations" || f.id === "folder" || f.id === "ai";
		return `<button class="side-item ${kind === f.id ? "is-active" : ""}" type="button" ${nav ? `data-act="go" data-id="${f.id}"` : ""}>${svg(f.icon)}<span class="grow">${f.label}</span></button>`;
	};
	return `
	<aside class="sidebar">
		<div class="side-head"><span class="traffic" aria-hidden="true"><i></i><i></i><i></i></span><span class="grow"></span><button class="icon-btn" type="button" aria-label="사이드바 가리기">${svg("panel-left", 16, 1.9)}</button></div>
		<div class="sidebar-search"><div class="side-search">${svg("search", 14, 2.2)}<span class="grow">검색…</span><span class="keycap">⌘F</span></div></div>
		<div class="side-scroll">
			<div class="side-group"><div class="side-label">즐겨찾기</div>${FAVORITES.map(item).join("")}</div>
			<div class="side-group"><div class="side-label">위치</div>
				<button class="side-item" type="button">${svg("hard-drive")}<span class="grow">Macintosh HD</span></button>
				<button class="side-item" type="button">${svg("hard-drive")}<span class="grow">SSD1</span><span class="trail">${svg("eject", 12)}</span></button>
			</div>
			<div class="side-group"><div class="side-label">태그</div>
				${["연구", "업무", "개인"].map((t) => `<button class="side-item" type="button"><i class="tag-dot"></i><span class="grow">${t}</span></button>`).join("")}
			</div>
		</div>
		<div class="side-footer"><button class="side-item" type="button">${svg("settings", 16)}<span class="grow">설정</span><span class="keycap">⌘,</span></button></div>
	</aside>`;
}

const TAB_TITLES = { folder: "다운로드", automations: "자동화", ai: "AI 검색" };

function toolbar() {
	const ai = activeTab().kind === "ai";
	return `
	<header class="toolbar">
		<button class="icon-btn" type="button" aria-label="뒤로">${svg("chevron-left", 16, 2.2)}</button>
		<button class="icon-btn is-off" type="button" aria-label="앞으로">${svg("chevron-right", 16, 2.2)}</button>
		<span class="toolbar-title">${TAB_TITLES[activeTab().kind]}</span>
		<span class="grow"></span>
		<div class="seg" role="group" aria-label="보기">
			<button class="icon-btn" type="button" aria-label="아이콘">${svg("layout-grid", 16, 1.9)}</button>
			<button class="icon-btn ${ai ? "" : "is-sel"}" type="button" aria-label="목록">${svg("list", 16, 1.9)}</button>
			<button class="icon-btn" type="button" aria-label="계층">${svg("columns-3", 16, 1.9)}</button>
		</div>
		<div class="tgroup">
			<button class="icon-btn drop-btn" type="button" aria-label="정렬">${svg("arrow-down-up", 16, 1.9)}${svg("chevron-down", 10, 2.4)}</button>
			<button class="icon-btn drop-btn" type="button" aria-label="그룹">${svg("layers", 16, 1.9)}${svg("chevron-down", 10, 2.4)}</button>
			<button class="icon-btn is-on" type="button" aria-label="정보 가리기">${svg("info", 16, 1.8)}</button>
			<button class="icon-btn ${ai ? "is-on" : ""}" type="button" aria-label="AI 검색">${svg("sparkles", 16, 2)}</button>
			<button class="icon-btn" type="button" aria-label="공유">${svg("share", 16, 2)}</button>
		</div>
	</header>`;
}

function tabStrip() {
	const tab = (t) => `
		<button class="tab ${t.id === state.active ? "is-active" : ""} ${t.id === state.newTab ? "is-new" : ""}" type="button" data-act="tab" data-id="${t.id}">
			${state.tabs.length > 1 ? `<span class="tab-close" data-act="close-tab" data-id="${t.id}" aria-label="탭 닫기">${svg("x", 9, 2.6)}</span>` : ""}
			${t.kind === "ai" ? svg("sparkles", 11, 2) : ""}<span>${TAB_TITLES[t.kind]}</span>
		</button>`;
	return `<nav class="tabs">${state.tabs.map(tab).join("")}<span class="tab-add">${svg("plus", 14, 2)}</span></nav>`;
}

/* ------------------------------------------------------------- 자동화 tab -- */

const RULE_COLS = "grid-template-columns: minmax(0,1fr) 150px 120px 48px";

function automationsPane() {
	const rows = state.rules.map((rule) => {
		const flash = state.flash?.id === rule.id ? " is-flash" : "";
		return `
		<div class="row${rule.id === state.selected ? " is-sel" : ""}${flash}" style="${RULE_COLS}" role="row" tabindex="-1"
			data-act="select" data-dbl="edit" data-menu="rule" data-id="${esc(rule.id)}">
			<span class="name"><span class="no-disclosure"></span><span class="rule-glyph ${runTone(rule.lastRun) === "fail" ? "fail" : ""}">${svg("zap", 11, 2)}</span><span>${esc(titleOf(rule))}</span></span>
			<span class="m">${esc(foldersText(rule.paths))}</span>
			<span class="m">${esc(rule.lastRun ? relTime(rule.lastRun.startedAt) : "—")}</span>
			<span class="c status">${dot(rule)}</span>
		</div>`;
	}).join("");
	return `
	<div class="col-header" style="${RULE_COLS}"><span>이름</span><span>감시 폴더</span><span>마지막 실행</span><span class="c">상태</span></div>
	<div class="rows" role="grid" data-menu="list">${rows}</div>
	<footer class="pathbar">
		<span class="status">${state.daemon ? '<i class="dot ok"></i>백그라운드에서 실행 중' : '<i class="dot off"></i>꺼짐 · 규칙이 실행되지 않습니다'}</span>
		<span class="path-sep">·</span><span class="status">규칙 ${state.rules.length}개</span>
		<span class="grow"></span>
		<button class="text-btn" type="button" data-act="daemon">${state.daemon ? "끄기" : "켜기"}</button>
	</footer>`;
}

/** The inspector for one rule: what it does in three rows, the rest behind 전체 정보. */
function ruleInspector(rule) {
	const run = rule.lastRun;
	const tone = runTone(run);
	const flashed = (field) => (state.flash?.id === rule.id && state.flash.fields.includes(field) ? " is-flash" : "");
	const actIcon = rule.run[0] === "autorag" ? (rule.run[1] === "refresh" ? "refresh-cw" : "sparkles") : "zap";
	const sub = run === undefined ? `${dot(rule)}아직 실행되지 않았어요` : tone === "ok" ? `${dot(rule)}${relTime(run.startedAt)} 실행 · 성공` : `${dot(rule)}${relTime(run.startedAt)} 실행 · 실패`;
	const details = state.details
		? `
			<div class="info-row"><dt>감시 폴더</dt><dd>${rule.paths.map(esc).join("<br>")}</dd></div>
			<div class="info-row"><dt>파일 패턴</dt><dd>${rule.include.map(esc).join(", ")}</dd></div>
			<div class="info-row"><dt>제외</dt><dd>${rule.exclude.length ? rule.exclude.map(esc).join(", ") : "없음"}</dd></div>
			<div class="info-row mono"><dt>명령</dt><dd>${esc(rule.run.join(" "))}</dd></div>
			<div class="info-row"><dt>규칙 ID</dt><dd>${esc(rule.id)}</dd></div>`
		: "";
	return `
	<div class="inspector-body">
		<div class="preview-paper">
			<div class="flow">
				<div class="flow-node"><span class="flow-ico">${folderGlyph(22)}</span><span>${esc(foldersText(rule.paths))}</span></div>
				<span class="flow-arrow">${svg("chevron-right", 16, 2.2)}</span>
				<div class="flow-node"><span class="flow-ico ${tone === "fail" ? "fail" : "act"}">${svg(actIcon, 20, 1.8)}</span><span>${esc(actionShort(rule))}</span></div>
			</div>
		</div>
		<div class="preview-title">${esc(titleOf(rule))}</div>
		<div class="preview-sub ${tone === "fail" ? "fail" : ""}">${sub}</div>
		<div class="chip-row">
			<button class="chip accent" type="button" data-act="edit" data-id="${esc(rule.id)}">${svg("pencil", 12, 2)}AI로 편집</button>
			<button class="chip" type="button" data-act="ask-delete" data-id="${esc(rule.id)}">${svg("trash", 12, 2)}삭제</button>
		</div>
		<div class="info-section">
			<div class="section-title"><span>요약</span><button class="text-btn" type="button" data-act="details">${state.details ? "간략히" : "전체 정보"}</button></div>
			<dl>
				<div class="info-row${flashed("when")}"><dt>언제</dt><dd>${esc(whenText(rule))}</dd></div>
				<div class="info-row${flashed("what")}"><dt>하는 일</dt><dd>${esc(whatText(rule))}</dd></div>
				${tone === "fail" ? `<div class="info-row fail"><dt>문제</dt><dd>${esc(failReason(run))}</dd></div>` : ""}
				${details}
			</dl>
		</div>
	</div>`;
}

/* --------------------------------------------------------------- Folder view -- */

const FILE_COLS = "grid-template-columns: minmax(0,1fr) 120px 72px 120px 44px";
const TILE = (kind) => `<span style="width:16px;height:16px;flex:none;border-radius:3px;background:var(--tile-${kind})"></span>`;

function folderPane() {
	const rows = DOWNLOADS.map((f) => `
		<div class="row${state.fileSel === f.name ? " is-sel" : ""}" style="${FILE_COLS}" role="row" data-act="file" data-id="${esc(f.name)}">
			<span class="name"><span class="no-disclosure"></span>${TILE(f.tile)}<span>${esc(f.name)}</span></span>
			<span class="m">${esc(f.date)}</span>
			<span class="m r">${esc(f.size)}</span>
			<span class="m">${esc(f.kind)}</span>
			<span class="m c">—</span>
		</div>`).join("");
	const crumb = (label, last) => `<span class="path-seg">${folderGlyph(14)}${label}</span>${last ? "" : '<span class="path-sep">›</span>'}`;
	return `
	<div class="col-header" style="${FILE_COLS}"><span>이름</span><span>수정한 날짜</span><span class="r">크기</span><span>종류</span><span class="c">인덱스</span></div>
	<div class="rows" role="grid">${rows}</div>
	<footer class="pathbar">${crumb("Macintosh HD")}${crumb("사용자")}${crumb("jeffrey")}${crumb("다운로드", true)}</footer>`;
}

/** The rules section shared by the folder and a file it holds; rows follow Inspector's .ver-row. */
function rulesSection(rules, title) {
	if (rules.length === 0) return "";
	return `
	<div class="info-section">
		<div class="section-title"><span>${title}</span><span class="count-pill">${rules.length}</span></div>
		${rules.map((rule) => `
		<div class="rule-row" role="button" tabindex="0" data-act="edit" data-menu="rule" data-id="${esc(rule.id)}">
			<span class="rule-glyph ${runTone(rule.lastRun) === "fail" ? "fail" : ""}">${svg("zap", 11, 2)}</span>
			<span class="txt"><span class="t">${esc(titleOf(rule))}</span><span class="s">${esc(lastRunText(rule))}</span></span>
			<span class="dot-slot">${dot(rule)}</span>
			<span class="acts">
				<button class="icon-btn xs" type="button" data-act="edit" data-id="${esc(rule.id)}" aria-label="AI로 편집" title="AI로 편집">${svg("pencil", 12, 2)}</button>
				<button class="icon-btn xs" type="button" data-act="ask-delete" data-id="${esc(rule.id)}" aria-label="삭제" title="삭제">${svg("trash", 12, 2)}</button>
			</span>
		</div>`).join("")}
	</div>`;
}

function folderInspector() {
	const watching = state.rules.filter((r) => r.paths.includes("~/Downloads"));
	const file = DOWNLOADS.find((f) => f.name === state.fileSel);
	if (file) {
		const handled = file.rule ? [ruleById(file.rule)].filter(Boolean) : [];
		return `
		<div class="inspector-body">
			<div class="preview-paper">${TILE(file.tile).replace("16px;height:16px", "44px;height:54px")}</div>
			<div class="preview-title">${esc(file.name)}</div>
			<div class="preview-sub">${esc(file.kind)} · ${esc(file.size)} · ${esc(file.date)}</div>
			<div class="chip-row">
				<button class="chip" type="button">${svg("check", 12, 2.4)}인덱싱에 포함</button>
				<button class="chip" type="button">${svg("trash", 12, 2)}휴지통</button>
				<button class="chip" type="button">${svg("copy", 12, 2)}경로 복사</button>
			</div>
			${rulesSection(handled, "이 파일을 처리한 자동화")}
			<div class="info-section">
				<div class="section-title"><span>일반 정보</span></div>
				<dl><div class="info-row"><dt>종류</dt><dd>${esc(file.kind)}</dd></div><div class="info-row"><dt>크기</dt><dd>${esc(file.size)}</dd></div><div class="info-row"><dt>위치</dt><dd>~/Downloads</dd></div></dl>
			</div>
		</div>`;
	}
	return `
	<div class="inspector-body">
		<div class="preview-paper folder">${folderGlyph(72)}</div>
		<div class="preview-title">다운로드</div>
		<div class="preview-sub">폴더 · 항목 ${DOWNLOADS.length}개</div>
		<div class="chip-row">
			<button class="chip" type="button">${svg("check", 12, 2.4)}인덱싱에 포함</button>
			<button class="chip" type="button">${svg("copy", 12, 2)}경로 복사</button>
		</div>
		${rulesSection(watching, "이 폴더의 자동화")}
		<div class="info-section">
			<div class="section-title"><span>일반 정보</span></div>
			<dl><div class="info-row"><dt>종류</dt><dd>폴더</dd></div><div class="info-row"><dt>위치</dt><dd>~/Downloads</dd></div></dl>
		</div>
	</div>`;
}


const FIELDS = [
	{ label: "폴더", key: "when", read: (r) => r.paths.map(folderName).join(", ") },
	{ label: "파일 종류", key: "when", read: (r) => kindsText(r.include) },
	{ label: "시점", key: "when", read: (r) => r.events.map((e) => EVENT_NAMES[e]).join("·") },
	{ label: "제외", key: "when", read: (r) => (r.exclude.length ? r.exclude.map((p) => p.replace(/^\*\*\/|\/\*\*$/g, "")).join(", ") : "없음") },
	{ label: "하는 일", key: "what", read: whatText },
	{ label: "대기", key: "when", read: (r) => `${r.debounceMs / 1000}초` },
];
const diff = (prev, next) => FIELDS.map((f) => ({ label: f.label, key: f.key, from: f.read(prev), to: f.read(next) })).filter((c) => c.from !== c.to);

const SUGGESTS = {
	"downloads-pdf-summary": ["HWP 파일도 포함해줘", "다섯 줄로 요약해줘", "데스크탑도 지켜봐줘"],
	"notes-index-refresh": ["‘보관함’ 폴더는 제외해줘", "10초 기다렸다가 실행해줘", "지워질 때는 무시해줘"],
	"hwp-to-pdf": ["왜 실패했어?", "Word 파일도 변환해줘", "이 규칙 삭제해줘"],
	"screenshot-tidy": ["이미지 파일 전체로 넓혀줘", "수정될 때도 실행해줘", "이 규칙 삭제해줘"],
};

/** A scripted stand-in for the agent's `manage_automations save`: a few Korean phrasings → a new rule. */
function draft(rule, text) {
	const next = structuredClone(rule);
	const only = /만\b|만 /.test(text) && !/도|추가|포함/.test(text);
	const exts = [...text.matchAll(/\b(pdf|hwp|docx|xlsx|pptx|md|txt)\b/gi)].map((m) => m[1].toLowerCase());
	if (/워드|word/i.test(text)) exts.push("docx");
	if (/엑셀|excel/i.test(text)) exts.push("xlsx");
	if (/이미지/.test(text)) next.include = ["**/*.png", "**/*.jpg"];
	if (exts.length) {
		const add = exts.flatMap((e) => (e === "hwp" ? ["**/*.hwp", "**/*.hwpx"] : [`**/*.${e}`]));
		next.include = only ? add : [...new Set([...next.include, ...add])];
	}
	const folder = [[/데스크탑|바탕화면/, "~/Desktop"], [/다운로드/, "~/Downloads"], [/문서/, "~/Documents"]].find(([re]) => re.test(text));
	if (folder && !next.paths.includes(folder[1])) next.paths = only ? [folder[1]] : [...next.paths, folder[1]];
	const ev = [[/지워|삭제될/, "delete"], [/수정/, "update"]].find(([re]) => re.test(text));
	if (ev) next.events = /무시|빼|말고|하지 ?마/.test(text) ? next.events.filter((e) => e !== ev[1]) : [...new Set([...next.events, ev[1]])];
	const ex = text.match(/[‘'"“]([^’'"”]+)[’'"”]\s*(?:폴더)?(?:는|은)?\s*(?:제외|빼)/);
	if (ex) next.exclude = [...new Set([...next.exclude, `**/${ex[1]}/**`])];
	const wait = text.match(/(\d+)\s*초/);
	if (wait) next.debounceMs = Number(wait[1]) * 1000;
	const lines = text.match(/(두|세|네|다섯|\d+)\s*줄/);
	if (lines && next.run[1] === "search") next.run = [next.run[0], next.run[1], next.run[2].replace(/(두|세|네|다섯|\d+)\s*줄/, `${lines[1]} 줄`)];
	return next;
}


/* -------------------------------------------------------------- Quick Look -- */

/** QuickLookWindow chrome (close, full screen, name, share, open pill) around a rule card. */
function quickLook() {
	const rule = state.preview && ruleById(state.preview);
	if (!rule) return "";
	const run = rule.lastRun;
	const tone = runTone(run);
	const actIcon = rule.run[0] === "autorag" ? (rule.run[1] === "refresh" ? "refresh-cw" : "sparkles") : "zap";
	const foot = run === undefined
		? `<i class="dot never"></i>아직 실행되지 않았어요`
		: tone === "ok"
			? `<i class="dot ok"></i>${relTime(run.startedAt)} 실행 · 성공`
			: `<i class="dot fail"></i>${relTime(run.startedAt)} 실행 · ${esc(failReason(run))}`;
	return `
	<div class="ql-scrim" data-act="close-preview">
		<div class="qlw" role="dialog" aria-label="${esc(titleOf(rule))}" data-stop>
			<header class="qlw-toolbar">
				<button class="ql-tool" type="button" data-act="close-preview" aria-label="닫기" title="닫기">
					<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="currentColor"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" style="stroke:var(--ql-knockout)" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg>
				</button>
				<button class="ql-tool" type="button" aria-label="전체 화면" title="전체 화면">
					<svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="currentColor"/><path d="M8.8 6.3H6.3v2.5M6.3 6.3l3.2 3.2M11.2 13.7h2.5v-2.5M13.7 13.7l-3.2-3.2" style="stroke:var(--ql-knockout)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
				</button>
				<span class="qlw-name"></span>
				<button class="ql-open" type="button" data-act="edit" data-id="${esc(rule.id)}">AI 검색에서 편집</button>
			</header>
			<div class="ql-rule">
				<span class="ql-glyph ${tone === "fail" ? "fail" : ""}">${svg(actIcon, 56, 1.5)}</span>
				<div class="ql-copy">
					<div class="ql-title">${esc(titleOf(rule))}</div>
					<dl class="ql-facts">
						<dt>언제</dt><dd>${esc(kindNoun(rule))}이 ${esc(eventsText(rule.events))}</dd>
						<dt>하는 일</dt><dd>${esc(whatText(rule, { full: true }))}</dd>
						<dt>대상 폴더</dt><dd>${rule.paths.map((p) => esc(folderName(p))).join(", ")}</dd>
					</dl>
					<div class="ql-foot ${tone === "fail" ? "fail" : ""}">${foot}</div>
				</div>
			</div>
		</div>
	</div>`;
}

/* ------------------------------------------------------------ AI 검색 tab -- */

/** The rule as an answer card: the same three facts Quick Look shows. */
function ruleCard(rule, flashFields = []) {
	const flash = (key) => (flashFields.includes(key) ? ' class="is-flash"' : "");
	return `
	<div class="rule-card">
		<div class="rule-card-head"><span class="rule-glyph ${runTone(rule.lastRun) === "fail" ? "fail" : ""}">${svg("zap", 11, 2)}</span><span class="t">${esc(titleOf(rule))}</span></div>
		<dl>
			<dt>언제</dt><dd${flash("when")}>${esc(kindNoun(rule))}이 ${esc(eventsText(rule.events))}</dd>
			<dt>하는 일</dt><dd${flash("what")}>${esc(whatText(rule, { full: true }))}</dd>
			<dt>대상 폴더</dt><dd${flash("folders")}>${rule.paths.map((p) => esc(folderName(p))).join(", ")}</dd>
		</dl>
	</div>`;
}

function aiPane(tab) {
	const body = tab.log.length === 0
		? `<div class="ai-empty"><b>무엇을 찾아드릴까요?</b><p>파일, 메일, 메신저 전체에서 찾아 빠른 답변과 정밀한 답변을 함께 드립니다.</p></div>`
		: tab.log.map((m, i) => message(m, i === tab.log.length - 1)).join("");
	return `
	<section class="ai" aria-label="AI 검색">
		<div class="ai-head">
			<span class="ai-mark">${svg("sparkles", 14, 2)}</span>
			<span class="ai-title">AI 검색</span>
			<span class="grow"></span>
			<button class="icon-btn sm" type="button" aria-label="대화 기록">${svg("rotate-ccw-clock", 16, 2)}</button>
			<button class="icon-btn sm" type="button" aria-label="새 대화">${svg("plus", 14, 2.4)}</button>
		</div>
		<div class="ai-body" data-chat><div class="ai-col">${body}</div></div>
		<form class="composer" data-composer>
			<div class="compose-box">
				<input data-draft value="${esc(tab.draft)}" placeholder="${tab.automation ? (tab.ruleId ? "어떻게 바꿀까요?" : "언제, 어떤 파일에, 무엇을 할지 말해 주세요") : "파일, 메일, 메신저 전체에서 물어보세요 (파일 드래그 앤 드롭 가능)"}" autocomplete="off">
				<button class="send" type="submit" aria-label="보내기" ${tab.draft.trim() ? "" : "disabled"}>${svg("arrow-up", 16, 2.6)}</button>
			</div>
			<p class="ai-notice">답변은 AI가 생성하며 부정확할 수 있어요. 인용된 출처를 확인하세요.</p>
		</form>
	</section>`;
}

function message(m, latest) {
	if (m.role === "user") {
		// The chip keeps the rule as it was when asked; the answer card below shows its current state.
		const rule = m.ruleSnapshot;
		const chip = rule
			? `<span class="ref-chip">${svg("zap", 12, 2)}<span class="n">${esc(titleOf(rule))}</span><span class="s">자동화</span></span>`
			: m.newRule ? `<span class="ref-chip">${svg("plus", 12, 2.4)}<span class="n">새 규칙</span><span class="s">자동화</span></span>` : "";
		return `<div class="user-wrap">${chip}<div class="bubble">${esc(m.text)}</div></div>`;
	}
	if (m.role === "thinking") return `<div class="thinking"><i class="dot"></i>규칙을 살펴보는 중…</div>`;
	const parts = [`<div class="assistant"><div>${m.html}</div></div>`];
	if (m.card) parts.push(ruleCard(m.card.rule, m.card.flash ?? []));
	if (m.proposal) parts.push(proposal(m.proposal));
	if (m.suggests && !m.proposal && latest) parts.push(`<div class="suggests">${m.suggests.map((s) => `<button class="suggest" type="button" data-act="suggest" data-text="${esc(s)}">${esc(s)}</button>`).join("")}</div>`);
	return parts.join("");
}

/** Only the fields that change, each as a short before → after. */
function proposal(p) {
	const foot =
		p.state === "applied" ? `<div class="proposal-foot done">${svg("check", 12, 2.4)} ${p.kind === "delete" ? "삭제했어요" : p.kind === "create" ? "추가했어요" : "적용했어요"}</div>`
		: p.state === "dropped" ? `<div class="proposal-foot dropped">취소했어요</div>`
		: p.kind === "delete" ? `<div class="proposal-foot"><button class="linear-btn" type="button" data-act="drop">취소</button><button class="linear-btn is-danger" type="button" data-act="apply">삭제</button></div>`
		: `<div class="proposal-foot"><button class="linear-btn" type="button" data-act="drop">취소</button><button class="linear-btn is-primary" type="button" data-act="apply">${p.kind === "create" ? "추가" : "적용"}</button></div>`;
	if (p.kind === "create") return `<div class="proposal">${ruleCard(p.next).replace('class="rule-card"', 'class="rule-card" style="border:0;border-radius:0"')}${foot}</div>`;
	const rows = p.kind === "delete"
		? `<div class="change"><dt>삭제</dt><dd>${esc(titleOf(p.prev))}</dd></div>`
		: p.changes.map((c) => `<div class="change"><dt>${c.label}</dt><dd><del>${esc(c.from)}</del><span class="to">→</span><ins>${esc(c.to)}</ins></dd></div>`).join("");
	return `<div class="proposal"><dl class="proposal-rows">${rows}</dl>${foot}</div>`;
}

/* ------------------------------------------------------- AI 검색 tab flow -- */

/** Open a new AI 검색 tab next to the current one and send `text` at once, as AI 요약 does. */
function openAiTab({ ruleId = null, text }) {
	const id = state.nextTab++;
	const at = state.tabs.findIndex((t) => t.id === state.active) + 1;
	const tab = { id, kind: "ai", automation: true, ruleId, log: [], draft: "" };
	state.tabs.splice(at, 0, tab);
	state.active = id;
	state.newTab = id;
	state.menu = null;
	state.preview = null;
	later(() => { if (state.newTab === id) state.newTab = null; }, 400);
	send(tab, text);
}

const EDIT_PROMPT = "이 자동화 규칙을 바꾸고 싶어";
const ADD_PROMPT = "새 자동화 규칙을 만들고 싶어";

function startEdit(id) {
	if (ruleById(id)) openAiTab({ ruleId: id, text: EDIT_PROMPT });
}
function startAdd() {
	openAiTab({ text: ADD_PROMPT });
}

const ADD_SUGGESTS = ["다운로드에 PDF가 생기면 요약해줘", "데스크탑 스크린샷을 사진 폴더로 옮겨줘", "문서 폴더가 바뀌면 검색 색인을 최신화해줘"];

/** A stand-in for the agent turning a sentence into a new rule (`manage_automations save`). */
function draftNew(text) {
	const folder = [[/데스크탑|바탕화면/, "~/Desktop"], [/문서/, "~/Documents"], [/다운로드/, "~/Downloads"]].find(([re]) => re.test(text))?.[1] ?? "~/Downloads";
	const kind = /스크린샷/.test(text) ? ["Screen Shot*.png"] : /pdf/i.test(text) ? ["**/*.pdf"] : /hwp|한글/i.test(text) ? ["**/*.hwp", "**/*.hwpx"] : ["**"];
	const refresh = /색인|인덱스/.test(text);
	const slug = `${folderName(folder)}-${refresh ? "refresh" : "rule"}`.replace(/[^\w-]/g, "") || "new-rule";
	return {
		id: `${slug}-${state.nextTab}`,
		paths: [folder],
		events: refresh ? ["create", "update", "delete"] : ["create"],
		include: kind,
		exclude: [],
		run: refresh ? ["autorag", "refresh"] : ["autorag", "search", text.replace(/^.*?(면|때)\s*/, "").replace(/^(데스크탑|바탕화면|다운로드|문서)\s*/, "")],
		appendFiles: !refresh,
		debounceMs: 1000,
		timeoutMs: 600_000,
		lastRun: undefined,
	};
}

function send(tab, text) {
	const value = text.trim();
	if (!value) return;
	const rule = tab.ruleId ? ruleById(tab.ruleId) : null;
	const first = tab.log.length === 0;
	for (const m of tab.log) if (m.proposal?.state === "pending") m.proposal.state = "dropped";
	tab.log.push({ role: "user", text: value, ruleSnapshot: first ? rule : null, newRule: first && !rule }, { role: "thinking" });
	tab.draft = "";
	render({ focusDraft: true });
	later(() => {
		tab.log.pop();
		tab.log.push(reply(rule, value, first));
		render({ focusDraft: tab.id === state.active });
	}, 700);
}

function reply(rule, value, first) {
	if (first && rule) return { role: "assistant", html: "지금 이 규칙은 이렇게 동작해요. 어떻게 바꿀까요?", card: { rule }, suggests: SUGGESTS[rule.id] ?? [] };
	if (first && !rule) return { role: "assistant", html: "언제, 어떤 파일에, 무엇을 하면 될지 한 문장으로 알려주세요.", suggests: ADD_SUGGESTS };
	if (!rule) {
		const next = draftNew(value);
		return { role: "assistant", html: "이 규칙을 추가할게요.", proposal: { kind: "create", state: "pending", next } };
	}
	if (/삭제해|지워 ?줘|없애/.test(value)) return { role: "assistant", html: "이 규칙을 삭제할까요? 폴더와 파일은 그대로 둡니다.", proposal: { kind: "delete", state: "pending", prev: rule } };
	if (/왜|실패|오류/.test(value)) {
		const run = rule.lastRun;
		return {
			role: "assistant",
			html: runTone(run) === "fail"
				? `${relTime(run.startedAt)} 실행이 <b>${esc(failReason(run))}</b>(으)로 실패했어요. 프로그램을 설치하면 규칙은 그대로 다시 동작합니다.`
				: "최근 실행은 성공했어요.",
			suggests: SUGGESTS[rule.id]?.filter((s) => !/왜/.test(s)),
		};
	}
	const next = draft(rule, value);
	const changes = diff(rule, next);
	return changes.length
		? { role: "assistant", html: "이렇게 바꿀게요.", proposal: { kind: "edit", state: "pending", prev: rule, next, changes } }
		: { role: "assistant", html: "어떤 부분을 바꿀지 조금 더 알려주세요. 예를 들면:", suggests: SUGGESTS[rule.id] };
}

function applyProposal(tab) {
	const msg = [...tab.log].reverse().find((m) => m.proposal?.state === "pending");
	if (!msg) return;
	const p = msg.proposal;
	p.state = "applied";
	if (p.kind === "delete") {
		removeRule(tab.ruleId);
		return;
	}
	if (p.kind === "create") {
		state.rules.push(p.next);
		state.selected = p.next.id;
		tab.ruleId = p.next.id;
		tab.log.push({ role: "assistant", html: `추가했어요. ${state.daemon ? "다음 파일부터 바로 동작합니다." : "백그라운드 실행을 켜면 동작합니다."} 자동화 탭에서 확인할 수 있어요.` });
		state.flash = { id: p.next.id, fields: [] };
	} else {
		const index = state.rules.findIndex((r) => r.id === tab.ruleId);
		state.rules[index] = p.next;
		const fields = [...new Set(p.changes.map((c) => (c.label === "폴더" ? "folders" : c.key)))];
		state.flash = { id: tab.ruleId, fields };
		tab.log.push({ role: "assistant", html: state.daemon ? "저장했어요. 다음 파일부터 바로 적용됩니다." : "저장했어요. 백그라운드 실행이 꺼져 있어 켜야 동작합니다.", card: { rule: p.next, flash: fields } });
	}
	render({ focusDraft: true });
	later(() => { state.flash = null; render(); }, 1900);
}

function dropProposal(tab) {
	const msg = [...tab.log].reverse().find((m) => m.proposal?.state === "pending");
	if (!msg) return;
	msg.proposal.state = "dropped";
	render({ focusDraft: true });
}

function removeRule(id) {
	const index = state.rules.findIndex((r) => r.id === id);
	if (index < 0) return;
	const [rule] = state.rules.splice(index, 1);
	if (state.selected === id) state.selected = state.rules[Math.min(index, state.rules.length - 1)]?.id ?? null;
	if (state.preview === id) state.preview = null;
	state.confirm = null;
	state.toast = { text: `‘${titleOf(rule)}’ 규칙을 삭제했어요`, undo: { rule, index } };
	render();
	const shown = state.toast;
	later(() => { if (state.toast === shown) { state.toast = null; render(); } }, 5000);
}

/* ------------------------------------------------------------------ Tabs -- */

/** Focus the first tab of `kind`, or turn the focused tab into it — the sidebar's navigate. */
function go(kind) {
	const existing = state.tabs.find((t) => t.kind === kind && kind !== "ai");
	if (existing) state.active = existing.id;
	else if (kind === "ai") openBlankAi();
	state.fileSel = null;
	state.preview = null;
}
function openBlankAi() {
	const id = state.nextTab++;
	state.tabs.push({ id, kind: "ai", ruleId: null, log: [], draft: "" });
	state.active = id;
	state.newTab = id;
}
function closeTab(id) {
	if (state.tabs.length === 1) return;
	const index = state.tabs.findIndex((t) => t.id === id);
	state.tabs.splice(index, 1);
	if (state.active === id) state.active = state.tabs[Math.max(0, index - 1)].id;
}

/* ----------------------------------------------------------------- Render -- */

function contextMenu() {
	if (!state.menu) return "";
	const { id, x, y } = state.menu;
	const kind = activeTab().kind;
	const items = id === null
		? `<button class="menu-item" type="button" data-act="add">AI 검색에서 새 규칙 추가…</button>`
		: `
		<button class="menu-item" type="button" data-act="preview" data-id="${esc(id)}">훑어보기<span class="grow"></span><span class="keycap">Space</span></button>
		<button class="menu-item" type="button" data-act="edit" data-id="${esc(id)}">AI 검색에서 편집</button>
		${kind === "folder" ? `<button class="menu-item" type="button" data-act="reveal" data-id="${esc(id)}">자동화 탭에서 보기</button>` : ""}
		${kind === "automations" && ruleById(id)?.paths.includes("~/Downloads") ? `<button class="menu-item" type="button" data-act="go" data-id="folder">감시 폴더 열기</button>` : ""}
		<div class="menu-sep"></div>
		<button class="menu-item" type="button" data-act="add">AI 검색에서 새 규칙 추가…</button>
		<div class="menu-sep"></div>
		<button class="menu-item danger" type="button" data-act="ask-delete" data-id="${esc(id)}">삭제</button>`;
	return `<div class="menu" style="left:${x}px;top:${y}px" role="menu">${items}</div>`;
}

function confirmDialog() {
	const rule = state.confirm && ruleById(state.confirm);
	if (!rule) return "";
	return `
	<div class="scrim">
		<div class="dialog" role="alertdialog" aria-modal="true">
			<div><h3>‘${esc(titleOf(rule))}’ 규칙을 삭제할까요?</h3><p>이 규칙만 지워지고 폴더와 파일은 그대로 남아요.</p></div>
			<div class="row-btns"><button class="linear-btn" type="button" data-act="cancel-delete">취소</button><button class="linear-btn is-danger" type="button" data-act="confirm-delete">삭제</button></div>
		</div>
	</div>`;
}

function render({ focusDraft = false } = {}) {
	const win = document.getElementById("window");
	const tab = activeTab();
	const selected = ruleById(state.selected);
	const pane = tab.kind === "ai" ? aiPane(tab) : tab.kind === "automations" ? automationsPane() : folderPane();
	const inspector = tab.kind === "ai"
		? `<div class="inspector-empty">답변의 근거가\n여기에 표시됩니다.</div>`
		: tab.kind === "automations"
			? selected ? ruleInspector(selected) : `<div class="inspector-empty">규칙을 선택하면\n요약이 여기에 표시됩니다.</div>`
			: folderInspector();
	win.innerHTML = `
		${sidebar()}
		<section class="main">
			${toolbar()}
			<div class="content">
				<div class="pane">${tabStrip()}${pane}</div>
				<aside class="inspector" aria-label="정보 창">${inspector}</aside>
			</div>
		</section>
		${contextMenu()}
		${quickLook()}
		${confirmDialog()}
		${state.toast ? `<output class="toast" aria-live="polite"><i class="dot ok"></i>${esc(state.toast.text)}${state.toast.undo ? `<button class="text-btn" type="button" data-act="undo">실행 취소</button>` : ""}</output>` : ""}`;
	for (const b of document.querySelectorAll(".review-bar [data-act=go]")) b.classList.toggle("is-on", b.dataset.id === tab.kind);
	document.getElementById("theme-toggle").textContent = document.documentElement.dataset.appearance === "dark" ? "라이트 모드" : "다크 모드";
	const chat = win.querySelector("[data-chat]");
	if (chat) chat.scrollTop = chat.scrollHeight;
	if (focusDraft) {
		const input = win.querySelector("[data-draft]");
		if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
	}
}

/* ----------------------------------------------------------------- Events -- */

document.addEventListener("click", (event) => {
	const target = event.target.closest("[data-act]");
	const menuOpen = state.menu !== null;
	if (menuOpen && !event.target.closest(".menu")) state.menu = null;
	// A click inside the Quick Look panel that hits no control must not close it.
	if (target?.dataset.act === "close-preview" && event.target.closest("[data-stop]") && !event.target.closest(".ql-tool")) return;
	if (!target) { if (menuOpen) render(); return; }
	const { act, id } = target.dataset;
	const tab = activeTab();
	switch (act) {
		case "go": go(id); break;
		case "tab": state.active = Number(id); state.preview = null; break;
		case "close-tab": event.stopPropagation(); closeTab(Number(id)); break;
		case "select": state.selected = id; break;
		case "file": state.fileSel = state.fileSel === id ? null : id; break;
		case "preview": state.menu = null; state.selected = id; state.preview = id; break;
		case "close-preview": state.preview = null; break;
		case "edit": startEdit(id); return;
		case "add": startAdd(); return;
		case "details": state.details = !state.details; break;
		case "ask-delete": state.menu = null; state.confirm = id; break;
		case "cancel-delete": state.confirm = null; break;
		case "confirm-delete": removeRule(state.confirm); return;
		case "undo": {
			const { rule, index } = state.toast.undo;
			state.rules.splice(index, 0, rule);
			state.selected = rule.id;
			state.toast = null;
			break;
		}
		case "reveal": go("automations"); state.selected = id; state.menu = null; break;
		case "daemon": state.daemon = !state.daemon; break;
		case "suggest": send(tab, target.dataset.text); return;
		case "apply": applyProposal(tab); return;
		case "drop": dropProposal(tab); return;
		case "theme": {
			const root = document.documentElement;
			root.dataset.appearance = root.dataset.appearance === "dark" ? "light" : "dark";
			break;
		}
		case "reset": for (const t of timers) clearTimeout(t); timers.clear(); state = freshState(); break;
	}
	render();
});

document.addEventListener("dblclick", (event) => {
	const row = event.target.closest("[data-dbl=edit]");
	if (row) startEdit(row.dataset.id);
});

document.addEventListener("contextmenu", (event) => {
	const row = event.target.closest("[data-menu=rule]");
	const list = event.target.closest("[data-menu=list]");
	if (!row && !list) return;
	event.preventDefault();
	const box = document.getElementById("window").getBoundingClientRect();
	if (row && activeTab().kind === "automations") state.selected = row.dataset.id;
	state.menu = { id: row ? row.dataset.id : null, x: Math.min(event.clientX - box.left, box.width - 230), y: Math.min(event.clientY - box.top, box.height - 260) };
	render();
});

document.addEventListener("input", (event) => {
	if (!event.target.matches("[data-draft]")) return;
	activeTab().draft = event.target.value;
	event.target.closest("form").querySelector(".send").disabled = !event.target.value.trim();
});

document.addEventListener("submit", (event) => {
	if (!event.target.matches("[data-composer]")) return;
	event.preventDefault();
	send(activeTab(), activeTab().draft);
});

document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") {
		if (state.preview) state.preview = null;
		else if (state.menu) state.menu = null;
		else if (state.confirm) state.confirm = null;
		else return;
		render();
		return;
	}
	if (event.target.matches("input")) return;
	if (activeTab().kind !== "automations" || !state.selected || state.confirm) return;
	if (event.key === " ") {
		event.preventDefault();
		state.preview = state.preview ? null : state.selected;
		render();
		return;
	}
	if (event.key === "Enter") { event.preventDefault(); startEdit(state.selected); return; }
	if (event.key === "Backspace" && event.metaKey) { state.confirm = state.selected; state.preview = null; render(); return; }
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		const i = state.rules.findIndex((r) => r.id === state.selected);
		const next = state.rules[i + (event.key === "ArrowDown" ? 1 : -1)];
		if (next) {
			state.selected = next.id;
			// Like Finder, an open preview follows the selection.
			if (state.preview) state.preview = next.id;
			render();
		}
	}
});

window.addEventListener("DOMContentLoaded", () => render());
