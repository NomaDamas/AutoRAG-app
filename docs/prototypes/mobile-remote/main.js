/* Dazzi mobile remote prototype — input and actions.
 *
 * Touch model (iOS Files): tap opens, long-press lifts the row and opens its
 * context menu, a left swipe reveals 휴지통 · 더보기, the trailing ⋯ is the
 * one-handed equivalent of long-press. Every action maps to the desktop call
 * it would make (fs.* through the remote bridge); file changes offer undo the
 * way the desktop toast does. */
"use strict";

const screenEl = () => $("#screen");
const paths = (arg) => String(arg ?? "").split("\n").filter(Boolean);
const close = () => { S.overlay = null; render(); };

/* --------------------------------------------------------------- Overlays -- */

/** Anchor a menu to an element: below it, right-aligned, flipped up near the bottom. */
function menuAt(menu, anchor, extra = {}) {
	const screen = screenEl().getBoundingClientRect();
	const r = anchor.getBoundingClientRect();
	const width = 268;
	const left = Math.min(Math.max(12, r.right - screen.left - width), screen.width - width - 12);
	const below = r.bottom - screen.top + 8;
	const spaceBelow = screen.height - below - 24;
	const pos = spaceBelow > 300
		? `left:${left}px;top:${below}px;max-height:${spaceBelow}px;--origin:top right`
		: `left:${left}px;bottom:${screen.bottom - r.top + 8}px;max-height:${r.top - screen.top - 60}px;--origin:bottom right`;
	S.overlay = { type: "menu", menu, pos, ...extra };
	render();
}
/** Long-press: the row lifts and the menu opens under it. Like iOS, when the
 * menu would not fit, the lifted row slides up (never squeezes the menu). */
function liftMenu(rowEl, list) {
	const screen = screenEl().getBoundingClientRect();
	const r = rowEl.getBoundingClientRect();
	const liftH = 64;
	const gap = 10;
	const top = parseFloat(getComputedStyle(screenEl()).getPropertyValue("--sa-top")) || 0;
	const bottomPad = 24;
	// Render once off-screen to learn the menu's natural height.
	S.overlay = { type: "menu", menu: "item", paths: list, lift: true, liftTop: -999, pos: "visibility:hidden;right:16px;top:0" };
	render();
	const natural = $("#screen .menu").scrollHeight;
	const avail = screen.height - top - 16 - liftH - gap - bottomPad;
	const menuH = Math.min(natural, avail);
	let liftTop = r.top - screen.top;
	if (liftTop + liftH + gap + menuH > screen.height - bottomPad) liftTop = screen.height - bottomPad - menuH - gap - liftH;
	liftTop = Math.max(top + 16, liftTop);
	const pos = `right:16px;top:${liftTop + liftH + gap}px;max-height:${menuH}px;--origin:top right`;
	if (navigator.vibrate) navigator.vibrate(8);
	S.overlay = { type: "menu", menu: "item", paths: list, lift: true, liftTop, pos };
	render();
}
const sheet = (name, extra = {}) => { S.overlay = { type: "sheet", sheet: name, ...extra }; render(); };
const alertBox = (opts) => {
	S.overlay = { type: "alert", ...opts };
	render();
	const input = $("#alert-input");
	if (input) {
		input.focus();
		const dot = input.value.lastIndexOf(".");
		input.setSelectionRange(0, opts.selectStem && dot > 0 ? dot : input.value.length);
	}
};
function openQl(path) {
	const n = node(path);
	if (!n) return;
	const r = route();
	const siblings = r.kind === "recents" ? RECENTS : n.parent ? listing(node(n.parent)).filter((x) => !isFolder(x)).map((x) => x.path) : [path];
	S.overlay = { type: "ql", path, list: siblings.includes(path) ? siblings : [path] };
	render();
}

/* ---------------------------------------------------------------- File ops -- */

