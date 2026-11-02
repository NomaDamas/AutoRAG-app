/* Dazzi mobile remote prototype — full-screen pages. Each returns
 * { nav, body, plain }: `nav` is the transparent navigation bar's glass
 * buttons, `body` scrolls under it, `plain` picks the white list background
 * (file listings) over the grouped gray one (navigation lists). */
"use strict";

function currentView() {
	const r = route();
	switch (r.kind) {
		case "root": return browseRoot();
		case "folder": return folderView(node(r.path));
		case "recents": return recentsView();
		case "chat": return chatView();
		case "rules": return rulesView();
		case "rule": return ruleView(RULES.find((x) => x.id === r.id));
		case "search": return searchView();
		case "settings": return settingsIndex();
		case "setting": return settingsPage(r.id);
		case "source": return sourcePage(r.id);
		default: return { nav: "", body: "" };
	}
}

const backBtn = () => (stack().length > 1 ? gbtn("chevron-left", "back", "", "뒤로") : "");
const large = (title, sub = "", act = "") =>
	`<div class="large"><h1>${act ? `<button data-act="${act}"><span class="h1-text">${esc(title)}</span>${svg("chevron-down", 22, 2.6).replace('class="icon"', 'class="icon chev"')}</button>` : `<span class="h1-text">${esc(title)}</span>`}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
const cell = ({ icon = "", tile = "", title, sub = "", value = "", chev = true, act = "", arg = "", cls = "", tail = "" }) =>
	`<button class="cell ${cls}" data-act="${act}" data-arg="${esc(arg)}">${tile || (icon ? `<span class="cell-icon">${svg(icon, 22, 1.9)}</span>` : "")}<span class="cell-main"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span>${value ? `<span class="cell-value">${value}</span>` : ""}${tail}${chev ? svg("chevron-right", 18, 2.4).replace('class="icon"', 'class="icon chev-r"') : ""}</button>`;
const sectionHtml = (id, title, cells, { foot = "", collapsible = true } = {}) =>
	`<section class="section ${S.collapsed.has(id) ? "is-collapsed" : ""}"><div class="section-head"><span>${esc(title)}</span>${collapsible ? `<button data-act="collapse" data-arg="${id}" aria-label="${esc(title)} 접기">${svg("chevron-down", 20, 2.6)}</button>` : ""}</div><div class="group">${cells.join("")}</div>${foot ? `<div class="section-foot">${foot}</div>` : ""}</section>`;

/* ------------------------------------------------------------- 둘러보기 -- */

function browseRoot() {
	const groups = PLACES.map((group) => {
		const cells = group.items.map((item) => {
			if (item.drive) {
				const used = 1 - item.drive.free / item.drive.total;
				return cell({ icon: "hard-drive", title: esc(item.label), sub: `${fmtSize(item.drive.free)} 사용 가능 · 전체 ${fmtSize(item.drive.total)}<span class="cap-bar"><i style="width:${(used * 100).toFixed(0)}%"></i></span>`, act: "go", arg: item.path, cls: "is-tall" });
			}
			if (item.tab) return cell({ icon: item.icon, title: esc(item.label), act: "tab", arg: item.tab });
			const n = node(item.path);
			const tail = item.status ? `<span class="status-dot ${item.status}"></span>` : "";
			return cell({ icon: item.icon, title: esc(item.label), value: n && item.path === "휴지통" && n.count ? String(n.count) : "", act: "go", arg: item.path, tail });
		});
		return sectionHtml(group.group, group.group, cells);
	});
	const tags = TAGS.slice(0, 5).map((t) => cell({ tile: `<span class="cell-icon"><span class="tag-dot" style="background:${TAG_COLOR[t.id]}"></span></span>`, title: t.label, value: String(allFiles().filter((n) => n.tags?.includes(t.id)).length || ""), act: "tag", arg: t.id }));
	return {
		nav: `<span class="nav-spacer"></span>${navTitle("둘러보기")}<div class="ggroup glass"><button class="gbtn" data-act="menu-browse-add" aria-label="추가">${svg("folder-plus", 21, 2.1)}</button><button class="gbtn" data-act="settings" aria-label="설정">${svg("settings", 21, 2.1)}</button></div>`,
		body: `${large("둘러보기", `<span class="live-dot"></span>${esc(PC_NAME)}에 연결됨`)}${groups.join("")}${sectionHtml("tags", "태그", tags)}`,
	};
}

/* ------------------------------------------------------------- 폴더 목록 -- */

function folderView(folder) {
	if (!folder) return { nav: backBtn(), body: `<div class="empty"><b>폴더를 찾을 수 없어요</b></div>` };
	const title = displayName(folder);
	const list = listing(folder);
	const trash = folder.path === "휴지통";
	const tagged = route().tag;
	const items = tagged ? allFiles().filter((n) => n.tags?.includes(tagged)) : list;
	const count = items.length;
	const sizeSum = items.reduce((sum, n) => sum + (n.size ?? 0), 0);
	const chips = trash
		? `<button class="chip" data-act="empty-trash" ${count ? "" : "disabled"}>${svg("trash", 16, 2.1)}휴지통 비우기</button>`
		: `<button class="chip" data-act="menu-sort">${svg("arrow-down-up", 16, 2.1)}${SORT_LABEL[S.sort.key]}${svg(S.sort.asc ? "chevron-up" : "chevron-down", 14, 2.6)}</button><button class="chip" data-act="folder-info">${svg("info", 16, 2.1)}폴더 정보</button><button class="chip" data-act="ask-folder">${svg("sparkles", 16, 2.1)}이 폴더에 묻기</button>`;
	const body = count
		? `<div class="toolbar-row">${chips}</div>${itemsHtml(items, { where: !!tagged })}<div class="list-foot">${count}개 항목${sizeSum ? ` · ${fmtSize(sizeSum)}` : ""}</div>`
		: `<div class="toolbar-row">${chips}</div><div class="empty">${svg(trash ? "trash" : "folder-open", 44, 1.5)}<b>${trash ? "휴지통이 비어 있어요" : "빈 폴더"}</b>${trash ? "" : `<span>＋ 버튼으로 새 폴더를 만들거나 이 기기의 파일을 올리세요</span>`}</div>`;
	const where = folder.parent ? `${esc(parentLabel(folder))}` : esc(PC_NAME);
	const nav = S.select
		? `${gtext(S.select.size === count ? "선택 해제" : "모두 선택", "select-all")}${navTitle(S.select.size ? `${S.select.size}개 선택됨` : "항목 선택", "", { always: true })}<span class="nav-spacer"></span>${gtext("완료", "select-done", "is-prominent")}`
		: `${backBtn()}${navTitle(title, where, { act: tagged ? "" : "menu-path" })}<span class="nav-spacer"></span><div class="ggroup glass">${trash || tagged ? "" : `<button class="gbtn" data-act="menu-add" aria-label="추가">${svg("plus", 22, 2.1)}</button>`}<button class="gbtn" data-act="menu-view" aria-label="보기 옵션">${svg("ellipsis", 22, 2.1)}</button></div>`;
	return { plain: S.view === "list", nav, body: `${large(title, `${where} · ${count}개 항목`, tagged ? "" : "menu-path")}${body}` };
}

/* ------------------------------------------------------------ 최근 항목 -- */

function recentsView() {
	const filters = [["all", "전체"], ["doc", "문서"], ["image", "사진"], ["media", "동영상·음악"]];
	const pick = (n) => {
		const family = kindOf(n).family;
		if (S.recentsFilter === "doc") return family === "doc";
		if (S.recentsFilter === "image") return family === "image";
		if (S.recentsFilter === "media") return family === "video" || family === "audio";
		return true;
	};
	const items = RECENTS.map(node).filter((n) => n && !inTrash(n) && pick(n)).sort((a, b) => b.mtime - a.mtime);
	const buckets = new Map();
	for (const n of items) { const b = bucketOf(n.mtime); if (!buckets.has(b)) buckets.set(b, []); buckets.get(b).push(n); }
	const groups = [...buckets].map(([label, list]) => `<div class="recent-head">${label}</div>${itemsHtml(list, { where: true })}`).join("");
	const chips = filters.map(([id, label]) => `<button class="chip ${S.recentsFilter === id ? "is-on" : ""}" data-act="recents-filter" data-arg="${id}">${label}</button>`).join("");
	const nav = S.select
		? `${gtext("모두 선택", "select-all")}${navTitle(`${S.select.size}개 선택됨`, "", { always: true })}<span class="nav-spacer"></span>${gtext("완료", "select-done", "is-prominent")}`
		: `<span class="nav-spacer"></span>${navTitle("최근 항목")}<div class="ggroup glass"><button class="gbtn" data-act="menu-view" aria-label="보기 옵션">${svg("ellipsis", 22, 2.1)}</button></div>`;
	return { plain: S.view === "list", nav, body: `${large("최근 항목")}<div class="toolbar-row">${chips}</div>${groups || `<div class="empty"><b>최근 항목 없음</b></div>`}` };
}

/* ---------------------------------------------------------------- AI 검색 -- */

function chatView() {
	const chat = S.chat;
	const modeLabel = { ask: "묻기", auto: "자동", full: "전체 허용" }[chat.mode];
	const nav = `${gbtn("history", "history", "", "대화 기록")}${navTitle(chat.phase === "empty" ? "AI 검색" : CHAT.title, chat.phase === "empty" ? "" : `파일 변경: ${modeLabel}`, { always: chat.phase !== "empty" })}<span class="nav-spacer"></span><div class="ggroup glass"><button class="gbtn" data-act="mode" aria-label="파일 변경 승인 모드">${svg("shield-check", 20, 2.1)}</button><button class="gbtn" data-act="new-chat" aria-label="새 대화">${svg("square-pen", 20, 2.1)}</button></div>`;
	if (chat.phase === "empty") {
		const sug = SUGGESTIONS.map((s) => `<button data-act="suggest" data-arg="${esc(s)}">${svg("sparkles", 18, 2)}<span>${esc(s)}</span></button>`).join("");
		return { nav, body: `<div class="chat"><div class="chat-empty"><div class="logo"><img src="../../../src/renderer/src/assets/dazzi-logo.png" alt=""></div><h2>무엇을 찾아 드릴까요?</h2><p>${esc(PC_NAME)}의 파일, 메일, 메신저를<br>내용으로 찾고 정리해요.</p><div class="suggest">${sug}</div></div></div>` };
	}
	const parts = chat.messages.map(messageHtml).join("");
	return { nav, body: `<div class="chat">${parts}<div class="ai-notice">답변은 AI가 생성하며 부정확할 수 있어요. 인용된 출처를 확인하세요.</div></div>` };
}
function inlineMd(text) {
	return esc(text)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\[(\d)\]/g, `<button class="cite" data-act="cite" data-arg="$1">$1</button>`);
}
function messageHtml(m) {
	if (m.role === "user")
		return `<div class="msg-user">${(m.attachments ?? []).map((p) => attachChip(p)).join("")}${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ""}</div>`;
	if (m.role === "thinking")
		return `<div class="msg-ai"><div class="steps">${(m.steps ?? []).map((s) => `<div>${svg("circle-check", 16, 2.2)}${esc(s)}</div>`).join("")}</div><span class="thinking shimmer">${esc(m.text)}</span></div>`;
	if (m.role === "result")
		return `<div class="result-card"><span class="tile">${svg("check", 18, 2.8)}</span><div><b>${esc(m.title)}</b><small>${esc(m.detail)}</small></div><button data-act="go" data-arg="${esc(m.path)}">열기</button></div>`;
	const blocks = m.blocks.map((b) => (b.p ? `<p>${inlineMd(b.p)}</p>` : `<ol>${b.list.map((li) => `<li>${inlineMd(li)}</li>`).join("")}</ol>`)).join("");
	const sources = m.sources?.length
		? `<div class="sources">${m.sources.map((s) => { const n = findByName(s.name); return `<button class="src" data-act="cite" data-arg="${s.n}"><span class="n">${s.n}</span><div><b>${esc(s.name)}</b><small>${esc(n ? parentLabel(n) : s.where)} · 관련도 ${s.score}%</small></div></button>`; }).join("")}</div>`
		: "";
	return `<div class="msg-ai">${blocks}${sources}<div class="msg-tools"><button data-act="copy-answer" aria-label="답변 복사">${svg("copy", 18, 2)}</button><button data-act="evidence-folder" aria-label="근거 폴더">${svg("folder-open", 18, 2)}</button><button data-act="retry" aria-label="다시 생성">${svg("rotate-cw", 18, 2)}</button></div></div>`;
}
const findByName = (name) => [...nodes.values()].find((n) => n.name === name && !inTrash(n));

/* ---------------------------------------------------------------- 자동화 -- */

function rulesView() {
	const rows = RULES.map((r) => cell({ tile: `<span class="cell-icon"><span class="status-dot ${r.status}"></span></span>`, title: esc(r.title), sub: `${esc(r.folder)} · ${esc(r.last)}`, act: "rule", arg: r.id }));
	return {
		nav: `<span class="nav-spacer"></span>${navTitle("자동화")}${gbtn("plus", "rule-add", "", "AI 검색에서 규칙 추가")}`,
		body: `${large("자동화")}<div class="daemon"><div><b>${S.daemon ? "백그라운드에서 실행 중" : "꺼짐 · 규칙이 실행되지 않습니다"}</b><small>규칙 ${RULES.length}개 · ${esc(PC_NAME)}</small></div><button class="switch ${S.daemon ? "is-on" : ""}" data-act="daemon" role="switch" aria-checked="${S.daemon}" aria-label="백그라운드 실행"></button></div>${sectionHtml("rules", "규칙", rows, { collapsible: false, foot: "파일이 생기거나 바뀔 때 Dazzi가 알아서 할 일을 정해 두세요. 규칙은 AI 검색에서 말로 만들고 고칩니다." })}`,
	};
}
function ruleView(rule) {
	const statusText = { ok: "마지막 실행 성공", fail: "마지막 실행 실패", never: "아직 실행되지 않음" }[rule.status];
	const logs = rule.runs
		? [0, 1, 2].map((i) => cell({ tile: `<span class="cell-icon"><span class="status-dot ${i === 0 ? rule.status : "ok"}"></span></span>`, title: i === 0 ? esc(rule.last) : ["어제 09:12", "10월 30일"][i - 1], sub: i === 0 && rule.status === "fail" ? "종료 코드 1 · hwp5: 알 수 없는 형식" : "파일 1개 · 21초", chev: false })).join("")
		: cell({ title: "실행 기록 없음", chev: false });
	return {
		nav: `${backBtn()}${navTitle(rule.title)}<span class="nav-spacer"></span>${gbtn("ellipsis", "menu-rule", rule.id, "규칙 메뉴")}`,
		body: `${large(rule.title, `<span class="status-dot ${rule.status}"></span>${statusText} · 총 ${rule.runs}회`)}
