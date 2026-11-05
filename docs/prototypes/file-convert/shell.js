/* Shared helpers for the file-convert prototypes: icons, theme toggle, toast, and the Finder shell markup.
 * Everything here is example data; no prototype touches the disk or runs a real conversion. */
"use strict";

/** Inline lucide glyph (markup comes from lucide-icons.js, generated from the app's own pin). */
function icon(name, cls = "") {
	const body = LUCIDE[name];
	if (body === undefined) throw new Error(`icon ${name} is not in lucide-icons.js`);
	return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

const FILES = [
	{ id: "a", name: "2026 업무보고.hwpx", ext: "hwpx", tile: "hwp", letter: "H", kind: "한글 문서", size: "412 KB", date: "Oct 19, 09:12" },
	{ id: "b", name: "계약서_최종.docx", ext: "docx", tile: "docx", letter: "W", kind: "Word 문서", size: "1.2 MB", date: "Oct 18, 17:40" },
	{ id: "c", name: "제품소개서.pdf", ext: "pdf", tile: "pdf", letter: "P", kind: "PDF 문서", size: "3.8 MB", date: "Oct 18, 11:03" },
	{ id: "d", name: "예산.xlsx", ext: "xlsx", tile: "xlsx", letter: "X", kind: "Excel 스프레드시트", size: "88 KB", date: "Oct 17, 15:26" },
	{ id: "e", name: "IMG_4021.heic", ext: "heic", tile: "heic", letter: "I", kind: "HEIC 이미지", size: "2.6 MB", date: "Oct 16, 08:51" },
	{ id: "f", name: "IMG_4022.heic", ext: "heic", tile: "heic", letter: "I", kind: "HEIC 이미지", size: "2.4 MB", date: "Oct 16, 08:51" },
	{ id: "g", name: "로고.svg", ext: "svg", tile: "svg", letter: "S", kind: "SVG 이미지", size: "14 KB", date: "Oct 12, 13:20" },
	{ id: "h", name: "회의록.md", ext: "md", tile: "md", letter: "M", kind: "Markdown", size: "6 KB", date: "Oct 12, 10:05" },
	{ id: "i", name: "발표자료.pptx", ext: "pptx", tile: "pptx", letter: "P", kind: "PowerPoint 프레젠테이션", size: "9.4 MB", date: "Oct 11, 19:44" },
	{ id: "j", name: "인터뷰.mov", ext: "mov", tile: "mov", letter: "V", kind: "QuickTime 동영상", size: "184 MB", date: "Oct 10, 14:08" },
	{ id: "k", name: "NotoSansKR.ttf", ext: "ttf", tile: "ttf", letter: "F", kind: "글꼴", size: "5.1 MB", date: "Oct 9, 22:04" },
	{ id: "l", name: "견적문의.eml", ext: "eml", tile: "eml", letter: "@", kind: "이메일 메시지", size: "38 KB", date: "Oct 8, 09:30" },
	{ id: "m", name: "자료.zip", ext: "zip", tile: "zip", letter: "Z", kind: "ZIP 압축 파일", size: "21 MB", date: "Oct 7, 16:12" },
];

/** What each source extension can become. Illustrative; the real list comes from the route planner. */
const TARGETS = {
	hwpx: ["pdf", "docx", "hwp", "txt", "md", "html", "png"],
	docx: ["pdf", "hwpx", "txt", "html", "epub", "md"],
	pdf: ["docx", "hwpx", "txt", "md", "png", "jpg", "pptx"],
	xlsx: ["pdf", "csv", "ods", "json", "html", "hwpx"],
	heic: ["jpg", "png", "webp", "avif", "pdf"],
	svg: ["png", "pdf", "jpg", "webp", "dxf"],
	md: ["pdf", "docx", "html", "hwpx", "epub", "txt"],
	pptx: ["pdf", "png", "jpg", "docx", "hwpx"],
	mov: ["mp4", "webm", "gif", "mp3", "mkv"],
	ttf: ["woff2", "woff", "otf", "eot"],
	eml: ["pdf", "html", "txt", "zip"],
	zip: ["7z", "tar.gz"],
};

/** Same-format jobs that are not a format change (shown beside the format list, never inside it). */
const SAME_FORMAT_TASKS = {
	pdf: [["압축 (용량 줄이기)", "gauge"], ["페이지 나누기", "layers"]],
	heic: [["크기 조절", "scaling"]],
	mov: [["용량 줄이기", "gauge"]],
};

/** Where a conversion needs an engine the app does not carry yet (the optional-download model). */
const NEEDS_ENGINE = { hwpx: { pdf: "rhwp" }, mov: { mp4: "FFmpeg", webm: "FFmpeg", gif: "FFmpeg", mp3: "FFmpeg", mkv: "FFmpeg" } };

const SIDEBAR = [
	{ group: "즐겨찾기", rows: [["sparkles", "AI 검색"], ["clock", "최근 항목"], ["house", "홈"], ["app-window", "응용 프로그램"], ["monitor", "데스크탑"], ["file-text", "문서", true], ["download", "다운로드"], ["music", "음악"], ["film", "동영상"], ["image", "사진"], ["trash", "휴지통"]] },
	{ group: "클라우드", rows: [["cloud", "iCloud Drive"], ["cloud", "OneDrive - Personal"]] },
	{ group: "위치", rows: [["hard-drive", "Macintosh HD"], ["hard-drive", "SSD1"]] },
];

function sidebarHtml() {
	const groups = SIDEBAR.map(
		(g) => `<div class="side-group">${g.group}</div>` + g.rows.map(([i, label, active]) => `<div class="side-row${active ? " active" : ""}">${icon(i)}<span>${label}</span></div>`).join(""),
	).join("");
	return `<aside class="sidebar" aria-label="사이드바">
		<div class="traffic" aria-hidden="true"><i></i><i></i><i></i></div>
		<div class="side-search">${icon("search", "sm")}<span>검색…</span><kbd>⌘F</kbd></div>
		${groups}
		<div class="side-footer">${icon("settings")}<span>설정</span></div>
	</aside>`;
}

function toolbarHtml({ inspectorOn = true, extra = "" } = {}) {
	return `<div class="toolbar">
		<button class="tb-btn" aria-label="뒤로">${icon("chevron-left")}</button>
		<button class="tb-btn" aria-label="앞으로" disabled style="opacity:.4">${icon("chevron-right")}</button>
		<span class="tb-title">문서</span>
		<div class="tb-seg">
			<button class="tb-btn" aria-label="아이콘">${icon("layout-grid")}</button>
			<button class="tb-btn on" aria-label="목록">${icon("list")}</button>
			<button class="tb-btn" aria-label="열">${icon("columns-3")}</button>
		</div>
		<button class="tb-btn" aria-label="정렬">${icon("arrow-up-down")}</button>
		<button class="tb-btn" aria-label="그룹">${icon("layers")}</button>
		${extra}
		<button class="tb-btn ${inspectorOn ? "accent" : ""}" aria-label="정보">${icon("info")}</button>
		<button class="tb-btn" aria-label="AI 검색">${icon("sparkles")}</button>
		<button class="tb-btn" aria-label="공유">${icon("share")}</button>
	</div>`;
}

function rowHtml(f, state = "") {
	return `<div class="frow ${state}" data-id="${f.id}">
		<div class="name"><span class="tile t-${f.tile}">${f.letter}</span><b>${f.name}</b></div>
		<span class="meta">${f.date}</span><span class="meta num">${f.size}</span><span class="meta">${f.kind}</span><span class="meta"></span>
	</div>`;
}

const COLHEAD = `<div class="col-head"><span>이름</span><span>수정한 날짜</span><span class="num">크기</span><span>종류</span><span>색인</span></div>`;
const PATHBAR = `<div class="pathbar">${icon("folder")}<span>Macintosh HD</span><span class="sep">›</span><span>사용자</span><span class="sep">›</span><span>jeffrey</span><span class="sep">›</span><span>문서</span></div>`;

function inspectorHtml(f, actionsHtml) {
	return `<aside class="inspector" aria-label="정보 창">
		<div class="insp-preview"><div class="paper">${f.ext.toUpperCase()}</div></div>
		<div class="insp-head"><h2>${f.name}</h2><p>${f.kind} · ${f.size}</p></div>
		<dl class="insp-meta"><dt>수정한 날짜</dt><dd>${f.date}</dd><dt>위치</dt><dd>~/문서</dd></dl>
		<div class="actions">${actionsHtml}</div>
	</aside>`;
}

/** The shipped Inspector action bar (DESIGN.md section 3) as chips, for prototypes that add to it. */
function baseChips(extra = "") {
	return `<button class="chip">${icon("external-link")}열기</button>
		<button class="chip">${icon("app-window")}다른 앱으로 열기</button>
		${extra}
		<button class="chip">${icon("package")}압축</button>
		<button class="chip">${icon("share")}공유</button>
		<button class="chip">${icon("sparkles")}AI 요약</button>`;
}

let toastTimer = 0;
function toast(message, iconName = "circle-check") {
	let el = document.getElementById("toast");
	if (!el) {
		el = document.createElement("div");
		el.id = "toast";
		el.className = "toast";
		el.setAttribute("role", "status");
		document.body.append(el);
	}
	el.innerHTML = `${icon(iconName)}<span>${message}</span>`;
	el.classList.add("show");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

function wireChrome() {
	document.getElementById("theme-toggle")?.addEventListener("click", (event) => {
		const root = document.documentElement;
		const dark = root.dataset.appearance !== "dark";
		root.dataset.appearance = dark ? "dark" : "light";
		event.currentTarget.textContent = dark ? "라이트 모드" : "다크 모드";
	});
}

/** Position a `.menu` inside `.window` next to `anchor`, kept inside the window. */
function placeMenu(menu, anchor, windowEl, { side = "below", dx = 0, dy = 4 } = {}) {
	const w = windowEl.getBoundingClientRect();
	const a = anchor.getBoundingClientRect();
	menu.style.visibility = "hidden";
	menu.style.display = "block";
	const m = menu.getBoundingClientRect();
	let left = side === "right" ? a.right - w.left + dx : a.left - w.left + dx;
	let top = side === "above" ? a.top - w.top - m.height - dy : a.bottom - w.top + dy;
	left = Math.max(8, Math.min(left, w.width - m.width - 8));
	top = Math.max(8, Math.min(top, w.height - m.height - 8));
	menu.style.left = `${left}px`;
	menu.style.top = `${top}px`;
	menu.style.visibility = "";
}

const REVIEW_LINKS = [
	["01-inspector-convert.html", "1 인스펙터"],
	["02-context-menu.html", "2 우클릭"],
	["03-rename-extension.html", "3 이름 변경"],
	["04-format-chips.html", "4 형식 칩"],
	["05-drag-to-convert.html", "5 끌어서"],
	["06-cant-open.html", "6 못 열 때"],
	["07-send-to.html", "7 보낼 곳"],
	["08-auto-rule.html", "8 자동 규칙"],
];

/** `scenario` is the one-line "when does a person need this" that each prototype exists to answer. */
function reviewBar(title, note, current, scenario = "") {
	const links = REVIEW_LINKS.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ""}>${label}</a>`).join("");
	return `<header class="review-bar">
		<div><strong>Dazzi <span>${title}</span></strong><p>${note}</p></div>
		<div class="review-actions">${links}<button id="theme-toggle" class="btn" type="button">다크 모드</button></div>
	</header>${scenario ? `<div class="scenario-line"><span class="badge accent">언제</span><span>${scenario}</span></div>` : ""}`;
}
