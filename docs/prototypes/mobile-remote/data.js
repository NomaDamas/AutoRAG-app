/* Dazzi mobile remote prototype — demo data.
 *
 * The tree mirrors the reporter's own remote session (a Windows PC with C: and
 * D:), so the mobile layout is judged against the exact listing that was
 * unusable in the desktop renderer at phone width. Shapes follow the app's
 * contracts loosely: a node is a listing row (name, kind, size, mtime) plus the
 * inspector fields the info sheet shows. */
"use strict";

const NOW = new Date("2026-11-02T14:20:00");
const day = (offset, hh = 12, mm = 0) => {
	const d = new Date(NOW);
	d.setDate(d.getDate() - offset);
	d.setHours(hh, mm, 0, 0);
	return d.getTime();
};
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime();
/** Listing kinds → OS kind label (Kind column), glyph family, and preview tier.
 * `preview` follows REMOTE_PREVIEW_MIMES: a browser can show images, PDF, text,
 * and playable media; Office/HWP documents have no browser preview. */
const KINDS = {
	folder: { label: "폴더", family: "folder" },
	mp4: { label: "MPEG-4 동영상", family: "video", preview: "video" },
	mp3: { label: "MP3 오디오", family: "audio", preview: "audio" },
	jpg: { label: "JPEG 이미지", family: "image", preview: "image" },
	png: { label: "PNG 이미지", family: "image", preview: "image" },
	pdf: { label: "PDF 문서", family: "doc", badge: "PDF", tint: "#E5484D", preview: "pdf" },
	docx: { label: "Word 문서", family: "doc", badge: "DOC", tint: "#2B6CD6" },
	hwp: { label: "한글 문서", family: "doc", badge: "HWP", tint: "#1F9BD7" },
	pptx: { label: "PowerPoint", family: "doc", badge: "PPT", tint: "#E0622A" },
	xlsx: { label: "Excel 통합 문서", family: "doc", badge: "XLS", tint: "#1E8E4E" },
	md: { label: "Markdown", family: "doc", badge: "MD", tint: "#6E6E73", preview: "text" },
	txt: { label: "텍스트", family: "doc", badge: "TXT", tint: "#6E6E73", preview: "text" },
	zip: { label: "ZIP 압축", family: "archive", badge: "ZIP", tint: "#8E8E93" },
	lnk: { label: "바로 가기", family: "app", badge: "LNK", tint: "#8E8E93" },
	url: { label: "인터넷 바로 가기", family: "app", badge: "URL", tint: "#8E8E93" },
	exe: { label: "응용 프로그램", family: "app", badge: "EXE", tint: "#5E5CE6" },
	iso: { label: "디스크 이미지", family: "archive", badge: "ISO", tint: "#8E8E93" },
};

/** Two-stop gradients stand in for real thumbnails (images, video frames, album art). */
const ART = [
	["#FF9A62", "#E6476B"], ["#5AC8FA", "#3263E0"], ["#8BD46B", "#2E9E6A"], ["#C08BFF", "#6848D8"],
	["#FFD36B", "#F08A24"], ["#5B6B8C", "#20283C"], ["#FF7FA8", "#B23A8A"], ["#6FE3D2", "#1C8DA6"],
];

let seq = 0;
const nodes = new Map();

/** A file row. `ext` picks the kind; `opts` carries tags, index state, art, dims. */
function f(name, size, mtime, opts = {}) {
	const ext = name.split(".").pop().toLowerCase();
	return { type: "file", name, ext, size, mtime, art: ART[seq++ % ART.length], ...opts };
}
/** A folder row with children. */
function d(name, children = [], opts = {}) {
	return { type: "folder", ext: "folder", name, children, mtime: opts.mtime ?? day(20), ...opts };
}

function register(node, parentPath, sep) {
	node.path = parentPath ? `${parentPath}${parentPath.endsWith(sep) ? "" : sep}${node.name}` : node.name;
	node.parent = parentPath ?? null;
	nodes.set(node.path, node);
	for (const child of node.children ?? []) register(child, node.path, sep);
	if (node.children) node.count = node.children.length;
	return node;
}

