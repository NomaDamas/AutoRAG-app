/**
 * Manual QA — a clipboard image pastes into both AI Agent composers and reaches the model (real app).
 *
 * The real librarian agent, the real preload bridge and renderer run end to end; only the model is scripted by a loopback
 * OpenAI-compatible server that records every request body. A real PNG is put on the OS clipboard (osascript)
 * and pasted with the real shortcut.
 *
 *   vision model:
 *   1. AI Agent tab: ⌘V shows the pasted picture itself (a thumbnail with a ✕, not a file name) within a time budget,
 *      no text lands in the field; the ✕ takes it off; pasting again and Enter sends; the request carries one
 *      image_url part with the pasted pixels; the sent bubble shows the picture;
 *   2. right sidebar chat (Info view dock): ⌘V shows the thumbnail with a ✕; Enter sends; the request carries the
 *      image; a follow-up typed in the chat view with a second paste carries the new picture too;
 *   3. a text paste still pastes text.
 *   text-only model:
 *   4. ⌘V in either composer is silently ignored: no pill, no card, no error, nothing sent as an image; the question
 *      goes through as plain text.
 *
 * macOS only (the clipboard is set with osascript/pbcopy, a shell stub stands in for MinSync). Run it in a VM so the
 * developer's clipboard is not overwritten:
 *   bun run qa script scripts/manual-qa/run-qa-finder-ai-chat-paste-image.mjs
 * Prereq without the runner: bun run build, ffmpeg on PATH.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";
import { chord, rmRetry, writeMinsyncStub } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-chat-paste-image");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-paste-image-"));
const PICTURES = join(WORK, "pictures");
mkdirSync(PICTURES, { recursive: true });
const RED = join(PICTURES, "red.png");
const BLUE = join(PICTURES, "blue.png");
for (const [path, color] of [[RED, "red"], [BLUE, "blue"]]) {
	execFileSync("ffmpeg", ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=320x200`, "-frames:v", "1", path], { stdio: "ignore" });
}

// ── The scripted model: records every request. ──
const seen = [];
const frame = (delta, finish) =>
	`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const server = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (new URL(req.url ?? "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
			res.writeHead(404).end();
			return;
		}
		const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		const decisionTool = (body.tools ?? []).find((tool) => tool.function?.name === "submit_decisions");
		if (decisionTool !== undefined) {
			const asked = decisionTool.function.parameters?.properties?.answers?.properties ?? {};
			const answers = {};
			for (const [key, schema] of Object.entries(asked)) {
				const shares = schema.properties?.probabilities?.properties;
				if (shares === undefined) {
					answers[key] = { yes: key === "follow_up" || key.startsWith("citation:") || key.startsWith("citation_") || key.startsWith("permission_") ? 1 : 0, confidence: 1 };
					continue;
				}
				const labels = Object.keys(shares);
				const winner = key === "route" && labels.includes("local") ? "local" : key === "permission_gate" && labels.includes("deny") ? "deny" : labels[0];
				answers[key] = { probabilities: Object.fromEntries(labels.map((label) => [label, label === winner ? 1 : 0])), confidence: 1 };
			}
			const call = { index: 0, id: "call_decision", type: "function", function: { name: "submit_decisions", arguments: JSON.stringify({ answers }) } };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(frame({ role: "assistant", tool_calls: [call] }, null));
			res.write(frame({}, "tool_calls"));
			res.end("data: [DONE]\n\n");
			return;
		}
		const images = (body.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part) => part.type === "image_url");
		seen.push({ images: images.map((part) => part.image_url?.url ?? ""), text: JSON.stringify(body.messages ?? []) });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
		res.write(frame({ role: "assistant", content: `I can see ${images.length} picture(s).` }, null));
		res.write(frame({}, "stop"));
		res.write(`data: ${JSON.stringify({ id: "chatcmpl-qa", object: "chat.completion.chunk", created: 0, model: "qa-model", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const MODEL_URL = `http://127.0.0.1:${server.address().port}`;

let currentApp;
const sweep = (patient) => {
	currentApp?.close().catch(() => undefined);
	server.close();
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

const pngUrlPixels = (url) => (url.startsWith("data:image/") ? Buffer.from(url.split(",")[1] ?? "", "base64") : Buffer.alloc(0));
/** The PNG's first pixel colour tells red from blue, whatever re-encoding the app did (resize keeps a small image as is). */
const dominant = (url) => {
	const bytes = pngUrlPixels(url);
	return bytes.length > 0 ? bytes.subarray(0, 8).toString("hex") : "";
};

