/* Dazzi mobile remote prototype — everything that floats over a page.
 *
 *   menu   — iOS context menu: anchored to the glass button or the lifted row,
 *            quick-action strip on top, then the desktop context-menu sections
 *            (state/context-menu.ts) in the same order.
 *   sheet  — the inspector (정보), evidence (근거), history, activity queue,
 *            the move/copy destination picker, and the attachment picker.
 *   alert  — rename / new folder / confirm, which on desktop are inline edits
 *            or modal dialogs.
 *   ql     — Quick Look, full screen, swipe between siblings.
 * S.overlay = { type, ... }; overlayHtml() draws it and main.js routes taps. */
"use strict";

function overlayHtml() {
	const o = S.overlay;
	if (!o) return "";
	const scrim = (cls = "") => `<div class="scrim ${cls}" data-act="dismiss"></div>`;
	if (o.type === "menu") return scrim(o.lift ? "is-blur" : "is-clear") + (o.lift ? liftHtml(o) : "") + menuHtml(o);
	if (o.type === "sheet") return scrim() + sheetHtml(o);
	if (o.type === "alert") return scrim() + alertHtml(o);
	if (o.type === "ql") return qlHtml(o);
	return "";
}

/* ------------------------------------------------------------------ Menus -- */

const mi = (icon, label, act, arg = "", { cls = "", sub = "", tail = "", check = false } = {}) =>
	`<button class="menu-item ${cls}" data-act="${act}" data-arg="${esc(arg)}">${check ? svg("check", 18, 2.6).replace('class="icon"', 'class="icon ck"') : icon ? svg(icon, 20, 1.9) : `<span class="icon"></span>`}<span class="mi-main">${label}${sub ? `<small>${sub}</small>` : ""}</span>${tail}</button>`;
const msep = `<div class="menu-sep"></div>`;
const sub = () => `<span class="mi-tail mi-chev">${svg("chevron-right", 16, 2.4)}</span>`;