${sectionHtml("rule-when", "언제", [cell({ icon: "folder", title: esc(rule.folder), sub: "지켜보는 폴더", act: "go", arg: rule.folder === "다운로드" ? `${HOME}\\Downloads` : `${HOME}\\Documents` }), cell({ icon: "zap", title: esc(rule.events), sub: esc(rule.include), chev: false })], { collapsible: false })}
<section class="section"><div class="section-head"><span>무엇을</span></div><div class="group"><div class="mono">${esc(rule.run)}</div></div></section>
${sectionHtml("rule-log", "실행 기록", [logs], { collapsible: false })}
<div class="btn-row">${rule.status === "fail" ? `<button class="is-primary" data-act="rule-fix">${svg("sparkles", 18, 2.2)}AI로 고치기</button>` : ""}<button data-act="rule-edit">${svg("message-circle", 18, 2.2)}AI 검색에서 고치기</button></div>`,
	};
}

/* ------------------------------------------------------------------ 검색 -- */

function searchView() {
	const q = S.search.q.trim();
	const scope = `<div class="scope"><button class="${S.search.scope === "name" ? "is-on" : ""}" data-act="scope" data-arg="name">파일 이름</button><button class="${S.search.scope === "content" ? "is-on" : ""}" data-act="scope" data-arg="content">${svg("sparkles", 14, 2.2)}내용</button></div>`;
	const nav = `<span class="nav-spacer"></span>${navTitle("검색")}`;
	if (!q) {
		const recent = SEARCH_RECENT.map((s) => `<button class="chip" data-act="q-set" data-arg="${esc(s)}">${svg("history", 15, 2.1)}${esc(s)}</button>`).join("");
		const picks = RECENTS.slice(0, 3).map(node).filter(Boolean);
		return { nav, body: `${large("검색")}${scope}<div class="recent-head">최근 검색</div><div class="recent-q">${recent}</div><div class="recent-head">최근에 연 항목</div>${S.view === "grid" ? `<div class="grid">${picks.map((n) => tileHtml(n, { where: true })).join("")}</div>` : `<div class="rows">${picks.map((n) => rowHtml(n, { where: true })).join("")}</div>`}` };
	}
	const needle = q.toLowerCase();
	const hits = [...nodes.values()].filter((n) => !inTrash(n) && n.name.toLowerCase().includes(needle) && n.parent).slice(0, 40);
	const ask = `<button class="ask-ai" data-act="ask-q">${svg("sparkles", 22, 2)}<div><b>“${esc(q)}” AI 검색에 묻기</b><small>파일 내용, 메일, 메신저까지 찾아요</small></div>${svg("chevron-right", 18, 2.4)}</button>`;
	const rows = hits.length
		? `<div class="recent-head">${esc(PC_NAME)} 전체 · ${hits.length}개</div><div class="rows">${hits.map((n) => rowHtml(n, { where: true, hl: q })).join("")}</div>`
		: `<div class="empty"><b>“${esc(q)}” 이름의 파일이 없어요</b><span>내용으로 찾으려면 AI 검색에 물어보세요</span></div>`;
	return { plain: true, nav, body: `${large("검색")}${scope}${S.search.scope === "content" ? "" : ask}${S.search.scope === "content" ? ask : rows}` };
}
