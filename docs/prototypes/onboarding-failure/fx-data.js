/* Data and helpers for the #283 first-index failure prototype.
 *
 * A pause shows only: icon, one title, one reason line, one button, up to two quiet links.
 * Nothing else is on screen: no card, no strip, no raw text. The reason and code stay in the app log.
 *
 * Counts, sizes, and the HTTP 402 detail are illustrative. The diagnostic codes are the ones the app
 * already emits (src/main/index-refresh.ts). */
"use strict";

const TOTAL = 12480;
const EMBEDDED = 4120;
const MODEL_BYTES = 727 + 11_423_705 + 1_191_586_416; // model-download.ts: Qwen3-Embedding-0.6B
const PER_MIN = { none: 450, local: 85, cloud: 900 }; // onboarding-contract.ts

const fmt = (n) => Math.round(n).toLocaleString("ko-KR");
const esc = (v) =>
	String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const ic = (slug, size = 14, cls = "") =>
	`<svg class="icon ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE[slug] ?? ""}</svg>`;
const brandMark = (name, size = 20) => `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${BRAND[name].mark}</svg>`;
const brandVars = (name) => `--brand:${BRAND[name].color};--lift:${BRAND[name].lift ?? BRAND[name].color}`;
const formatSize = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const eta = (embed) => Math.ceil(TOTAL / PER_MIN[embed]);

const PHASES = {
	local: [["parsed", "문서 읽기"], ["minsync", "임베딩"], ["finalizing", "정리"]],
	cloud: [["parsed", "문서 읽기"], ["minsync", "임베딩"], ["finalizing", "정리"]],
	none: [["parsed", "문서 읽기"], ["finalizing", "정리"]],
};
const PHASE_LABEL = { parsed: "문서 읽는 중", minsync: "임베딩 중", finalizing: "정리 중" };
const phaseAt = (p, embed) => (embed === "none" ? (p < 90 ? "parsed" : "finalizing") : p < 50 ? "parsed" : p < 95 ? "minsync" : "finalizing");

const RECENT = [
	["Documents", "2026 사업계획서.docx"], ["Notes", "회의록 10월.md"], ["Documents", "budget.xlsx"],
	["Desktop", "proposal-final.docx"], ["Notes", "독서 메모.md"], ["Documents", "계약서 초안.hwp"],
];

const IX_FLOATS = [
	{ x: 6, y: 15, kind: "ghost", icon: "scan-eye" },
	{ x: 24, y: 10, kind: "file", text: "MD", color: "#5b5b61", o: 0.5, s: 34 },
	{ x: 15, y: 38, kind: "file", text: "HWP", color: "#2b7de9", r: -7, o: 0.85 },
	{ x: 3, y: 58, kind: "ghost", icon: "folder", o: 0.8 },
	{ x: 11, y: 80, kind: "ghost", icon: "image", o: 0.7 },
	{ x: 22, y: 93, kind: "file", text: "DOC", color: "#2f5fd0", r: -9, o: 0.55, s: 36 },
	{ x: 76, y: 9, kind: "ghost", icon: "mail", o: 0.55, s: 36 },
	{ x: 94, y: 13, kind: "file", text: "PDF", color: "#e5533d", r: 9 },
	{ x: 99, y: 33, kind: "brand", brand: "slack", o: 0.8 },
	{ x: 86, y: 46, kind: "brand", brand: "obsidian" },
	{ x: 90, y: 72, kind: "file", text: "XLS", color: "#1f9d55", r: 10 },
	{ x: 77, y: 90, kind: "ghost", icon: "file-text", o: 0.6 },
	{ x: 97, y: 91, kind: "brand", brand: "github", o: 0.75, s: 38 },
];

const KINDS = {
	config: ["설정 확인 필요", "config"],
	transient: ["일시 오류", "transient"],
	environment: ["환경 문제", "environment"],
	unknown: ["원인 미확인", "unknown"],
};

const OPEN = { id: "open", t: "일단 Dazzi 열기" };
const diskFree = 0.2;