function doTrash(list) {
	const trash = node("휴지통");
	const moved = list.map(node).filter(Boolean).map((n) => {
		const from = n.parent;
		const copy = cloneNode(n);
		copy.from = from;
		copy.name = uniqueName(trash, copy.name);
		detach(n);
		attach(copy, trash);
		return { from, trashed: copy.path, original: n.name };
	});
	S.select = null; S.overlay = null;
	toast(moved.length > 1 ? `${moved.length}개 항목을 휴지통으로 옮겼어요` : `‘${moved[0].original}’ 휴지통으로 이동`, {
		icon: "trash",
		undo: () => moved.forEach((m) => restoreOne(m.trashed, m.original)),
	});
}
function restoreOne(path, name) {
	const n = node(path);
	const dest = node(n?.from);
	if (!n || !dest) return null;
	const copy = cloneNode(n);
	delete copy.from;
	copy.name = uniqueName(dest, name ?? n.name);
	detach(n);
	attach(copy, dest);
	return copy;
}
function doRestore(list) {
	const restored = list.map((p) => restoreOne(p)).filter(Boolean);
	S.select = null; S.overlay = null;
	toast(restored.length > 1 ? `${restored.length}개 항목을 복원했어요` : `‘${restored[0]?.name}’ 원래 위치로 복원`, {
		icon: "rotate-ccw",
		action: restored.length === 1 ? { label: "보기", act: "reveal", arg: restored[0].path } : null,
	});
}
function doTransfer(list, destPath, mode) {
	const dest = node(destPath);
	const made = list.map(node).filter(Boolean).map((n) => {
		const copy = cloneNode(n);
		copy.name = uniqueName(dest, n.name);
		if (mode === "move") detach(n);
		attach(copy, dest);
		return { copy, from: n.parent, name: n.name };
	});
	S.select = null; S.overlay = null;
	const verb = mode === "move" ? "이동" : "복사";
	toast(`${made.length}개 항목을 ${displayName(dest)}(으)로 ${verb}했어요`, {
		icon: mode === "move" ? "folder-input" : "copy",
		undo: () => made.forEach((m) => {
			const n = node(m.copy.path);
			if (!n) return;
			if (mode === "move") { const back = cloneNode(n); back.name = m.name; detach(n); attach(back, node(m.from)); } else detach(n);
		}),
	});
}
function doDuplicate(list) {
	const made = list.map(node).filter(Boolean).map((n) => {
		const folder = node(n.parent);
		const copy = cloneNode(n);
		const dot = n.name.lastIndexOf(".");
		copy.name = uniqueName(folder, dot > 0 && !isFolder(n) ? `${n.name.slice(0, dot)} 복사본${n.name.slice(dot)}` : `${n.name} 복사본`);
		copy.mtime = NOW.getTime();
		attach(copy, folder);
		return copy;
	});
	S.overlay = null; S.select = null;
	S.fresh = made[0]?.path; S.flash = made[0]?.path;
	toast(made.length > 1 ? `${made.length}개 항목 복제` : `‘${made[0].name}’ 만듦`, { icon: "files", undo: () => made.forEach((m) => node(m.path) && detach(node(m.path))) });
}
function doCreate(name, folderish) {
	const folder = node(route().path);
	const n = folderish ? d(uniqueName(folder, name), [], { mtime: NOW.getTime() }) : f(uniqueName(folder, name), 0, NOW.getTime());
	attach(n, folder);
	S.fresh = n.path; S.flash = n.path; S.overlay = null;
	toast(`‘${n.name}’ 만듦`, { icon: folderish ? "folder-plus" : "file-text", undo: () => node(n.path) && detach(node(n.path)) });
}
function doRename(path, name) {
	const n = node(path);
	if (!n || !name || name === n.name) return close();
	const folder = node(n.parent);
	if (folder.children.some((c) => c !== n && c.name === name)) {
		S.overlay = { ...S.overlay, text: `‘${name}’ 이름이 이미 있어요. 다른 이름을 입력하세요.`, input: name, keep: false };
		render();
		return;
	}
	const old = n.name;
	const copy = cloneNode(n);
	copy.name = name;
	const index = folder.children.indexOf(n);
	detach(n);
	attach(copy, folder);
	folder.children.splice(folder.children.indexOf(copy), 1);
	folder.children.splice(index, 0, copy);
	S.overlay = null; S.flash = copy.path;
	toast(`이름을 ‘${name}’(으)로 바꿈`, { icon: "pencil", undo: () => doRename(copy.path, old) });
}
function doUpload() {
	const folder = node(route().path);
	const n = f(uniqueName(folder, "IMG_2107.jpg"), 3_600_000, NOW.getTime(), { dims: "4032 × 3024", uploading: 0 });
	attach(n, folder);
	S.fresh = n.path; S.overlay = null;
	render();
	const timer = setInterval(() => {
		const live = node(n.path);
		if (!live) return clearInterval(timer);
		live.uploading = Math.min(1, live.uploading + 0.2);
		if (live.uploading >= 1) {
			clearInterval(timer);
			delete live.uploading;
			S.flash = live.path;
			toast(`‘${live.name}’ 올림 · ${fmtSize(live.size)}`, { icon: "upload" });
			return;
		}
		const bar = $(`[data-path="${CSS.escape(live.path)}"] .up-bar i`);
		if (bar) bar.style.width = `${live.uploading * 100}%`; else render();
	}, 380);
}
function askAi(list) {
	S.chat.attachments = [...new Set([...S.chat.attachments, ...list])];
	const one = list.length === 1 && node(list[0]);
	S.chat.draft = one ? (isFolder(one) ? "이 폴더에 뭐가 있는지 정리해줘" : "이 파일 요약해줘") : `이 ${list.length}개 항목 비교해줘`;
	S.overlay = null; S.select = null;
	setTab("ai");
	setTimeout(() => { const box = $("#composer"); if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); } }, 50);
}

/* ------------------------------------------------------------------- Chat -- */

let chatTimers = [];
function runChat(text) {
	chatTimers.forEach(clearTimeout);
	const chat = S.chat;
	chat.messages.push({ role: "user", text, attachments: chat.attachments });
	chat.attachments = []; chat.draft = ""; chat.phase = "running";
	const thinking = { role: "thinking", text: "파일 이름과 내용에서 찾는 중…", steps: [] };
	chat.messages.push(thinking);
	render();
	scrollChatEnd();
	const step = (ms, fn) => chatTimers.push(setTimeout(() => { fn(); if (S.tab === "ai") { render(); scrollChatEnd(); } else render(); }, ms));
	step(700, () => { thinking.steps.push("D:\\KBO_ost 폴더 14개 항목 확인"); thinking.text = "가사 색인 읽는 중…"; });
	step(1500, () => { thinking.steps.push("가사 색인 2건 일치"); thinking.text = "답변 쓰는 중…"; });
	step(2300, () => {
		chat.messages.pop();
		chat.messages.push(CHAT.messages[1]);
		chat.phase = "answered";
		chat.approval = true;
	});
}
function scrollChatEnd() { const page = pageEl(); if (page) page.scrollTo({ top: page.scrollHeight, behavior: "smooth" }); }
function allowChange() {
	const base = node("D:\\KBO_ost");
	const target = d(uniqueName(base, "kt 위즈"), [], { mtime: NOW.getTime() });
	attach(target, base);
	const names = CHAT.approval.ops.slice(1);
	for (const name of names) {
		const n = base.children.find((c) => c.name === name);
		if (!n) continue;
		const copy = cloneNode(n);
		detach(n);
		attach(copy, target);
	}
	S.chat.approval = false;
	S.chat.messages.push({ role: "result", title: "kt 위즈 폴더에 6개 파일 이동함", detail: "D:\\KBO_ost\\kt 위즈 · 실행 취소 가능", path: target.path });
	render();
	scrollChatEnd();
}