const kboOst = d("KBO_ost", [
	d("제작완", [f("응원가 메들리 최종.mp3", 8_400_000, at(2023, 11, 9, 23, 35))], { mtime: at(2023, 11, 9, 23, 35) }),
	f("20160705_제작완료_응원가.mp3", 761_000, at(2023, 11, 9, 21, 39)),
	f("2022 KT 위즈 황재균 응원가.mp3", 561_000, at(2023, 11, 9, 21, 39), { tags: ["red"], indexed: true }),
	f("2023 kt위즈 노동요.mp3", 30_000_000, at(2023, 11, 9, 21, 37), { tags: ["red"], indexed: true }),
	f("롯데 자이언츠 내야수 응원가.mp3", 546_000, at(2023, 11, 9, 21, 39)),
	f("롯데자이언츠 전준우 응원가.mp3", 980_000, at(2023, 11, 9, 21, 39)),
	f("부활한 KT 장성우 응원가.mp3", 811_000, at(2023, 11, 9, 21, 39), { tags: ["red"] }),
	f("키움 히어로즈 외야수 응원가.mp3", 522_000, at(2023, 11, 9, 21, 39)),
	f("키움의 '혜성' 김혜성 응원가.mp3", 626_000, at(2023, 11, 9, 21, 39)),
	f("한화 응원가 - 나는 행복합니다.mp3", 609_000, at(2023, 11, 9, 21, 39), { tags: ["orange"] }),
	f("KT WIZ 문상철 선수 응원가.mp3", 550_000, at(2023, 11, 9, 21, 39), { tags: ["red"] }),
	f("ktwiz 1루 2루 3루 홈런 응원가.mp3", 619_000, at(2023, 11, 9, 21, 39), { tags: ["red"] }),
	f("ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3", 425_000, at(2023, 11, 9, 21, 39), { tags: ["red"], indexed: true }),
	f("kbo 노동요.jpg", 172_000, at(2023, 11, 9, 23, 51), { dims: "1200 × 1200" }),
], { mtime: at(2023, 11, 9, 23, 35) });

const edai = d("EDAI 영상", [
	d("아시아경제TV 원본", [f("인터뷰 원본.mp4", 820_000_000, at(2024, 7, 5, 13, 41))], { mtime: at(2024, 7, 5, 13, 41) }),
	f("5분 피칭_EDAI.mp4", 128_000_000, at(2025, 10, 20, 23, 41), { dur: "5:12", indexed: true }),
	f("ad_rolling_demo.mp4", 3_800_000, at(2025, 1, 10, 14, 57), { dur: "0:21" }),
	f("EDAI 홍보하는척영상.mp4", 110_000_000, at(2025, 10, 24, 14, 19), { dur: "2:48" }),
	f("EDAI_오렌지플래닛_발표.mp4", 63_000_000, at(2025, 1, 26, 17, 56), { dur: "3:05" }),
	f("EDAI_CF_2301.mp4", 123_000_000, at(2025, 1, 18, 23, 21), { dur: "0:30" }),
	f("EDAI_CF.mp4", 124_000_000, at(2025, 11, 9, 1, 14), { dur: "0:30", versions: true }),
	f("EDAI_tech_demo_cut.mp4", 13_000_000, at(2024, 12, 23, 15, 30), { dur: "1:02" }),
	f("occlusion_test.mp4", 11_000_000, at(2025, 1, 10, 13, 58), { dur: "0:14" }),
], { mtime: at(2025, 8, 5, 23, 33) });

