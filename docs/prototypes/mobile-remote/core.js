/* Dazzi mobile remote prototype — state, formatting, row/thumbnail markup, and
 * the render loop. Views (views.js), overlays (overlays.js), and input
 * (main.js) build on these globals; data.js supplies the demo tree. */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (value) =>
	String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** Lucide glyph from icons.js; stroke 2 matches SF Symbols' regular weight at 20pt better than the app's 1.8. */
const svg = (slug, size = 20, stroke = 2) =>
	`<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" stroke-width="${stroke}" aria-hidden="true">${LUCIDE[slug] ?? ""}</svg>`;

const SEP = "\\";
const PC_NAME = "DESKTOP-KDG";
const DAY_MS = 86_400_000;
const TAG_COLOR = {
	red: "var(--tag-red)", orange: "var(--tag-orange)", yellow: "var(--tag-yellow)", green: "var(--tag-green)",
	blue: "var(--tag-blue)", purple: "var(--tag-purple)", gray: "var(--tag-gray)",
};
const TABS = [
	{ id: "browse", label: "둘러보기", icon: "folder" },
	{ id: "recents", label: "최근 항목", icon: "history" },
	{ id: "ai", label: "AI 검색", icon: "sparkles" },
	{ id: "auto", label: "자동화", icon: "zap" },
];
const SORT_LABEL = { name: "이름", date: "수정일", size: "크기", kind: "종류" };

/* ------------------------------------------------------------------ State -- */

const S = {
	tab: "browse",
	prevTab: "browse",
	stacks: {
		browse: [{ kind: "root" }],
		recents: [{ kind: "recents" }],
		ai: [{ kind: "chat" }],
		auto: [{ kind: "rules" }],
		search: [{ kind: "search" }],
	},
	scrollMemo: {},
	anim: null,
	min: false,
	view: "list",
	sort: { key: "name", asc: true },
	select: null,
	clip: null,
	overlay: null,
	toast: null,
	undoFn: null,
	flash: null,
	fresh: null,
	collapsed: new Set(),
	recentsFilter: "all",
	daemon: true,
	activity: ACTIVITY.map((item) => ({ ...item })),
	chat: { phase: "empty", messages: [], attachments: [], draft: "", mode: "ask", approval: false },
	search: { q: "", scope: "name" },
};

/* ------------------------------------------------------------- Formatting -- */

function fmtSize(bytes) {
	if (bytes == null) return "";
	if (bytes < 1000) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
	return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}
