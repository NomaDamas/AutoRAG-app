// Live AI Search QA: drives the built Finder app with Playwright and proves
// that a query shows the Thinking indicator (never the reasoning text), streams
// a Quick draft and a Deep answer, and that a
// broken config surfaces as an error instead of an endless wait.
//
// Prerequisites: `bun run build`, OPENROUTER_API_KEY in the environment.
// Run: node scripts/manual-qa/run-qa-finder-answer-streaming.mjs
// Set QA_REQUIRE_DEEP_STREAM=1 to also require a streamed Deep draft.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { AutoRAGAgent, buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModel } from "@autorag/librarian/core";
import { AI_PANEL, finderWindow, openAiSearch } from "./launch-finder.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVIDENCE = join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-answer-streaming");
const RUN_TIMEOUT_MS = 240_000;
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

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-answer-streaming-"));
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
writeFileSync(
	join(DOCS, "finance-approval-matrix.txt"),
	[
		"재무 승인 매트릭스 (2026년 상반기)",
		"- 100만원 이하 일반 지급: 팀장 승인",
		"- 100만원 초과 지급: 재무 담당 임원 승인",
		"- 환불 예외 전 구간: 지급 전 임원(director) 승인 필수",
	].join("\n"),
);

function writeConfig(name, searchPaths) {
	const path = join(WORK, name);
	writeFileSync(
		path,
		JSON.stringify(
			{
				searchPaths,
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
	return path;
}

const GOOD_CONFIG = writeConfig("config.json", [DOCS]);
const MISSING_ROOT_CONFIG = writeConfig("config-missing-root.json", [join(WORK, "deleted-docs")]);

async function warmIndex(configPath) {
	const config = resolveConfigReadOnly({ flags: {}, env: { ...process.env, AUTORAG_CONFIG: configPath }, cwd: WORK });
	const resolved = await resolveAgentModel(config);
	const agent = new AutoRAGAgent({ ...buildAgentOptions(config), model: resolved.model });
	const result = await agent.refresh(true);
	log(`warm index: scanned=${result.scanned} minsync=${JSON.stringify(result.minsync)}`);
}

async function launch(configPath, label) {
	const env = { ...process.env, AUTORAG_CONFIG: configPath, AUTORAG_SKIP_ONBOARDING: "1" };
	delete env.ELECTRON_RENDERER_URL;
	const app = await _electron.launch({
		args: [ROOT, `--user-data-dir=${join(WORK, `user-data-${label}`)}`],
		cwd: WORK,
		env,
	});
	const page = await finderWindow(app, 30_000);
	page.on("pageerror", (error) => log(`[${label}:pageerror] ${String(error).slice(0, 300)}`));
	app.process().stderr?.on("data", (chunk) => {
		const text = String(chunk).trim();
		if (text !== "" && !text.includes("Debugger")) log(`[${label}:main:err] ${text.slice(0, 300)}`);
	});
	await openAiSearch(page);
	return { app, page };
}

/**
 * Records every DOM change of the AI panel with a timestamp, so streaming is
 * judged from what the user actually saw, not from a sampling interval.
 */
async function installRecorder(page) {
	await page.evaluate(() => {
		const read = () => {
			// v7 renders the loaded answer as plain `.assistant-prose` blocks under
			// `.assistant-msg`: Quick first, Deep second. Streaming has no dedicated
			// class; the disabled composer marks a run in progress.
			const prose = [...document.querySelectorAll(".assistant-msg .assistant-prose")];
			const quick = prose[0] ?? null;
			const deep = prose[1] ?? null;
			const input = document.querySelector('input[aria-label="Ask AutoRAG"]');
			const inProgress = input !== null && input.disabled;
			return {
				thinking: document.querySelector(".water-wave-thinking") !== null,
				thinkingTexts: [...document.querySelectorAll(".water-wave-thinking")].map((element) => element.textContent),
				quickDraft: quick?.textContent?.length ?? 0,
				quickStreaming: inProgress && quick !== null,
				deepDraft: deep?.textContent?.length ?? 0,
				deepStreaming: inProgress && deep !== null,
				error: document.querySelector(".ai .text-danger-text")?.textContent ?? "",
				inputDisabled: input?.disabled ?? null,
			};
		};
		const start = performance.now();
		const timeline = [];
		let last = "";
		const record = () => {
			const state = read();
			const key = JSON.stringify(state);
			if (key === last) return;
			last = key;
			timeline.push({ t: Math.round(performance.now() - start), ...state });
		};
		window.__qaTimeline = timeline;
		new MutationObserver(record).observe(document.querySelector('section[aria-label="AI Search"]:not([aria-hidden="true"])'), {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
		});
		record();
	});
}

const FINISHED = () => {
	const input = document.querySelector('input[aria-label="Ask AutoRAG"]');
	return input !== null && !input.disabled && document.querySelector(".user-msg") !== null;
};

const distinctGrowth = (values) => {
	const nonZero = values.filter((value) => value > 0);
	return new Set(nonZero).size > 1 && nonZero.at(-1) > nonZero[0];
};

const results = [];
const check = (name, pass, detail) => {
	results.push({ name, pass, detail });
	log(`${pass ? "PASS" : "FAIL"} ${name}: ${detail}`);
};

let running = null;
try {
	log(`work dir: ${WORK}`);
	await warmIndex(GOOD_CONFIG);

	// Scenario 1: a real query shows Thinking, then streams Quick and Deep.
	running = await launch(GOOD_CONFIG, "stream");
	let { page } = running;
	await installRecorder(page);
	await page.fill('input[aria-label="Ask AutoRAG"]', QUERY);
	await page.keyboard.press("Enter");
	log(`submitted: ${QUERY}`);
	await page.waitForFunction(() => document.querySelector(".water-wave-thinking"), null, { timeout: RUN_TIMEOUT_MS });
	await page.screenshot({ path: join(EVIDENCE, "1-thinking.png") });
	await page.waitForFunction(() => document.querySelector(".assistant-msg .assistant-prose"), null, { timeout: RUN_TIMEOUT_MS });
	await page.screenshot({ path: join(EVIDENCE, "2-quick-streaming.png") });
	await page.waitForFunction(FINISHED, null, { timeout: RUN_TIMEOUT_MS });
	await page.screenshot({ path: join(EVIDENCE, "3-complete.png") });
	const timeline = await page.evaluate(() => window.__qaTimeline);
	writeFileSync(join(EVIDENCE, "timeline.json"), JSON.stringify(timeline, null, 2));
	log(`timeline states: ${timeline.length}`);

	const quickFinal = (state) => state.quickDraft > 0 && !state.quickStreaming;
	const beforeQuickFinal = timeline.filter((state) => !quickFinal(state));
	check(
		"thinking indicator shown",
		beforeQuickFinal.some((state) => state.thinking),
		`indicator states ${JSON.stringify([...new Set(beforeQuickFinal.map((state) => state.thinking))])}`,
	);
	check(
		"reasoning text never rendered",
		timeline.every((state) => state.thinkingTexts.every((value) => value.startsWith("Thinking"))),
		`indicator texts ${JSON.stringify([...new Set(timeline.flatMap((state) => state.thinkingTexts))])}`,
	);
	const quickStreaming = timeline.filter((state) => state.quickStreaming);
	check(
		"quick answer streams",
		distinctGrowth(quickStreaming.map((state) => state.quickDraft)),
		`quick draft lengths while streaming ${JSON.stringify([...new Set(quickStreaming.map((state) => state.quickDraft))].slice(0, 12))}`,
	);
	const final = timeline.at(-1);
	check("quick answer final", quickFinal(final), `quick ${final.quickDraft} chars`);
	// v7 renders the Deep answer permanently under a static "Worked for Ns"
	// label (no disclosure), so the prose is visible as soon as it exists.
	await page.locator(".assistant-msg .assistant-prose").nth(1).waitFor({ state: "visible", timeout: 8000 }).catch(() => undefined);
	const deepFinalChars = ((await page.locator(".assistant-msg .assistant-prose").nth(1).textContent()) ?? "").length;
	check("deep answer final", deepFinalChars > 0, `deep ${deepFinalChars} chars`);
	// v7 has no per-answer card chrome to police (the Quick/Deep labels are gone).
	log(`deep thinking indicator shown=${timeline.some((state) => state.thinking)}`);
	const deepStreaming = timeline.filter((state) => state.deepStreaming);
	const deepStreamed = distinctGrowth(deepStreaming.map((state) => state.deepDraft));
	const deepDetail = `deep draft lengths while streaming ${JSON.stringify([...new Set(deepStreaming.map((state) => state.deepDraft))].slice(0, 12))}`;
	if (process.env.QA_REQUIRE_DEEP_STREAM === "1") check("deep answer streams", deepStreamed, deepDetail);
	else log(`INFO deep answer streams=${deepStreamed}: ${deepDetail}`);
	check("composer re-enabled", final.inputDisabled === false && final.error === "", `inputDisabled=${final.inputDisabled} error="${final.error}"`);
	await running.app.close();
	running = null;

	// Scenario 2: a config whose search root is gone must fail visibly.
	running = await launch(MISSING_ROOT_CONFIG, "missing-root");
	page = running.page;
	await page.fill('input[aria-label="Ask AutoRAG"]', QUERY);
	const submittedAt = Date.now();
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => document.querySelector(".ai .text-danger-text")?.textContent, null, { timeout: 5_000 });
	await page.waitForFunction(FINISHED, null, { timeout: 5_000 });
	const errorText = await page.locator(`${AI_PANEL} .text-danger-text`).textContent();
	await page.screenshot({ path: join(EVIDENCE, "4-missing-root-error.png") });
	check(
		"broken config shows an error",
		/search root does not exist/.test(errorText ?? ""),
		`after ${Date.now() - submittedAt}ms: "${errorText}"`,
	);
	await running.app.close();
	running = null;
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (running !== null) await running.page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
} finally {
	if (running !== null) await running.app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

writeFileSync(join(EVIDENCE, "summary.json"), JSON.stringify(results, null, 2));
const failed = results.filter((result) => !result.pass);
log(failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