const desktop = d("Desktop", [
	d("ai hub 이용신청 서류", [
		f("이용신청서.hwp", 84_000, at(2025, 1, 29, 1, 1)),
		f("보안서약서.pdf", 212_000, at(2025, 1, 29, 1, 1)),
	], { mtime: at(2025, 1, 29, 1, 1) }),
	f("참여인력경력서_진민성.pptx", 513_000, at(2025, 2, 6, 3, 37), { indexed: true }),
	f("2026 사업계획서_최종.pdf", 2_400_000, day(0, 10, 12), { indexed: true, tags: ["blue"], pages: 14 }),
	f("회의록_1030.md", 6_200, day(3, 18, 4), { indexed: true }),
	f("Dazzi.lnk", 2_000, day(0, 11, 5)),
	f("Discord.lnk", 2_000, at(2025, 10, 17, 22, 50)),
	f("Docker Desktop.lnk", 2_000, at(2025, 1, 31, 15, 56)),
	f("Factorio.url", 222, at(2025, 11, 8, 17, 23)),
	f("kbo 노동요.jpg", 172_000, at(2025, 11, 9, 23, 51), { dims: "1200 × 1200" }),
	f("Notion.lnk", 2_000, at(2025, 8, 5, 23, 43)),
	f("ubuntu-24.04.3-desktop-amd64.iso", 5_900_000_000, at(2026, 1, 21, 21, 17)),
	f("YouTube Music.lnk", 3_000, at(2025, 4, 11, 19, 34)),
], { mtime: day(0, 11, 5) });

const documents = d("Documents", [
	d("계약서", [f("용역계약서_2026.pdf", 640_000, day(6, 9, 30), { indexed: true, pages: 6 })], { mtime: day(6) }),
	d("세금", [f("2025 종합소득세 신고서.pdf", 1_100_000, day(40), { indexed: true })], { mtime: day(40) }),
	f("이력서_김동규.docx", 98_000, day(1, 21, 2), { indexed: true, versions: true }),
	f("가계부_2026.xlsx", 64_000, day(2, 8, 41), { indexed: true }),
	f("논문 초안 v3.hwp", 320_000, day(1, 23, 50), { indexed: true, versions: true }),
], { mtime: day(1) });

const downloads = d("Downloads", [
	f("Invoice-2026-10.pdf", 88_000, day(0, 9, 3), { indexed: true, pages: 2 }),
	f("IMG_2041.jpg", 3_400_000, day(0, 8, 15), { dims: "4032 × 3024" }),
	f("IMG_2042.jpg", 3_100_000, day(0, 8, 16), { dims: "4032 × 3024" }),
	f("dataset_sample.zip", 48_000_000, day(1, 16, 22)),
	f("발표자료_최종_진짜최종.pptx", 12_000_000, day(2, 17, 30), { versions: true }),
	f("Dazzi-Setup-2.8.0.exe", 186_000_000, day(4, 10, 0)),
], { mtime: day(0) });

const pictures = d("Pictures", [
	d("Screenshots", [f("스크린샷 2026-11-01.png", 820_000, day(1, 22, 10))], { mtime: day(1) }),
	f("가족사진_추석.jpg", 5_200_000, day(30), { dims: "6000 × 4000", tags: ["green"] }),
	f("강아지.jpg", 2_800_000, day(12), { dims: "3024 × 4032" }),
	f("제주 바다.jpg", 4_400_000, day(60), { dims: "4032 × 3024" }),
], { mtime: day(1) });

const music = d("Music", [f("Playlist 2026.m3u.txt", 1_200, day(80))], { mtime: day(80) });

const home = d("김동규", [desktop, documents, downloads, music, pictures], { mtime: day(0) });

const driveC = register(d("C:", [
	d("Program Files", [d("Dazzi"), d("Docker")], { mtime: day(4) }),
	d("Users", [home], { mtime: day(0) }),
	d("Windows", [], { mtime: day(9) }),
], { label: "Local Disk (C:)", total: 1_000_000_000_000, free: 212_000_000_000 }), null, "\\");