const startOfDay = (time) => { const x = new Date(time); x.setHours(0, 0, 0, 0); return x.getTime(); };
const daysAgo = (time) => Math.round((startOfDay(NOW) - startOfDay(time)) / DAY_MS);
const hhmm = (x) => `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
function fmtDate(time) {
	const x = new Date(time);
	const diff = daysAgo(time);
	if (diff === 0) return `오늘 ${hhmm(x)}`;
	if (diff === 1) return `어제 ${hhmm(x)}`;
	if (diff < 7) return `${"일월화수목금토"[x.getDay()]}요일`;
	if (x.getFullYear() === NOW.getFullYear()) return `${x.getMonth() + 1}월 ${x.getDate()}일`;
	return `${x.getFullYear()}. ${x.getMonth() + 1}. ${x.getDate()}.`;
}
function fmtFull(time) {
	const x = new Date(time);
	const h = x.getHours();
	return `${x.getFullYear()}년 ${x.getMonth() + 1}월 ${x.getDate()}일 ${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${String(x.getMinutes()).padStart(2, "0")}`;
}
function bucketOf(time) {
	const diff = daysAgo(time);
	if (diff === 0) return "오늘";
	if (diff === 1) return "어제";
	if (diff < 7) return "이번 주";
	if (diff < 31) return "이번 달";
	return "이전";
}

/* ------------------------------------------------------------------ Nodes -- */

const node = (path) => nodes.get(path);
const isFolder = (n) => n.type === "folder";
const inTrash = (n) => n.path.startsWith(`휴지통${SEP}`);
const kindOf = (n) =>
	KINDS[n.ext] ?? { label: `${n.ext.toUpperCase()} 파일`, family: "doc", badge: n.ext.toUpperCase().slice(0, 4), tint: "#8E8E93" };
const previewOf = (n) => (isFolder(n) ? null : kindOf(n).preview ?? null);

/** The label the sidebar would show for a folder (데스크탑 for C:\Users\…\Desktop). */
function displayName(folder) {
	for (const group of PLACES) for (const item of group.items) if (item.path === folder.path) return item.label;
	return folder.label ?? folder.name;
}
function ancestors(n) {
	const chain = [];
	for (let at = n; at; at = at.parent ? node(at.parent) : null) chain.unshift(at);
	return chain;
}
const parentLabel = (n) => (n.parent ? displayName(node(n.parent)) : "");
function shortPath(path) {
	const n = node(path);
	if (n) return displayName(n);
	return path.replace(HOME, "~");
}

function forget(n) { nodes.delete(n.path); (n.children ?? []).forEach(forget); }
function detach(n) {
	const parent = n.parent ? node(n.parent) : null;
	if (parent) { parent.children = parent.children.filter((c) => c !== n); parent.count = parent.children.length; }
	forget(n);
}
function attach(n, folder) {
	folder.children.push(n);
	folder.count = folder.children.length;
	register(n, folder.path, SEP);
}
function uniqueName(folder, name) {
	const taken = new Set(folder.children.map((c) => c.name));
	if (!taken.has(name)) return name;
	const dot = name.lastIndexOf(".");
	const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
	for (let i = 2; ; i++) if (!taken.has(`${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
}
const cloneNode = (n) => JSON.parse(JSON.stringify(n, (key, value) => (key === "parent" || key === "path" ? undefined : value)));

function listing(folder) {
	const { key, asc } = S.sort;
	const dir = asc ? 1 : -1;
	const byName = (a, b) => a.name.localeCompare(b.name, "ko", { numeric: true });
	const cmp = {
		name: byName,
		date: (a, b) => a.mtime - b.mtime,
		size: (a, b) => (a.size ?? 0) - (b.size ?? 0),
		kind: (a, b) => kindOf(a).label.localeCompare(kindOf(b).label, "ko") || byName(a, b),
	}[key];
	return [...folder.children].sort((a, b) => isFolder(b) - isFolder(a) || cmp(a, b) * dir);
}
const allFiles = () => [...nodes.values()].filter((n) => !isFolder(n) && !inTrash(n));

/* ------------------------------------------------------------- Thumbnails -- */

function folderSvg(size, tag) {
	const back = tag ? `color-mix(in srgb, ${tag} 82%, black)` : "var(--folder-stroke)";
	const front = tag ?? "var(--folder)";
	return `<svg class="folder-svg" width="${size}" height="${Math.round(size * 0.8)}" viewBox="0 0 50 40" aria-hidden="true"><path d="M2 6a4 4 0 0 1 4-4h11.6a4 4 0 0 1 2.8 1.2L23.2 6H44a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="${back}"/><path d="M2 13a4 4 0 0 1 4-4h38a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4z" fill="${front}"/></svg>`;
}
const PHOTO = `<svg width="100%" height="100%" viewBox="0 0 44 44" preserveAspectRatio="none" aria-hidden="true"><circle cx="31" cy="13" r="5" fill="rgba(255,255,255,0.5)"/><path d="M0 35l12-13 9 9 7-6 16 14v5H0z" fill="rgba(0,0,0,0.16)"/></svg>`;
const artStyle = (n) => `background:linear-gradient(140deg, ${n.art[0]}, ${n.art[1]})`;
function docThumb(n, width = 34) {
	const k = kindOf(n);
	const height = Math.round((width * 44) / 34);
	return `<div class="thumb-doc" style="width:${width}px;height:${height}px"><svg width="${width}" height="${height}" viewBox="0 0 34 44" aria-hidden="true"><path d="M2.5 3.5A2.5 2.5 0 0 1 5 1h17.5L32 10.5v30A2.5 2.5 0 0 1 29.5 43h-24.5A2.5 2.5 0 0 1 2.5 40.5z" fill="var(--m-doc)" stroke="var(--m-doc-edge)" stroke-width="1"/><path d="M22.5 1v7a2.5 2.5 0 0 0 2.5 2.5h7" fill="none" stroke="var(--m-doc-edge)" stroke-width="1"/><path d="M8 17h18M8 21h18M8 25h12" stroke="var(--m-doc-line)" stroke-width="1.6" stroke-linecap="round"/></svg><span class="badge" style="background:${k.tint}">${esc(k.badge)}</span></div>`;
}
function thumbHtml(n) {
	const k = kindOf(n);
	if (isFolder(n)) return `<div class="thumb">${folderSvg(40, n.tags?.[0] && TAG_COLOR[n.tags[0]])}</div>`;
	if (k.family === "image") return `<div class="thumb"><div class="thumb-art" style="${artStyle(n)}">${PHOTO}</div></div>`;
	if (k.family === "video")
		return `<div class="thumb"><div class="thumb-art" style="${artStyle(n)}">${svg("play", 16, 0)}</div>${n.dur ? `<span class="thumb-dur">${n.dur}</span>` : ""}</div>`;
	if (k.family === "audio") return `<div class="thumb"><div class="thumb-art" style="${artStyle(n)}">${svg("music", 20, 2.2)}</div></div>`;
	if (k.family === "doc") return `<div class="thumb">${docThumb(n)}</div>`;
	return `<div class="thumb"><div class="thumb-art is-badge" style="background:${k.tint}">${esc(k.badge)}</div></div>`;
}
function tileThumb(n) {
	const k = kindOf(n);
	if (isFolder(n)) return folderSvg(78, n.tags?.[0] && TAG_COLOR[n.tags[0]]);
	if (k.family === "image") return `<div class="t-art is-photo" style="${artStyle(n)}">${PHOTO}</div>`;
	if (k.family === "video")
		return `<div class="t-art is-photo" style="${artStyle(n)}">${svg("play", 22, 0)}</div>${n.dur ? `<span class="thumb-dur">${n.dur}</span>` : ""}`;
	if (k.family === "audio") return `<div class="t-art" style="${artStyle(n)}">${svg("music", 30, 2)}</div>`;
	if (k.family === "doc") return docThumb(n, 56);
	return `<div class="t-art is-badge" style="width:64%;background:${k.tint}">${esc(k.badge)}</div>`;
}

/* ------------------------------------------------------------------ Rows -- */

/** Middle truncation keeps the extension: "ktwiz 캡틴 박경수…부활.mp3". `hl` marks a search match. */
function nameHtml(n, cls = "row-name", hl = "") {
	const mark = (text) => {
		const safe = esc(text);
		if (!hl) return safe;
		const at = text.toLowerCase().indexOf(hl.toLowerCase());
		return at < 0 ? safe : `${esc(text.slice(0, at))}<mark class="hl">${esc(text.slice(at, at + hl.length))}</mark>${esc(text.slice(at + hl.length))}`;
	};
	const dot = n.name.lastIndexOf(".");
	if (isFolder(n) || dot < 0 || n.name.length < 16 || hl) return `<span class="${cls}"><span class="nm-h">${mark(n.name)}</span></span>`;
	const cut = Math.max(0, dot - 4);
	return `<span class="${cls}"><span class="nm-h">${mark(n.name.slice(0, cut))}</span><span class="nm-t">${mark(n.name.slice(cut))}</span></span>`;
}
const tagDots = (n) =>
	n.tags?.length ? `<span class="dots">${n.tags.map((t) => `<i style="background:${TAG_COLOR[t]}"></i>`).join("")}</span>` : "";
function metaText(n, { where = false } = {}) {
	const first = inTrash(n) && n.from ? `${shortPath(n.from)}에서` : where ? parentLabel(n) : fmtDate(n.mtime);
	return `${esc(first)} · ${isFolder(n) ? `${n.count}개 항목` : fmtSize(n.size)}`;
}
const metaHtml = (n, opts) =>
	`<span class="row-meta">${tagDots(n)}<span class="mt">${metaText(n, opts)}</span>${n.indexed ? `<span class="ix" title="AI 검색에 포함">${svg("sparkles", 12, 2.2)}</span>` : ""}</span>`;
const checkHtml = (on) => `<span class="check ${on ? "is-on" : ""}">${on ? svg("check", 14, 3.2) : ""}</span>`;

function rowHtml(n, opts = {}) {
	const selecting = !!S.select;
	const on = S.select?.has(n.path);
	const cls = ["row", S.flash === n.path && "is-flash", S.fresh === n.path && "is-new", n.uploading != null && "is-uploading"].filter(Boolean).join(" ");
	const swipe = inTrash(n)
		? `<button class="sw-more" data-act="restore" data-arg="${esc(n.path)}">${svg("rotate-ccw", 20)}복원</button><button class="sw-trash" data-act="delete-forever" data-arg="${esc(n.path)}">${svg("trash", 20)}삭제</button>`
		: `<button class="sw-more" data-act="row-more" data-arg="${esc(n.path)}">${svg("ellipsis", 20)}더보기</button><button class="sw-trash" data-act="trash" data-arg="${esc(n.path)}">${svg("trash", 20)}휴지통</button>`;
	return `<div class="${cls}" data-path="${esc(n.path)}"><div class="swipe-actions">${swipe}</div><div class="row-inner" data-act="open" data-arg="${esc(n.path)}">${selecting ? checkHtml(on) : ""}${thumbHtml(n)}<div class="row-main">${nameHtml(n, "row-name", opts.hl)}${n.uploading != null ? `<span class="row-meta"><span class="up-bar"><i style="width:${Math.round(n.uploading * 100)}%"></i></span>업로드 중</span>` : metaHtml(n, opts)}</div>${selecting ? "" : `<button class="row-more" data-act="row-more" data-arg="${esc(n.path)}" aria-label="${esc(n.name)} 메뉴">${svg("ellipsis", 20)}</button>`}</div></div>`;
}
function tileHtml(n, opts = {}) {
	const on = S.select?.has(n.path);
	const meta = isFolder(n) ? `${n.count}개 항목` : opts.where ? parentLabel(n) : fmtDate(n.mtime);
	return `<div class="tile-item ${S.flash === n.path ? "is-flash" : ""}" data-path="${esc(n.path)}" data-act="open" data-arg="${esc(n.path)}"><div class="t-thumb">${tileThumb(n)}</div>${S.select ? checkHtml(on) : ""}<span class="t-name">${esc(n.name)}</span><span class="t-meta">${tagDots(n)}${esc(meta)}</span></div>`;
}
const itemsHtml = (list, opts) =>
	S.view === "grid" ? `<div class="grid">${list.map((n) => tileHtml(n, opts)).join("")}</div>` : `<div class="rows">${list.map((n) => rowHtml(n, opts)).join("")}</div>`;

/* ------------------------------------------------------------ Navigation -- */

const stack = () => S.stacks[S.tab];
const route = () => stack().at(-1);
const routeKey = () => `${S.tab}:${JSON.stringify(route())}`;
const pageEl = () => $("#screen .page");

function rememberScroll() { const page = pageEl(); if (page) S.scrollMemo[routeKey()] = page.scrollTop; }
function push(next) { rememberScroll(); stack().push(next); S.anim = "push"; S.select = null; S.min = false; render(); }
function back() {
	if (stack().length < 2) return;
	stack().pop();
	S.anim = "pop"; S.select = null; S.min = false;
	render();
}
function setTab(id) {
	if (id === S.tab) {
		if (stack().length > 1) { S.stacks[id] = [stack()[0]]; S.anim = "pop"; }
	} else {
		rememberScroll();
		if (S.tab !== "search") S.prevTab = S.tab;
		S.tab = id;
	}
	S.select = null; S.min = false;
	render();
}
/** Show a path in 둘러보기 the way PathBar would: every ancestor on the stack, the item flashed. */
function revealPath(path) {
	const n = node(path);
	if (!n) return;
	const folder = isFolder(n) ? n : node(n.parent);
	S.tab = "browse";
	S.stacks.browse = [{ kind: "root" }, ...ancestors(folder).map((a) => ({ kind: "folder", path: a.path }))];
	S.flash = isFolder(n) ? null : n.path;
	S.overlay = null; S.select = null; S.anim = "push";
	render();
	setTimeout(() => { if (S.flash === n.path) S.flash = null; }, 1800);
}

/* ----------------------------------------------------------------- Toasts -- */

let toastTimer = 0;
function toast(text, { icon = "circle-check", undo = null, action = null } = {}) {
	S.toast = { id: Date.now(), text, icon, action, undo: !!undo };
	S.undoFn = undo;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { S.toast = null; S.undoFn = null; render(); }, 4200);
	render();
}

