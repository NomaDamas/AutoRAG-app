/**
 * Manual QA — the librarian corrects the first answer (`revision` events, AutoRAG#2186).
 *
 * Deterministic lane: replaces main's `search:start` / `search:cancel` handlers with a scripted backend that emits the
 * stream the way the librarian does (quick, one `revision` per correction, deep), so the real renderer is what is
 * checked. With real keyboard and mouse input in an isolated profile:
 *
 *   1. a replaced claim shows the struck words beside the new ones, with the reason as its tooltip and the line that
 *      says the answer was corrected;
 *   2. after the motion the struck words are gone and the new words stay marked;
 *   3. a retracted claim stays struck, and the new citation opens the source the final answer sent;
 *   4. a run that corrects nothing draws as it always did.
 *
 * Not covered here: reading a corrected chat back from history. The scripted backend replaces `search:start`, so
 * nothing reaches the chat store; that path is covered by test/search-service.test.ts and test/ui-answer-revision.test.tsx.
 *
 * Screenshots land in .omo/evidence/ai-finder-app/qa-ai-search-revision/.
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-revision.mjs
 * Prereq: bun run build.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-revision");
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

const RUN_ID = `ulw-ai-revision-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const HOME = join(tmpdir(), `${RUN_ID}-home`);
mkdirSync(join(HOME, ".autorag"), { recursive: true });

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	for (const dir of [USER_DATA, HOME]) {
		try {
			if (patient === true) rmRetry(dir);
			else rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			log(`cleanup: ${dir} stayed behind (${error.code ?? error.message})`);
		}
	}
};
process.on("exit", () => sweep(false));

app = await launchFinder({
	userDataDir: USER_DATA,
	env: { AUTORAG_HOME: join(HOME, ".autorag"), AUTORAG_CONFIG: join(HOME, ".autorag", "config.json") },
});
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));

await app.evaluate(({ ipcMain, BrowserWindow }) => {
	const state = { runs: new Map(), starts: [] };
	const send = (payload) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.webContents.getURL().includes("index.html")) window.webContents.send("search:event", payload);
		}
	};
	for (const channel of ["search:start", "search:steer", "search:cancel"]) ipcMain.removeHandler(channel);
	ipcMain.handle("search:start", (_event, searchId, chatId, query) => {
		state.starts.push({ chatId, query });
		return new Promise((resolve) => state.runs.set(searchId, { resolve }));
	});
	ipcMain.handle("search:steer", () => false);
	ipcMain.handle("search:cancel", () => undefined);
	globalThis.__qaRevision = {
		state,
		quick: ({ text, evidence }) => {
			const searchId = [...state.runs.keys()].at(-1);
			send({ type: "quick", searchId, sessionId: "s", phase: { answer: text, evidence } });
		},
		revision: (revision) => {
			const searchId = [...state.runs.keys()].at(-1);
			send({ type: "revision", searchId, revision });
		},
		finish: ({ deep }) => {
			const searchId = [...state.runs.keys()].at(-1);
			if (deep !== null) send({ type: "deep", searchId, sessionId: "s", phase: deep });
			send({ type: "done", searchId });
			state.runs.get(searchId)?.resolve();
			state.runs.delete(searchId);
		},
	};
});
const starts = () => app.evaluate(() => globalThis.__qaRevision.state.starts);
const call = (name, payload) => app.evaluate((_electron, [fn, value]) => globalThis.__qaRevision[fn](value), [name, payload]);
const waitFor = async (predicate, label, timeoutMs = 8000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return true;
		await page.waitForTimeout(50);
	}
	log(`timeout waiting for ${label}`);
	return false;
};

await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);
const panel = page.locator(AI_PANEL);
const composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
const ask = async (text, expectedStarts) => {
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await waitFor(async () => (await starts()).length === expectedStarts, `run ${expectedStarts} start`);
};
const ev = (number, title, excerpt) => ({ number, title, summary: `${title} summary`, source: `/tmp/${title}`, excerpts: [excerpt], confidence: 0.9 });
const CORRECTED = /Corrected the answer|답을 고쳤어요|回答を修正しました|已更正回答/u;
const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';

const FIRST = "- 환불은 팀장 승인이 필요합니다 [1]\n- 한도는 50만 원입니다 [2]\n- 지급은 다음 달 25일입니다 [3]";
const replace = { op: "replace", claimId: "c1", original: "- 환불은 팀장 승인이 필요합니다 [1]", replacement: "- 환불은 이사 승인이 필요합니다 [4]", reason: "2026년 개정" };
const retract = { op: "retract", claimId: "c3", original: "- 지급은 다음 달 25일입니다 [3]", reason: "근거 없음" };

// 1. A correction arrives while the person watches.
await ask("환불 승인은 누가 하나요?", 1);
await call("quick", { text: FIRST, evidence: [ev(1, "old-policy.md", "팀장 승인"), ev(2, "limits.md", "한도 50만 원"), ev(3, "payout.md", "25일 지급")] });
await waitFor(async () => (await panel.locator(".assistant-prose").count()) === 1, "quick answer");
await page.screenshot({ path: join(EVIDENCE, "01-quick-answer.png") });
await call("revision", replace);
await waitFor(async () => (await panel.locator(".assistant-prose del").count()) === 1, "struck words");
const during = {
	del: await panel.locator(".assistant-prose del").allInnerTexts(),
	ins: await panel.locator(".assistant-prose ins").allInnerTexts(),
	title: await panel.locator("[data-revision=replace]").getAttribute("title"),
	head: await panel.locator(".assistant-prose").first().innerText(),
};
check("the struck words stand beside the new ones", during.del[0] === "환불은 팀장 승인이 필요합니다" && during.ins[0]?.startsWith("환불은 이사 승인이 필요합니다"), JSON.stringify(during));
check("the reason is the correction's tooltip", during.title === "2026년 개정", during.title);
check("the answer says it was corrected", CORRECTED.test(during.head), during.head.slice(0, 40));
check("the unchanged claims stay as they were", during.head.includes("한도는 50만 원입니다") && during.head.includes("지급은 다음 달 25일입니다"));
await page.screenshot({ path: join(EVIDENCE, "02-correction-arrives.png") });

await call("revision", retract);
await call("finish", { deep: { answer: "", evidence: [ev(4, "new-policy.md", "이사 승인 (2026년 개정)")] } });
await waitFor(async () => (await panel.locator(".assistant-prose del").count()) === 2, "both corrections drawn");

// 2. The motion ends: the replaced words leave, the retracted claim stays struck.
await waitFor(async () => (await panel.locator("[data-revision=replace] del").count()) === 0, "struck words collapse", 6000);
const settled = {
  replaceDel: await panel.locator("[data-revision=replace] del").count(),
  replaceIns: await panel.locator("[data-revision=replace] ins").getAttribute("data-settled"),
  retractDel: await panel.locator("[data-revision=retract] del").allInnerTexts(),
};
check("the replaced words leave once the change has settled", settled.replaceDel === 0 && settled.replaceIns === "true", JSON.stringify(settled));
check("a retracted claim stays struck", settled.retractDel[0] === "지급은 다음 달 25일입니다", JSON.stringify(settled.retractDel));
await page.screenshot({ path: join(EVIDENCE, "03-settled.png") });

// 3. The new citation opens the source only the final answer sent.
await panel.locator("[data-revision=replace] ins .cite", { hasText: /^4$/ }).click();
await waitFor(async () => ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("new-policy.md"), "new citation opens");
check("the new citation opens the source the final answer sent", ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("new-policy.md"), await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent());
check("only one answer is shown: the final answer added nothing", (await panel.locator(".assistant-prose").count()) === 1, String(await panel.locator(".assistant-prose").count()));

// 4. A run that corrects nothing draws as it always did.
await ask("한도는요?", 2);
await call("quick", { text: "한도는 50만 원입니다 [1]", evidence: [ev(1, "limits.md", "한도 50만 원")] });
await call("finish", { deep: null });
await waitFor(async () => (await panel.locator(".assistant-prose").count()) === 2, "second answer");
check("an answer nobody corrected carries no correction marks", (await panel.locator(".assistant-prose").nth(1).locator("[data-revision]").count()) === 0);
check("and says nothing was corrected", !CORRECTED.test(await panel.locator(".assistant-prose").nth(1).innerText()));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