/* ---------------------------------------------------------------- Actions -- */

const ACTIONS = {
	noop: () => toast("시안에서는 이 화면을 그리지 않았어요", { icon: "info" }),
	dismiss: close,
	back,
	tab: (arg) => setTab(arg),
	"search-exit": () => setTab(S.prevTab),
	go: (arg) => {
		const n = node(arg);
		S.overlay = null;
		if (!n) return;
		if (S.tab !== "browse" || route().kind === "rule") return revealPath(n.path);
		push({ kind: "folder", path: n.path });
	},
	open: (arg, el) => {
		if (S.select) {
			S.select.has(arg) ? S.select.delete(arg) : S.select.add(arg);
			return render();
		}
		const n = node(arg);
		if (!n) return;
		if (isFolder(n)) return S.tab === "browse" ? push({ kind: "folder", path: n.path }) : revealPath(n.path);
		if (inTrash(n)) return sheet("info", { path: n.path });
		openQl(n.path);
	},
	"row-more": (arg, el) => {
		const row = el.closest(".row");
		if (row && !S.overlay) return liftMenu(row, [arg]);
		menuAt("item", el, { paths: [arg] });
	},
	collapse: (arg) => { S.collapsed.has(arg) ? S.collapsed.delete(arg) : S.collapsed.add(arg); render(); },
	tag: (arg) => { push({ kind: "folder", path: "D:", tag: arg }); },
	settings: () => { S.overlay = null; if (S.tab !== "browse") S.tab = "browse"; push({ kind: "settings" }); },
	"menu-view": (_, el) => menuAt("view", el),
	"menu-add": (_, el) => menuAt("add", el),
	"menu-path": (_, el) => menuAt("path", el),
	"menu-sort": (_, el) => menuAt("sort", el),
	"menu-browse-add": (_, el) => menuAt("browse-add", el),
	"menu-rule": (arg, el) => menuAt("rule", el, { id: arg }),
	"sel-more": (_, el) => menuAt("sel-more", el),
	mode: (_, el) => menuAt("mode", el),
	"toggle-sub": (arg) => { S.overlay.open = S.overlay.open === arg ? null : arg; render(); },
	"set-view": (arg) => { S.view = arg; close(); },
	"set-sort": (arg) => { S.sort = S.sort.key === arg ? { key: arg, asc: !S.sort.asc } : { key: arg, asc: arg === "name" || arg === "kind" }; S.overlay = null; render(); },
	"set-mode": (arg) => { S.chat.mode = arg; S.overlay = null; toast(`파일 변경 승인: ${{ ask: "묻기", auto: "자동", full: "전체 허용" }[arg]}`, { icon: "shield-check" }); },
	"select-start": () => { S.select = new Set(); S.overlay = null; render(); },
	"select-done": () => { S.select = null; render(); },
	"select-all": () => {
		const r = route();
		const all = r.kind === "recents" ? RECENTS : listing(node(r.path)).map((n) => n.path);
		S.select = S.select.size === all.length ? new Set() : new Set(all);
		render();
	},
	"sel-trash": () => doTrash([...S.select]),
	"sel-restore": () => doRestore([...S.select]),
	"sel-delete": () => ACTIONS["delete-forever"]([...S.select].join("\n")),
	"sel-move": () => sheet("picker", { paths: [...S.select], mode: "move", at: route().path ?? "" }),
	"sel-copy": () => sheet("picker", { paths: [...S.select], mode: "copy", at: route().path ?? "" }),
	"sel-ai": () => askAi([...S.select]),
	copy: (arg) => { S.clip = { paths: paths(arg) }; S.overlay = null; S.select = null; toast(`${paths(arg).length}개 항목 복사됨 · 붙여넣을 폴더로 가세요`, { icon: "copy" }); },
	"clip-clear": () => { S.clip = null; render(); },
	paste: () => { const list = S.clip.paths; S.clip = null; doTransfer(list, route().path, "copy"); },
	move: (arg) => sheet("picker", { paths: paths(arg), mode: "move", at: node(paths(arg)[0])?.parent ?? "" }),
	"pick-at": (arg) => { S.overlay = { ...S.overlay, at: arg, keep: false }; render(); },
	"pick-done": () => doTransfer(S.overlay.paths, S.overlay.at, S.overlay.mode),
	"pick-new-folder": () => {
		const at = node(S.overlay.at);
		const made = d(uniqueName(at, "새 폴더"), [], { mtime: NOW.getTime() });
		attach(made, at);
		S.overlay = { ...S.overlay, at: made.path, keep: false };
		render();
	},
	download: (arg) => { S.overlay = null; const list = paths(arg); toast(list.length > 1 ? `${list.length}개 항목을 ZIP으로 받는 중…` : `‘${node(list[0]).name}’ 다운로드 중…`, { icon: "download" }); },
	ql: (arg) => openQl(arg),
	"ql-tap": (_, el, ev) => { if (ev.target.closest("button")) return; S.overlay.immersive = !S.overlay.immersive; S.overlay.keep = false; render(); },
	info: (arg) => sheet("info", { path: arg }),
	"info-more": (arg, el) => menuAt("item", el, { paths: [arg] }),
	"folder-info": () => sheet("folderInfo", { path: route().path }),
	"folder-rules": () => sheet("folderInfo", { path: route().path }),
	reveal: (arg) => { if (arg) revealPath(arg); },
	ask: (arg) => askAi(paths(arg)),
	"ask-folder": () => askAi([route().path]),
	rename: (arg) => { const n = node(arg); alertBox({ title: "이름 변경", input: n.name, ok: "완료", path: arg, op: "rename", selectStem: !isFolder(n) }); },
	"new-folder": () => alertBox({ title: "새 폴더", input: "새 폴더", ok: "만들기", op: "new-folder" }),
	"new-file": (arg) => doCreate(arg, false),
	upload: () => doUpload(),
	duplicate: (arg) => doDuplicate(paths(arg)),
	"copy-path": (arg) => { S.overlay = null; navigator.clipboard?.writeText(arg).catch(() => {}); toast("경로를 복사했어요", { icon: "link" }); },
	compress: (arg) => {
		const list = paths(arg);
		const first = node(list[0]);
		const folder = node(first.parent);
		const zip = f(uniqueName(folder, list.length > 1 ? "보관 파일.zip" : `${first.name.replace(/\.[^.]+$/, "")}.zip`), Math.round(list.reduce((s, p) => s + (node(p).size ?? 2_000_000), 0) * 0.7), NOW.getTime());
		attach(zip, folder);
		S.overlay = null; S.select = null; S.fresh = zip.path; S.flash = zip.path;
		toast(`‘${zip.name}’ 만듦`, { icon: "file-archive", undo: () => node(zip.path) && detach(node(zip.path)) });
	},
	extract: (arg) => { const n = node(arg); const folder = node(n.parent); const out = d(uniqueName(folder, n.name.replace(/\.zip$/i, "")), [f("README.md", 2_100, NOW.getTime())], { mtime: NOW.getTime() }); attach(out, folder); S.overlay = null; S.fresh = out.path; S.flash = out.path; toast(`‘${out.name}’에 풀었어요`, { icon: "folder-open" }); },
	convert: (arg) => { const [label, path] = arg.split("\n"); S.overlay = null; S.activity.unshift({ id: `conv-${Date.now()}`, kind: "convert", title: label, detail: node(path)?.name ?? "", progress: 0.05, icon: "refresh-cw" }); toast(`${label} 시작 · 아래에서 진행 상황을 볼 수 있어요`, { icon: "refresh-cw" }); },
	magic: (arg) => { const [id] = arg.split("\n"); const a = MAGIC_ACTIONS.find((x) => x.id === id); S.overlay = null; S.activity.unshift({ id: `magic-${Date.now()}`, kind: "magic", title: a.label, detail: `매직 액션 · ${node(paths(arg)[1])?.name ?? ""}`, progress: null, icon: "wand-sparkles" }); toast(`‘${a.label}’ 실행 중`, { icon: "wand-sparkles" }); },
	"toggle-index": (arg) => {
		const list = paths(arg).map(node).filter(Boolean);
		const on = !list.every((n) => n.indexed);
		list.forEach((n) => { n.indexed = on; });
		if (S.overlay?.type === "menu") S.overlay = null;
		toast(on ? `${list.length > 1 ? `${list.length}개 항목을` : "이 항목을"} AI 검색에 포함했어요` : "AI 검색에서 제외했어요", { icon: "sparkles" });
	},
	"tag-toggle": (arg) => {
		const [tag, ...rest] = arg.split("\n");
		const list = rest.map(node).filter(Boolean);
		const on = !list.every((n) => n.tags?.includes(tag));
		for (const n of list) { n.tags = (n.tags ?? []).filter((t) => t !== tag); if (on) n.tags.push(tag); }
		render();
	},
	trash: (arg) => {
		const row = $$("#screen .row").find((r) => r.dataset.path === paths(arg)[0]);
		if (row && !S.overlay) { row.classList.add("is-leaving"); setTimeout(() => doTrash(paths(arg)), 220); } else doTrash(paths(arg));
	},
	restore: (arg) => doRestore(paths(arg)),
	"delete-forever": (arg) => alertBox({ title: paths(arg).length > 1 ? `${paths(arg).length}개 항목을 영구 삭제할까요?` : `‘${node(paths(arg)[0]).name}’을(를) 영구 삭제할까요?`, text: "이 작업은 실행 취소할 수 없어요.", ok: "삭제", danger: true, op: "delete", paths: paths(arg) }),
	"empty-trash": () => alertBox({ title: "휴지통을 비울까요?", text: `${node("휴지통").count}개 항목이 영구 삭제돼요. 실행 취소할 수 없어요.`, ok: "휴지통 비우기", danger: true, op: "delete", paths: node("휴지통").children.map((c) => c.path) }),
	"alert-ok": () => {
		const o = S.overlay;
		const value = $("#alert-input")?.value.trim();
		if (o.op === "rename") return doRename(o.path, value);
		if (o.op === "new-folder") return doCreate(value || "새 폴더", true);
		if (o.op === "delete") { o.paths.forEach((p) => node(p) && detach(node(p))); S.overlay = null; S.select = null; toast(`${o.paths.length}개 항목을 영구 삭제했어요`, { icon: "trash" }); }
		if (o.op === "rule-delete") { RULES.splice(RULES.findIndex((r) => r.id === o.id), 1); S.overlay = null; back(); toast("규칙을 삭제했어요", { icon: "trash" }); }
		if (o.op === "disconnect") { SET.sources = SET.sources.filter((s) => s.id !== o.id); S.overlay = null; back(); toast("연결을 해제했어요", { icon: "plug" }); }
	},
	favorite: () => { S.overlay = null; toast("즐겨찾기에 추가했어요", { icon: "star" }); },
	undo: () => { const fn = S.undoFn; S.toast = null; S.undoFn = null; fn?.(); toast("실행 취소했어요", { icon: "undo-2" }); },
	"recents-filter": (arg) => { S.recentsFilter = arg; render(); },
	activity: () => sheet("activity"),
	"act-cancel": (arg) => { S.activity = S.activity.filter((a) => a.id !== arg); S.overlay.keep = false; render(); },
	"fix-now": () => { S.overlay = null; S.activity = S.activity.filter((a) => a.kind !== "fix"); S.chat.draft = "Discord 첨부 파일 가져오기가 실패했어. 원인 찾아서 고쳐줘"; setTab("ai"); },
	/* AI 검색 */
	suggest: (arg) => runChat(arg),
	send: () => { const text = $("#composer")?.value.trim() || S.chat.draft.trim(); if (text || S.chat.attachments.length) runChat(text || "이 파일 요약해줘"); },
	attach: () => sheet("attach"),
	"attach-toggle": (arg) => { const list = S.chat.attachments; S.chat.attachments = list.includes(arg) ? list.filter((p) => p !== arg) : [...list, arg]; S.overlay.keep = true; render(); },
	"attach-upload": () => toast("휴대폰의 사진 선택기가 열려요 (시안)", { icon: "image" }),
	"attach-browse": () => { S.overlay = null; setTab("browse"); toast("항목을 길게 눌러 ‘AI에게 묻기’를 고르세요", { icon: "sparkles" }); },
	detach: (arg) => { S.chat.attachments = S.chat.attachments.filter((p) => p !== arg); render(); },
	cite: (arg) => sheet("evidence", { n: Number(arg) }),
	history: () => sheet("history"),
	"open-chat": () => { S.overlay = null; S.chat.messages = [CHAT.messages[0], CHAT.messages[1]]; S.chat.phase = "answered"; render(); },
	"new-chat": () => { chatTimers.forEach(clearTimeout); S.overlay = null; S.chat = { ...S.chat, phase: "empty", messages: [], attachments: [], draft: "", approval: false }; render(); },
	allow: () => allowChange(),
	deny: () => { S.chat.approval = false; S.chat.messages.push({ role: "assistant", blocks: [{ p: "알겠어요. 파일은 그대로 두었어요." }] }); render(); scrollChatEnd(); },
	"deny-note": () => { S.chat.approval = false; S.chat.draft = "대신 "; render(); $("#composer")?.focus(); },
	"copy-answer": () => toast("답변을 복사했어요", { icon: "copy" }),
	"evidence-folder": () => toast("근거 파일 3개를 임시 폴더로 열었어요", { icon: "folder-open" }),
	retry: () => runChat(S.chat.messages.find((m) => m.role === "user")?.text ?? ""),
	/* 검색 */
	"q-set": (arg) => { S.search.q = arg; render(); },
	"q-clear": () => { S.search.q = ""; render(); $("#q")?.focus(); },
	scope: (arg) => { S.search.scope = arg; render(); },
	"ask-q": () => { const q = S.search.q; setTab("ai"); runChat(q); },
	/* 자동화 */
	rule: (arg) => { S.overlay = null; if (S.tab !== "auto") S.tab = "auto"; push({ kind: "rule", id: arg }); },
	daemon: () => { S.daemon = !S.daemon; render(); },
	"rule-add": () => { S.overlay = null; S.chat.draft = "다운로드에 새 PDF가 생기면 "; setTab("ai"); $("#composer")?.focus(); },
	"rule-edit": (arg) => { const r = RULES.find((x) => x.id === (arg || route().id)); S.overlay = null; S.chat.draft = `‘${r.title}’ 규칙을 고쳐줘: `; setTab("ai"); },
	"rule-fix": () => { S.chat.draft = "‘새 한글 문서 → PDF 변환’ 규칙이 실패했어. 원인 찾아서 고쳐줘"; setTab("ai"); },
	"rule-run": () => { S.overlay = null; toast("규칙을 지금 실행했어요", { icon: "play" }); },
	"rule-delete": (arg) => alertBox({ title: "규칙을 삭제할까요?", text: "이 규칙이 더 이상 실행되지 않아요.", ok: "삭제", danger: true, op: "rule-delete", id: arg }),
	/* 설정 */
	"set-page": (arg) => { S.overlay = null; if (S.tab !== "browse") S.tab = "browse"; if (route().kind !== "settings" && route().kind !== "setting") { rememberScroll(); S.stacks.browse.push({ kind: "settings" }); } push({ kind: "setting", id: arg }); },
	"set-source": (arg) => push({ kind: "source", id: arg }),
	"set-toggle": (arg) => {
		const [key, sub] = arg.split(".");
		if (key === "magic") SET.magic[sub] = !SET.magic[sub];
		else if (key === "mcp") SET.mcpServers[Number(sub)].on = !SET.mcpServers[Number(sub)].on;
		else if (key === "source") { const s = SET.sources.find((x) => x.id === sub); s.on = !s.on; s.status = s.on ? "ok" : "off"; s.meta = s.on ? "다시 켰어요 · 다음 최신화를 기다리는 중" : "꺼짐"; }
		else if (sub != null) SET[key][sub] = !SET[key][sub];
		else SET[key] = !SET[key];
		render();
	},
	"set-choice": (arg, el) => menuAt("choice", el, { key: arg }),
	"set-interval": (arg, el) => menuAt("interval", el, { id: arg }),
	"set-pick": (arg) => {
		const [key, value] = arg.split("\n");
		SET[key] = value;
		S.overlay = null;
		if (key === "theme") { document.documentElement.dataset.appearance = value; $("#theme-toggle").textContent = value === "dark" ? "라이트 모드" : "다크 모드"; }
		render();
	},
	"set-pick-interval": (arg) => { const [id, v] = arg.split("\n"); SET.sources.find((x) => x.id === id).interval = v; S.overlay = null; render(); },
	"set-sheet": (arg) => sheet("settings", { arg }),
	"set-save": () => { S.overlay = null; toast("저장했어요", { icon: "circle-check" }); },
	"set-add": () => {
		const value = $("#set-input")?.value.trim();
		const kind = S.overlay.arg;
		S.overlay = null;
		if (!value) return render();
		if (kind === "addScope") SET.scopeFolders.push(value);
		if (kind === "addExclude") SET.excludes.push(value);
		if (kind === "addFavorite") SET.sidebarItems[value.split(/[\\/]/).pop() || value] = true;
		toast(`‘${value}’ 추가했어요`, { icon: "plus" });
	},
	"set-browse": () => toast("폴더 선택 화면이 열려요 (시안)", { icon: "folder" }),
	"set-scope-remove": (arg) => { SET.scopeFolders = SET.scopeFolders.filter((p) => p !== arg); toast(`‘${arg}’ 검색 폴더에서 뺐어요`, { icon: "circle-minus", undo: () => SET.scopeFolders.push(arg) }); },
	"set-exclude-remove": (arg) => { SET.excludes = SET.excludes.filter((p) => p !== arg); render(); },
	"set-lang-remove": (arg) => { SET.docLangs = SET.docLangs.filter((l) => l !== arg); render(); },
	"set-lang-add": (_, el) => menuAt("choice", el, { key: "docLangAdd" }),
	"set-lang-reset": () => { SET.docLangs = ["한국어", "English"]; render(); },
	"set-preset": (arg) => toast(`‘${arg}’ 적용했어요`, { icon: "circle-check", undo: () => {} }),
	"set-ai-custom": (arg) => { const ask = { sidebar: "음악과 동영상은 숨기고 다운로드를 맨 위로 올려줘", contextMenu: "이미지 여러 개 우클릭하면 해상도랑 용량 표로 정리해주는 매직 액션 만들어줘", shortcuts: "이름 변경은 F2로 바꿔줘" }[arg]; S.chat.draft = ask; setTab("ai"); },
	"set-refresh": () => toast("최신화를 시작했어요 · 아래 진행 상황에서 볼 수 있어요", { icon: "refresh-cw" }),
	"set-copy-address": () => { navigator.clipboard?.writeText("http://192.168.0.12:47833").catch(() => {}); toast("주소 복사됨", { icon: "link" }); },
	"set-copied": () => toast("복사됨", { icon: "copy" }),
	"set-link": (arg) => toast(`${arg} 페이지를 새 탭에서 열어요`, { icon: "external-link" }),
	"set-desktop": (arg) => toast(`${arg}은(는) 데스크탑에서 진행돼요`, { icon: "monitor" }),
	"set-managed": () => { SET.answerModel = "Dazzi 관리형"; toast("답변 모델을 Dazzi 관리형으로 바꿨어요", { icon: "sparkles" }); },
	"set-service": (arg, el) => toast(`${arg}: 연결 정보 수정 · 연결 확인 · 모델 다시 검색 · 연결 해제`, { icon: "info" }),
	"set-connect": (arg) => toast(`${arg} 연결을 추가했어요 · 처음 가져오는 중`, { icon: "plus" }),
	"set-disconnect": (arg) => alertBox({ title: "연결을 해제할까요?", text: `‘${SET.sources.find((s) => s.id === arg).alias}’ 연결이 Dazzi 검색에서 제거됩니다. 원본 앱의 데이터는 지워지지 않습니다.`, ok: "연결 해제", danger: true, op: "disconnect", id: arg }),
};

