import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
/**
 * Manual QA — images in AI Search answers and evidence, in the real app.
 *
 * Deterministic lane: seeds the chat store (<userData>/chat-history/chats.json)
 * with one chat whose answers reference images the way model output does —
 * a markdown image, a bare absolute path in a sentence, a path in inline code,
 * a missing file, a HEIC file Chromium cannot decode, and a web image URL —
 * and whose evidence points at a real PNG and at a markdown note with a
 * relative image link. Loading the chat through the history surface drives
 * only the real render path, then checks:
 *
 *   - local images render as pictures (decoded pixels, not raw text), each
 *     captioned with its file name and full path;
 *   - a missing file and an undecodable format fall back to a card that shows
 *     the path instead of a broken image;
 *   - a web image is never fetched (no remote loads from model output); its
 *     card opens the page in the OS browser (shell.openExternal stubbed);
 *   - an image evidence source renders in the Evidence paper;
 *   - a relative image link in an excerpt resolves against the source folder;
 *   - clicking a rendered image opens it in Quick Look.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-images.mjs
 * Prereq: bun run build, ffmpeg on PATH (fixture images).
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-images");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => { console.log(line); appendFileSync(LOG, `${line}\n`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, detail) => { log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`); if (!ok) failures.push(label); };

const RUN_ID = `ulw-ai-images-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const DOCS = join(homedir(), "Documents", RUN_ID);
const PHOTOS = join(DOCS, "사진");
const CHART = join(PHOTOS, "매출차트.png");
const SCREEN = join(PHOTOS, "screen-shot.png");
const DIAGRAM = join(PHOTOS, "diagram.jpg");
const MISSING = join(PHOTOS, "없는-이미지.png");
const HEIC = join(PHOTOS, "iphone.heic");
const EVIDENCE_IMAGE = join(PHOTOS, "영수증.png");
const NOTE = join(DOCS, "회의록.md");
const FIGURE = join(DOCS, "images", "fig 1.png");
const WEB_IMAGE = "https://example.com/assets/logo.png";

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	for (const dir of [USER_DATA, DOCS]) {
		try {
			if (patient === true) rmRetry(dir);
			else rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			log(`cleanup: ${dir} stayed behind (${error.code ?? error.message})`);
		}
	}
};
process.on("exit", () => sweep(false));

/** A small two-band picture: decoded pixels are checkable through naturalWidth. */
function picture(path, width, height, color) {
	execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height},drawbox=x=0:y=${height / 2}:w=${width}:h=${height / 2}:color=0xf2a900:t=fill`, "-frames:v", "1", path]);
}

mkdirSync(PHOTOS, { recursive: true });
mkdirSync(join(DOCS, "images"), { recursive: true });
mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
picture(CHART, 320, 180, "0x2f7de1");
picture(SCREEN, 240, 160, "0x34a853");
picture(DIAGRAM, 200, 200, "0xa142f4");
picture(EVIDENCE_IMAGE, 180, 240, "0xea4335");
picture(FIGURE, 160, 90, "0x00acc1");
// Real HEIC bytes are not needed: Chromium cannot decode the format, so the
// renderer must never hand it to <img>. A copied PNG under a .heic name keeps
// the fixture tool-free while proving the extension decides.
copyFileSync(CHART, HEIC);
writeFileSync(NOTE, "## 회의록\n도식은 아래 그림을 참고합니다.\n");
log(`fixtures: ${DOCS}`);

const evidence = [
	{
		number: 1,
		title: basename(EVIDENCE_IMAGE),
		summary: "영수증 사진에서 금액을 읽었습니다.",
		source: EVIDENCE_IMAGE,
		excerpts: ["합계 ₩48,000"],
		confidence: 0.88,
		feedbackId: "fb-img-1",
	},
	{
		number: 2,
		title: basename(NOTE),
		summary: "회의록의 도식입니다.",
		source: NOTE,
		excerpts: ["도식은 아래 그림을 참고합니다.\n![도식 1](images/fig%201.png)"],
		confidence: 0.74,
		feedbackId: "fb-img-2",
	},
];
const quickAnswer = [
	`분기 매출 차트입니다. [1]`,
	``,
	`![매출 차트](${CHART})`,
	``,
	`화면 캡처는 ${SCREEN}에 있습니다. [2]`,
].join("\n");
const deepAnswer = [
	`도식 원본: \`${DIAGRAM}\``,
	``,
	`![지난 분기 차트](${MISSING})`,
	``,
	`아이폰 사진: ${HEIC}`,
	``,
	`![웹 로고](${WEB_IMAGE})`,
].join("\n");
const now = new Date().toISOString();
const record = {
	id: "c-img-1",
	title: "이미지 결과 확인",
	snippet: "분기 매출 차트입니다.",
	updatedAt: now,
	messages: [
		{ role: "user", text: "매출 차트 이미지 보여줘", attachments: [], at: now },
		{
			role: "assistant",
			sessionId: "qa-image-session",
			quick: { answer: quickAnswer, evidence, meta: "0.4s · 2 sources" },
			deep: { answer: deepAnswer, evidence, meta: "2 sources read · 2s" },
			stopped: false,
			at: now,
		},
	],
};
writeFileSync(join(USER_DATA, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);

app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
page.on("console", (message) => {
	if (message.type() === "error") log(`[console.error] ${message.text().slice(0, 300)}`);
});
// Any request the renderer sends to the web would be a remote load driven by
// model output; record them all.
const remoteRequests = [];
page.on("request", (request) => {
	if (/^https?:/u.test(request.url())) remoteRequests.push(request.url());
});
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);
await app.evaluate(({ shell }) => {
	globalThis.__qaOpenedUrls = [];
	shell.openExternal = async (url) => {
		globalThis.__qaOpenedUrls.push(url);
	};
});
log("app ready");

