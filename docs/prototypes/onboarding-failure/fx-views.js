/* Views for the #283 prototype: each returns an HTML string from the state `S` (fx-main.js).
 *
 * The pause screen is deliberately small: icon, title, one reason line, one button, up to two quiet
 * links. No card, no strip, no raw text. */
"use strict";

/* The scenario as it is right now: a fix (embedding or folder) changes what is kept and what is left. */
function cur() {
	const sc = SC[S.sc];
	return { ...sc, embed: S.fixed?.embed ?? sc.embed, total: S.fixed?.total ?? TOTAL };
}

function phaseStrip(embed, mode, activeIdx) {
	return PHASES[embed]
		.map(([id, label], i) => {
			const done = mode === "done" || i < activeIdx;
			const active = mode === "run" && i === activeIdx;
			return `<span class="ix-phase ${done ? "done" : ""} ${active ? "active" : ""}"><i></i>${label}</span>`;
		})
		.join("");
}

function statusPill(icon, strong, small, spin = false) {
	return `${ic(icon, 16, spin ? "spin" : "")}<span><strong>${esc(strong)}</strong><small>${esc(small)}</small></span>`;
}

function tipCard() {
	return `<div class="ix-tip"><div class="ix-tip-art"><div class="keys"><span class="keycap">⌘</span><span class="keycap">K</span></div></div><div class="ix-tip-copy"><div class="ix-tip-head">${ic("sparkles", 12)} 꿀팁 <em>1 / 9</em></div><h3>⌘K 한 번이면 바로 질문</h3><p>어느 화면에서든 AI Search 입력창으로 이동합니다. 폴더를 열지 않고 문서 내용을 묻고, 근거와 함께 답을 받으세요.</p></div><div class="ix-timer"><span></span></div></div>`;
}

const gateWait = `<div class="ix-notice">${ic("triangle-alert", 18)}<span><strong>Dazzi를 종료하거나 Mac을 끄지 마세요</strong><small>첫 인덱싱은 오래 걸립니다. 종료하면 진행이 멈춰요. 전원 어댑터를 연결하고 덮개를 열어 두세요.</small></span></div><button class="ix-open-btn" disabled>${ic("lock", 13)} 완료되면 열 수 있어요</button>`;

/* ------------------------------------------------------------------ running */
function runningView() {
	const r = S.run;
	const c = cur();
	const p = r ? r.p : SC.running.progress;
	const embed = r ? r.embed : "local";
	const phase = phaseAt(p, embed);
	const idx = PHASES[embed].findIndex(([id]) => id === phase);
	const left = Math.max(1, Math.ceil((eta(embed) * (100 - p)) / 100));
	const resumed = r?.resumed;
	const read = Math.min(c.total, Math.round(c.total * Math.min(1, p / (embed === "none" ? 90 : 50))));
	const dlPct = r?.dl ?? null;
	const pill =
		dlPct !== null
			? statusPill("loader-circle", "임베딩 모델을 내려받는 중", "받기가 끝나면 첫 색인이 자동으로 시작됩니다.", true)
			: statusPill("loader-circle", `${resumed ? "이어서 " : ""}${PHASE_LABEL[phase]}…`, phase === "minsync" ? "벡터 인덱스 만드는 중" : phase === "finalizing" ? "검색 인덱스 최적화" : RECENT[Math.floor(p) % RECENT.length].join(" · "), true);
	const meta =
		dlPct !== null
			? `<b>${Math.floor(dlPct)}%</b><span>·</span><span>${formatSize((MODEL_BYTES * dlPct) / 100)} / ${formatSize(MODEL_BYTES)}</span>${resumed ? `<span>·</span><span class="ix-kept">${ic("circle-check", 11)} 받은 부분 이어받기</span>` : ""}`
			: `<b>${Math.floor(p)}%</b><span>·</span><span>${left <= 1 ? "1분 미만 남음" : `약 ${left}분 남음`}</span><span>·</span><span>${fmt(read)} / ${fmt(c.total)}개 파일</span>${resumed && S.keptNote ? `<span>·</span><span class="ix-kept">${ic("circle-check", 11)} ${S.keptNote}</span>` : ""}`;
	return `
		<div class="ix-status" role="status">${pill}</div>
		<h1 class="ix-title">${resumed ? "멈춘 곳부터 이어서 하고 있어요" : "Dazzi가 파일을 읽고 있어요"}</h1>
		<div class="ix-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(dlPct ?? p)}"><span style="width:${dlPct ?? p}%"></span></div>
		<div class="ix-meta">${meta}</div>
		<div class="ix-phases">${phaseStrip(embed, "run", idx)}</div>
		<div class="ix-gate">${gateWait}</div>
		${tipCard()}
		<button type="button" class="ix-bg-start" data-act="bg">백그라운드에서 계속하고 바로 시작하기</button>`;
}

