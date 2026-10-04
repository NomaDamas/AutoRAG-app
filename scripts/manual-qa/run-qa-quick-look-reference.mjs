/**
 * Manual QA — Quick Look against the owner's quicklook-preview-reference.
 *
 * Builds a fixture folder with one file per reference panel (video, audio,
 * PDF, HTML, code, Markdown, other, folder), drives the production build
 * (`bun run build` first), opens each with Space from the Finder list, checks
 * the panel's behaviour in the DOM, times Space → content, and captures the
 * real window (native material included) with `screencapture` on macOS.
 *
 * Set `AUTORAG_SKIP_NATIVE_CAPTURE=1` when the display server cannot capture
 * native window rectangles; DOM and page screenshots still run.
 * Needs ffmpeg for the media fixtures.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-reference";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-reference-"));

// ------------------------------------------------------------------ fixtures
const ffmpeg = (...args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

const CODE = `# -*- coding: utf-8 -*-
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side

OUT = "Talent_Evaluation.xlsx"

# ---- General Talent Profile Model: dimensions & weights ----
dims = [
    ("教育背景 / Education Background", 0.15,
     "院校层次、专业层次、学制完整性（同一院校同一专业，水平相当）"),
    ("专业匹配度 / Professional Match", 0.20,
     "所学专业与中医骨伤岗位的对口程度"),
]

weights = [d[1] for d in dims]
for c in cands:
    c["total"] = round(sum(s * w for s, w in zip(c["scores"], weights)), 2)

ranked = sorted(cands, key=lambda x: x["total"], reverse=True)


def reco(t):
    if t >= 88:
        return "강력 추천 / Strongly Recommend"
    return "备选 / Backup"


HEAD = PatternFill("solid", fgColor="2F5597")
`;

const MARKDOWN = `# Kill-Seoksam

실시간 보이스피싱 감지 데모 — 통화 음성을 15초 단위로 받아 텍스트로 바꾸고, AI가 사기 확률을 판단합니다.

## 동작 방식

1. **Record from microphone** 버튼을 눌러 녹음을 시작합니다
2. 마이크에 대고 말하세요 (한국어)
3. 15초마다 자동으로 음성 → 텍스트 변환 → AI 분석
4. 보이스피싱 확률과 경고가 실시간으로 표시됩니다

## 설정

| 항목 | 값 |
| --- | --- |
| 처리 간격 | 15초 |
| 샘플레이트 | 16kHz |
| 언어 | 한국어 |

## 실행

\`\`\`bash
pip install -r requirements.txt
python app.py
\`\`\`

> 마이크 권한 오류가 발생하면 주소창의 자물쇠 아이콘 → 사이트 설정 → 마이크를 "허용"으로 변경하세요.

- STT: \`Whisper\`
- 분석: \`Claude\`
<script>window.parent.postMessage("pwned", "*")</script>
`;

const HTML = `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Kill-Seoksam — 보이스피싱 실시간 감지</title>
  <style>body{margin:0;font-family:-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;color:#121826}nav{display:flex;gap:22px;padding:18px 28px;border-bottom:1px solid #eceef2;font-size:13px}main{padding:56px 28px 40px;max-width:760px;margin:0 auto}h1{font-size:40px;line-height:1.2;margin:14px 0 0}.btn{display:inline-flex;height:44px;align-items:center;padding:0 20px;border-radius:10px;background:#4f46e5;color:#fff;text-decoration:none;font-weight:600}</style>
</head>
<body>
  <nav><strong>Kill‑Seoksam</strong><a href="#how">작동 방식</a><a href="#settings">설정</a></nav>
  <main>
    <p style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#4f46e5">VOICE PHISHING DETECTOR</p>
    <h1>통화 중 보이스피싱을 실시간으로 감지합니다</h1>
    <p>15초마다 음성을 텍스트로 변환하고, AI가 대화를 분석해 사기 확률과 경고를 표시합니다.</p>
    <a class="btn" href="/demo">녹음 시작</a>
  </main>
  <script>document.title = "scripts must not run"; document.body.dataset.ran = "yes";</script>
</body>
</html>
`;

function pdfFixture(path) {
	const pages = Array.from({ length: 9 }, (_unused, index) => index);
	const parts = ["1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"];
	const kids = pages.map((index) => `${3 + index * 2} 0 R`).join(" ");
	parts.push(`2 0 obj<</Type/Pages/Count ${pages.length}/Kids[${kids}]>>endobj\n`);
	const fontId = 3 + pages.length * 2;
	for (const index of pages) {
		const stream = `BT /F1 28 Tf 72 760 Td (Page ${index + 1}) Tj ET BT /F1 11 Tf 72 720 Td (Quick Look reference QA fixture) Tj ET`;
		parts.push(`${3 + index * 2} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents ${4 + index * 2} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>endobj\n`);
		parts.push(`${4 + index * 2} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`);
	}
	parts.push(`${fontId} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`);
	let body = "%PDF-1.4\n";
	const offsets = [];
	for (const part of parts) {
		offsets.push(body.length);
		body += part;
	}
	const xref = body.length;
	body += `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer<</Size ${parts.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	writeFileSync(path, body);
}

function exeFixture(path) {
	const bytes = new Uint8Array(6_800_000);
	const view = new DataView(bytes.buffer);
	bytes.set([0x4d, 0x5a], 0);
	view.setUint32(0x3c, 0x80, true);
	bytes.set([0x50, 0x45, 0, 0], 0x80);
	view.setUint16(0x84, 0x8664, true);
	view.setUint16(0x98, 0x20b, true);
	writeFileSync(path, bytes);
}

ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1280x720:d=20:r=30", "-f", "lavfi", "-i", "sine=frequency=330:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(root, "제대로됨.mp4"));
ffmpeg("-f", "lavfi", "-i", "gradients=s=600x600:c0=0xf7c548:c1=0xc23a5d:n=2:d=1", "-frames:v", "1", join(root, ".cover.jpg"));
ffmpeg(
	"-f", "lavfi", "-i", "aevalsrc=0.8*sin(2*PI*220*t)*(0.15+0.85*abs(sin(2*PI*t/9))):s=44100:d=157", "-i", join(root, ".cover.jpg"),
	"-map", "0:a", "-map", "1:v", "-c:a", "libmp3lame", "-b:a", "320k", "-ar", "44100", "-c:v", "mjpeg", "-id3v2_version", "3",
	"-metadata", "title=Afterglow", "-metadata", "artist=Sample Artist", "-metadata", "album=Demo Sessions", "-disposition:v", "attached_pic",
	join(root, "Sample Artist - Afterglow.mp3"),
);
rmSync(join(root, ".cover.jpg"));
pdfFixture(join(root, "guide.pdf"));
writeFileSync(join(root, "landing.html"), HTML);
writeFileSync(join(root, "build_eval.py"), CODE);
writeFileSync(join(root, "README.md"), MARKDOWN);
exeFixture(join(root, "SecuKitNXS.exe"));
const projects = join(root, "Projects");
mkdirSync(join(projects, "kill-seoksam"), { recursive: true });
mkdirSync(join(projects, "assets"), { recursive: true });
for (let index = 1; index <= 18; index += 1) {
	const note = join(projects, `note-${index}.txt`);
	writeFileSync(note, `note ${index}\n`);
	utimesSync(note, new Date(2026, 8, 20), new Date(2026, 8, 20));
}
for (const [name, minute] of [["report.pdf", 10], ["demo.mp4", 11], ["README.md", 13], ["build_eval.py", 14]]) {
	copyFileSync(join(root, name === "report.pdf" ? "guide.pdf" : name === "demo.mp4" ? "제대로됨.mp4" : name), join(projects, name));
	utimesSync(join(projects, name), new Date(2026, 8, 30, 16, minute), new Date(2026, 8, 30, 16, minute));
}
utimesSync(join(projects, "assets"), new Date(2026, 8, 30, 16, 12), new Date(2026, 8, 30, 16, 12));
utimesSync(join(projects, "kill-seoksam"), new Date(2026, 8, 30, 16, 15), new Date(2026, 8, 30, 16, 15));

// ---------------------------------------------------------------------- run
const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

/**
 * One full pass in `appearance`. The native material and both renderer roots
 * are pinned to the same appearance so the reference panels are comparable.
 */