function itemMenu(paths) {
	const many = paths.length > 1;
	const n = node(paths[0]);
	const arg = paths.join("\n");
	if (inTrash(n)) return mi("rotate-ccw", many ? `${paths.length}개 항목 원래 위치로 복원` : "원래 위치로 복원", "restore", arg) + msep + mi("trash", "영구 삭제", "delete-forever", arg, { cls: "is-danger" });
	const folder = isFolder(n);
	const exts = new Set(paths.map((p) => node(p).ext));
	const magic = MAGIC_ACTIONS.filter((a) => !a.exts || [...exts].every((e) => a.exts.includes(e)));
	const conv = !many ? SUGGESTED[n.ext] ?? [] : [];
	const o = S.overlay;
	const open = (id) => o.open === id;
	// Order follows state/context-menu.ts, folded for a phone: the primary verbs
	// sit in the quick strip, convert/compress/index collapse into one submenu.
	const quick = `<div class="menu-quick"><button data-act="copy" data-arg="${esc(arg)}">${svg("copy", 22, 1.9)}복사</button><button data-act="move" data-arg="${esc(arg)}">${svg("folder-input", 22, 1.9)}이동</button><button data-act="download" data-arg="${esc(arg)}">${svg("download", 22, 1.9)}다운로드</button></div>`;
	let html = quick + msep;
	if (!many) html += (folder ? "" : mi("eye", "훑어보기", "ql", arg)) + mi("info", "정보 보기", "info", arg) + (S.tab !== "browse" ? mi("folder-open", "상위 폴더에서 보기", "reveal", arg) : "");
	html += msep;
	html += mi("sparkles", many ? `${paths.length}개 항목을 AI에게 묻기` : folder ? "이 폴더에 묻기" : "AI 요약", "ask", arg, { cls: "is-accent-icon" });
	if (magic.length) {
		html += mi("wand-sparkles", "매직 액션", "toggle-sub", "magic", { cls: open("magic") ? "is-open" : "", tail: sub() });
		if (open("magic")) html += magic.map((a) => mi("", esc(a.label), "magic", `${a.id}\n${arg}`, { cls: "is-sub", sub: a.mode === "agent" ? "AI 에이전트" : "스크립트" })).join("");
	}
	const indexed = paths.every((p) => node(p).indexed);
	const tools = [
		mi("", many ? `${paths.length}개 항목 압축` : "압축", "compress", arg, { cls: "is-sub" }),
		n.ext === "zip" ? mi("", "압축 해제", "extract", arg, { cls: "is-sub" }) : "",
		...conv.map((c) => mi("", esc(c.label), "convert", `${c.label}\n${arg}`, { cls: "is-sub" })),
		mi("", indexed ? "인덱싱에서 제외" : "인덱싱에 포함", "toggle-index", arg, { cls: "is-sub" }),
		mi("", "복제", "duplicate", arg, { cls: "is-sub" }),
	].join("");
	html += mi("layers", "빠른 작업", "toggle-sub", "tools", { cls: open("tools") ? "is-open" : "", tail: sub(), sub: conv.length ? conv.map((c) => c.label).join(" · ") : "압축 · 인덱싱 · 복제" });
	if (open("tools")) html += tools;
	html += msep;
	if (!many) html += mi("pencil", "이름 변경", "rename", arg);
	html += mi("link", "경로 복사", "copy-path", arg);
	html += `<div class="menu-tags">${TAGS.map((t) => { const on = paths.every((p) => node(p).tags?.includes(t.id)); return `<button class="${on ? "is-on" : ""}" style="background:${TAG_COLOR[t.id]};color:${TAG_COLOR[t.id]}" data-act="tag-toggle" data-arg="${t.id}\n${esc(arg)}" aria-label="${t.label} 태그">${on ? `<span style="color:#fff">${svg("check", 14, 3.2)}</span>` : ""}</button>`; }).join("")}</div>`;
	html += msep + mi("trash", "휴지통으로 이동", "trash", arg, { cls: "is-danger" });
	return html;
}
function viewMenu() {
	const r = route();
	const folder = r.kind === "folder" && !r.tag;
	const view = (id, icon, label) => mi(icon, label, "set-view", id, { check: S.view === id });
	const sortRows = Object.entries(SORT_LABEL).map(([key, label]) =>
		mi("", label, "set-sort", key, { check: S.sort.key === key, tail: S.sort.key === key ? `<span class="mi-tail">${svg(S.sort.asc ? "chevron-up" : "chevron-down", 16, 2.4)}</span>` : "" }),
	).join("");
	return `${folder ? mi("square-check-big", "선택", "select-start") + msep : r.kind === "recents" ? mi("square-check-big", "선택", "select-start") + msep : ""}${view("grid", "layout-grid", "아이콘")}${view("list", "list", "목록")}${msep}<div class="menu-label">정렬 기준</div>${sortRows}${folder ? msep + mi("info", "폴더 정보", "folder-info") + mi("sparkles", "이 폴더에 묻기", "ask-folder") + (r.path !== "휴지통" ? mi("zap", "이 폴더의 자동화", "folder-rules") : "") : ""}`;
}
function addMenu() {
	return mi("folder-plus", "새 폴더", "new-folder") + mi("file-text", "새 텍스트 문서", "new-file", "새 텍스트 문서.txt") + mi("file-text", "새 Markdown 문서", "new-file", "새 문서.md") + msep + mi("upload", "이 기기에서 올리기", "upload", "", { sub: "사진 보관함 · 파일 앱" }) + (S.clip ? mi("clipboard-copy", `붙여넣기 (${S.clip.paths.length}개)`, "paste") : "");
}
function pathMenu() {
	const here = node(route().path);
	const chain = ancestors(here).reverse();
	return chain.map((a, i) => mi(i === 0 ? "check" : a.parent ? "folder" : "hard-drive", esc(displayName(a)), i === 0 ? "dismiss" : "go", a.path, { check: i === 0 })).join("") + msep + mi("link", "경로 복사", "copy-path", here.path) + mi("star", "즐겨찾기에 추가", "favorite", here.path);
}
const sortMenu = () => Object.entries(SORT_LABEL).map(([key, label]) => mi("", label, "set-sort", key, { check: S.sort.key === key, tail: S.sort.key === key ? `<span class="mi-tail">${svg(S.sort.asc ? "chevron-up" : "chevron-down", 16, 2.4)}</span>` : "" })).join("");
const ruleMenu = (id) => mi("message-circle", "AI 검색에서 고치기", "rule-edit", id) + mi("play", "지금 실행", "rule-run", id) + msep + mi("trash", "규칙 삭제", "rule-delete", id, { cls: "is-danger" });
const browseAddMenu = () => mi("folder-plus", "즐겨찾기에 폴더 추가", "noop") + mi("pencil", "사이드바 편집", "noop", "", { sub: "데스크탑의 설정 → 사이드바와 같아요" });
function selMoreMenu() {
	const paths = [...S.select];
	return mi("download", "다운로드", "download", paths.join("\n")) + mi("files", "복제", "duplicate", paths.join("\n")) + mi("file-archive", `${paths.length}개 항목 압축`, "compress", paths.join("\n")) + msep + `<div class="menu-tags">${TAGS.map((t) => `<button style="background:${TAG_COLOR[t.id]};color:${TAG_COLOR[t.id]}" data-act="tag-toggle" data-arg="${t.id}\n${esc(paths.join("\n"))}" aria-label="${t.label} 태그"></button>`).join("")}</div>` + msep + mi("sparkles", "인덱싱에 포함", "toggle-index", paths.join("\n"));
}

