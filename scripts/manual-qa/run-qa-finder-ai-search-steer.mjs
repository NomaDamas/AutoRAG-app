/**
 * Manual QA — steering a running AI Search (issue #176), in the real app.
 *
 * Deterministic lane: replaces main's `search:start` / `search:steer` /
 * `search:cancel` handlers with a scripted run that the lane drives step by
 * step (no model, no network), so the real renderer, preload bridge, and IPC
 * path run while the timing is exact. With real keyboard input it checks:
 *
 *   1. the composer stays enabled while a search runs, with a steering hint
 *      and placeholder;
 *   2. Enter before the Quick answer sends a steer: a user bubble above the
 *      Quick answer that waits (dashed, pulsing) until the run reports
 *      delivery, then shows "Applied" with a check;
 *   3. Enter after the Quick answer places the steer between Quick and Deep;
 *   4. ⌥Enter queues a "Next question" chip instead of steering; it is asked
 *      once the run ends;
 *   5. a steer the run refuses becomes the next question;
 *   6. a steer still waiting when the run ends is struck through;
 *   7. Esc stops the whole run and puts queued questions back in the composer.
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
	const state = { runs: new Map(), steers: [], refuseNextSteer: false, starts: [] };
	const send = (payload) => {
		for (const window of BrowserWindow.getAllWindows()) {
			if (window.webContents.getURL().includes("index.html")) window.webContents.send("search:event", payload);
		}
	};
	for (const channel of ["search:start", "search:steer", "search:cancel"]) ipcMain.removeHandler(channel);
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
const composer = panel.locator('textarea[aria-label="Ask Dazzi"]');
const steerBubbles = panel.locator(".steer-msg");
log("app ready");

// ── 1. A run starts; the composer stays live. ─────────────────────────────
await composer.click();
await page.keyboard.type("When is the Dazzi v2 launch?");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).running === 1, "run start");
check("the composer stays enabled while the search runs", await composer.isEnabled());
const placeholder = await composer.getAttribute("placeholder");
check("the composer invites a correction while searching", /wrong way|Correct/iu.test(placeholder ?? ""), placeholder ?? "");
check("a hint names Enter / ⌥Enter / Esc", (await panel.locator(".steer-hint").innerText()).includes("Esc"), await panel.locator(".steer-hint").innerText());
await page.screenshot({ path: join(EVIDENCE, "01-searching-composer.png") });

// ── 2. Steer before the Quick answer. ─────────────────────────────────────
await composer.click();
await page.keyboard.type("Only the June planning notes.");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).steers.length === 1, "first steer");
check("Enter during a search steers it, it does not start a new search", JSON.stringify((await qa("state")).steers) === JSON.stringify(["Only the June planning notes."]) && (await qa("state")).starts.length === 1, JSON.stringify(await qa("state")));
check("the composer clears after a steer", (await composer.inputValue()) === "");
const firstSteer = steerBubbles.nth(0);
check("the steer shows as a waiting bubble", (await firstSteer.getAttribute("data-steer-status")) === "pending");
check("the waiting bubble says it goes in at the next step", (await firstSteer.locator(".steer-status").innerText()).includes("next step"), await firstSteer.locator(".steer-status").innerText());
await page.waitForTimeout(400);
await page.screenshot({ path: join(EVIDENCE, "02-steer-pending-before-quick.png") });

await qa("emit", { type: "steer-delivered" });
await waitFor(async () => (await firstSteer.getAttribute("data-steer-status")) === "delivered", "delivery");
check("delivery turns the bubble into Applied", (await firstSteer.locator(".steer-status").innerText()).includes("Applied"), await firstSteer.locator(".steer-status").innerText());
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
check("the composer leaves steering mode once the run ends", (await panel.locator(".steer-hint").count()) === 0);
// The bubble's colors ease over --dur-color; capture the settled state.
await page.waitForTimeout(400);
await page.screenshot({ path: join(EVIDENCE, "05-run-ended-dropped-steer.png") });

// ── 5. ⌥Enter queues; a refused steer queues too; both are asked in order. ──
await composer.click();
await page.keyboard.type("Who owns the launch checklist?");
await page.keyboard.press("Enter");
await waitFor(async () => (await qa("state")).running === 1, "second run");
await composer.click();
await page.keyboard.type("What blocks the launch?");
await page.keyboard.press("Alt+Enter");
await panel.locator(".queued-question").waitFor();
check("⌥Enter queues the next question instead of steering", (await qa("state")).steers.length === 2 && (await panel.locator(".queued-question").innerText()).includes("blocks the launch"));
await qa("refuse");
await composer.click();
await page.keyboard.type("Also list the owners.");
await page.keyboard.press("Enter");
await waitFor(async () => (await panel.locator(".queued-question").count()) === 2, "refused steer queued");
check("a steer the run refuses is queued as the next question", (await panel.locator(".queued-question").nth(1).innerText()).includes("owners"));
await page.waitForTimeout(300);
await page.screenshot({ path: join(EVIDENCE, "06-queued-questions.png") });
await qa("finish");
await waitFor(async () => (await qa("state")).starts.length === 3, "queued question starts");
check("the first queued question is asked once the run ends", (await qa("state")).starts[2] === "What blocks the launch?", JSON.stringify((await qa("state")).starts));

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