/* ------------------------------------------------------------------ Input -- */

let press = null;
const LONG_MS = 480;

function onPointerDown(ev) {
	const screen = screenEl();
	if (!screen.contains(ev.target)) return;
	const row = ev.target.closest(".row, .tile-item");
	const grab = ev.target.closest("[data-drag='sheet']");
	const ql = ev.target.closest(".ql-stage");
	press = { x: ev.clientX, y: ev.clientY, t: Date.now(), row, grab, ql, moved: false, axis: null, fired: false };
	if (row && !S.select && !S.overlay && !ev.target.closest(".row-more, .swipe-actions")) {
		row.classList.add("is-pressed");
		press.timer = setTimeout(() => {
			press.fired = true;
			row.classList.remove("is-pressed");
			const path = row.dataset.path;
			liftMenu(row, S.select?.size && S.select.has(path) ? [...S.select] : [path]);
		}, LONG_MS);
	}
}
function onPointerMove(ev) {
	if (!press) return;
	const dx = ev.clientX - press.x;
	const dy = ev.clientY - press.y;
	if (!press.axis && Math.hypot(dx, dy) > 8) {
		press.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
		clearTimeout(press.timer);
		press.row?.classList.remove("is-pressed");
	}
	if (press.axis === "x" && press.row?.classList.contains("row") && !S.select && !S.overlay) {
		const inner = $(".row-inner", press.row);
		const base = press.row.classList.contains("is-open") ? -160 : 0;
		const x = Math.min(0, Math.max(-220, base + dx));
		press.row.classList.add("is-dragging");
		inner.style.transform = `translateX(${x}px)`;
		press.moved = true;
		press.swipeX = x;
		ev.preventDefault();
	}
	if (press.grab && press.axis === "y") {
		const el = press.grab.closest(".sheet");
		el.classList.add("is-dragging");
		el.style.transform = `translateY(${Math.max(0, dy)}px)`;
		press.moved = true; press.dy = dy;
	}
	if (press.ql && press.axis === "x") {
		const track = $(".ql-track", press.ql);
		const i = S.overlay.list.indexOf(S.overlay.path);
		track.classList.add("is-dragging");
		track.style.transform = `translateX(calc(${-i * 100}% + ${dx}px))`;
		press.moved = true; press.dx = dx;
	}
	if (press.ql && press.axis === "y" && dy > 0) {
		const ql = press.ql.closest(".ql");
		ql.style.transform = `translateY(${dy * 0.6}px) scale(${1 - Math.min(dy, 300) / 1500})`;
		ql.style.opacity = String(1 - Math.min(dy, 300) / 600);
		press.moved = true; press.dy = dy;
	}
}
function onPointerUp() {
	if (!press) return;
	clearTimeout(press.timer);
	const p = press;
	press = null;
	p.row?.classList.remove("is-pressed");
	if (p.row && p.swipeX != null) {
		const inner = $(".row-inner", p.row);
		p.row.classList.remove("is-dragging");
		$$("#screen .row.is-open").forEach((r) => { if (r !== p.row) { r.classList.remove("is-open"); $(".row-inner", r).style.transform = ""; } });
		if (p.swipeX < -200) { inner.style.transform = ""; ACTIONS.trash(p.row.dataset.path); }
		else if (p.swipeX < -70) { p.row.classList.add("is-open"); inner.style.transform = "translateX(-160px)"; }
		else { p.row.classList.remove("is-open"); inner.style.transform = ""; }
	}
	if (p.grab && p.dy != null) {
		const el = p.grab.closest(".sheet");
		el.classList.remove("is-dragging");
		if (p.dy > 110) close();
		else if (p.dy < -40 && S.overlay?.type === "sheet") { S.overlay.full = true; S.overlay.keep = false; render(); }
		else el.style.transform = "";
	}
	if (p.ql && p.dx != null) {
		const o = S.overlay;
		const i = o.list.indexOf(o.path);
		const next = p.dx < -60 ? Math.min(o.list.length - 1, i + 1) : p.dx > 60 ? Math.max(0, i - 1) : i;
		o.path = o.list[next]; o.keep = false;
		render();
	}
	if (p.ql && p.dy != null && p.axis === "y") {
		if (p.dy > 120) close();
		else { const ql = $(".ql"); if (ql) { ql.style.transform = ""; ql.style.opacity = ""; } }
	}
	if (p.moved || p.fired) suppressClick = Date.now();
}
let suppressClick = 0;