function menuHtml(o) {
	const body = {
		item: () => itemMenu(o.paths),
		view: viewMenu, add: addMenu, path: pathMenu, sort: sortMenu, rule: () => ruleMenu(o.id),
		"browse-add": browseAddMenu, "sel-more": selMoreMenu, mode: modeMenu,
	}[o.menu]();
	const style = o.pos ?? "";
	return `<div class="menu" role="menu" style="${style}" data-k="menu-${o.menu}">${body}</div>`;
}
function liftHtml(o) {
	const n = node(o.paths[0]);
	const top = o.liftTop;
	const extra = o.paths.length > 1 ? `<span class="lift-count">${o.paths.length}</span>` : "";
	return `<div class="lift" style="top:${top}px">${thumbHtml(n)}<div class="row-main">${nameHtml(n)}${metaHtml(n, { where: S.tab !== "browse" })}</div>${extra}</div>`;
}
function modeMenu() {
	const modes = [
		["ask", "묻기", "모든 shell·쓰기·편집 호출 전에 물어봅니다. 읽기와 검색은 묻지 않습니다."],
		["auto", "자동", "안전한 변경은 통과시키고, 기존 파일을 바꾸는 확신 없는 변경만 물어봅니다."],
		["full", "전체 허용", "묻지 않고 파일을 바꿉니다."],
	];
	return `<div class="menu-label">파일 변경 승인</div>` + modes.map(([id, label, desc]) => mi("", label, "set-mode", id, { check: S.chat.mode === id, sub: desc, cls: "is-multiline" })).join("");
}

/* ----------------------------------------------------------------- Sheets -- */

function sheetHtml(o) {
	const view = {
		info: () => infoSheet(o), evidence: () => evidenceSheet(o), history: historySheet, activity: activitySheet,
		picker: () => pickerSheet(o), attach: () => attachSheet(o), folderInfo: () => folderInfoSheet(o),
	}[o.sheet]();
	const cls = [view.medium ? "is-medium" : "", view.solid ? "is-solid" : ""].join(" ");
	return `<div class="sheet ${cls}" role="dialog" aria-label="${esc(view.title)}" style="${view.height ? `height:${view.height}` : ""}" data-k="sheet-${o.sheet}"><span class="grabber" data-drag="sheet"></span><div class="sheet-head" data-drag="sheet">${view.left ?? gbtn("x", "dismiss", "", "닫기")}<h3>${esc(view.title)}${view.subtitle ? `<small>${esc(view.subtitle)}</small>` : ""}</h3>${view.right ?? `<span style="width:44px"></span>`}</div><div class="sheet-body">${view.body}</div>${view.foot ?? ""}</div>`;
}

function kv(rows) { return rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `<div class="kv"><span>${k}</span><b>${v}</b></div>`).join(""); }