const driveD = register(d("D:", [
	d("$RECYCLE.BIN", [], { mtime: at(2026, 11, 2, 22, 47) }),
	d("121.한국어 성능이 개선된 초거대AI 언어모델 개발 및 데이터", [], { mtime: at(2025, 1, 14, 15, 41) }),
	d("actions-runner", [], { mtime: day(0, 5, 3) }),
	d("beat saber", [], { mtime: at(2025, 12, 7, 9, 25) }),
	d("dev", [], { mtime: at(2025, 10, 13, 3, 20) }),
	d("Docker", [], { mtime: at(2025, 8, 6, 21, 40) }),
	d("Downloads", [], { mtime: at(2025, 8, 30, 0, 44) }),
	d("DriveCache", [], { mtime: at(2025, 4, 17, 13, 43) }),
	edai,
	d("Epic Games", [], { mtime: at(2025, 3, 28, 12, 34) }),
	d("Fancam", [], { mtime: at(2025, 2, 3, 20, 37) }),
	d("IBM", [], { mtime: at(2025, 4, 6, 21, 35) }),
	kboOst,
], { label: "Python (D:)", total: 2_000_000_000_000, free: 640_000_000_000 }), null, "\\");

/** Connections → saved attachments (<AUTORAG_HOME>/attachments/discord/<connection>/). */
register(d("Discord 첨부 파일", [
	d("NomaDamas", [
		f("B200 노드 배치도.png", 410_000, day(2, 15, 22), { dims: "1920 × 1080", indexed: true }),
		f("용역계약서_서명본.pdf", 720_000, day(5, 11, 3), { indexed: true, pages: 6 }),
	], { mtime: day(2) }),
	f("slurm_job.txt", 2_400, day(1, 9, 40), { indexed: true }),
], { mtime: day(1) }), null, "\\");

/** Trash: rows remember their original folder (원래 위치로 복원). */
register(d("휴지통", [
	f("오래된 백업.zip", 1_200_000_000, day(3, 12, 0), { from: "D:\\" }),
	f("IMG_1999.jpg", 2_900_000, day(6, 20, 10), { from: "C:\\Users\\김동규\\Downloads", dims: "4032 × 3024" }),
], { mtime: day(3), trash: true }), null, "\\");

const HOME = "C:\\Users\\김동규";
const P = (rel) => (rel ? `${HOME}\\${rel}` : HOME);

/** Sidebar groups (Sidebar.tsx / data/places.ts). AI 검색 and 자동화 are tabs on mobile. */
const PLACES = [
	{
		group: "즐겨찾기",
		items: [
			{ label: "최근 항목", icon: "history", tab: "recents" },
			{ label: "홈", icon: "house", path: P("") },
			{ label: "데스크탑", icon: "monitor", path: P("Desktop") },
			{ label: "문서", icon: "file-text", path: P("Documents") },
			{ label: "다운로드", icon: "download", path: P("Downloads") },
			{ label: "음악", icon: "music", path: P("Music") },
			{ label: "사진", icon: "image", path: P("Pictures") },
			{ label: "휴지통", icon: "trash", path: "휴지통" },
		],
	},
	{
		group: "연결",
		items: [{ label: "Discord 첨부 파일", icon: "message-circle", status: "ok", path: "Discord 첨부 파일" }],
	},
	{
		group: "위치",
		items: [
			{ label: "Local Disk (C:)", icon: "hard-drive", path: "C:", drive: driveC },
			{ label: "Python (D:)", icon: "hard-drive", path: "D:", drive: driveD },
		],
	},
];

const TAGS = [
	{ id: "red", label: "빨간색" }, { id: "orange", label: "주황색" }, { id: "yellow", label: "노란색" },
	{ id: "green", label: "초록색" }, { id: "blue", label: "파란색" }, { id: "purple", label: "보라색" },
	{ id: "gray", label: "회색" },
];