/* ---------------------------------------------------------------- Bottom -- */

const gbtn = (icon, act, arg = "", label = "", cls = "") =>
	`<button class="gbtn glass ${cls}" data-act="${act}" data-arg="${esc(arg)}" aria-label="${esc(label)}">${svg(icon, 20, 2.1)}</button>`;
const gtext = (text, act, cls = "") => `<button class="gtext glass ${cls}" data-act="${act}">${esc(text)}</button>`;
function navTitle(title, sub = "", { always = false, act = "" } = {}) {
	const inner = `<b><span>${esc(title)}</span>${act ? svg("chevron-down", 14, 2.6) : ""}</b>${sub ? `<small>${sub}</small>` : ""}`;
	return `<div class="nav-title ${always ? "is-always" : ""}">${act ? `<button data-act="${act}">${inner}</button>` : inner}</div>`;
}

function ringHtml(item) {
	const C = 2 * Math.PI * 13;
	const error = item.tone === "error";
	const value = error ? "" : `<circle class="r-val" data-ring="${item.id}" cx="16" cy="16" r="13" fill="none" stroke-width="3" stroke-linecap="round" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(item.progress == null ? C * 0.7 : C * (1 - item.progress)).toFixed(2)}"/>`;
	return `<span class="ring ${error ? "is-error" : ""} ${item.progress == null && !error ? "is-spin" : ""}"><svg class="r" width="32" height="32" viewBox="0 0 32 32"><circle class="r-track" cx="16" cy="16" r="13" fill="none" stroke-width="3"/>${value}</svg>${svg(item.icon, 14, 2.4)}</span>`;
}
function toastHtml() {
	const t = S.toast;
	const action = t.action ? `<button data-act="${t.action.act}" data-arg="${esc(t.action.arg ?? "")}">${esc(t.action.label)}</button>` : "";
	return `<div class="toast glass ${t.undo || t.action ? "" : "no-action"}" data-k="toast-${t.id}" role="status">${svg(t.icon, 18, 2.2)}<span>${esc(t.text)}</span>${t.undo ? `<button data-act="undo">실행 취소</button>` : ""}${action}</div>`;
}
function accessoryHtml() {
	const [first, ...rest] = S.activity;
	return `<button class="accessory glass" data-act="activity" data-k="acc-${first.id}" aria-label="진행 및 대기 중인 작업">${ringHtml(first)}<div class="acc-main"><b data-acc-title>${esc(first.title)}</b><small>${esc(first.detail)}</small></div>${rest.length ? `<span class="acc-count">+${rest.length}</span>` : ""}</button>`;
}
function pasteHtml() {
	const folder = node(route().path);
	return `<div class="paste-bar glass" data-k="paste"><span class="ring">${svg("copy", 18, 2.2)}</span><div class="acc-main"><b>${S.clip.paths.length}개 항목 복사됨</b><small>${esc(displayName(folder))}에 붙여넣을 수 있어요</small></div><button class="acc-x" data-act="clip-clear" aria-label="복사 취소">${svg("x", 18, 2.4)}</button><button class="acc-btn" data-act="paste">붙여넣기</button></div>`;
}
function selbarHtml() {
	const off = S.select.size ? "" : "disabled";
	const b = (icon, label, act, cls = "") => `<button class="${cls}" data-act="${act}" ${off}>${svg(icon, 22, 2)}<span>${label}</span></button>`;
	const trash = route().path === "휴지통";
	const buttons = trash
		? b("rotate-ccw", "복원", "sel-restore") + b("trash", "영구 삭제", "sel-delete", "is-danger")
		: b("folder-input", "이동", "sel-move") + b("copy", "복사", "sel-copy") + b("sparkles", "AI에게", "sel-ai") + b("ellipsis", "더보기", "sel-more") + b("trash", "휴지통", "sel-trash", "is-danger");
	return `<div class="selbar glass" data-k="selbar">${buttons}</div>`;
}
function composerHtml() {
	const chat = S.chat;
	const ready = chat.draft.trim() || chat.attachments.length;
	const chips = chat.attachments.length ? `<div class="comp-attach">${chat.attachments.map((p) => attachChip(p, true)).join("")}</div>` : "";
	return `<div class="composer-wrap" data-k="composer">${chips}<div class="composer glass"><button class="c-btn" data-act="attach" aria-label="파일 첨부">${svg("plus", 22, 2.2)}</button><textarea id="composer" rows="1" enterkeyhint="send" placeholder="파일, 메일, 메신저에서 찾기">${esc(chat.draft)}</textarea><button class="c-btn send" data-act="send" ${ready ? "" : "disabled"} aria-label="보내기">${svg("arrow-up", 22, 2.6)}</button></div></div>`;
}
function attachChip(path, removable = false) {
	const n = node(path);
	if (!n) return "";
	return `<span class="attach-chip">${thumbHtml(n)}<span>${esc(n.name)}</span>${removable ? `<button data-act="detach" data-arg="${esc(path)}" aria-label="첨부 빼기">${svg("x", 12, 3)}</button>` : ""}</span>`;
}
function approvalHtml() {
	const a = CHAT.approval;
	return `<div class="approval glass" data-k="approval" role="alertdialog"><div class="ap-head"><span class="tile">${svg("shield-check", 18, 2.2)}</span><div><b>${esc(a.headline)}</b><small>${esc(a.summary)}</small></div></div><details><summary>변경 내용 ${a.ops.length}개 보기</summary><ul>${a.ops.map((o) => `<li>${esc(o)}</li>`).join("")}</ul></details><div class="ap-btns"><button data-act="deny">거부</button><button class="is-primary" data-act="allow">한 번만 허용</button></div><button class="ap-alt" data-act="deny-note">거부하고 모델에게 알려주기…</button></div>`;
}
function barRowHtml() {
	if (S.tab === "search") {
		const prev = TABS.find((t) => t.id === S.prevTab) ?? TABS[0];
		return `<div class="bar-row is-search">${gbtn(prev.icon, "search-exit", "", `${prev.label}(으)로 돌아가기`)}<label class="search-field glass" data-k="sf">${svg("search", 18, 2.2)}<input id="q" type="search" enterkeyhint="search" autocomplete="off" placeholder="파일 이름이나 내용" value="${esc(S.search.q)}">${S.search.q ? `<button class="sf-clear" data-act="q-clear" aria-label="지우기">${svg("x", 16, 2.6)}</button>` : ""}</label></div>`;
	}
	const index = TABS.findIndex((t) => t.id === S.tab);
	const tabs = TABS.map((t) => {
		const badge = t.id === "ai" && S.chat.approval && S.tab !== "ai" ? `<span class="tab-badge">1</span>` : "";
		return `<button class="tab ${t.id === S.tab ? "is-on" : ""}" data-act="tab" data-arg="${t.id}" aria-label="${t.label}">${svg(t.icon, 24, t.id === S.tab ? 2.3 : 1.9)}<span>${t.label}</span>${badge}</button>`;
	}).join("");
	return `<div class="bar-row"><nav class="tabbar glass" style="--n:${TABS.length}"><i class="tab-lens" style="--i:${index}"></i>${tabs}</nav>${gbtn("search", "tab", "search", "검색", "search-tab")}</div>`;
}
function bottomHtml() {
	const parts = [];
	if (S.toast) parts.push(toastHtml());
	if (S.select) {
		parts.push(selbarHtml());
	} else {
		if (S.tab === "ai") parts.push(S.chat.approval ? approvalHtml() : composerHtml());
		else if (S.tab === "browse" && S.clip && route().kind === "folder" && route().path !== "휴지통") parts.push(pasteHtml());
		else if (S.tab !== "search" && S.activity.length) parts.push(accessoryHtml());
		parts.push(barRowHtml());
	}
	const min = S.min && S.tab !== "ai" && S.tab !== "search" && !S.select;
	return `<div class="bottom ${min ? "is-min" : ""}">${parts.join("")}</div>`;
}