function onClick(ev) {
	if (Date.now() - suppressClick < 350) { ev.preventDefault(); ev.stopPropagation(); return; }
	const review = ev.target.closest("[data-review]");
	if (review) return reviewAction(review.dataset.review, review.dataset.arg);
	const el = ev.target.closest("[data-act]");
	if (!el || !screenEl().contains(el)) return;
	const open = $("#screen .row.is-open");
	if (open && !el.closest(".swipe-actions")) {
		open.classList.remove("is-open");
		$(".row-inner", open).style.transform = "";
		if (el.closest(".row") === open || !el.closest(".swipe-actions")) return;
	}
	const fn = ACTIONS[el.dataset.act];
	if (!fn) return;
	ev.preventDefault();
	fn(el.dataset.arg ?? "", el, ev);
}
function onContextMenu(ev) {
	const row = ev.target.closest("#screen .row, #screen .tile-item");
	if (!row) return;
	ev.preventDefault();
	if (!S.overlay && !S.select) liftMenu(row, [row.dataset.path]);
}
function onInput(ev) {
	if (ev.target.id === "q") { S.search.q = ev.target.value; render(); }
	if (ev.target.id === "composer") {
		S.chat.draft = ev.target.value;
		ev.target.style.height = "auto";
		ev.target.style.height = `${Math.min(120, ev.target.scrollHeight)}px`;
		const send = $(".composer .send");
		if (send) send.disabled = !ev.target.value.trim() && !S.chat.attachments.length;
	}
	if (ev.target.id === "hq") { S.overlay.q = ev.target.value; render(); }
}
function onKey(ev) {
	if (ev.key === "Enter" && ev.target.id === "alert-input") { ev.preventDefault(); ACTIONS["alert-ok"](); }
	if (ev.key === "Enter" && !ev.shiftKey && ev.target.id === "composer") { ev.preventDefault(); ACTIONS.send(); }
	if (ev.key === "Escape" && S.overlay) close();
}