function infoSheet(o) {
	const n = node(o.path);
	if (!n) return { title: "정보", body: "" };
	const k = kindOf(n);
	const head = `<div class="info-head">${thumbHtml(n)}<div><b>${esc(n.name)}</b><small>${esc(isFolder(n) ? `폴더 · ${n.count}개 항목` : `${k.label} · ${fmtSize(n.size)}`)}</small></div></div>`;
	const qa = (icon, label, act, cls = "") => `<button class="qa ${cls}" data-act="${act}" data-arg="${esc(n.path)}">${svg(icon, 22, 2)}${label}</button>`;
	const quick = `<div class="quick-actions">${isFolder(n) ? qa("folder-open", "열기", "go") : previewOf(n) ? qa("eye", "훑어보기", "ql") : qa("download", "다운로드", "download")}${qa("sparkles", isFolder(n) ? "묻기" : "AI 요약", "ask", "is-ai")}${qa("folder-input", "이동", "move")}${qa("ellipsis", "더보기", "info-more")}</div>`;
	const sugg = (SUGGESTED[n.ext] ?? []).map((s) => cell({ icon: s.icon, title: esc(s.label), act: "convert", arg: `${s.label}\n${n.path}` }));
	const versions = n.versions
		? sectionHtml("versions", "버전", [cell({ tile: `<span class="cell-icon"><span class="vtag">최신</span></span>`, title: esc(n.name), sub: fmtFull(n.mtime), chev: false }), cell({ tile: `<span class="cell-icon"><span class="vtag near">비슷함</span></span>`, title: esc(n.name.replace(/(\.[^.]+)$/, " (이전)$1")), sub: `${fmtDate(n.mtime - 9 * DAY_MS)} · 92% 일치`, chev: false })], { collapsible: false, foot: "dupey가 찾은 같은 문서의 다른 버전이에요." })
		: "";
	const tags = n.tags?.length ? n.tags.map((t) => `<span class="tag-dot" style="background:${TAG_COLOR[t]}"></span>`).join(" ") : "없음";
	const rows = kv([
		["종류", esc(k.label)],
		["크기", isFolder(n) ? `${n.count}개 항목` : `${fmtSize(n.size)} (${n.size.toLocaleString("ko-KR")}바이트)`],
		["위치", esc(n.parent ?? PC_NAME)],
		[k.family === "image" ? "이미지 크기" : null, n.dims],
		[n.pages ? "페이지" : null, n.pages],
		[n.dur ? "재생 시간" : null, n.dur],
		["수정일", fmtFull(n.mtime)],
		["태그", tags],
	].filter(([key]) => key));
	const index = `<div class="section"><div class="group"><div class="cell" style="cursor:default"><span class="cell-icon">${svg("sparkles", 22, 1.9)}</span><span class="cell-main"><b>AI 검색에 포함</b><small>${n.indexed ? "내용까지 찾을 수 있어요" : "이름으로만 찾을 수 있어요"}</small></span><button class="switch ${n.indexed ? "is-on" : ""}" data-act="toggle-index" data-arg="${esc(n.path)}" role="switch" aria-checked="${!!n.indexed}" aria-label="AI 검색에 포함"></button></div></div></div>`;
	const tail = `<div class="section"><div class="group">${cell({ icon: "link", title: "경로 복사", act: "copy-path", arg: n.path, chev: false, cls: "is-accent" })}${cell({ icon: "pencil", title: "이름 변경", act: "rename", arg: n.path, chev: false, cls: "is-accent" })}${cell({ icon: "trash", title: "휴지통으로 이동", act: "trash", arg: n.path, chev: false, cls: "is-danger" })}</div></div>`;
	return {
		title: "정보", solid: true, height: o.full ? "calc(100% - var(--sa-top) - 8px)" : "68%",
		body: `${head}${quick}${index}${sugg.length ? sectionHtml("sugg", "빠른 작업", sugg, { collapsible: false }) : ""}${versions}<section class="section"><div class="section-head"><span>일반 정보</span></div><div class="group">${rows}</div></section>${tail}`,
	};
}
function folderInfoSheet(o) {
	const f = node(o.path);
	const files = f.children.filter((c) => !isFolder(c));
	const total = files.reduce((s, c) => s + (c.size ?? 0), 0);
	const indexed = files.filter((c) => c.indexed).length;
	const families = {};
	for (const c of f.children) { const l = isFolder(c) ? "폴더" : kindOf(c).label; families[l] = (families[l] ?? 0) + 1; }
	const rules = RULES.filter((r) => r.folder === displayName(f));
	return {
		title: "폴더 정보", solid: true, height: "62%",
		body: `<div class="info-head">${thumbHtml(f)}<div><b>${esc(displayName(f))}</b><small>${f.count}개 항목 · ${fmtSize(total)}</small></div></div>
<section class="section"><div class="group">${kv([["위치", esc(f.parent ?? PC_NAME)], ["인덱싱", `${indexed}/${files.length}개 파일`], ["수정일", fmtFull(f.mtime)]])}</div></section>
<section class="section"><div class="section-head"><span>종류별</span></div><div class="group">${kv(Object.entries(families).map(([k, v]) => [esc(k), `${v}개`]))}</div></section>
${sectionHtml("frules", "이 폴더의 자동화", rules.length ? rules.map((r) => cell({ tile: `<span class="cell-icon"><span class="status-dot ${r.status}"></span></span>`, title: esc(r.title), sub: esc(r.last), act: "rule", arg: r.id })) : [cell({ icon: "plus", title: "규칙 추가", sub: "AI 검색에서 말로 만들어요", act: "rule-add", cls: "is-accent" })], { collapsible: false })}`,
	};
}
function evidenceSheet(o) {
	const src = CHAT.messages[1].sources;
	const s = src.find((x) => x.n === o.n) ?? src[0];
	const n = findByName(s.name);
	const tabs = `<div class="ev-tabs">${src.map((x) => `<button class="${x.n === s.n ? "is-on" : ""}" data-act="cite" data-arg="${x.n}">${x.n}</button>`).join("")}</div>`;
	const excerpt = esc(s.excerpt).replace(/“(.+?)”/, (m, inner) => `“<mark>${inner}</mark>”`);
	return {
		title: "근거", subtitle: `${src.length}개 출처`, medium: !o.full, height: o.full ? "calc(100% - var(--sa-top) - 8px)" : "auto",
		body: `${tabs}<div class="excerpt"><div class="where">${n ? thumbHtml(n) : ""}<div><b>${esc(s.name)}</b><small>${esc(n ? n.parent : s.where)}</small></div></div>${excerpt}<div class="ev-score">관련도<span class="cap-bar"><i style="width:${s.score}%"></i></span>${s.score}%</div></div><div class="btn-row"><button data-act="reveal" data-arg="${esc(n?.path ?? "")}">${svg("folder-open", 18, 2.2)}위치 보기</button><button class="is-primary" data-act="ql" data-arg="${esc(n?.path ?? "")}">${svg("eye", 18, 2.2)}근거 위치 보기</button></div>`,
	};
}
function historySheet() {
	const q = S.overlay.q ?? "";
	const groups = HISTORY.map((g) => {
		const items = g.items.filter((t) => t.includes(q));
		return items.length ? `<div class="section-label" style="padding-top:14px">${g.bucket}</div><div class="section" style="margin-top:0"><div class="group">${items.map((t) => cell({ title: esc(t), act: "open-chat", arg: t, chev: false, cls: t === CHAT.title && S.chat.phase !== "empty" ? "is-current" : "" })).join("")}</div></div>` : "";
	}).join("");
	return {
		title: "대화 기록", height: "calc(100% - var(--sa-top) - 8px)",
		right: gbtn("square-pen", "new-chat", "", "새 대화"),
		body: `<label class="sheet-search">${svg("search", 17, 2.2)}<input id="hq" type="search" placeholder="대화 기록 검색" value="${esc(q)}"></label>${groups || `<div class="empty"><b>“${esc(q)}”에 해당하는 대화가 없습니다</b></div>`}`,
	};
}
function activitySheet() {
	const rows = S.activity.map((a) => {
		const btn = a.kind === "fix" ? `<button class="act-btn" data-act="fix-now">AI로 고치기</button>` : a.kind === "magic" ? `<button class="act-btn" data-act="act-cancel" data-arg="${a.id}">중지</button>` : "";
		return `<div class="act ${a.tone === "error" ? "is-error" : ""}">${ringHtml(a)}<div><b>${esc(a.title)}</b><small>${esc(a.detail)}</small>${a.progress != null ? `<span class="cap-bar"><i data-bar="${a.id}" style="width:${Math.round(a.progress * 100)}%"></i></span>` : ""}</div>${btn}</div>`;
	}).join("");
	return { title: "진행 및 대기열", subtitle: `${S.activity.length}개 작업`, medium: true, height: "auto", body: S.activity.length ? `<div class="section" style="margin-top:4px"><div class="group">${rows}</div></div>` : `<div class="empty" style="padding:40px"><b>진행 중인 작업이 없어요</b></div>` };
}
function pickerSheet(o) {
	const at = node(o.at);
	const folders = at ? listing(at).filter(isFolder) : [];
	const crumbs = at ? ancestors(at).map((a, i, all) => `${i ? svg("chevron-right", 14, 2.4) : ""}<button class="${i === all.length - 1 ? "is-here" : ""}" data-act="pick-at" data-arg="${esc(a.path)}">${esc(displayName(a))}</button>`).join("") : "";
	const roots = PLACES.flatMap((g) => g.items).filter((i) => i.path && i.path !== "휴지통" && node(i.path)).map((i) => cell({ icon: i.icon, title: esc(i.label), act: "pick-at", arg: i.path }));
	const body = at
		? `<div class="crumbs"><button data-act="pick-at" data-arg="">${svg("house", 16, 2.2)}</button>${svg("chevron-right", 14, 2.4)}${crumbs}</div><div class="section" style="margin-top:0"><div class="group">${folders.length ? folders.map((f) => cell({ tile: `<span class="cell-icon">${folderSvg(26)}</span>`, title: esc(f.name), sub: `${f.count}개 항목`, act: "pick-at", arg: f.path })).join("") : `<div class="cell" style="cursor:default"><span class="cell-main"><small>하위 폴더 없음</small></span></div>`}</div></div>`
		: `<div class="section" style="margin-top:0"><div class="group">${roots.join("")}</div></div>`;
	const verb = o.mode === "copy" ? "복사" : "이동";
	const same = at && o.paths.every((p) => node(p)?.parent === at.path);
	return {
		solid: true,
		title: `${o.paths.length}개 항목 ${verb}`, subtitle: "위치 선택", height: "calc(100% - var(--sa-top) - 8px)",
		left: gtext("취소", "dismiss"),
		right: `<span style="width:44px"></span>`,
		body,
		foot: `<div class="sheet-foot"><button class="sf-ghost" data-act="pick-new-folder" ${at ? "" : "disabled"}>${svg("folder-plus", 18, 2.2)}새 폴더</button><button class="sf-main" data-act="pick-done" ${at && !same ? "" : "disabled"}>${at ? `${esc(displayName(at))}(으)로 ${verb}` : "폴더를 고르세요"}</button></div>`,
	};
}
function attachSheet() {
	const recents = RECENTS.map(node).filter(Boolean).slice(0, 8);
	const picked = new Set(S.chat.attachments);
	return {
		title: "첨부", height: "70%",
		left: gtext("취소", "dismiss"), right: gtext("완료", "dismiss", "is-prominent"),
		body: `<div class="quick-actions" style="grid-template-columns:repeat(3,1fr)"><button class="qa" data-act="attach-upload">${svg("image", 22, 2)}사진</button><button class="qa" data-act="attach-upload">${svg("upload", 22, 2)}이 기기 파일</button><button class="qa" data-act="attach-browse">${svg("folder", 22, 2)}${esc(PC_NAME.split("-")[0])}에서</button></div><div class="recent-head">최근 항목</div><div class="rows attach-rows">${recents.map((n) => `<div class="row"><div class="row-inner" data-act="attach-toggle" data-arg="${esc(n.path)}">${checkHtml(picked.has(n.path))}${thumbHtml(n)}<div class="row-main">${nameHtml(n)}${metaHtml(n, { where: true })}</div></div></div>`).join("")}</div>`,
	};
}