const SC = {
	running: { id: "running", group: "기준", label: "진행 중", pip: "run", phase: "run", progress: 41, embed: "local" },
	done: { id: "done", group: "기준", label: "성공", pip: "ok", phase: "done", progress: 100, embed: "local" },

	config: {
		id: "config", group: "멈춤", label: "설정 오류", pip: "warn", phase: "paused", kind: "config", embed: "cloud",
		progress: 0, stopAt: null, cur: "cloud", suggest: "local", blocked: { cloud: "크레딧 소진" },
		icon: "cloud", title: "원격 임베딩을 쓸 수 없어요", sub: "크레딧이 부족해요",
		bad: { t: "원격 임베딩이 요청을 거절했어요", d: "HTTP 402 · 크레딧 부족" },
		exits: [{ id: "fix", t: "임베딩 방식 바꾸기", target: "embedding" }, { id: "retry", t: "충전했어요, 다시 시도" }, OPEN],
		primary: "fix", recover: "크레딧 충전하기",
		step: { t: "원격 임베딩을 쓸 수 없어서 멈췄어요" },
		app: { t: "의미 검색을 쓸 수 없어요", fix: "임베딩 방식 바꾸기", retry: "다시 시도", side: "의미 검색 준비 중단", sideD: "임베딩 · 크레딧 소진", item: "임베딩이 멈췄어요" },
	},

	transient: {
		id: "transient", group: "멈춤", label: "일시 오류", pip: "warn", phase: "paused", kind: "transient", embed: "cloud",
		progress: 64, stopAt: "minsync", cur: "cloud",
		icon: "wifi-off", title: "연결이 끊겼어요", sub: "연결되면 자동으로 이어서 해요",
		bad: { t: "원격 임베딩 서버에 닿지 않아요", d: "api.dazziapp.com · 네트워크 시간 초과" },
		exits: [{ id: "retry", t: "지금 다시 시도" }, OPEN],
		primary: "retry", recover: "연결 복구하기", auto: { kind: "net", attempts: 6, every: 8 },
		app: { t: "연결을 기다리는 중이에요", fix: null, retry: "지금 다시 시도", side: "연결 기다리는 중", sideD: "임베딩 · 자동 재시도", item: "연결을 기다리는 중" },
	},

	folder: {
		id: "folder", group: "멈춤", label: "환경 · 폴더", pip: "warn", phase: "paused", kind: "environment", embed: "local",
		progress: 0, stopAt: null,
		icon: "folder-x", title: "‘Projects’ 폴더를 읽을 수 없어요", sub: "드라이브를 연결하면 자동으로 이어져요",
		bad: { t: "/Volumes/Work SSD/Projects", d: "읽을 수 없거나 비어 있어요" },
		exits: [{ id: "retry", t: "다시 확인" }, { id: "fix", t: "‘Projects’ 빼고 계속", target: "inline" }, OPEN],
		primary: "retry", recover: "드라이브 연결하기", auto: { kind: "poll", every: 3 },
		app: { t: "‘Projects’ 폴더를 읽을 수 없어요", fix: null, retry: "다시 확인", empty: true, side: "폴더를 읽을 수 없어요", sideD: "Projects", item: "폴더를 읽을 수 없어요" },
	},

	disk: {
		id: "disk", group: "멈춤", label: "환경 · 디스크", pip: "warn", phase: "paused", kind: "environment", embed: "local",
		progress: 62, stopAt: null, dl: true, cur: "local", suggest: "none", blocked: { local: "공간 부족" },
		icon: "hard-drive", title: "저장 공간이 부족해요", sub: "0.5 GB가 더 필요해요",
		bad: { t: "임베딩 모델을 받을 공간이 없어요", d: `남은 공간 ${diskFree} GB · 모델 ${formatSize(MODEL_BYTES)}` },
		exits: [{ id: "retry", t: "공간 확보했어요, 이어서 받기" }, { id: "fix", t: "임베딩 방식 바꾸기", target: "embedding" }, OPEN],
		primary: "retry", recover: "공간 확보하기",
		step: { t: "저장 공간이 모자라 모델을 받지 못했어요" },
		app: { t: "모델 내려받기가 멈췄어요", fix: "임베딩 방식 바꾸기", retry: "이어서 받기", side: "모델 내려받기 멈춤", sideD: "저장 공간 부족", item: "모델 내려받기가 멈췄어요" },
	},

	unknown: {
		id: "unknown", group: "멈춤", label: "원인 미확인", pip: "warn", phase: "paused", kind: "unknown", embed: "local",
		progress: 64, stopAt: "minsync", cur: "local", suggest: "none",
		icon: "circle-alert", title: "임베딩이 멈췄어요", sub: "읽은 문서는 그대로예요",
		bad: { t: "임베딩을 쓸 수 없다고 해요", d: "이유는 알려주지 않았어요" },
		exits: [{ id: "retry", t: "다시 시도" }, { id: "fix", t: "임베딩 방식 바꾸기", target: "embedding" }, OPEN],
		primary: "retry", recover: "다음 시도는 성공시키기",
		step: { t: "임베딩을 이어가지 못했어요" },
		app: { t: "의미 검색 준비가 멈췄어요", fix: "임베딩 방식 바꾸기", retry: "다시 시도", side: "임베딩 멈춤", sideD: "원인 미확인", item: "임베딩이 멈췄어요" },
	},

	partial: {
		id: "partial", group: "끝남", label: "부분 실패", pip: "warn", phase: "done", kind: "partial", embed: "local", progress: 100,
		skipped: [
			{ n: 12, t: "제한 시간 초과" },
			{ n: 5, t: "읽기 오류" },
			{ n: 3, t: "임베딩 중 건너뜀" },
			{ n: 2, t: "파서 중단" },
		],
		app: { t: "22개 파일을 건너뛰었어요", fix: null, retry: "지금 다시 시도", side: "22개 파일 건너뜀", sideD: "다음 새로 고침에서 재시도", item: "22개 파일 건너뜀" },
	},
};
const ORDER = ["running", "done", "config", "transient", "folder", "disk", "unknown", "partial"];