async function pass(appearance) {
	const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
	try {
		await app.evaluate(({ nativeTheme }, source) => {
			nativeTheme.themeSource = source;
		}, appearance);
		const main = await finderWindow(app, 30_000);
		const preview = await poll(
			async () => (await app.windows()).find((page) => page.url().includes("quick-look.html")),
			(page) => page !== undefined,
			30_000,
		);
		if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
		await preview.emulateMedia({ colorScheme: appearance });
		await main.emulateMedia({ colorScheme: appearance });
		await preview.evaluate((source) => {
			document.documentElement.dataset.appearance = source;
		}, appearance);
		await main.evaluate((source) => {
			document.documentElement.dataset.appearance = source;
		}, appearance);
		const windowState = () =>
			app.evaluate(({ BrowserWindow }) => {
				const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
				return window === undefined ? null : { visible: window.isVisible(), bounds: window.getBounds() };
			});
		const settled = () => preview.evaluate(() => document.getElementById("root")?.dataset.zoom === undefined && document.querySelector('[data-quicklook-state="ready"]') !== null);

		async function open(name, ready) {
			const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
			await row.waitFor({ timeout: 30_000 });
			await row.click();
			const started = Date.now();
			await main.keyboard.press("Space");
			await poll(() => preview.evaluate(ready).catch(() => false), Boolean, 10_000);
			const elapsed = Date.now() - started;
			await poll(settled, Boolean);
			await poll(async () => (await windowState())?.visible === true, Boolean);
			await new Promise((resolve) => setTimeout(resolve, 450));
			return elapsed;
		}

		async function capture(name) {
			const slug = `${appearance}-${name}`;
			const state = await windowState();
			await preview.screenshot({ path: join(EVIDENCE, `${slug}-page.png`) });
			if (process.platform === "darwin" && state !== null && process.env.AUTORAG_SKIP_NATIVE_CAPTURE !== "1") {
				const { x, y, width, height } = state.bounds;
				execFileSync("screencapture", ["-x", "-R", `${x - 24},${y - 24},${width + 48},${height + 48}`, join(EVIDENCE, `${slug}-window.png`)]);
			}
			return state;
		}

		async function close() {
			await main.keyboard.press("Space");
			await poll(async () => (await windowState())?.visible === false, Boolean);
			await new Promise((resolve) => setTimeout(resolve, 200));
		}

		const openLabel = () => preview.locator(".qlw__open").textContent();

		// Video
		let ms = await open("제대로됨.mp4", () => {
			const video = document.querySelector("video");
			return video instanceof HTMLVideoElement && video.currentTime > 0;
		});
		check("video plays within 1.5s of Space", ms < 1500, `${ms}ms`);
		check("video HUD has the reference controls", (await preview.locator(".ql-hud button").count()) === 7);
		await preview.locator('.ql-hud button[aria-label="재생 속도"]').click();
		const speed = await poll(() => preview.locator('.ql-hud button[aria-label="재생 속도"]').textContent(), (text) => text === "1.25×");
		check("speed pill cycles", speed === "1.25×", speed ?? "");
		let state = await capture("01-video");
		check("video window keeps 16:9", state !== null && Math.abs(state.bounds.width / (state.bounds.height - 46) - 16 / 9) < 0.05, JSON.stringify(state?.bounds));
		console.log(`      open label: ${await openLabel()}`);
		await close();

		// Audio
		ms = await open("Sample Artist - Afterglow.mp3", () => document.querySelector(".ql-audio__title")?.textContent === "Afterglow" && document.querySelector(".ql-audio__art img") !== null);
		check("audio shows tags and cover", ms < 2000, `${ms}ms`);
		const bars = await poll(
			() => preview.locator(".ql-audio span.flex-none").evaluateAll((nodes) => new Set(nodes.map((node) => node.style.height)).size),
			(count) => count > 4,
		);
		check("waveform decoded", bars > 4, `${bars} distinct bar heights`);
		check("audio stream facts", ((await preview.locator(".ql-audio").textContent()) ?? "").includes("320 kbps · 44.1 kHz"));
		state = await capture("02-audio");
		check("audio panel is 620 × 368", state !== null && state.bounds.width === 620 && state.bounds.height === 368, JSON.stringify(state?.bounds));
		await close();

		// PDF
		ms = await open("guide.pdf", () => document.querySelectorAll(".ql__paper canvas").length > 0);
		check("pdf first page within 1.5s", ms < 1500, `${ms}ms`);
		check("pdf lays out every page", (await preview.locator(".ql__paper").count()) === 9);
		check("pdf rail lists every page", (await preview.locator(".ql__rail-item").count()) === 9);
		check("pdf pill shows page and zoom", ((await preview.locator(".ql-pdf__pill").textContent()) ?? "").includes("1 / 9"));
		state = await capture("03-pdf");
		const zoomOf = async () => Number(/(\d+)%/.exec((await preview.locator(".ql-pdf__pill").textContent()) ?? "")?.[1] ?? 0);
		const fitted = await zoomOf();
		await preview.locator('.ql-pdf__pill button[aria-label="확대"]').click();
		const zoomed = await poll(zoomOf, (value) => value > fitted);
		check("pdf zooms to the next step", zoomed > fitted, `${fitted}% → ${zoomed}%`);
		await preview.locator(".ql__rail-item").nth(6).click();
		await poll(() => preview.locator(".ql-pdf__pill").textContent(), (text) => (text ?? "").includes("7 / 9"));
		check("rail jumps to a page", ((await preview.locator(".ql-pdf__pill").textContent()) ?? "").includes("7 / 9"));
		await close();

		// HTML
		ms = await open("landing.html", () => document.querySelector(".ql-html iframe") !== null);
		check("html renders", ms < 1500, `${ms}ms`);
		const ran = await preview.locator(".ql-html iframe").evaluate((frame) => {
			try {
				return frame.contentDocument?.body?.dataset.ran ?? "blocked";
			} catch {
				return "blocked";
			}
		});
		check("html scripts stay off", ran !== "yes", ran);
		state = await capture("04-html");
		check("html panel is the reference 980 × 720", state !== null && state.bounds.width === 980 && state.bounds.height === 720, JSON.stringify(state?.bounds));
		await preview.getByRole("button", { name: "모바일" }).click();
		check("mobile width is 390", (await preview.locator(".ql-html iframe").evaluate((frame) => frame.getBoundingClientRect().width)) === 390);
		await capture("04-html-mobile");
		await preview.getByRole("button", { name: "소스" }).click();
		check("html source is highlighted", (await preview.locator(".ql-lines .hljs-tag").count()) > 10);
		await close();

		// Code
		ms = await open("build_eval.py", () => document.querySelectorAll(".ql-line").length > 0);
		check("code renders", ms < 1500, `${ms}ms`);
		const footer = (await preview.locator("footer").textContent()) ?? "";
		check("code footer names Python, UTF-8, LF", footer.includes("Python 3") && footer.includes("UTF-8") && footer.includes("LF"), footer);
		check("code is highlighted", (await preview.locator(".hljs-keyword").count()) > 5 && (await preview.locator(".hljs-built_in").count()) > 3 && (await preview.locator(".ql-const").count()) > 1);
		state = await capture("05-code");
		// 28 lines at 12.5px × 1.62 plus padding, footer, and toolbar: the panel hugs the file instead of the screen.
		check("code panel is 840 wide and hugs its lines", state !== null && state.bounds.width === 840 && state.bounds.height > 600 && state.bounds.height < 760, JSON.stringify(state?.bounds));
		await preview.getByRole("button", { name: "줄 바꿈" }).click();
		check("wrap toggles", (await preview.locator(".ql-lines").getAttribute("data-wrap")) === "false");
		await preview.getByRole("button", { name: "코드 복사" }).click();
		const clipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
		check("copy puts the source on the clipboard", clipboard === CODE, `${clipboard.length} chars`);
		await close();

		// Markdown
		ms = await open("README.md", () => document.querySelector(".ql-md h1") !== null);
		check("markdown renders split view", ms < 1500, `${ms}ms`);
		check("markdown preview has table and code", (await preview.locator(".ql-md table").count()) === 1 && (await preview.locator(".ql-md pre").count()) === 1);
		check("markdown drops raw scripts", (await preview.locator(".ql-md script").count()) === 0);
		const mdFooter = (await preview.locator("footer").textContent()) ?? "";
		check("markdown footer counts blocks", mdFooter.includes("제목 4 · 표 1 · 코드 블록 1"), mdFooter);
		state = await capture("06-markdown");
		check("markdown panel is 1100 wide and hugs its panes", state !== null && state.bounds.width === 1100 && state.bounds.height < 900, JSON.stringify(state?.bounds));
		await preview.getByRole("button", { name: "렌더링" }).click();
		check("render-only mode hides source", (await preview.locator(".ql-lines").count()) === 0);
		await close();

		// Other
		ms = await open("SecuKitNXS.exe", () => document.querySelector(".ql-other__name")?.textContent === "SecuKitNXS.exe");
		check("other panel opens", ms < 1500, `${ms}ms`);
		state = await capture("07-other");
		check("other panel is the reference 620 × 290", state !== null && state.bounds.width === 620 && state.bounds.height === 290, JSON.stringify(state?.bounds));
		const collapsed = state?.bounds.height ?? 0;
		await preview.getByRole("button", { name: "자세한 정보" }).click();
		await poll(() => preview.locator(".ql-other__details").textContent(), (text) => (text ?? "").includes("PE32+") && !(text ?? "").includes("계산 중"));
		const details = (await preview.locator(".ql-other__details").textContent()) ?? "";
		check("details show platform and checksum", details.includes("Windows (PE32+, x86-64)") && /[0-9a-f]{64}/.test(details), details.slice(0, 160));
		const expanded = await poll(async () => (await windowState())?.bounds.height ?? 0, (height) => height > collapsed + 60);
		check("panel grows for details", expanded > collapsed + 60, `${collapsed} → ${expanded}`);
		await new Promise((resolve) => setTimeout(resolve, 400));
		await capture("07-other-expanded");
		await close();

		// Folder
		ms = await open("Projects", () => document.querySelector(".ql-folder__name")?.textContent === "Projects");
		check("folder opens with Space", ms < 1500, `${ms}ms`);
		const count = await poll(() => preview.locator(".ql-folder__count").textContent(), (text) => (text ?? "").includes("MB"));
		check("folder shows count and size", (count ?? "").startsWith("24 items, "), count ?? "");
		const items = await preview.locator(".ql-folder__items > div > span").evaluateAll((nodes) => nodes.map((node) => node.textContent));
		check("folder lists recent items first", JSON.stringify(items) === JSON.stringify(["kill-seoksam", "build_eval.py", "README.md", "assets", "demo.mp4", "report.pdf"]), JSON.stringify(items));
		state = await capture("08-folder");
		check("folder panel is 640 wide, about the reference 384 tall", state !== null && state.bounds.width === 640 && Math.abs(state.bounds.height - 384) <= 8, JSON.stringify(state?.bounds));
		await close();
	} finally {
		await app.close();
	}
}

try {
	for (const appearance of ["light", "dark"]) {
		console.log(`\n— ${appearance}`);
		await pass(appearance);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed; evidence in ${EVIDENCE}`);
process.exit(failed.length === 0 ? 0 : 1);