/** User magic actions (shared/context-menu-contract.ts): matched by target kind / extension. */
const MAGIC_ACTIONS = [
	{ id: "pdf3", label: "PDF 핵심 3줄 요약", mode: "agent", exts: ["pdf", "docx", "hwp", "pptx"] },
	{ id: "sha", label: "SHA-256 해시 계산", mode: "script", exts: null },
	{ id: "imgtable", label: "해상도·용량 표로 정리", mode: "agent", exts: ["jpg", "png"] },
	{ id: "lyrics", label: "가사 받아쓰기", mode: "agent", exts: ["mp3", "mp4"] },
];

/** Inspector suggested-action bar (state/file-actions.ts), capability-gated per extension.
 * 이미지 편집 opens a desktop app, so a phone never offers it. Conversions run on
 * the host; today `conversion.*` and `actions.run` are REMOTE_NATIVE_ONLY_METHODS
 * (see README "What the build needs"). */
const SUGGESTED = {
	mp4: [{ label: "동영상 변환", icon: "film" }, { label: "용량 줄이기", icon: "minimize-2" }],
	mp3: [{ label: "용량 줄이기", icon: "minimize-2" }, { label: "M4A로 변환", icon: "refresh-cw" }],
	jpg: [{ label: "용량 줄이기", icon: "minimize-2" }, { label: "PNG로 변환", icon: "refresh-cw" }],
	png: [{ label: "용량 줄이기", icon: "minimize-2" }, { label: "JPG로 변환", icon: "refresh-cw" }],
	pdf: [{ label: "용량 줄이기", icon: "minimize-2" }, { label: "DOCX로 변환", icon: "refresh-cw" }],
	hwp: [{ label: "PDF로 변환", icon: "refresh-cw" }],
	docx: [{ label: "PDF로 변환", icon: "refresh-cw" }],
	pptx: [{ label: "PDF로 변환", icon: "refresh-cw" }, { label: "용량 줄이기", icon: "minimize-2" }],
	zip: [{ label: "압축 해제", icon: "folder-open" }],
};

const RECENTS = [
	P("Desktop\\2026 사업계획서_최종.pdf"),
	P("Downloads\\Invoice-2026-10.pdf"),
	P("Downloads\\IMG_2041.jpg"),
	P("Downloads\\IMG_2042.jpg"),
	"D:\\KBO_ost\\ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3",
	P("Documents\\이력서_김동규.docx"),
	P("Documents\\논문 초안 v3.hwp"),
	P("Pictures\\Screenshots\\스크린샷 2026-11-01.png"),
	P("Downloads\\발표자료_최종_진짜최종.pptx"),
	P("Documents\\가계부_2026.xlsx"),
	P("Desktop\\회의록_1030.md"),
	"D:\\EDAI 영상\\5분 피칭_EDAI.mp4",
];

/** Background tasks for the sidebar activity queue (state/sidebar-activity-queue.ts). */
const ACTIVITY = [
	{ id: "index", kind: "index", title: "인덱싱 중 2/3", detail: "문서 읽는 중 · Python (D:)", progress: 0.62, icon: "database" },
	{ id: "magic", kind: "magic", title: "PDF 핵심 3줄 요약", detail: "매직 액션 · 2026 사업계획서_최종.pdf", progress: null, icon: "wand-sparkles" },
	{ id: "fix", kind: "fix", title: "AI로 고치기 대기 중", detail: "Discord 첨부 파일 가져오기 실패", progress: null, icon: "triangle-alert", tone: "error" },
];

/** Automations (librarian automations.json + last-run record). */
const RULES = [
	{ id: "pdf", title: "새 PDF → 세 줄 요약", folder: "다운로드", events: "파일 생성", include: "**/*.pdf", run: "autorag search \"이 문서를 세 줄로 요약해서 같은 폴더에 <원본명>-요약.md로 저장해줘\"", status: "ok", last: "3분 전", runs: 42 },
	{ id: "md", title: "Markdown 변경 → 인덱스 새로 고침", folder: "문서 외 1곳", events: "생성 · 변경 · 삭제", include: "**/*.md", run: "autorag refresh", status: "ok", last: "41분 전", runs: 318 },
	{ id: "hwp", title: "새 한글 문서 → PDF 변환", folder: "다운로드", events: "파일 생성", include: "**/*.hwp, **/*.hwpx", run: "hwp5 --to pdf", status: "fail", last: "어제 18:02", runs: 7 },
	{ id: "img", title: "새 스크린샷 → 날짜별 폴더로", folder: "Screenshots", events: "파일 생성", include: "**/*.png", run: "autorag search \"촬영 날짜별 폴더로 옮겨줘\"", status: "never", last: "실행 기록 없음", runs: 0 },
];