const STATUS = `<div class="statusbar"><span>14:20</span><span class="sb-icons"><svg width="18" height="12" viewBox="0 0 18 12" aria-hidden="true"><rect x="0" y="8" width="3" height="4" rx="1" fill="currentColor"/><rect x="5" y="5.5" width="3" height="6.5" rx="1" fill="currentColor"/><rect x="10" y="3" width="3" height="9" rx="1" fill="currentColor"/><rect x="15" y="0" width="3" height="12" rx="1" fill="currentColor"/></svg>${svg("wifi", 17, 2.6)}<svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" opacity="0.4"/><rect x="2" y="2" width="16" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4a2 2 0 0 0 0-4z" fill="currentColor" opacity="0.45"/></svg></span></div>`;

/* ---------------------------------------------------------------- Render -- */

const shownKeys = new Set();
let lastLens = null;

function render() {
	const screen = $("#screen");
	const view = currentView();
	const key = routeKey();
	const oldPage = pageEl();
	const keep = oldPage && oldPage.dataset.key === key && !S.anim;
	const top = keep ? oldPage.scrollTop : S.anim === "pop" ? S.scrollMemo[key] ?? 0 : 0;
	const active = document.activeElement;
	const focusId = active?.id && screen.contains(active) ? active.id : null;
	const caret = focusId ? [active.selectionStart, active.selectionEnd] : null;
	const sheetTop = $(".sheet-body", screen)?.scrollTop ?? 0;
	const menuTop = $(".menu", screen)?.scrollTop ?? 0;

	screen.classList.toggle("is-plain", !!view.plain);
	screen.innerHTML = `${STATUS}<div class="page ${S.anim ? `enter-${S.anim}` : ""}" data-key="${esc(key)}">${view.body}</div><div class="edge edge-top"></div><div class="edge edge-bottom"></div><header class="navbar">${view.nav}</header>${bottomHtml()}${overlayHtml()}`;

	const seen = new Set();
	for (const el of $$("[data-k]", screen)) {
		if (shownKeys.has(el.dataset.k)) el.classList.add("is-static");
		seen.add(el.dataset.k);
	}
	shownKeys.clear();
	seen.forEach((k) => shownKeys.add(k));

	const page = pageEl();
	const bottom = $(".bottom", screen);
	const reserve = bottom ? screen.getBoundingClientRect().bottom - bottom.getBoundingClientRect().top + 20 : 40;
	page.style.paddingBottom = `${Math.max(reserve, 40)}px`;
	page.scrollTop = top;
	screen.classList.toggle("is-scrolled", top > 36);
	const sheetBody = $(".sheet-body", screen);
	if (sheetBody && S.overlay?.keep) sheetBody.scrollTop = sheetTop;
	const menu = $(".menu", screen);
	if (menu && S.overlay?.keep) menu.scrollTop = menuTop;
	if (S.overlay) S.overlay.keep = true;

	const lens = $(".tab-lens", screen);
	const index = TABS.findIndex((t) => t.id === S.tab);
	if (lens && lastLens != null && lastLens !== index && lastLens >= 0) {
		lens.style.setProperty("--i", lastLens);
		void lens.offsetWidth;
		lens.style.setProperty("--i", index);
	}
	lastLens = index;

	if (focusId) {
		const el = document.getElementById(focusId);
		if (el) { el.focus({ preventScroll: true }); if (caret && el.setSelectionRange) el.setSelectionRange(caret[0], caret[1]); }
	}
	if (S.flash && S.anim) {
		const row = $$("[data-path]", page).find((r) => r.dataset.path === S.flash);
		row?.scrollIntoView({ block: "center" });
	}
	S.anim = null;
	S.fresh = null;
	afterRender(screen);
}