let lastTop = 0;
function onScroll(ev) {
	const page = ev.target;
	if (!page.classList?.contains("page")) return;
	const top = page.scrollTop;
	screenEl().classList.toggle("is-scrolled", top > 36);
	const min = top > 80 && top > lastTop + 4 ? true : top < lastTop - 6 || top < 40 ? false : S.min;
	lastTop = top;
	if (min !== S.min && S.tab !== "ai" && S.tab !== "search" && !S.select) {
		S.min = min;
		$(".bottom")?.classList.toggle("is-min", min);
	}
}

/* -------------------------------------------------------------- Lifecycle -- */

function afterRender(screen) {
	const box = $("#composer", screen);
	if (box) { box.style.height = "auto"; box.style.height = `${Math.min(120, box.scrollHeight)}px`; }
}

/** Background work ticks like the real queue: indexing advances, conversions finish. */
setInterval(() => {
	let changed = false;
	for (const a of S.activity) {
		if (a.progress == null || a.tone === "error") continue;
		a.progress = Math.min(1, a.progress + (a.kind === "convert" ? 0.12 : 0.004));
		const C = 2 * Math.PI * 13;
		$$(`[data-ring="${a.id}"]`).forEach((r) => r.setAttribute("stroke-dashoffset", (C * (1 - a.progress)).toFixed(2)));
		$$(`[data-bar="${a.id}"]`).forEach((b) => { b.style.width = `${a.progress * 100}%`; });
		if (a.progress >= 1) {
			S.activity = S.activity.filter((x) => x !== a);
			if (a.kind === "convert") toast(`${a.title} 완료 · ${a.detail}`, { icon: "circle-check" });
			changed = true;
		}
	}
	if (changed && !S.toast) render();
}, 600);