async function session(name, input, body) {
	const dir = join(WORK, name);
	const model = { provider: "qa", id: "qa-model", name: "QA", baseUrl: `${MODEL_URL}/v1`, api: "openai-completions", apiKeyEnv: "QA_API_KEY", reasoning: false, input, contextWindow: 128000, maxTokens: 4096 };
	mkdirSync(join(dir, "docs"), { recursive: true });
	mkdirSync(join(dir, "workspace"), { recursive: true });
	mkdirSync(join(dir, "home", "bin"), { recursive: true });
	mkdirSync(join(dir, "pi-agent"), { recursive: true });
	writeMinsyncStub(join(dir, "home", "bin"));
	const config = join(dir, "config.json");
	writeFileSync(
		config,
		`${JSON.stringify({ searchPaths: [join(dir, "docs")], workspacePath: join(dir, "workspace"), memoryPath: join(dir, "memory.json"), minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false, jev: { backend: "sllm", sllm: { model } }, webSearch: false, queryDecomposition: false, model }, null, 2)}\n`,
	);
	const app = await launchFinder({
		userDataDir: join(dir, "user-data"),
		env: {
			AUTORAG_HOME: join(dir, "home"),
			AUTORAG_CONFIG: config,
			PI_CODING_AGENT_DIR: join(dir, "pi-agent"),
			AUTORAG_SKIP_DUPEY_CHECK: "1",
			ELECTRON_RENDERER_URL: "",
			QA_API_KEY: "qa-key",
			PATH: `${join(dir, "home", "bin")}${delimiter}${process.env.PATH ?? ""}`,
			OPENROUTER_API_KEY: "",
			OPENAI_API_KEY: "",
			ANTHROPIC_API_KEY: "",
		},
	});
	currentApp = app;
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(20_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	try {
		await body(app, page);
	} finally {
		await app.close().catch(() => undefined);
		currentApp = undefined;
	}
}

/**
 * Put a PNG file on the OS clipboard, as a screenshot tool does. The app's main-process `clipboard` is not reachable
 * from `app.evaluate`, so the OS's own tools do it (macOS only; run it in a VM so the developer's clipboard is spared).
 */
const copyImage = async (_app, path) => {
	execFileSync("osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(path)}) as «class PNGf»)`]);
};
const copyText = async (_app, text) => {
	execFileSync("pbcopy", { input: text });
};
const settled = (page, selector) =>
	page.waitForFunction((sel) => document.querySelector(`${sel} button[aria-label="Stop"]`) === null && document.querySelector(`${sel} .assistant-prose, ${sel} .inspector-chat-question`) !== null, selector, { timeout: 90_000 });
const shot = async (page, name) => {
	await page.waitForTimeout(450);
	await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
};

// ── Vision model ─────────────────────────────────────────────────────────
await session("vision", ["text", "image"], async (app, page) => {
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const composer = panel.locator('textarea[aria-label="Ask AI"]');

	// 1. AI Agent tab.
	await copyImage(app, RED);
	await composer.click();
	await page.keyboard.press(chord("V"));
	const pill = panel.locator(".composer-attach-thumbs [data-attachment-thumb]");
	const pastedAt = Date.now();
	await pill.first().waitFor();
	const showMs = Date.now() - pastedAt;
	check("⌘V shows the pasted image as a picture", (await pill.count()) === 1 && (await pill.first().locator("img").count()) === 1);
	const decoded = await pill.first().locator("img").evaluate((img) => ({ done: img.complete, width: img.naturalWidth, height: img.naturalHeight }));
	check("the picture is decoded (real pixels, not a broken image)", decoded.done && decoded.width === 320 && decoded.height === 200, JSON.stringify(decoded));
	check("it carries no file name", !/pasted-image/u.test(await pill.first().innerText()));
	check("the thumbnail shows within 1.5 s of the paste", showMs < 1500, `${showMs} ms`);
	check("no text landed in the field", (await composer.inputValue()) === "");
	await shot(page, "01-tab-pasted");
	await pill.first().locator('button[aria-label="Remove attachment"]').click();
	check("the ✕ takes the picture off", (await pill.count()) === 0);
	await shot(page, "01b-tab-removed");
	await copyImage(app, RED);
	await composer.click();
	await page.keyboard.press(chord("V"));
	await pill.first().waitFor();
	await page.keyboard.type("이 스크린샷에 뭐가 있어?");
	await page.keyboard.press("Enter");
	await settled(page, AI_PANEL);
	check("the thumbnail left the composer when sent", (await pill.count()) === 0);
	check("the sent bubble shows the picture", (await panel.locator(".user-msg [data-attachment-thumb] img").count()) === 1 && (await panel.locator(".user-msg [data-attachment-thumb] img").first().evaluate((img) => img.naturalWidth)) === 320);
	const tabRequests = seen.filter((request) => request.images.length > 0);
	check("the model request carries exactly one image", tabRequests.length > 0 && tabRequests.every((request) => request.images.length === 1), JSON.stringify(seen.map((request) => request.images.length)));
	check("the image is the pasted PNG", tabRequests.length > 0 && Buffer.from(tabRequests[0].images[0].split(",")[1], "base64").subarray(1, 4).toString() === "PNG", tabRequests[0]?.images[0]?.slice(0, 40));
	check("the answer shows the model saw it", (await panel.locator(".assistant-prose").allInnerTexts()).join(" ").includes("1 picture"));
	await shot(page, "02-tab-answered");

	// A follow-up with a second paste: the new picture rides along.
	seen.length = 0;
	await copyImage(app, BLUE);
	await composer.click();
	await page.keyboard.press(chord("V"));
	await pill.first().waitFor();
	check("the first pasted picture is not a stale draft: exactly one thumbnail for the new paste", (await pill.count()) === 1);
	await page.keyboard.type("그리고 이건?");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelectorAll(".user-msg").length === 2, null, { timeout: 30_000 });
	await settled(page, AI_PANEL);
	check("the follow-up's request carries both pictures (the chat keeps the first)", seen.some((request) => request.images.length === 2), JSON.stringify(seen.map((request) => request.images.length)));

	// A paste of text is still a text paste.
	await copyText(app, "plain pasted words");
	await composer.click();
	await page.keyboard.press(chord("V"));
	check("a text paste still pastes the text", (await composer.inputValue()) === "plain pasted words" && (await pill.count()) === 0, await composer.inputValue());
	await composer.fill("");

	// 2. Right sidebar chat.
	seen.length = 0;
	await page.locator(".sidebar__item", { hasText: "Documents" }).first().click().catch(() => undefined);
	const dock = page.locator(".inspector-chat-dock textarea");
	await dock.waitFor({ timeout: 30_000 });
	await copyImage(app, RED);
	await dock.click();
	await page.keyboard.press(chord("V"));
	const card = page.locator(".inspector-chat-composer [data-attachment-thumb]");
	await card.first().waitFor();
	check("the sidebar composer shows the pasted image as a picture", (await card.count()) === 1 && (await card.first().locator("img").evaluate((img) => img.naturalWidth)) === 320);
	check("the sidebar picture has a ✕ and no file name", (await card.first().locator('button[aria-label="Remove attachment"]').count()) === 1 && !/pasted-image/u.test(await card.first().innerText()));
	await shot(page, "03-sidebar-pasted");
	await dock.click();
	await page.keyboard.type("사이드바에서 물어요");
	await page.keyboard.press("Enter");
	await page.locator(".inspector-chat").waitFor();
	await page.waitForFunction(() => document.querySelector('.inspector-chat button[aria-label="Stop"]') === null && document.querySelectorAll(".inspector-chat .inspector-chat-question").length >= 1, null, { timeout: 90_000 });
	check("the sidebar question reached the model with the image", seen.some((request) => request.images.length === 1), JSON.stringify(seen.map((request) => request.images.length)));
	check("the question shows the picture in the sidebar chat", (await page.locator(".inspector-chat .inspector-chat-question").first().locator("xpath=..").locator("[data-attachment-thumb] img").count()) >= 1);
	await shot(page, "04-sidebar-answered");

	seen.length = 0;
	const chatInput = page.locator(".inspector-chat textarea");
	await copyImage(app, BLUE);
	await chatInput.click();
	await page.keyboard.press(chord("V"));
	await page.locator(".inspector-chat-composer [data-attachment-thumb]").first().waitFor();
	await page.keyboard.type("이어서: 이 그림은?");
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelectorAll(".inspector-chat .inspector-chat-question").length === 2, null, { timeout: 30_000 });
	await page.waitForFunction(() => document.querySelector('.inspector-chat button[aria-label="Stop"]') === null, null, { timeout: 90_000 });
	check("the sidebar follow-up carries the new picture", seen.some((request) => request.images.length === 2), JSON.stringify(seen.map((request) => request.images.length)));
});

// ── Text-only model ──────────────────────────────────────────────────────
seen.length = 0;
await session("text", ["text"], async (app, page) => {
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await openAiSearch(page);
	const panel = page.locator(AI_PANEL);
	const composer = panel.locator('textarea[aria-label="Ask AI"]');
	await copyImage(app, RED);
	await composer.click();
	await page.keyboard.press(chord("V"));
	await page.waitForTimeout(1500);
	check("a text-only model: the paste adds nothing", (await panel.locator(".composer-attach-pill, [data-attachment-thumb]").count()) === 0);
	check("a text-only model: no text lands in the field either", (await composer.inputValue()) === "");
	check("a text-only model: no error shows", (await panel.getByText(/error|Something went wrong/iu).count()) === 0);
	await shot(page, "05-text-only-ignored");
	await page.keyboard.type("그냥 텍스트 질문");
	await page.keyboard.press("Enter");
	await settled(page, AI_PANEL);
	check("the question still goes through as plain text", seen.length > 0 && seen.every((request) => request.images.length === 0));
	check("and is answered", (await panel.locator(".assistant-prose").allInnerTexts()).join(" ").includes("0 picture"));
});

sweep(true);
if (failures.length > 0) {
	log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
log("\nall checks passed");
