/**
 * Manual QA — a follow-up question continues the same AI Search chat.
 *
 * Deterministic lane: replaces main's `search:start` / `search:cancel` handlers
 * with a scripted backend that records the chat id of every run and settles
 * runs on command (no model, no network). With real keyboard and mouse input:
 *
 *   1. a question, once answered, is followed by a second question typed
 *      straight into the composer: both runs carry the same chat id and the
 *      first question and answer stay on screen above the second;
 *   2. a third follow-up keeps appending to the same conversation;
 *   3. only the New chat button clears the conversation, and the next
 *      question gets a new chat id.
 *
 * Screenshots land in .omo/evidence/ai-finder-app/qa-ai-search-follow-up/.
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-follow-up.mjs
 * Prereq: bun run build.
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-follow-up");
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

const RUN_ID = `ulw-ai-follow-up-qa-${Date.now().toString(36)}`;
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
	globalThis.__qaFollow = {
		state,
		answer: ({ text, quickEvidence = [], deep = null }) => {
			const searchId = [...state.runs.keys()].at(-1);
			send({ type: "quick", searchId, sessionId: "s", phase: { answer: text, evidence: quickEvidence } });
			if (deep !== null) {
				send({ type: "deep", searchId, sessionId: "s", phase: deep });
			}
			send({ type: "done", searchId });
			state.runs.get(searchId)?.resolve();
			state.runs.delete(searchId);
		},
	};
});
const starts = () => app.evaluate(() => globalThis.__qaFollow.state.starts);
const answer = (payload) =>
	app.evaluate((_electron, value) => globalThis.__qaFollow.answer(typeof value === "string" ? { text: value } : value), payload);
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
const composer = panel.locator('input[aria-label="Ask Dazzi"]');
const ask = async (text, expectedStarts) => {
	await composer.click();
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
	await waitFor(async () => (await starts()).length === expectedStarts, `run ${expectedStarts} start`);
};
const bubbles = () => panel.locator(".user-msg .bubble").allInnerTexts();
const proses = () => panel.locator(".assistant-prose").allInnerTexts();

const ev = (number, title, excerpt) => ({
	number,
	title,
	summary: `${title} summary`,
	source: `/tmp/${title}`,
	excerpts: [excerpt],
	confidence: 0.9,
});
const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';

// 1. Question, answer (with Quick [1..4] and Deep [1..2]), then a follow-up typed into the same composer.
await ask("When is the Dazzi v2 launch?", 1);
await answer({
	text: "The launch is on July 14 [1][2][3][4].",
	quickEvidence: [
		ev(1, "launch-plan.md", "Launch target: July 14."),
		ev(2, "owner-matrix.md", "Owner: Jeffrey."),
		ev(3, "budget-q3.csv", "Budget: 3.8B."),
		ev(4, "readme.md", "General overview."),
	],
	deep: {
		answer: "**Verified**: July 14 confirmed by owner matrix [1] and launch plan [2].",
		evidence: [
			ev(1, "owner-matrix.md", "Verified owner matrix."),
			ev(2, "launch-plan.md", "Verified launch plan."),
		],
	},
});
await waitFor(async () => (await proses()).length === 2, "first turn quick+deep answers");
await page.screenshot({ path: join(EVIDENCE, "01-first-answer.png") });
await ask("And who owns it?", 2);
const [first, second] = await starts();
check("the follow-up runs in the same chat as the first question", first.chatId === second.chatId, JSON.stringify([first.chatId, second.chatId]));
check("the follow-up's text reaches the backend", second.query === "And who owns it?", second.query);
check(
	"the first question and answer stay on screen above the follow-up",
	JSON.stringify(await bubbles()) === JSON.stringify(["When is the Dazzi v2 launch?", "And who owns it?"]) &&
		(await proses()).join("|").includes("July 14"),
	JSON.stringify({ bubbles: await bubbles(), proses: await proses() }),
);
// Turn 2 has Quick citations [1..2] and an empty Deep evidence array [] (testing the q>0, d=0 case).
await answer({
	text: "Jeffrey owns it [1][2].",
	quickEvidence: [
		ev(1, "team-roster.md", "Jeffrey leads v2."),
		ev(2, "org-chart.pdf", "Reporting line."),
	],
	deep: {
		answer: "Confirmed as-is.",
		evidence: [],
	},
});
await waitFor(async () => (await proses()).length === 4, "second turn answers");
await page.screenshot({ path: join(EVIDENCE, "02-follow-up-answer.png") });

// 2. A third turn with NO citations keeps appending, and earlier turns' citations remain clickable.
await ask("Any blockers?", 3);
const third = (await starts())[2];
check("a third follow-up still uses that chat", third.chatId === first.chatId, third.chatId);
await answer("None.");
await waitFor(async () => (await proses()).length === 5, "third answer");
check("all three turns read top to bottom", JSON.stringify(await bubbles()) === JSON.stringify(["When is the Dazzi v2 launch?", "And who owns it?", "Any blockers?"]), JSON.stringify(await bubbles()));

// Verify that even after Turn 3 (which has 0 citations), the Evidence panel shows earlier evidence and every turn/phase chip works:
const evTabsCount = await page.locator(`${EVIDENCE_HALF} .evidence-tab`).count();
check("Evidence panel stays populated when the latest follow-up turn has no citations", evTabsCount >= 2, `tabs=${evTabsCount}`);

// Click [4] in Turn 1 Quick (which only exists in Turn 1 Quick, not Turn 1 Deep)
await panel.locator(".assistant-prose").nth(0).locator(".cite", { hasText: /^4$/ }).click();
await waitFor(async () => ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("4. readme.md"), "Turn 1 Quick [4]");
check(
	"clicking [4] in Turn 1 Quick opens Turn 1 Quick's 4th evidence",
	((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("4. readme.md") && (await page.locator(".toast").count()) === 0,
	await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent(),
);

// Click [1] in Turn 1 Quick vs [1] in Turn 1 Deep (same number, different phase evidence)
await panel.locator(".assistant-prose").nth(0).locator(".cite", { hasText: /^1$/ }).click();
await waitFor(async () => ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("1. launch-plan.md"), "Turn 1 Quick [1]");
check(
	"clicking [1] in Turn 1 Quick opens launch-plan.md",
	((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("1. launch-plan.md"),
	await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent(),
);

await panel.locator(".assistant-prose").nth(1).locator(".cite", { hasText: /^1$/ }).click();
await waitFor(async () => ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("1. owner-matrix.md"), "Turn 1 Deep [1]");
check(
	"clicking [1] in Turn 1 Deep opens owner-matrix.md",
	((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("1. owner-matrix.md"),
	await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent(),
);

// Click [2] in Turn 2 Quick (where Turn 2 Deep had evidence: [])
await panel.locator(".assistant-prose").nth(2).locator(".cite", { hasText: /^2$/ }).click();
await waitFor(async () => ((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("2. org-chart.pdf"), "Turn 2 Quick [2]");
check(
	"clicking [2] in Turn 2 Quick (when Turn 2 Deep has empty evidence []) opens org-chart.pdf",
	((await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent()) ?? "").includes("2. org-chart.pdf"),
	await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent(),
);
await page.screenshot({ path: join(EVIDENCE, "03-three-turns.png") });
// 3. Only New chat starts a new chat.
await panel.locator('button[aria-label="New chat"]').click();
check("New chat clears the conversation", (await bubbles()).length === 0 && (await proses()).length === 0);
await ask("A fresh topic", 4);
const fourth = (await starts())[3];
check("the first question after New chat gets a new chat id", fourth.chatId !== first.chatId, JSON.stringify([fourth.chatId, first.chatId]));
await answer("Fresh answer.");
await waitFor(async () => (await proses()).length === 1, "fresh answer");
check("the new chat shows only its own turn", JSON.stringify(await bubbles()) === JSON.stringify(["A fresh topic"]), JSON.stringify(await bubbles()));
await page.screenshot({ path: join(EVIDENCE, "04-new-chat.png") });

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