await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().click();
const quickProse = page.locator(".assistant-msg .assistant-prose").nth(0);
const deepProse = page.locator(".assistant-msg .assistant-prose").nth(1);
await deepProse.waitFor({ state: "visible" });
await sleep(800);
await page.screenshot({ path: join(EVIDENCE, "01-answers.png") });

/** naturalWidth of the rendered <img> for a path, or null when there is none. */
const decoded = (scope, path) =>
	scope.evaluate((root, wanted) => {
		const img = [...root.querySelectorAll("img")].find((node) => node.closest("[data-image-path]")?.getAttribute("data-image-path") === wanted);
		return img === undefined ? null : { complete: img.complete, width: img.naturalWidth, height: img.naturalHeight };
	}, path);
const waitDecoded = async (scope, path) => {
	const deadline = Date.now() + 5000;
	for (;;) {
		const state = await decoded(scope, path);
		if ((state !== null && state.complete) || Date.now() > deadline) return state;
		await sleep(100);
	}
};

const quickText = await quickProse.innerText();
check("the markdown image syntax is not printed as raw text", !quickText.includes("!["), quickText.slice(0, 160));
const chart = await waitDecoded(quickProse, CHART);
check("a markdown image renders the local picture", chart?.width === 320 && chart?.height === 180, JSON.stringify(chart));
const screen = await waitDecoded(quickProse, SCREEN);
check("a bare absolute image path in a sentence renders the picture", screen?.width === 240, JSON.stringify(screen));
check("the sentence text around the bare path stays", quickText.includes("화면 캡처는") && quickText.includes("있습니다."), quickText.replace(/\s+/g, " ").slice(0, 200));
/** CSS attribute selector for a value that may hold Windows backslashes. */
const byAttr = (name, value) => `[${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"]`;
const caption = (await quickProse.locator(byAttr("data-image-path", CHART)).innerText().catch(() => "")) ?? "";
check("the rendered image is captioned with its file name", caption.includes(basename(CHART)), caption);
const captionTitle = await quickProse.locator(`${byAttr("data-image-path", CHART)} [title]`).first().getAttribute("title").catch(() => null);
check("the caption carries the full path", captionTitle === CHART, String(captionTitle));
const cites = await quickProse.locator(".cite").allTextContents();
check("citation chips keep working next to images", cites.join(",") === "1,2", JSON.stringify(cites));

