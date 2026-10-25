/* State machine, events, and review bar for the #283 prototype.
 *
 * The flow it demonstrates:
 *   run ──stop──▶ paused ──retry/fix──▶ run (resumed) ──▶ done
 *                   │  └─ same reason again ─▶ paused (the main exit switches away from "retry")
 *                   └─ "open Dazzi" ─▶ app (the same problem stays visible there and is fixable there)
 * "해결됨" in the review bar stands for the real world getting fixed (credit topped up, network back,
 * drive plugged in, disk space freed); an embedding change fixes the problem by itself. */
"use strict";

const S = {
	sc: "running", theme: "light", mode: "onb", view: "run", run: null, fixed: null, keptNote: "",
	repeat: 0, pulse: false, countdown: 0, healed: false, attempt: 1, pick: null,
	appFlow: "gone", appP: 50, appView: "files", appPickOpen: false, notes: false,
};
const $ = (id) => document.getElementById(id);
const timers = { run: null, sec: null, app: null, toast: null, atoast: null };

/* ------------------------------------------------------------------ decor */
function ixDecor() {
	const ys = [-60, 40, 130, 220, 300, 380, 470, 560, 660];
	const paths = ys
		.map((y, i) => {
			const mid = 300 + (y - 300) * 0.35;
			const end = 300 + (y - 300) * 0.12;
			return `<path style="animation-delay:-${i * 0.37}s" d="M-20 ${y} C 260 ${y}, 300 ${mid}, 455 ${end}"/><path style="animation-delay:-${i * 0.29}s" d="M1020 ${y} C 740 ${y}, 700 ${mid}, 545 ${end}"/>`;
		})
		.join("");
	const floats = IX_FLOATS.map((f, i) => {
		const st = `left:${f.x}%;top:${f.y}%;--d:-${i * 0.9}s;--t:${6 + (i % 4)}s${f.r ? `;--r:${f.r}deg` : ""}${f.o ? `;--o:${f.o}` : ""}${f.s ? `;--s:${f.s}px` : ""}`;
		if (f.kind === "file") return `<span class="ix-float file" style="${st};--c:${f.color}" aria-hidden="true">${f.text}</span>`;
		if (f.kind === "brand") return `<span class="ix-float brand" style="${st};${brandVars(f.brand)}" aria-hidden="true">${brandMark(f.brand, 20)}</span>`;
		return `<span class="ix-float ghost" style="${st}" aria-hidden="true">${ic(f.icon, 18)}</span>`;
	}).join("");
	return `<svg class="ix-lines" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">${paths}</svg>${floats}`;
}

/* --------------------------------------------------------------- rendering */
function swapFrom(html, sels) {
	const t = document.createElement("template");
	t.innerHTML = html;
	for (const s of sels) {
		const live = $("ixDyn")?.querySelector(s);
		const next = t.content.querySelector(s);
		if (live && next) live.innerHTML = next.innerHTML;
	}
}

function updateRunning() {
	const html = runningView();
	swapFrom(html, [".ix-status", ".ix-title", ".ix-meta", ".ix-phases"]);
	const r = S.run;
	const bar = $("ixDyn")?.querySelector(".ix-bar");
	if (bar && r) {
		const v = r.dl ?? r.p;
		bar.setAttribute("aria-valuenow", String(Math.floor(v)));
		const span = bar.querySelector("span");
		if (span) span.style.width = `${v}%`;
	}
}

function updateAuto() {
	swapFrom(pausedView(), [".ix-sub"]);
}

function renderOnb() {
	const onb = $("onb");
	const stage = $("stage");
	const step = S.mode === "step";
	onb.classList.toggle("immersive", !step);
	$("winTitle").textContent = "Dazzi powered by AutoRAG";
	if (step) {
		stage.innerHTML = stepView();
		$("footer").innerHTML = stepFooter();
		return;
	}
	$("footer").innerHTML = "";
	if (!$("ix")) {
		stage.innerHTML = `<section class="ix" id="ix">${ixDecor()}<div id="ixDyn" class="ix-dyn"></div></section>`;
	}
	$("ix").className = `ix ${S.view === "done" ? "done" : ""} ${S.view === "paused" ? "paused" : ""}`;
	$("ixDyn").innerHTML = S.view === "run" ? runningView() : S.view === "paused" ? pausedView() : doneView();
}

function renderApp() {
	const win = $("appWin");
	if (!$("appBody")) win.innerHTML = `<div id="appBody" style="display:contents"></div><div class="a-toast" id="aToast"></div>`;
	$("appBody").innerHTML = appView();
}

/* The in-app window is the app's real minimum size (1360px); scale it down on narrower screens. */
function fitApp() {
	const win = $("appWin");
	const scale = Math.min(1, (window.innerWidth - 48) / 1360);
	win.style.zoom = scale < 1 ? String(scale) : "";
}
window.addEventListener("resize", fitApp);