/* ---------------------------------------------------------------- Review -- */

const SCENES = {
	"둘러보기": () => {},
	"D: 드라이브": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: "D:" }]; },
	"KBO_ost 폴더": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: "D:" }, { kind: "folder", path: "D:\\KBO_ost" }]; },
	"아이콘 보기": () => { S.view = "grid"; S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: `${HOME}\\Pictures` }]; },
	"길게 누름 메뉴": (after) => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: "D:" }, { kind: "folder", path: "D:\\KBO_ost" }]; after(() => { const row = $$("#screen .row")[5]; liftMenu(row, [row.dataset.path]); }); },
	"선택 모드": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: "D:" }, { kind: "folder", path: "D:\\KBO_ost" }]; S.select = new Set(["D:\\KBO_ost\\2023 kt위즈 노동요.mp3", "D:\\KBO_ost\\KT WIZ 문상철 선수 응원가.mp3"]); },
	"정보 시트": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: "D:" }, { kind: "folder", path: "D:\\KBO_ost" }]; S.overlay = { type: "sheet", sheet: "info", path: "D:\\KBO_ost\\ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3" }; },
	"훑어보기": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: `${HOME}\\Downloads` }]; openQlScene(`${HOME}\\Downloads\\IMG_2041.jpg`); },
	"이동 위치 선택": () => { S.stacks.browse = [{ kind: "root" }, { kind: "folder", path: `${HOME}\\Downloads` }]; S.overlay = { type: "sheet", sheet: "picker", paths: [`${HOME}\\Downloads\\IMG_2041.jpg`, `${HOME}\\Downloads\\IMG_2042.jpg`], mode: "move", at: `${HOME}\\Pictures` }; },
	"최근 항목": () => { S.tab = "recents"; },
	"검색": () => { S.prevTab = "browse"; S.tab = "search"; S.search.q = "kt"; },
	"AI 검색 · 빈 화면": () => { S.tab = "ai"; },
	"AI 검색 · 승인": () => { S.tab = "ai"; S.chat.messages = [CHAT.messages[0], CHAT.messages[1]]; S.chat.phase = "answered"; S.chat.approval = true; },
	"AI 검색 · 근거": () => { S.tab = "ai"; S.chat.messages = [CHAT.messages[0], CHAT.messages[1]]; S.chat.phase = "answered"; S.overlay = { type: "sheet", sheet: "evidence", n: 1 }; },
	"자동화": () => { S.tab = "auto"; },
	"자동화 · 실패 규칙": () => { S.tab = "auto"; S.stacks.auto = [{ kind: "rules" }, { kind: "rule", id: "hwp" }]; },
	"진행 중인 작업": () => { S.overlay = { type: "sheet", sheet: "activity" }; },
	"설정": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }]; },
	"설정 · 일반": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "general" }]; },
	"설정 · 구독": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "plan" }]; },
	"설정 · 사이드바": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "sidebar" }]; },
	"설정 · 우클릭 메뉴": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "contextMenu" }]; },
	"설정 · AI 모델": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "ai" }]; },
	"설정 · 인덱싱": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "indexing" }]; },
	"설정 · 연결된 앱": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "setting", id: "apps" }]; },
	"설정 · Discord": () => { S.stacks.browse = [{ kind: "root" }, { kind: "settings" }, { kind: "source", id: "discord" }]; },
};
function openQlScene(path) { const n = node(path); S.overlay = { type: "ql", path, list: listing(node(n.parent)).filter((x) => !isFolder(x)).map((x) => x.path) }; }