/** A seeded AI 검색 conversation with citations and a pending file-change approval. */
const CHAT = {
	title: "kt 위즈 응원가 모으기",
	messages: [
		{ role: "user", text: "KBO 응원가 중에 kt 위즈 것만 한 폴더로 모아줘" },
		{
			role: "assistant",
			blocks: [
				{ p: "D:\\KBO_ost에서 kt 위즈 응원가 6곡을 찾았어요. 파일 이름과 태그로 확인했고, 두 곡은 가사 색인으로 한 번 더 확인했어요.[1][2]" },
				{ list: ["2022 KT 위즈 황재균 응원가.mp3", "2023 kt위즈 노동요.mp3 [1]", "부활한 KT 장성우 응원가.mp3", "KT WIZ 문상철 선수 응원가.mp3", "ktwiz 1루 2루 3루 홈런 응원가.mp3", "ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3 [2]"] },
				{ p: "롯데·키움·한화 응원가는 그대로 둘게요. **D:\\KBO_ost\\kt 위즈** 폴더를 만들어 옮기려면 승인해 주세요." },
			],
			sources: [
				{ n: 1, name: "2023 kt위즈 노동요.mp3", where: "D:\\KBO_ost", excerpt: "“…승리를 위하여 kt wiz, 오늘도 마법처럼…” — 가사 색인 00:41", score: 92 },
				{ n: 2, name: "ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3", where: "D:\\KBO_ost", excerpt: "“캡틴 박경수, 박경수 안타! kt wiz의 박경수…” — 가사 색인 00:12", score: 88 },
				{ n: 3, name: "회의록_1030.md", where: "데스크탑", excerpt: "“응원가 파일은 구단별 폴더로 정리하기로 함”", score: 61 },
			],
		},
	],
	approval: {
		headline: "Dazzi가 파일을 바꾸려고 해요 — 허용할까요?",
		summary: "새 폴더 1개 만들고 파일 6개 이동",
		target: "D:\\KBO_ost\\kt 위즈",
		ops: ["📁 kt 위즈 만들기", "2022 KT 위즈 황재균 응원가.mp3", "2023 kt위즈 노동요.mp3", "부활한 KT 장성우 응원가.mp3", "KT WIZ 문상철 선수 응원가.mp3", "ktwiz 1루 2루 3루 홈런 응원가.mp3", "ktwiz 캡틴 박경수 응원가 l 응원가 부활.mp3"],
	},
};

const HISTORY = [
	{ bucket: "오늘", items: ["kt 위즈 응원가 모으기", "10월 인보이스 합계"] },
	{ bucket: "어제", items: ["이력서 경력 기간 맞추기", "논문 초안 참고문헌 확인"] },
	{ bucket: "지난 7일", items: ["EDAI 광고 영상 중 가장 최신 버전", "Discord에서 받은 계약서 찾기", "제주 사진 용량 줄이기"] },
];

const SUGGESTIONS = [
	"지난주에 받은 인보이스 합계 알려줘",
	"EDAI 광고 영상 중 가장 최신 버전은?",
	"Discord에서 받은 계약서 찾아줘",
];

const SEARCH_RECENT = ["사업계획서", "kt 위즈", "IMG_20", "계약서"];

globalThis.DEMO = { NOW, KINDS, nodes, PLACES, TAGS, MAGIC_ACTIONS, SUGGESTED, RECENTS, ACTIVITY, RULES, CHAT, HISTORY, SUGGESTIONS, SEARCH_RECENT, HOME };
