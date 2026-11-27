/**
 * Manual QA — steering a running AI Chat (issue #176), in the real app.
 *
 * Deterministic lane: replaces main's `search:start` / `search:steer` /
 * `search:cancel` handlers with a scripted run that the lane drives step by
 * step (no model, no network), so the real renderer, preload bridge, and IPC
 * path run while the timing is exact. With real keyboard input it checks:
 *
 *   1. the composer stays enabled while a search runs, with its usual placeholder and no key hint;
 *   2. Enter before the Quick answer holds the message (dimmed, 미루기 / 취소) and, sorted as a correction, sends it
 *      after the hold; it turns solid once the run reports delivery, and copies under the pointer;
 *   3. Enter after the Quick answer places the correction between Quick and Deep;
 *   4. a correction still waiting when the run ends is struck through;
 *   5. a message sorted as the next question, ⌥Enter, and a refused correction wait as dashed bubbles (지금 반영 /
 *      수정 / 삭제); the first is asked once the run ends;
 *   6. a held correction can be cancelled or postponed;
 *   7. Esc stops the whole run and puts what was waiting back in the composer.
 *
 * Screenshots land in .omo/evidence/ai-finder-app/qa-ai-search-steer/.
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-steer.mjs
 * Prereq: bun run build.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-steer");
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

const RUN_ID = `ulw-ai-steer-qa-${Date.now().toString(36)}`;
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

// The app's AutoRAG home points into the temp dir: the real ~/.autorag is never read or written.
app = await launchFinder({
	userDataDir: USER_DATA,
	env: { AUTORAG_HOME: join(HOME, ".autorag"), AUTORAG_CONFIG: join(HOME, ".autorag", "config.json") },
});
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));

// A scripted search backend in main. The lane emits events and settles runs through `qa(...)`.
await app.evaluate(({ ipcMain, BrowserWindow }) => {
	const state = { runs: new Map(), steers: [], refuseNextSteer: false, starts: [], kind: "steer" };
	const send = (payload) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.webContents.getURL().includes("index.html")) window.webContents.send("search:event", payload);
		}
	};
	for (const channel of ["search:start", "search:steer", "search:cancel", "search:classifyFollowUp"]) ipcMain.removeHandler(channel);
	ipcMain.handle("search:classifyFollowUp", () => state.kind);
	ipcMain.handle("search:start", (_event, searchId, _chatId, query) => {
		state.starts.push(query);
		return new Promise((resolve) => state.runs.set(searchId, { resolve, query }));
	});
	ipcMain.handle("search:steer", (_event, searchId, text) => {
		if (!state.runs.has(searchId) || state.refuseNextSteer) {
			state.refuseNextSteer = false;
			return false;
		}
		state.steers.push(text);
		return true;
	});
	ipcMain.handle("search:cancel", (_event, searchId) => {
		const run = state.runs.get(searchId);
		state.runs.delete(searchId);
		send({ type: "cancelled", searchId });
		run?.resolve();
	});
	globalThis.__qaSteer = {
		state,
		current: () => [...state.runs.keys()].at(-1),
		emit: (event) => send({ ...event, searchId: [...state.runs.keys()].at(-1) }),
		finish: () => {
			const searchId = [...state.runs.keys()].at(-1);
			const run = state.runs.get(searchId);
			state.runs.delete(searchId);
			send({ type: "done", searchId });
			run?.resolve();
		},
	};
});
const qa = (action, arg) =>
	app.evaluate(
		(_electron, [name, value]) => {
			const steer = globalThis.__qaSteer;
			if (name === "emit") return steer.emit(value);
			if (name === "finish") return steer.finish();
			if (name === "refuse") {
				steer.state.refuseNextSteer = true;
				return null;
			}
			if (name === "kind") {
				steer.state.kind = value;
				return null;
			}
			if (name === "state") return { steers: steer.state.steers, starts: steer.state.starts, running: steer.state.runs.size };
			return null;
		},
		[action, arg],
	);
const phase = (answer) => ({ answer, evidence: [] });
const waitFor = async (predicate, label, timeoutMs = 5000) => {
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
const composer = panel.locator('textarea[aria-label="Ask AI"]');
const steerBubbles = panel.locator(".steer-msg");
log("app ready");

// ── 1. A run starts; the composer stays live. ─────────────────────────────
await composer.click();
await page.keyboard.type("When is the Dazzi v2 launch?");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).running === 1, "run start");
check("the composer stays enabled while the search runs", await composer.isEnabled());
const placeholder = await composer.getAttribute("placeholder");
check("the composer keeps its usual placeholder while searching", /Dazzi/u.test(placeholder ?? ""), placeholder ?? "");
check("no key hint sits over the composer", (await panel.locator(".steer-hint").count()) === 0);
await page.screenshot({ path: join(EVIDENCE, "01-searching-composer.png") });

// ── 2. Steer before the Quick answer. ─────────────────────────────────────
await composer.click();
await page.keyboard.type("Only the June planning notes.");
await page.keyboard.press("Enter");
const firstSteer = steerBubbles.nth(0);
await firstSteer.waitFor();
check("the message is held first, not sent", (await firstSteer.getAttribute("data-steer-status")) === "held" && (await qa("state")).steers.length === 0, JSON.stringify(await qa("state")));
check("a held correction offers postpone and cancel", (await firstSteer.locator("button").count()) === 2);
await firstSteer.locator("button").first().hover();
await page.waitForTimeout(300);
await page.screenshot({ path: join(EVIDENCE, "02-steer-held.png") });
await waitFor(async () => (await qa("state")).steers.length === 1, "first steer");
check("after the hold the correction is sent, and no new search starts", JSON.stringify((await qa("state")).steers) === JSON.stringify(["Only the June planning notes."]) && (await qa("state")).starts.length === 1, JSON.stringify(await qa("state")));
check("the composer clears after a steer", (await composer.inputValue()) === "");
check("a sent steer waits, with nothing to press", (await firstSteer.getAttribute("data-steer-status")) === "pending" && (await firstSteer.locator("button").count()) === 0);
await page.mouse.move(5, 5);
await page.waitForTimeout(400);
await page.screenshot({ path: join(EVIDENCE, "02b-steer-pending-before-quick.png") });

await qa("emit", { type: "steer-delivered" });
await waitFor(async () => (await firstSteer.getAttribute("data-steer-status")) === "delivered", "delivery");
check("delivery offers copy under the bubble", (await firstSteer.locator("button").count()) === 1);
const copyOpacity = () => firstSteer.locator(".bubble-actions").evaluate((row) => getComputedStyle(row).opacity);
check("copy is hidden until the pointer is on the bubble", (await copyOpacity()) === "0", await copyOpacity());
await firstSteer.locator(".steer-bubble").hover();
await page.waitForTimeout(300);
check("copy shows under the pointer", (await copyOpacity()) === "1", await copyOpacity());
await page.screenshot({ path: join(EVIDENCE, "02c-copy-on-hover.png") });
await page.mouse.move(5, 5);
await qa("emit", { type: "quick", sessionId: "s", phase: phase("- The June plan targets **July 14** for the v2 launch.") });
await panel.locator(".assistant-prose").first().waitFor();
const order = await panel.evaluate((root) => {
	const quick = root.querySelector(".assistant-prose");
	const steer = root.querySelector(".steer-msg");
	return quick !== null && steer !== null && Boolean(steer.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING);
});
check("a steer sent before the Quick answer sits above it", order);
await page.screenshot({ path: join(EVIDENCE, "03-steer-delivered-quick.png") });

// ── 3. Steer after the Quick answer. ──────────────────────────────────────
await composer.click();
await page.keyboard.type("Answer in Korean.");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).steers.length === 2, "second steer");
const afterQuickInAssistant = await panel.locator(".assistant-msg .steer-msg").count();
check("a steer sent after the Quick answer sits between Quick and Deep", afterQuickInAssistant === 1, `in assistant turn: ${afterQuickInAssistant}`);
await page.waitForTimeout(400);
await page.screenshot({ path: join(EVIDENCE, "04-after-quick-pending.png") });

// ── 4. The run ends with that steer still waiting. ────────────────────────
await qa("emit", { type: "deep", sessionId: "s", phase: phase("**정정**: 7월 14일로 확인되었습니다.") });
await qa("finish");
await waitFor(async () => (await steerBubbles.nth(1).getAttribute("data-steer-status")) === "dropped", "dropped steer");
check("a steer the run never took is struck through", (await steerBubbles.nth(1).getAttribute("data-steer-status")) === "dropped");
check("the delivered steer stays Applied after the run", (await steerBubbles.nth(0).getAttribute("data-steer-status")) === "delivered");
// The bubble's colors ease over --dur-color; capture the settled state.
await page.waitForTimeout(400);
await page.screenshot({ path: join(EVIDENCE, "05-run-ended-dropped-steer.png") });

// ── 5. What waits: sorted as next, ⌥Enter, and a refused correction. ───────
await composer.click();
await page.keyboard.type("Who owns the launch checklist?");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).running === 1, "second run");
await qa("kind", "next");
await composer.click();
await page.keyboard.type("What blocks the launch?");
await page.keyboard.press("Enter");
await panel.locator(".queued-question").waitFor();
check("a message sorted as the next question waits at once", (await qa("state")).steers.length === 2 && (await panel.locator(".queued-question").innerText()).includes("blocks the launch"));
await qa("kind", "steer");
await composer.click();
await page.keyboard.type("Which risks are open?");
await page.keyboard.press("Alt+Enter");
await waitFor(async () => (await panel.locator(".queued-question").count()) === 2, "alt-enter queued");
await qa("refuse");
await composer.click();
await page.keyboard.type("Also list the owners.");
await page.keyboard.press("Enter");
await waitFor(async () => (await panel.locator(".queued-question").count()) === 3, "refused steer queued", 8000);
check("a correction the run refuses waits as the next question", (await panel.locator(".queued-question").nth(2).innerText()).includes("owners"));
check("a waiting question offers send now, edit and delete", (await panel.locator(".queued-question").first().locator("button").count()) === 3);
await panel.locator(".queued-question").first().locator("button").first().hover();
await page.waitForTimeout(300);
await page.screenshot({ path: join(EVIDENCE, "06-queued-questions.png") });
await panel.locator(".queued-question").nth(1).locator("button").nth(2).click();
check("delete removes a waiting question", (await panel.locator(".queued-question").count()) === 2);

// ── 6. A held correction can be cancelled or postponed. ───────────────────
const before = (await qa("state")).steers.length;
await composer.click();
await page.keyboard.type("Never mind this one.");
await page.keyboard.press("Enter");
const held = panel.locator('.steer-msg[data-steer-status="held"]');
await held.waitFor();
await held.locator("button").nth(1).click();
await page.waitForTimeout(3600);
check("a cancelled correction is never sent", (await qa("state")).steers.length === before && (await held.count()) === 0);
await composer.click();
await page.keyboard.type("Ask this after.");
await page.keyboard.press("Enter");
await held.waitFor();
await held.locator("button").first().click();
check("a postponed correction waits as the next question", (await panel.locator(".queued-question").count()) === 3 && (await panel.locator(".queued-question").nth(2).innerText()).includes("Ask this after"));
await panel.locator(".queued-question").nth(2).locator("button").nth(2).click();
await qa("finish");
await waitFor(async () => (await qa("state")).starts.length === 3, "queued question starts");
check("the first waiting question is asked once the run ends", (await qa("state")).starts[2] === "What blocks the launch?", JSON.stringify((await qa("state")).starts));

// ── 6. Esc stops the run; the remaining queued question returns to the composer. ──
await page.keyboard.press("Escape");
await waitFor(async () => (await qa("state")).running === 0, "stop");
await page.waitForTimeout(300);
check("Esc stops the run", (await qa("state")).running === 0 && (await panel.innerText()).includes("Generation stopped."));
check("questions queued behind a stopped run go back to the composer", (await composer.inputValue()).includes("Also list the owners."), await composer.inputValue());
check("nothing queued is asked after Stop", (await qa("state")).starts.length === 3);
await page.screenshot({ path: join(EVIDENCE, "07-stopped-queue-restored.png") });

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
