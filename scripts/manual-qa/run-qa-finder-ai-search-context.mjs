/**
 * Manual QA — what the conversation does to the model's view of a chat (issue #389), in the real app.
 *
 * Deterministic lane: replaces main's `search:start` / `search:steer` / `search:cancel` handlers with a scripted run the
 * lane drives step by step (no model, no network), so the real renderer, preload bridge and IPC path run while the
 * timing is exact. In English and in Korean, with real keyboard and mouse input, it checks:
 *
 *   1. while pi summarises the earlier turns, the run's status line says so (in place of "Thinking…");
 *   2. once the summary is in, a divider marks the place in the conversation, with a line saying what it means;
 *   3. a result that was too large for the request is noted under it, and the answer follows below;
 *   4. a run that failed because the conversation no longer fits the model explains why, in warning colours, with
 *      "New chat" and "Ask narrower" (which puts the question back in the composer) and no AI fix;
 *   5. the notices stay with their turn once it is an earlier turn, and come back when a stored chat is reopened
 *      (a summary written after the Quick answer sits between Quick and Deep);
 *   6. the dark appearance draws the same notices from its own tokens.
 *
 * Screenshots land in .omo/evidence/ai-finder-app/qa-ai-search-context/ (or $QA_OUT).
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-ai-search-context.mjs
 * Prereq: bun run build.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-context");
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

const RUN_ID = `ulw-ai-context-qa-${Date.now().toString(36)}`;
const WORK = join(tmpdir(), RUN_ID);
const HOME = join(WORK, "home");
mkdirSync(join(HOME, ".autorag"), { recursive: true });

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

/** The interface strings the lane reads, straight from the app's dictionaries. */
const dictionary = (language) => {
	const locale = JSON.parse(readFileSync(join(ROOT, "src/shared/i18n/locales", `${language}.json`), "utf8"));
	return {
		panel: locale.aiSearch.title,
		ask: locale.aiSearch.askDazzi,
		history: locale.aiSearch.history,
		newChat: locale.aiSearch.newChat,
		thinking: locale.aiSearch.thinking,
		compacting: locale.aiSearch.context.compacting,
		compacted: locale.aiSearch.context.compacted,
		compactedHint: locale.aiSearch.context.compactedHint,
		trimmed: locale.aiSearch.context.trimmed,
		overflowTitle: locale.appError.contextOverflow.title,
		overflowHint: locale.appError.contextOverflow.hint,
		askNarrower: locale.appError.askNarrower,
		fix: locale.appError.fixAction,
	};
};

const OVERFLOW = "400 context_length_exceeded: This model's maximum context length is 1048576 tokens. However, you requested about 1731204 tokens.";
const phase = (answer) => ({ answer, evidence: [] });

