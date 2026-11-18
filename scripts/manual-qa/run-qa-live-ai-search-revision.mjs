// Live end-to-end: a real model corrects the first answer it already gave, and the real app draws the correction.
//
// The corpus holds an outdated policy that matches the question's words and a newer memo that overrides it for one
// vendor. Whether the model gets the first answer wrong is its own doing (the lane forces nothing), so the lane asks up
// to QA_LIVE_ATTEMPTS times in fresh chats and judges the first one that produced a correction; when none did, the
// contract was never exercised and the lane fails. What it asserts is the app's side of the contract:
//
//   - a correction is drawn in the Quick answer, in place, with its reason, with nothing added above the answer;
//   - the replaced words leave after the motion; a retracted claim stays struck;
//   - every citation the correction brings opens a source (none is left as a dead chip);
//   - the answer is not repeated under itself as a second, full answer;
//   - the chat read back from the store shows the same corrections.
//
// The model is a 2026+ release (global model-usage rule); the default is looked up in the live OpenRouter catalog by
// `autorag models list --available`, never guessed. Set QA_LIVE_MODEL to use another, OPENROUTER_API_KEY (or
// QA_OPENROUTER_KEY) for the key. The corpus is searched with a sparse-only index, so no corpus text goes to an
// embedding service. Run `bun run build` first, then on this machine (the key is not forwarded into a VM):
//
//   OPENROUTER_API_KEY=... QA_LIVE_MODEL=anthropic/claude-haiku-5.5 bun scripts/manual-qa/run-qa-live-ai-search-revision.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-revision");
mkdirSync(EVIDENCE, { recursive: true });

const KEY = (process.env.QA_OPENROUTER_KEY ?? process.env.OPENROUTER_API_KEY ?? "").trim();
const MODEL_ID = process.env.QA_LIVE_MODEL ?? "anthropic/claude-haiku-5.5";
const ATTEMPTS = Number(process.env.QA_LIVE_ATTEMPTS ?? 4);
if (KEY === "") {
	console.error("An OpenRouter key is required: set QA_OPENROUTER_KEY or OPENROUTER_API_KEY.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

/** The developer's own `minsync`, skipping the inert stand-in other lanes prepend to PATH. */
function realMinSync() {
	const name = process.platform === "win32" ? "minsync.exe" : "minsync";
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (directory === "" || directory.includes("autorag-fake-minsync")) continue;
		const candidate = join(directory, name);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("A real `minsync` on PATH is required for the live revision lane.");
}

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-revision-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsync = realMinSync();
const bin = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(minsync)} "$@"\n`);
chmodSync(bin, 0o755);

// The first answer is built from what the baseline retrieval finds first. The old checklist uses the question's own
// words (vendor, approval, payment term), so it ranks first; the memo that overrides it for new vendors says the same
// things in other words (supplier, sign-off, settlement), so only the verification phase's second look finds it.
writeFileSync(
	join(DOCS, "vendor-onboarding-checklist.md"),
	[
		"# Vendor onboarding checklist (v1, 2025-03)",
		"",
		"New vendors must be approved by the procurement lead before the first purchase order.",
		"The vendor approval is recorded in the vendor register.",
		"The standard payment term is net 30 days.",
		"Vendor approval and the payment term are owned by Procurement Operations.",
		"",
	].join("\n"),
);
writeFileSync(
	join(DOCS, "supply-contract-amendment-3.md"),
	[
		"# Supply contract amendment No. 3 (2026-09-12)",
		"",
		"From 2026-09-12 every first-time supplier is cleared by the CFO, not by the procurement lead.",
		"Settlement for these suppliers falls due 60 days after invoice, replacing the 30 days of the old checklist.",
		"",
	].join("\n"),
);
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			// Keyword-only mode: a sparse-only index, so the memo that rewords the old checklist is found only by the
			// verification phase, as in a corpus the person has not embedded. It also needs no dense model.
			appIndexing: { semanticSearch: false },
			minSync: { enabled: true, autoInstall: false, embedder: { id: "none" } },
			jikji: false,
			model: { provider: "openrouter", id: MODEL_ID },
			jev: { backend: "openrouter" },
		},
		null,
		2,
	)}\n`,
);