/* ----------------------------------------------------------------- Alerts -- */

function alertHtml(o) {
	const input = o.input != null ? `<input id="alert-input" value="${esc(o.input)}" enterkeyhint="done" autocomplete="off" spellcheck="false">` : "";
	return `<div class="alert" role="alertdialog" data-k="alert"><h4>${esc(o.title)}</h4>${o.text ? `<p>${esc(o.text)}</p>` : ""}${input}<div class="alert-btns"><button data-act="dismiss">취소</button><button class="${o.danger ? "is-danger" : "is-primary"}" data-act="alert-ok">${esc(o.ok)}</button></div></div>`;
}

/* ------------------------------------------------------------- Quick Look -- */

function qlHtml(o) {
	const list = o.list.map(node).filter(Boolean);
	const i = Math.max(0, list.findIndex((n) => n.path === o.path));
	const n = list[i];
	const dark = kindOf(n).family === "image" || kindOf(n).family === "video";
	const slides = list.map((x) => `<div class="ql-slide">${qlContent(x)}</div>`).join("");
	return `<div class="ql ${dark ? "is-dark" : ""} ${o.immersive ? "is-immersive" : ""}" role="dialog" aria-label="훑어보기" data-k="ql"><div class="ql-top">${gtext("완료", "dismiss")}${navTitle(n.name, `${i + 1} / ${list.length}`, { always: true })}<span class="nav-spacer"></span>${gbtn("info", "info", n.path, "정보")}</div><div class="ql-stage" data-act="ql-tap"><div class="ql-track" style="transform:translateX(${-i * 100}%)">${slides}</div></div><div class="ql-bottom"><div class="ggroup glass"><button class="gbtn" data-act="download" data-arg="${esc(n.path)}" aria-label="다운로드">${svg("download", 22, 2)}</button><button class="gbtn" data-act="ask" data-arg="${esc(n.path)}" aria-label="AI 요약">${svg("sparkles", 22, 2)}</button><button class="gbtn" data-act="row-more" data-arg="${esc(n.path)}" aria-label="더보기">${svg("ellipsis", 22, 2)}</button><button class="gbtn" data-act="trash" data-arg="${esc(n.path)}" aria-label="휴지통">${svg("trash", 22, 2)}</button></div></div></div>`;
}
function qlContent(n) {
	const k = kindOf(n);
	const p = previewOf(n);
	if (p === "image") {
		const [w, h] = (n.dims ?? "4 × 3").split(" × ").map(Number);
		return `<div class="ql-photo ${w === h ? "is-square" : h > w ? "is-portrait" : ""}" style="${artStyle(n)}">${PHOTO}</div>`;
	}
	if (p === "video") return `<div class="ql-video" style="${artStyle(n)}"><span class="pbtn">${svg("play", 30, 0).replace("<path", '<path fill="currentColor"')}</span><span class="vbar"><i></i></span></div>`;
	if (p === "audio") return `<div class="ql-audio"><div class="art" style="${artStyle(n)}">${svg("music", 72, 1.6)}</div><h5>${esc(n.name.replace(/\.[^.]+$/, ""))}</h5><p>${esc(parentLabel(n))}</p><div class="scrub"><div class="track"><i></i></div><div class="times"><span>0:41</span><span>-1:22</span></div></div><div class="transport"><button aria-label="이전">${svg("skip-back", 30, 2)}</button><button class="play" aria-label="재생">${svg("play", 44, 0).replace("<path", '<path fill="currentColor"')}</button><button aria-label="다음">${svg("skip-forward", 30, 2)}</button></div></div>`;
	if (p === "pdf" || p === "text") {
		const lines = Array.from({ length: 9 }, (_, i) => `<div class="bar" style="width:${70 + ((i * 37) % 30)}%"></div>`).join("");
		return `<div style="width:100%;display:grid;justify-items:center"><div class="ql-page"><h5>${esc(n.name.replace(/\.[^.]+$/, ""))}</h5><p>${p === "text" ? "# 회의 메모 — 응원가 파일은 구단별 폴더로 정리하기로 함. 다음 회의까지 목록 공유." : "1. 사업 개요 — 본 계획서는 2026년 사업 추진 방향과 예산을 정리한다."}</p>${lines}<p>2. 추진 일정</p>${lines}</div>${n.pages ? `<div class="ql-page-count">1 / ${n.pages} 페이지</div>` : ""}</div>`;
	}
	return `<div class="ql-none">${isFolder(n) ? folderSvg(96) : docThumb(n, 72)}<b>${esc(n.name)}</b><span>${esc(k.label)} · ${fmtSize(n.size)}<br>이 형식은 브라우저에서 미리볼 수 없어요.</span><button class="acc-btn" data-act="download" data-arg="${esc(n.path)}">다운로드</button></div>`;
}