let pristine = null;
function snapshot() { return { nodes: new Map([...nodes].map(([k, v]) => [k, v])), tree: JSON.stringify([...nodes.values()].filter((n) => !n.parent).map(cloneNode)) }; }
function resetState() {
	chatTimers.forEach(clearTimeout);
	nodes.clear();
	for (const root of JSON.parse(pristine.tree)) register(root, null, SEP);
	Object.assign(S, {
		tab: "browse", prevTab: "browse", anim: null, min: false, view: "list", sort: { key: "name", asc: true }, select: null, clip: null, overlay: null, toast: null, undoFn: null, flash: null, recentsFilter: "all",
		stacks: { browse: [{ kind: "root" }], recents: [{ kind: "recents" }], ai: [{ kind: "chat" }], auto: [{ kind: "rules" }], search: [{ kind: "search" }] },
		activity: ACTIVITY.map((x) => ({ ...x })), chat: { phase: "empty", messages: [], attachments: [], draft: "", mode: "ask", approval: false }, search: { q: "", scope: "name" },
	});
}
function reviewAction(kind, arg) {
	if (kind === "theme") {
		const dark = document.documentElement.dataset.appearance !== "dark";
		document.documentElement.dataset.appearance = dark ? "dark" : "light";
		$("#theme-toggle").textContent = dark ? "라이트 모드" : "다크 모드";
		return render();
	}
	if (kind === "reset" || kind === "scene") {
		resetState();
		const queued = [];
		if (kind === "scene") SCENES[arg]((fn) => queued.push(fn));
		$$("[data-review='scene']").forEach((b) => b.classList.toggle("is-on", b.dataset.arg === arg));
		render();
		queued.forEach((fn) => fn());
		history.replaceState(null, "", kind === "scene" ? `#${encodeURIComponent(arg)}` : location.pathname);
	}
}

function boot() {
	$("#scenes").innerHTML = Object.keys(SCENES).map((name) => `<button class="rbtn" type="button" data-review="scene" data-arg="${esc(name)}">${esc(name)}</button>`).join("");
	pristine = snapshot();
	document.addEventListener("click", onClick, true);
	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointermove", onPointerMove, { passive: false });
	document.addEventListener("pointerup", onPointerUp);
	document.addEventListener("pointercancel", onPointerUp);
	document.addEventListener("contextmenu", onContextMenu);
	document.addEventListener("input", onInput);
	document.addEventListener("keydown", onKey);
	document.addEventListener("scroll", onScroll, true);
	const params = new URLSearchParams(location.search);
	if (params.get("theme") === "dark") reviewAction("theme");
	const fromHash = () => {
		const scene = decodeURIComponent(location.hash.slice(1));
		if (SCENES[scene]) reviewAction("scene", scene); else render();
	};
	window.addEventListener("hashchange", fromHash);
	fromHash();
}
boot();