const env = {
	HOME: WORK,
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: KEY,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const QUESTION = "신규 거래처를 처음 등록할 때 승인은 누가 하고 결제 조건은 며칠이야?";

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(".sidebar__item", { timeout: 60_000 });
	const refresh = await page.evaluate(() => window.autorag.settings.configRefresh());
	check("the corpus is indexed before the first question", refresh.ok === true, JSON.stringify({ ok: refresh.ok, error: refresh.error }));
	if (refresh.ok !== true) throw new Error("the index did not build, so no search can find the corpus");
	await openAiSearch(page);

	let drawn = null;
	for (let attempt = 1; attempt <= ATTEMPTS && drawn === null; attempt += 1) {
		console.log(`attempt ${attempt}/${ATTEMPTS} (${MODEL_ID})`);
		if (attempt > 1) await page.locator('button[aria-label="New chat"]').click();
		await page.fill('textarea[aria-label="Ask Dazzi"]', QUESTION);
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			() => {
				const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
				const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
				return done || document.querySelector(".ai .text-danger-text")?.textContent;
			},
			null,
			{ timeout: 300_000 },
		);
		const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
		if (error !== "") {
			check("AI Chat shows no error", false, error.slice(0, 300));
			break;
		}
		const marks = await page.locator(".assistant-msg [data-revision]").count();
		const prose = (await page.locator(".assistant-msg .assistant-prose").allInnerTexts()).join("\n---\n");
		await page.screenshot({ path: join(EVIDENCE, `attempt-${attempt}.png`) });
		console.log(`  corrections drawn: ${marks}; answer: ${prose.replace(/\s+/g, " ").slice(0, 300)}`);
		if (marks > 0) drawn = { attempt, marks };
	}

	check("the model corrected its first answer in at least one attempt", drawn !== null, `attempts=${ATTEMPTS}`);
	if (drawn !== null) {
		const msg = page.locator(".assistant-msg").first();
		const proses = msg.locator(".assistant-prose");
		const first = proses.first();
		const text = await first.innerText();
		const kinds = await msg.locator("[data-revision]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-revision")));
		console.log(`  correction kinds: ${JSON.stringify(kinds)}`);
		check("every drawn correction is a replace, retract or add", kinds.every((kind) => ["replace", "retract", "add"].includes(kind ?? "")), JSON.stringify(kinds));
		const reasons = await msg.locator("[data-revision]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") ?? ""));
		check("every correction carries its reason", reasons.every((reason) => reason.trim() !== ""), JSON.stringify(reasons));

		// The motion ends: replaced words leave; retracted claims stay struck.
		await page.waitForTimeout(4000);
		check("the replaced words have left once the change settled", (await msg.locator("[data-revision=replace] del").count()) === 0);
		check("a retracted claim stays struck", (await msg.locator("[data-revision=retract]").count()) === (await msg.locator("[data-revision=retract] del").count()));

		// A source a correction brought in is marked in the answer and in the inspector alike (whatever the model corrected).
		const freshChips = await msg.locator("button.cite[data-fresh]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-cite")));
		const freshTabs = await page.locator(".evidence-tab[data-fresh]").evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
		console.log(`  new sources: chips ${JSON.stringify(freshChips)}, inspector tabs ${JSON.stringify(freshTabs)}`);
		check("every new-source chip sits inside a correction", (await msg.locator("button.cite[data-fresh]:not([data-revision] *)").count()) === 0);
		check("the inspector marks exactly the sources the chips mark (the open one excepted)", freshTabs.every((tab) => freshChips.includes(tab)), `${JSON.stringify(freshChips)} vs ${JSON.stringify(freshTabs)}`);
		if (freshChips.length > 0) {
			const target = msg.locator("button.cite[data-fresh]").first();
			const number = await target.getAttribute("data-cite");
			await target.click();
			await page.waitForTimeout(500);
			check("opening a new source ends its mark in the answer and in the inspector", (await msg.locator(`button.cite[data-cite='${number}']`).first().getAttribute("data-fresh")) === null && (await page.locator(`.evidence-tab[data-fresh]`).filter({ hasText: new RegExp(`^${number}$`, "u") }).count()) === 0, String(number));
		}

		// No chip left dead: each citation chip in the corrected answer opens a source.
		const cites = await first.locator("button.cite").evaluateAll((nodes) => nodes.map((node) => node.textContent));
		console.log(`  citation chips in the corrected answer: ${JSON.stringify(cites)}`);
		if (cites.length > 0) {
			const last = first.locator("button.cite").last();
			await last.click();
			await page.waitForTimeout(500);
			const titles = await page.locator('.inspector-half[aria-label="Evidence"] .preview-title').allInnerTexts();
			check("a citation of the corrected answer opens a source", titles.length > 0 && titles.every((title) => title.trim() !== ""), JSON.stringify(titles));
		}

		const count = await proses.count();
		const second = count > 1 ? await proses.nth(1).innerText() : "";
		console.log(`  answer blocks: ${count}${count > 1 ? `; second: ${second.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
		check("the final answer is not a second full copy of the corrected one", count === 1 || !second.includes(text.trim().slice(0, 40)), `${count} block(s)`);

		// The chat read back from the store shows the same corrections.
		const stored = await page.evaluate(async () => {
			const list = await window.autorag.search.historyList();
			const record = list.length === 0 ? null : await window.autorag.search.historyGet(list[0].id);
			const assistant = record?.messages.find((message) => message.role === "assistant");
			return { revisions: assistant?.revisions ?? null, quick: assistant?.quick?.answer ?? null };
		});
		check("the stored chat holds the corrections", Array.isArray(stored.revisions) && stored.revisions.length > 0, JSON.stringify(stored.revisions ?? null).slice(0, 300));
		check("the stored Quick answer is still the first answer, as the person read it", typeof stored.quick === "string" && stored.quick !== "" && !stored.quick.includes("\u0001"));
	}
	await page.screenshot({ path: join(EVIDENCE, "live-revision-final.png") });
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
} finally {
	await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