/* ------------------------------------------------------------------- paused */
/* The one reason line. It is also where the live countdown / repeat message goes. */
function subText(sc) {
	if (S.repeat > 0) return ["같은 이유로 또 멈췄어요", true];
	const a = sc.auto;
	if (a && S.healed) return ["연결됐어요 · 이어서 해요", false];
	if (a?.kind === "net") {
		if (S.attempt > a.attempts) return ["자동 재시도를 멈췄어요 · 직접 다시 시도해 주세요", false];
		return [`${S.countdown}초 뒤 자동으로 다시 시도해요`, false];
	}
	return [sc.sub, false];
}

/* First entry is the button; the rest are quiet links. A repeated stop moves the button off "retry". */
function orderedExits(sc) {
	let main = sc.primary;
	if (S.repeat > 0) {
		const other = sc.exits.find((e) => e.id !== "retry");
		if (other) main = other.id;
	}
	const first = sc.exits.find((e) => e.id === main) ?? sc.exits[0];
	return [first, ...sc.exits.filter((e) => e !== first)];
}

function pausedView() {
	const sc = SC[S.sc];
	const [first, ...links] = orderedExits(sc);
	const [sub, again] = subText(sc);
	const p = sc.progress;
	return `
		<span class="ix-hero">${ic(sc.icon, 26)}</span>
		<h1 class="ix-title">${esc(sc.title)}</h1>
		<p class="ix-sub ${again ? "again" : ""} ${S.pulse ? "pulse" : ""}" role="status" aria-live="polite">${esc(sub)}</p>
		${p > 0 ? `<div class="ix-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}"><span style="width:${p}%"></span><i class="ix-stop" style="left:${p}%"></i></div>` : ""}
		<button type="button" class="ix-cta" data-act="exit" data-id="${first.id}">${esc(first.t)} <span class="kbd">↵</span></button>
		<div class="ix-links">${links.map((l) => `<button type="button" data-act="exit" data-id="${l.id}">${esc(l.t)}</button>`).join("")}</div>`;
}

/* --------------------------------------------------------------------- done */
function doneView() {
	const sc = SC[S.sc];
	const partial = S.sc === "partial";
	const skippedN = partial ? sc.skipped.reduce((a, s) => a + s.n, 0) : 0;
	const read = TOTAL - skippedN;
	const pill = statusPill("circle-check", "인덱싱 완료", `${fmt(read)}개 파일 · 데이터 소스 3개`);
	const skip = partial
		? `<div class="ix-skipline"><span class="ix-skippill">${ic("triangle-alert", 13)} ${skippedN}개 파일은 건너뛰었어요</span></div>`
		: "";
	return `
		<div class="ix-status" role="status">${pill}</div>
		<h1 class="ix-title">모든 준비가 끝났어요</h1>
		<div class="ix-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"><span style="width:100%"></span></div>
		<div class="ix-meta"><b>100%</b><span>·</span><span>총 ${partial ? 151 : 148}분</span><span>·</span><span>${fmt(read)}개 파일</span></div>
		<div class="ix-phases">${phaseStrip("local", "done", 3)}</div>
		<div class="ix-gate"><div class="ix-notice ok">${ic("circle-check", 18)}<span><strong>이제 종료해도 괜찮아요</strong><small>${partial ? "나머지는 모두 검색할 수 있어요. 새로 바뀐 파일은 백그라운드에서 이어서 읽습니다." : `${fmt(read)}개 파일을 모두 읽었어요. 새로 바뀐 파일은 백그라운드에서 이어서 읽습니다.`}</small></span></div><button class="ix-open-btn" data-act="finish">Dazzi 열기 <span class="kbd">↵</span></button></div>
		${partial ? skip : tipCard()}`;
}