/** A stored chat whose latest turn was summarised after its Quick answer and used part of a large result before it. */
function seedChat(userData, words) {
	mkdirSync(join(userData, "chat-history"), { recursive: true });
	const at = new Date().toISOString();
	const record = {
		id: "c-context-1",
		title: words.storedTitle,
		snippet: words.storedQuick,
		updatedAt: at,
		messages: [
			{ role: "user", text: words.storedTitle, attachments: [], at },
			{ role: "assistant", sessionId: "s1", quick: phase(words.storedQuick), deep: null, stopped: false, at },
			{ role: "user", text: words.storedFollowUp, attachments: [], at },
			{
				role: "assistant",
				sessionId: "s1",
				quick: phase(words.storedQuick2),
				deep: phase(words.storedDeep2),
				stopped: false,
				at,
				context: [
					{ kind: "trimmed", timing: "before-quick" },
					{ kind: "compacted", timing: "after-quick" },
				],
			},
		],
	};
	writeFileSync(join(userData, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);
}

const WORDS = {
	en: {
		q1: "What does the refund policy say?",
		a1: "Refunds over **$500** need director approval before payout.",
		q2: "Summarize everything Spotlight finds about refunds",
		a2: "Across the refund documents, the approval threshold is **$500** and payouts wait for the director's sign-off.",
		q3: "Now list every PDF with its full text",
		storedTitle: "Budget review",
		storedQuick: "The 2026 budget is in budget-2026.xlsx.",
		storedFollowUp: "Compare it with every finance PDF",
		storedQuick2: "The finance PDFs agree with the budget totals.",
		storedDeep2: "Verified: the totals match in all twelve finance PDFs.",
	},
	ko: {
		q1: "환불 정책은 어떻게 돼?",
		a1: "**50만 원**이 넘는 환불은 지급 전에 이사 승인이 필요합니다.",
		q2: "Spotlight에서 환불 관련 문서를 전부 찾아서 요약해 줘",
		a2: "환불 문서 전체를 보면 승인 기준은 **50만 원**이고, 지급은 이사 결재 후에 이뤄집니다.",
		q3: "이제 모든 PDF를 전문과 함께 나열해 줘",
		storedTitle: "예산 검토",
		storedQuick: "2026년 예산은 budget-2026.xlsx에 있습니다.",
		storedFollowUp: "재무 PDF 전부와 비교해 줘",
		storedQuick2: "재무 PDF들은 예산 합계와 일치합니다.",
		storedDeep2: "검증 완료: 재무 PDF 12개 모두 합계가 일치합니다.",
	},
};

async function scriptSearch() {
	await app.evaluate(({ ipcMain, BrowserWindow }) => {
		const state = { runs: new Map(), starts: [] };
		const send = (payload) => {
			for (const window of BrowserWindow.getAllWindows()) {
				if (window.webContents.getURL().includes("index.html")) window.webContents.send("search:event", payload);
			}
		};
		for (const channel of ["search:start", "search:steer", "search:cancel"]) ipcMain.removeHandler(channel);
		ipcMain.handle("search:start", (_event, searchId, _chatId, query) => {
			state.starts.push(query);
			return new Promise((resolve) => state.runs.set(searchId, { resolve }));
		});
		ipcMain.handle("search:steer", () => false);
		ipcMain.handle("search:cancel", (_event, searchId) => {
			const run = state.runs.get(searchId);
			state.runs.delete(searchId);
			send({ type: "cancelled", searchId });
			run?.resolve();
		});
		globalThis.__qaContext = {
			state,
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
}

const qa = (action, arg) =>
	app.evaluate(
		(_electron, [name, value]) => {
			const context = globalThis.__qaContext;
			if (name === "emit") return context.emit(value);
			if (name === "finish") return context.finish();
			if (name === "state") return { starts: context.state.starts, running: context.state.runs.size };
			return null;
		},
		[action, arg],
	);

async function runLanguage(language) {
	const text = dictionary(language);
	const words = WORDS[language];
	const userData = join(WORK, `profile-${language}`);
	seedChat(userData, words);
	app = await launchFinder({
		userDataDir: userData,
		language,
		env: { AUTORAG_HOME: join(HOME, ".autorag"), AUTORAG_CONFIG: join(HOME, ".autorag", "config.json") },
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	await scriptSearch();
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
	await page.locator(".sidebar__item", { hasText: text.panel }).first().click();
	const panel = page.locator(`section[aria-label="${text.panel}"]:not([aria-hidden="true"])`);
	const composer = panel.locator(`textarea[aria-label="${text.ask}"]`);
	await composer.waitFor({ timeout: 30_000 });
	log(`app ready (${language})`);

	const waitFor = async (predicate, label, timeoutMs = 5000) => {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (await predicate()) return true;
			await page.waitForTimeout(50);
		}
		log(`timeout waiting for ${label}`);
		return false;
	};
	const shot = async (name) => {
		await page.waitForTimeout(400);
		await page.screenshot({ path: join(EVIDENCE, `${language}-${name}.png`) });
	};
	const ask = async (question) => {
		const before = (await qa("state")).starts.length;
		await composer.click();
		await page.keyboard.type(question);
		await page.keyboard.press("Enter");
		await waitFor(async () => (await qa("state")).starts.length === before + 1, `run start: ${question}`);
	};
	const compacting = panel.locator('[data-context="compacting"]');
	const dividers = panel.locator('[data-context="compacted"]');
	const trims = panel.locator('[data-context="trimmed"]');
	/** True when the last match of each selector comes in this order in the panel (the latest turn's elements). */
	const inOrder = (...selectors) =>
		panel.evaluate((root, list) => {
			const nodes = list.map((selector) => [...root.querySelectorAll(selector)].at(-1));
			if (nodes.some((node) => node === undefined)) return false;
			return nodes.every((node, index) => index === 0 || Boolean(nodes[index - 1].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
		}, selectors);

	// ── An earlier turn, so there is a conversation to summarise. ─────────────────────────────────
	await ask(words.q1);
	await qa("emit", { type: "quick", sessionId: "s", phase: phase(words.a1) });
	await qa("finish");
	await waitFor(async () => (await qa("state")).running === 0, "first run end");

	// ── 1. pi summarises: the status line says so instead of "Thinking…". ─────────────────────────
	await ask(words.q2);
	await qa("emit", { type: "compacting", active: true });
	await compacting.waitFor();
	check(`${language}: the status line says the earlier turns are being summarised`, (await compacting.innerText()).includes(text.compacting), await compacting.innerText());
	check(`${language}: it is a live status`, (await compacting.getAttribute("role")) === "status");
	check(`${language}: no Thinking line beside it`, (await panel.locator(".water-wave-thinking").count()) === 0);
	await shot("01-compacting");

	// ── 2. The summary is in: a divider marks the place. ──────────────────────────────────────────
	await qa("emit", { type: "compacting", active: false });
	await qa("emit", { type: "context-notice", notice: { kind: "compacted", timing: "before-quick" } });
	await dividers.first().waitFor();
	check(`${language}: the summarising line is gone`, (await compacting.count()) === 0);
	check(`${language}: the run goes back to its Thinking line`, (await panel.locator(".water-wave-thinking").count()) === 1);
	const divider = await dividers.first().innerText();
	check(`${language}: the divider names the summary and what it means`, divider.includes(text.compacted) && divider.includes(text.compactedHint), divider);
	await shot("02-compacted");

	// ── 3. A result was cut to fit; the answer follows. ────────────────────────────────────────────
	await qa("emit", { type: "context-notice", notice: { kind: "trimmed", timing: "before-quick" } });
	await trims.first().waitFor();
	await qa("emit", { type: "quick", sessionId: "s", phase: phase(words.a2) });
	await qa("finish");
	await waitFor(async () => (await qa("state")).running === 0, "second run end");
	check(`${language}: the cut result is noted`, (await trims.first().innerText()).includes(text.trimmed), await trims.first().innerText());
	check(
		`${language}: question, divider, note, then the answer`,
		await inOrder(".user-msg", '[data-context="compacted"]', '[data-context="trimmed"]', ".assistant-prose"),
	);
	await shot("03-answered");
	await page.evaluate(() => document.documentElement.setAttribute("data-appearance", "dark"));
	await shot("03-answered-dark");
	await page.evaluate(() => document.documentElement.removeAttribute("data-appearance"));

	// ── 4. The conversation no longer fits even after the summary. ────────────────────────────────
	await ask(words.q3);
	await qa("emit", { type: "compacting", active: true });
	await qa("emit", { type: "compacting", active: false });
	await qa("emit", { type: "context-notice", notice: { kind: "compacted", timing: "before-quick" } });
	await qa("emit", { type: "error", message: OVERFLOW, action: "new-chat" });
	await qa("finish");
	const alert = panel.locator('[role="alert"]');
	await alert.waitFor();
	const alertText = await alert.innerText();
	check(`${language}: the error says the model's limit was passed, and what to do`, alertText.includes(text.overflowTitle) && alertText.includes(text.overflowHint), alertText);
	check(`${language}: the provider's raw words stay behind the details toggle`, !alertText.includes("context_length_exceeded"));
	const labels = await alert.locator("button").allInnerTexts();
	check(`${language}: New chat leads, Ask narrower follows, no AI fix`, labels.some((label) => label.includes(text.newChat)) && labels.some((label) => label.includes(text.askNarrower)) && !labels.some((label) => label.includes(text.fix)), JSON.stringify(labels));
	const badge = await alert.locator("[data-notice-icon]").getAttribute("class");
	check(`${language}: the error is drawn in warning colours`, (badge ?? "").includes("bg-warn-bg"), badge ?? "");
	check(`${language}: the question, then the summary divider, then the error`, await inOrder(".user-msg", '[data-context="compacted"]', '[role="alert"]'));
	check(`${language}: the earlier turn keeps its divider and note`, (await dividers.count()) === 2 && (await trims.count()) === 1, `${await dividers.count()} dividers, ${await trims.count()} notes`);
	await shot("04-overflow-error");

	// ── Ask narrower: the question comes back to the composer. ─────────────────────────────────────
	await alert.locator("button", { hasText: text.askNarrower }).click();
	check(`${language}: Ask narrower puts the question back in the composer`, (await composer.inputValue()) === words.q3, await composer.inputValue());
	check(`${language}: and focuses it`, await composer.evaluate((field) => field === document.activeElement));
	await shot("05-ask-narrower");

	// ── New chat: a fresh conversation. ────────────────────────────────────────────────────────────
	await alert.locator("button", { hasText: text.newChat }).click();
	await waitFor(async () => (await panel.locator(".user-msg").count()) === 0, "new chat");
	check(`${language}: New chat clears the conversation and its notices`, (await panel.locator(".user-msg").count()) === 0 && (await dividers.count()) === 0 && (await trims.count()) === 0);

	// ── 5. A stored chat brings its notices back, each where it happened. ─────────────────────────
	await panel.locator(`[aria-label="${text.history}"]`).click();
	await page.locator(".history-item").first().click();
	await dividers.first().waitFor();
	check(`${language}: the stored divider and note come back`, (await dividers.count()) === 1 && (await trims.count()) === 1);
	const placement = await panel.evaluate((root) => {
		const turn = root.querySelectorAll(".assistant-msg")[1];
		const proses = turn?.querySelectorAll(".assistant-prose") ?? [];
		const divider = turn?.querySelector('[data-context="compacted"]');
		if (divider == null || proses.length !== 2) return false;
		const afterQuick = Boolean(proses[0].compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING);
		const beforeDeep = Boolean(divider.compareDocumentPosition(proses[1]) & Node.DOCUMENT_POSITION_FOLLOWING);
		return afterQuick && beforeDeep;
	});
	check(`${language}: a summary written after the Quick answer sits between Quick and Deep`, placement);
	await shot("06-restored");

	await app.close();
	app = undefined;
}

await runLanguage("en");
await runLanguage("ko");

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