const diagram = await waitDecoded(deepProse, DIAGRAM);
check("an image path in inline code renders the picture", diagram?.width === 200, JSON.stringify(diagram));
const missingCard = deepProse.locator(byAttr("data-image-path", MISSING));
await missingCard.waitFor({ state: "visible", timeout: 3000 }).catch(() => undefined);
const missingImg = await decoded(deepProse, MISSING);
const missingText = (await missingCard.innerText().catch(() => "")) ?? "";
check("a missing image falls back to a card without a broken <img>", missingImg === null && (await missingCard.count()) === 1, JSON.stringify({ missingImg, count: await missingCard.count() }));
check("the missing-image card shows the file name and path", missingText.includes(basename(MISSING)) && (await missingCard.locator(byAttr("title", MISSING)).count()) >= 1, missingText);
const heicCard = deepProse.locator(byAttr("data-image-path", HEIC));
check("an undecodable format is never handed to <img>", (await decoded(deepProse, HEIC)) === null && (await heicCard.count()) === 1, `count=${await heicCard.count()}`);
const webCard = deepProse.locator(byAttr("data-image-url", WEB_IMAGE));
const webText = (await webCard.innerText().catch(() => "")) ?? "";
check("a web image shows a card with its address", (await webCard.count()) === 1 && webText.includes("example.com"), webText);
check("a web image is never fetched by the renderer", remoteRequests.length === 0, JSON.stringify(remoteRequests));
await deepProse.scrollIntoViewIfNeeded();
await page.screenshot({ path: join(EVIDENCE, "02-deep-fallbacks.png") });

// Web image card -> OS browser.
await webCard.click().catch(() => undefined);
await sleep(400);
const opened = await app.evaluate(() => globalThis.__qaOpenedUrls);
check("the web image card opens the page in the OS browser", JSON.stringify(opened) === JSON.stringify([WEB_IMAGE]), JSON.stringify(opened));

// Evidence half: image source and a relative image in an excerpt.
const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab`);
const paperImage = await waitDecoded(page.locator(EVIDENCE_HALF), EVIDENCE_IMAGE);
check("an image evidence source renders in the Evidence paper", paperImage?.width === 180 && paperImage?.height === 240, JSON.stringify(paperImage));
await page.screenshot({ path: join(EVIDENCE, "03-evidence-image.png") });
await page.locator(`${EVIDENCE_HALF} .evidence-tab`, { hasText: /^2$/ }).click();
await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.startsWith("2. "), `${EVIDENCE_HALF} .preview-title`);
const figure = await waitDecoded(page.locator(EVIDENCE_HALF), FIGURE);
check("a relative image in an excerpt resolves against the source folder", figure?.width === 160, JSON.stringify(figure));
await page.screenshot({ path: join(EVIDENCE, "04-evidence-relative.png") });

// Rendered image -> Quick Look.
const quickLookState = () =>
	app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
		return window === undefined ? null : { visible: window.isVisible(), title: window.getTitle() };
	});
await quickProse.locator(`${byAttr("data-image-path", CHART)} button`).first().click().catch(() => undefined);
let ql = null;
for (let attempt = 0; attempt < 50; attempt += 1) {
	ql = await quickLookState();
	if (ql?.visible) break;
	await sleep(100);
}
check("clicking a rendered image opens it in Quick Look", ql?.visible === true && ql.title === basename(CHART), JSON.stringify(ql));
await sleep(600);
const qlPage = (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html"));
if (qlPage !== undefined) await qlPage.screenshot({ path: join(EVIDENCE, "05-quick-look.png") }).catch(() => undefined);
if (qlPage !== undefined) await qlPage.keyboard.press("Escape").catch(() => undefined);

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