function render() {
	document.documentElement.dataset.appearance = S.theme;
	const isApp = S.mode === "app";
	$("onbFrame").hidden = isApp;
	$("appWin").hidden = !isApp;
	if (isApp) renderApp();
	else renderOnb();
	renderBar();
	renderNotes();
}

function renderBar() {
	const groups = ["기준", "멈춤", "끝남"];
	const btn = (id) => {
		const g = SC[id];
		return `<button class="rbtn ${S.sc === id ? "is-on" : ""}" type="button" data-act="scenario" data-id="${id}"><span class="pip ${g.pip}"></span>${g.label}</button>`;
	};
	const sc = SC[S.sc];
	const healable = sc.phase === "paused";
	$("reviewBar").innerHTML = `
		<div class="review-title"><strong>Dazzi 첫 인덱싱 실패 시안 · #283</strong>멈춤은 같은 화면의 한 상태예요. 버튼을 눌러 보세요</div>
		<nav class="review-actions" aria-label="시안 조작">
			${groups.map((g) => `<span class="review-label">${g}</span>${ORDER.filter((id) => SC[id].group === g).map(btn).join("")}<span class="review-gap"></span>`).join("")}
			<button class="rbtn ${S.mode === "app" ? "is-on" : ""}" type="button" data-act="mode" data-id="${S.mode === "app" ? "onb" : "app"}">${S.mode === "app" ? "온보딩 화면 보기" : "앱 안 보기"}</button>
			${healable ? `<button class="rbtn ${S.healed ? "is-on" : ""}" type="button" data-act="heal">${S.healed ? "✓ " : ""}${esc(sc.recover)}</button>` : ""}
			<span class="review-gap"></span>
			<button class="rbtn" type="button" data-act="theme">${S.theme === "dark" ? "라이트 모드" : "다크 모드"}</button>
			<button class="rbtn" type="button" data-act="reset">처음 상태로</button>
			<button class="rbtn ${S.notes ? "is-on" : ""}" type="button" data-act="notes">해설</button>
		</nav>`;
}

function renderNotes() {
	const el = $("notes");
	el.hidden = !S.notes;
	if (S.notes && !el.dataset.ready) {
		el.innerHTML = notesHtml();
		el.dataset.ready = "1";
	}
}

function toast(text) {
	const el = S.mode === "app" ? $("aToast") : $("onbToast");
	if (!el) return;
	el.textContent = text;
	el.classList.add("show");
	clearTimeout(timers.toast);
	timers.toast = setTimeout(() => el.classList.remove("show"), 2600);
}

/* -------------------------------------------------------------- run engine */
function stopTimers() {
	clearInterval(timers.run);
	clearInterval(timers.sec);
	clearInterval(timers.app);
}

function startRun(r) {
	clearInterval(timers.run);
	clearInterval(timers.sec);
	S.run = r;
	S.view = "run";
	timers.run = setInterval(tickRun, 120);
}

function tickRun() {
	const r = S.run;
	if (!r) return;
	if (r.failAt !== undefined && Date.now() >= r.failAt) return stopAgain();
	if (r.dl != null) {
		r.dl = Math.min(100, r.dl + 3);
		if (r.dl >= 100) r.dl = null;
	} else {
		r.p = Math.min(100, r.p + 1.6);
	}
	if (r.dl == null && r.p >= 100) return completeRun();
	updateRunning();
}

function completeRun() {
	clearInterval(timers.run);
	S.run = null;
	S.view = "done";
	render();
}

function stopAgain() {
	clearInterval(timers.run);
	S.run = null;
	S.view = "paused";
	S.repeat += 1;
	S.pulse = true;
	armAuto();
	render();
	setTimeout(() => (S.pulse = false), 500);
}

/* One retry = resume from what is kept. Embedding changes and healed problems both finish; otherwise it stops again. */
function retry() {
	const sc = SC[S.sc];
	const embed = S.fixed?.embed ?? sc.embed;
	let r;
	if (sc.dl && !S.fixed?.embed) r = { dl: sc.progress, p: 0, embed, resumed: true };
	else if (sc.progress > 0) {
		const p = embed === "none" ? 90 : S.fixed?.embed ? 50 : sc.progress;
		r = { p, embed, resumed: true };
		S.keptNote = S.fixed?.embed ? `문서 ${fmt(TOTAL)}개 읽기 보존` : `임베딩 ${fmt(EMBEDDED)}개 보존`;
	} else r = { p: 0, embed, resumed: false };
	const ok = S.healed || S.fixed !== null;
	if (!ok) r.failAt = Date.now() + 1600;
	startRun(r);
	render();
}