/* ------------------------------------------------- embedding re-choice step */
const meter = ([label, fill, text, tone]) =>
	`<div class="em-meter ${tone}" aria-label="${label}: ${text}"><span class="em-m-label">${label}</span><span class="em-pips" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i class="${i <= fill ? "on" : ""}"></i>`).join("")}</span><b>${text}</b></div>`;

function embedOptions() {
	return [
		{ id: "none", icon: "search", name: "사용 안 함", line: "키워드 검색만", meters: [["필요 성능", 1, "낮음", "good"], ["정확도", 2, "아쉬움", "warn"]], foot: `약 <b>${eta("none")}분</b>` },
		{ id: "local", icon: "cpu", name: "로컬 임베딩", line: "이 Mac에서 처리", meters: [["필요 성능", 4, "높음", "warn"], ["정확도", 4, "좋음", "good"]], foot: `약 <b>${eta("local")}분</b><span>·</span>0.6 GB` },
		{ id: "cloud", icon: "cloud", name: "원격 임베딩", tag: ["Pro", "warn"], line: "서버에서 처리", meters: [["필요 성능", 1, "낮음", "good"], ["정확도", 4, "좋음", "good"]], foot: `약 <b>${eta("cloud")}분</b>` },
	];
}

function embedCard(o) {
	const sc = SC[S.sc];
	const blocked = sc.blocked?.[o.id];
	const sel = S.pick === o.id && !blocked;
	const tag = blocked ? [blocked, "bad"] : sc.cur === o.id ? ["방금 멈춤", "warn"] : o.tag;
	return `<div class="em-card ${sel ? "selected" : ""} ${blocked ? "disabled" : ""}" role="radio" aria-checked="${sel}" aria-disabled="${!!blocked}" data-act="pick" data-id="${o.id}"><span class="em-radio"></span><div class="embed-icon">${ic(o.icon, 19)}</div><div class="em-title"><h3>${o.name}</h3>${tag ? `<span class="em-tag ${tag[1]}">${tag[0]}</span>` : ""}</div><p class="em-line">${o.line}</p><div class="em-meters">${o.meters.map(meter).join("")}</div><div class="em-foot">${o.foot}</div></div>`;
}

function stepView() {
	const sc = SC[S.sc];
	return `<section class="screen center em-screen"><div class="screen-copy"><span class="eyebrow">${ic("search", 12)} 의미 검색</span><h1>임베딩을 어떻게 쓸까요?</h1></div>
		<div class="plan-callout warn">${ic("triangle-alert", 14)}<span><b>${esc(sc.step.t)}</b></span></div>
		<div class="em-cards" role="radiogroup" aria-label="임베딩 방식">${embedOptions().map(embedCard).join("")}</div></section>`;
}

function stepFooter() {
	const ok = S.pick && !SC[S.sc].blocked?.[S.pick];
	return `<button type="button" class="back-btn" data-act="stepBack" aria-label="인덱싱 화면으로 돌아가기">${ic("chevron-left", 15)}</button>
		<div class="progress-dashes">${Array.from({ length: 8 }, (_, i) => `<span class="dash ${i < 7 ? "done" : "active"}"></span>`).join("")}</div>
		<button type="button" class="primary" data-act="stepGo" ${ok ? "" : "disabled"}>이어서 시작 <span class="kbd">↵</span></button>`;
}

/* --------------------------------------------------------------- in-app mock */
function sidebar() {
	const a = SC[S.sc].app;
	let block = "";
	if (S.appFlow === "fail") {
		block = `<button type="button" class="a-activity" data-tone="error" data-act="appSettings" title="인덱싱 상태 보기"><span class="row"><span>${esc(a.side)}</span></span><div class="a-bar error"><span style="width:100%"></span></div><span class="detail">${esc(a.sideD)}</span></button>`;
	} else if (S.appFlow === "run") {
		block = `<button type="button" class="a-activity" data-tone="run" data-act="appSettings"><span class="row"><span>인덱싱 중</span><span class="pct">${Math.floor(S.appP)}%</span></span><div class="a-bar"><span style="width:${S.appP}%"></span></div><span class="detail">임베딩 · 이어서 하는 중</span></button>`;
	} else if (S.appFlow === "ok") {
		block = `<button type="button" class="a-activity" data-tone="ok" data-act="appSettings"><span class="row"><span>인덱싱 완료</span></span><div class="a-bar ok"><span style="width:100%"></span></div></button>`;
	}
	const item = (icon, label, on = false, act = "") => `<button class="a-item ${on ? "on" : ""}" type="button" ${act ? `data-act="${act}"` : ""}>${ic(icon, 15)}<span>${label}</span></button>`;
	return `<aside class="a-side"><div class="a-side-head"><span class="a-traffic"><i></i><i></i><i></i></span></div><div class="a-scroll"><div><div class="a-label">즐겨찾기</div>${item("sparkles", "AI Search")}${item("zap", "자동화")}${item("clock", "최근 항목")}</div><div><div class="a-label">위치</div>${item("house", "홈")}${item("folder", "Documents", S.appView === "files", "appFiles")}${item("download", "Downloads")}${item("monitor", "Desktop")}</div></div><div class="a-foot">${block}${item("settings", "설정", S.appView === "settings", "appSettings")}</div></aside>`;
}

function appBanner() {
	const a = SC[S.sc].app;
	if (S.appFlow === "gone") return "";
	if (S.appFlow === "run") return `<div class="a-banner run">${ic("loader-circle", 18, "spin")}<div class="copy"><strong>의미 검색을 준비하는 중이에요</strong><div class="a-bar"><span style="width:${S.appP}%"></span></div></div></div>`;
	if (S.appFlow === "ok") return `<div class="a-banner ok">${ic("circle-check", 18)}<div class="copy"><strong>의미 검색이 준비됐어요</strong></div></div>`;
	const btn = a.fix ? `<button class="a-btn accent" type="button" data-act="appFix">${esc(a.fix)}</button>` : `<button class="a-btn accent" type="button" data-act="appRetry">${esc(a.retry)}</button>`;
	return `<div class="a-banner" role="alert">${ic("triangle-alert", 18)}<div class="copy"><strong>${esc(a.t)}</strong></div>${btn}</div>`;
}

function filesView() {
	const a = SC[S.sc].app;
	if (a.empty && S.appFlow !== "ok") {
		return `<div class="a-empty">${ic("folder-x", 28)}<strong>아직 검색할 문서가 없어요</strong><span>폴더를 읽을 수 있게 되면 자동으로 채워져요</span></div>`;
	}
	const rows = [["2026 사업계획서.docx", "오늘 14:02", "Word 문서", "2.4 MB"], ["회의록 10월.md", "오늘 11:20", "Markdown", "14 KB"], ["budget.xlsx", "어제", "Excel 문서", "880 KB"], ["proposal-final.docx", "10월 21일", "Word 문서", "1.1 MB"], ["독서 메모.md", "10월 19일", "Markdown", "6 KB"], ["계약서 초안.hwp", "10월 18일", "한글 문서", "320 KB"]];
	return `<div class="a-list"><div class="a-head"><span>이름</span><span>수정일</span><span>종류</span><span>크기</span></div>${rows.map(([n, d, k, s]) => `<div class="a-row"><span class="nm">${ic("file-text", 14)}${n}</span><span class="mut">${d}</span><span class="mut">${k}</span><span class="mut">${s}</span></div>`).join("")}</div>`;
}

function settingsView() {
	const sc = SC[S.sc];
	const a = sc.app;
	const bad = S.appFlow === "fail";
	const run = S.appFlow === "run";
	const partial = S.sc === "partial";
	const headline = run ? "인덱싱 중" : bad ? "인덱싱 멈춤" : "인덱싱 완료";
	const tone = run ? "run" : bad ? "error" : "ok";
	const items = partial
		? [["ok", "로컬 폴더", "스캔 12,480 · 기록 12,458 · 삭제 0 · 건너뜀 22", ""], ["warn", "건너뛴 파일 22개", "다음 새로 고침에서 자동으로 다시 시도해요", "지금 다시 시도"]]
		: [["ok", "로컬 폴더", `문서 ${fmt(S.sc === "folder" ? 0 : TOTAL)}개 읽음`, ""], [run ? "run" : bad ? "warn" : "ok", "임베딩", run ? "이어서 하는 중" : bad ? `<b>${esc(a.item)}</b> · ${esc(sc.bad?.d ?? "")}` : "완료", ""]];
	const opts = [["none", "사용 안 함", "키워드 검색만"], ["local", "로컬 임베딩", "이 Mac에서 처리"], ["cloud", "원격 임베딩", "서버에서 처리 · Pro"]];
	return `<div class="a-settings"><h4>설정 · 인덱싱</h4>
		<div class="a-card"><div class="a-card-head"><strong>${headline}</strong>${run ? `<span>${Math.floor(S.appP)}%</span>` : ""}</div><div class="a-bar ${tone === "error" ? "error" : tone === "ok" ? "ok" : ""}"><span style="width:${run ? S.appP : 100}%"></span></div>
		<ul class="a-items">${items.map(([t, name, m, btn]) => `<li><span class="a-dot ${t}"></span><span class="t">${name}</span><span class="m">${m}</span>${btn ? `<button class="a-btn" type="button" data-act="appRetry">${btn}</button>` : ""}</li>`).join("")}</ul>
		${bad && !partial ? `<div class="a-actions">${a.fix ? `<button class="a-btn accent" type="button" data-act="appPick">${esc(a.fix)}</button>` : ""}<button class="a-btn ${a.fix ? "" : "accent"}" type="button" data-act="appRetry">${esc(a.retry)}</button></div>` : ""}</div>
		${S.appPickOpen ? `<div class="a-card"><div class="a-card-head"><strong>임베딩 방식</strong></div><div class="a-opts">${opts.map(([id, n, d]) => `<button type="button" class="a-opt ${S.pick === id ? "on" : ""} ${sc.blocked?.[id] ? "off" : ""}" data-act="appChoose" data-id="${id}"><span class="a-radio"></span><span><b>${n}</b><small>${sc.blocked?.[id] ?? d}</small></span></button>`).join("")}</div><div class="a-actions"><button class="a-btn accent" type="button" data-act="appApply" ${S.pick && !sc.blocked?.[S.pick] ? "" : "disabled"}>적용하고 이어서 하기</button></div></div>` : ""}</div>`;
}

function appView() {
	const title = S.appView === "settings" ? "설정" : "Documents";
	return `${sidebar()}<main class="a-main"><div class="a-toolbar">${ic("chevron-left", 16)}${ic("chevron-right", 16)}<h4>${title}</h4><span class="sp"></span>${ic("search", 16)}</div>${S.appView === "files" ? appBanner() : ""}${S.appView === "files" ? filesView() : settingsView()}</main>`;
}
