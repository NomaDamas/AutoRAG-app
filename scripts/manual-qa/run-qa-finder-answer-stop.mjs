// Live AI Search QA: Stop must end the turn at once. Pressing the composer's
// stop button mid-run has to clear every generating indicator — the pending
// shimmer and the "Thinking…" row — instead of hanging, show the stopped notice, and
// never let the animation return while the backend unwinds.
//
// Prerequisites: `bun run build`, OPENROUTER_API_KEY in the environment.
// Run: node scripts/manual-qa/run-qa-finder-answer-stop.mjs
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AutoRAGAgent, buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModel } from "@autorag/librarian/core";
import { AI_PANEL, finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-answer-stop");
const RUN_TIMEOUT_MS = 240_000;
/** Hang ceiling for Stop to settle the UI; the old "shimmer survives forever" bug blows past any ceiling. */
const SETTLE_BUDGET_MS = 60_000;
/** How long to watch after Stop for a generating indicator to sneak back. */
const SETTLE_WATCH_MS = 2_500;
const QUERY = "환불 예외 승인 규칙을 문서에서 찾아 요약해줘";

if (!process.env.OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY is required for the live AI Search QA.");
	process.exit(2);
}

rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-answer-stop-"));
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
writeFileSync(
	join(DOCS, "refund-policy.txt"),
	[
		"환불 정책 (v3, 2026-07-15 승인)",
		"1. 일반 환불은 5영업일 내 처리한다.",
		"2. 환불 예외(exception)는 지급 전 반드시 임원(director) 승인이 필요하다.",
		"3. 재무팀은 요청에 원래의 승인 체인을 첨부해야 한다.",
		"4. 7월 리뷰에서 승인된 예외는 4분기까지 유예된다.",
	].join("\n"),
);

const CONFIG = join(WORK, "config.json");
writeFileSync(
	CONFIG,
	JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: WORK,
			memoryPath: join(WORK, "memory.json"),
			// Local embeddings only: corpus text never leaves the machine.
			minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			model: {
				provider: "openrouter",
				id: "deepseek/deepseek-v4.1-flash",
				baseUrl: "https://openrouter.ai/api/v1",
				api: "openai-completions",
				apiKeyEnv: "OPENROUTER_API_KEY",
			},
		},
		null,
		2,
	),
);

async function warmIndex() {
	const config = resolveConfigReadOnly({ flags: {}, env: { ...process.env, AUTORAG_CONFIG: CONFIG }, cwd: WORK });
	const resolved = await resolveAgentModel(config);
	const agent = new AutoRAGAgent({ ...buildAgentOptions(config), model: resolved.model });
	const result = await agent.refresh(true);
	log(`warm index: scanned=${result.scanned} minsync=${JSON.stringify(result.minsync)}`);
}

/** The live DOM read of everything Stop must clear. */
const readState = ([panel]) => {
	const root = document.querySelector(panel);
	if (root === null) return null;
	const input = root.querySelector('textarea[aria-label="Ask Dazzi"]');
	return {
		settled:
			input !== null &&
			!input.disabled &&
			root.querySelector(".water-wave-thinking") === null &&
			(root.textContent ?? "").includes("Generation stopped."),
		generating: root.querySelector(".water-wave-thinking") !== null,
		inputDisabled: input?.disabled ?? null,
		stoppedNotice: (root.textContent ?? "").includes("Generation stopped."),
		error: root.querySelector(".text-danger-text")?.textContent ?? "",
	};
};

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let app = null;
let page = null;
try {
	log(`work dir: ${WORK}`);
	await warmIndex();

	const env = { AUTORAG_CONFIG: CONFIG, ELECTRON_RENDERER_URL: undefined };
	app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
	page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
	await openAiSearch(page);

	await page.fill('textarea[aria-label="Ask Dazzi"]', QUERY);
	await page.keyboard.press("Enter");
	log(`submitted: ${QUERY}`);
	await page.waitForSelector('button[aria-label="Stop"]', { timeout: RUN_TIMEOUT_MS });
	const before = await page.evaluate(readState, [AI_PANEL]);
	check("the run is generating when Stop is pressed", before !== null && before.generating, JSON.stringify(before));
	await page.screenshot({ path: join(EVIDENCE, "1-generating.png") });

	const clickedAt = Date.now();
	await page.click('button[aria-label="Stop"]');
	let settled = false;
	let settleError = "";
	try {
		await page.waitForFunction(
			(panel) => {
				const root = document.querySelector(panel);
				if (root === null) return false;
				const input = root.querySelector('textarea[aria-label="Ask Dazzi"]');
				return (
					input !== null &&
					!input.disabled &&
							root.querySelector(".water-wave-thinking") === null &&
					(root.textContent ?? "").includes("Generation stopped.")
				);
			},
			AI_PANEL,
			{ timeout: SETTLE_BUDGET_MS },
		);
		settled = true;
	} catch (error) {
		settleError = String(error).slice(0, 200);
	}
	const elapsed = Date.now() - clickedAt;
	const after = await page.evaluate(readState, [AI_PANEL]);
	await page.screenshot({ path: join(EVIDENCE, "2-stopped.png") });
	log(`stop settled=${settled} after ${elapsed}ms ${JSON.stringify(after)} ${settleError}`);

	check("Stop clears the generating look", settled && after !== null && !after.generating, `settled=${settled} after ${elapsed}ms`);
	check("the stopped notice is shown", after !== null && after.stoppedNotice, JSON.stringify(after));
	check("the composer is re-enabled", after !== null && after.inputDisabled === false, JSON.stringify(after));
	check("Stop surfaces no error", after !== null && after.error === "", after === null ? "panel gone" : after.error);

	await sleep(SETTLE_WATCH_MS);
	const watched = await page.evaluate(readState, [AI_PANEL]);
	await page.screenshot({ path: join(EVIDENCE, "3-after-watch.png") });
	check(
		"the generating look never returns",
		watched !== null && !watched.generating && watched.stoppedNotice,
		`after ${SETTLE_WATCH_MS}ms ${JSON.stringify(watched)}`,
	);
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (page !== null) await page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	if (app !== null) await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

writeFileSync(join(EVIDENCE, "summary.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.pass);
log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