function armAuto() {
	clearInterval(timers.sec);
	const a = SC[S.sc].auto;
	if (!a || S.view !== "paused") return;
	S.countdown = a.every;
	timers.sec = setInterval(() => {
		S.countdown -= 1;
		if (S.countdown <= 0) {
			S.attempt += 1;
			S.countdown = a.every;
			if (a.kind === "net" && S.attempt > a.attempts) clearInterval(timers.sec);
		}
		updateAuto();
	}, 1000);
}

function setHealed(v) {
	S.healed = v;
	const a = SC[S.sc].auto;
	if (S.view === "paused" && a) {
		if (v) {
			clearInterval(timers.sec);
			updateAuto();
			setTimeout(() => S.healed && S.view === "paused" && retry(), 1300);
		} else armAuto();
	}
	renderBar();
}

/* ------------------------------------------------------------------ actions */
function reset(id) {
	stopTimers();
	const sc = SC[id];
	Object.assign(S, {
		sc: id, mode: "onb", run: null, fixed: null, keptNote: "", repeat: 0, pulse: false, healed: false,
		pick: sc.suggest ?? null, attempt: 1, countdown: sc.auto?.every ?? 0, appFlow: "gone", appView: "files", appPickOpen: false,
	});
	if (id === "running") startRun({ p: 41, embed: "local" });
	else if (sc.phase === "done") S.view = "done";
	else {
		S.view = "paused";
		armAuto();
	}
	render();
}

function toApp(flow, p = 50) {
	stopTimers();
	S.mode = "app";
	S.appFlow = flow;
	S.appP = p;
	S.appView = "files";
	S.appPickOpen = false;
	if (flow === "run") runApp();
	render();
}

function runApp() {
	clearInterval(timers.app);
	S.appFlow = "run";
	timers.app = setInterval(() => {
		S.appP = Math.min(100, S.appP + 1.2);
		if (S.appP >= 100) {
			clearInterval(timers.app);
			S.appFlow = "ok";
			render();
			setTimeout(() => {
				if (S.appFlow === "ok") {
					S.appFlow = "gone";
					render();
				}
			}, 4000);
			return;
		}
		render();
	}, 150);
}

function exitAction(id) {
	const sc = SC[S.sc];
	const e = sc.exits.find((x) => x.id === id);
	if (id === "retry") return retry();
	if (id === "open") return toApp("fail");
	if (id === "fix" && e?.target === "embedding") {
		S.mode = "step";
		S.pick = sc.suggest ?? null;
		return render();
	}
	if (id === "fix") {
		S.fixed = { total: 9760 };
		toast("‘Projects’를 제외했어요 · 9,760개로 시작해요");
		return retry();
	}
}

document.addEventListener("click", (ev) => {
	const el = ev.target.closest("[data-act]");
	if (!el) return;
	const act = el.dataset.act;
	const id = el.dataset.id;
	switch (act) {
		case "scenario": return reset(id);
		case "mode": return id === "app" ? toApp(SC[S.sc].phase === "paused" ? "fail" : S.sc === "partial" ? "fail" : "gone") : (S.mode = "onb", render());
		case "theme": S.theme = S.theme === "dark" ? "light" : "dark"; return render();
		case "reset": return reset("running");
		case "notes": S.notes = !S.notes; return render();
		case "heal": return setHealed(!S.healed);
		case "exit": return exitAction(id);
		case "bg": return toApp("run", S.run?.p ?? 50);
		case "finish": return toApp(S.sc === "partial" ? "fail" : "gone");
		case "pick": if (!SC[S.sc].blocked?.[id]) { S.pick = id; renderOnb(); } return;
		case "stepBack": S.mode = "onb"; return render();
		case "stepGo": S.fixed = { embed: S.pick }; S.mode = "onb"; return retry();
		case "appSettings": S.appView = "settings"; return render();
		case "appFiles": S.appView = "files"; return render();
		case "appFix":
		case "appPick": S.appView = "settings"; S.appPickOpen = true; S.pick = SC[S.sc].suggest ?? null; return render();
		case "appChoose": if (!SC[S.sc].blocked?.[id]) { S.pick = id; render(); } return;
		case "appApply": S.fixed = { embed: S.pick }; S.appPickOpen = false; S.appP = S.pick === "none" ? 90 : 50; runApp(); return render();
		case "appRetry":
			if (!S.healed) return toast("아직 같은 문제예요 · 해결한 뒤 다시 눌러 주세요 (위 ‘해결’ 버튼)");
			S.appP = SC[S.sc].progress || 50; runApp(); return render();
	}
});

document.addEventListener("keydown", (ev) => {
	if (ev.key !== "Enter" || ev.target.closest("button, details, input")) return;
	if (S.mode === "step") return $("footer").querySelector(".primary:not(:disabled)")?.click();
	if (S.mode !== "onb") return;
	if (S.view === "paused") return document.querySelector(".ix-cta")?.click();
	if (S.view === "done") return document.querySelector(".ix-open-btn")?.click();
});

reset("running");
