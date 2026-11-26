/**
 * Live end-to-end QA: Temp-folder sandbox verification & retry-on-failure for
 * both Magic Actions (manual editor + AI assistant) and File Automations (AI Agent),
 * driven against the real built Electron app and a real 2026+ LLM.
 *
 * Scenarios verified:
 *   1. Manual Magic Action editor modal ("임시 폴더에서 테스트"):
 *      - Broken script -> red failure card with real error.
 *      - Fixed script -> green success card showing stdout and created file diff (`upper.txt`).
 *   2. AI assistant (`app-customizer`) Magic Action creation with sandbox verification & retry:
 *      - Asks the real LLM to try a broken command first, observe the temp-sandbox failure,
 *        remake/fix it into a working uppercase-file script, verify in the temp folder, and save.
 *      - Confirms the real Documents folder was NOT polluted during sandbox testing.
 *      - Right-clicks a real `.txt` file in Finder and runs the saved Magic Action end-to-end.
 *   3. AI Agent (`InteractiveSearchAgent`) Automation creation with temp-folder sandbox verification:
 *      - Opens a new automation draft from the Automations tab.
 *      - Asks the real LLM to create a rule watching Documents for new `.txt` files that writes
 *        an uppercase `.done.log` sibling file, verifying it in a temp folder before finalizing.
 *      - Confirms Documents stayed clean during verification, the rule landed in `automations.json`
 *        and appeared in the Automations list, and executing the saved rule via the real librarian
 *        CLI against a newly dropped `.txt` file actually produces the expected `.done.log` file!
 *
 * Run in a macOS VM (never steals host focus):
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-verify-magic-and-automations.mjs --token "$TOKEN"
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { cssAttr, homeEnv, rmRetry } from "./platform.mjs";

const MODEL_ID = process.env.QA_LIVE_MODEL?.trim() || "deepseek/deepseek-v4.1-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-verify-magic-and-automations");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

function resolveOpenRouterKey() {
	const fileIdx = process.argv.indexOf("--openrouter-key-file");
	if (fileIdx >= 0 && typeof process.argv[fileIdx + 1] === "string" && existsSync(process.argv[fileIdx + 1])) {
		const raw = readFileSync(process.argv[fileIdx + 1], "utf8").trim();
		if (raw.length > 0) return raw;
	}
	const fromEnv = process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	return null;
}

function resolveDazziToken() {
	const fileIdx = process.argv.indexOf("--token-file");
	if (fileIdx >= 0 && typeof process.argv[fileIdx + 1] === "string" && existsSync(process.argv[fileIdx + 1])) {
		const raw = readFileSync(process.argv[fileIdx + 1], "utf8").trim();
		if (raw.length > 0) return raw;
	}
	const flagIdx = process.argv.indexOf("--token");
	if (flagIdx >= 0 && typeof process.argv[flagIdx + 1] === "string" && process.argv[flagIdx + 1].trim().length > 0) {
		return process.argv[flagIdx + 1].trim();
	}
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8")).dazzi;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
}

const OPENROUTER_KEY = resolveOpenRouterKey();
const TOKEN = OPENROUTER_KEY === null ? resolveDazziToken() : null;
if (OPENROUTER_KEY === null && TOKEN === null) {
	console.error("An OpenRouter API key (--openrouter-key-file / OPENROUTER_API_KEY) or Dazzi token (--token-file / --token / QA_DAZZI_TOKEN) is required.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "dazzi-qa-live-verify-")));
const HOME_DIR = join(WORK, "home");
const DOCS_DIR = join(HOME_DIR, "Documents");
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const RULES = join(AUTORAG_HOME, "automations.json");
const USER_DATA = join(WORK, "user-data");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "automations", "logs"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(USER_DATA, "settings"), { recursive: true });

writeFileSync(join(DOCS_DIR, "sample-note.txt"), "hello dazzi sandbox\nsecond line here\n", "utf8");

// MinSync stub that answers `--version`, `check`, `query`, `sync`, and `capabilities` so AI Search starts cleanly
// without waiting on a dense embedding server inside a fresh VM.
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(
	minsyncStub,
	[
		"#!/usr/bin/env node",
		'const c = process.argv[2];',
		'if (c === "--version" || c === "-V") { console.log("minsync 0.7.6"); process.exit(0); }',
		'if (c === "query") { console.log(JSON.stringify({ results: [] })); process.exit(0); }',
		'if (c === "check") { console.log(JSON.stringify({ vectorstore_ok: true, embedder_ok: true })); process.exit(0); }',
		'if (c === "sync") { console.log(JSON.stringify({ files_processed: 0 })); process.exit(0); }',
		'console.log(JSON.stringify({ initialized: true }));',
	].join("\n"),
	"utf8",
);
chmodSync(minsyncStub, 0o755);

if (OPENROUTER_KEY !== null) {
	writeFileSync(
		join(AGENT_DIR, "auth.json"),
		`${JSON.stringify({ openrouter: { type: "api_key", key: OPENROUTER_KEY } })}\n`,
		{ mode: 0o600 },
	);
} else {
	writeFileSync(
		join(AGENT_DIR, "auth.json"),
		`${JSON.stringify({ dazzi: { type: "oauth", access: TOKEN, refresh: "", expires: Number.MAX_SAFE_INTEGER } })}\n`,
		{ mode: 0o600 },
	);
}

const baseConfig =
	OPENROUTER_KEY !== null
		? {
				searchPaths: [DOCS_DIR],
				workspacePath: join(WORK, "workspace"),
				memoryPath: join(WORK, "memory.json"),
				minSync: { enabled: true, autoInstall: false, binaryPath: minsyncStub, embedder: { id: "none" } },
				jikji: false,
				jev: { model: "~typesafe/jev-latest", backend: "openrouter" },
				queryDecomposition: {
					model: {
						provider: "openrouter",
						id: "upstage/solar-mini4",
						name: "Upstage: Solar Mini 4",
						api: "openai-completions",
						baseUrl: "https://openrouter.ai/api/v1",
						apiKeyEnv: "OPENROUTER_API_KEY",
					},
				},
				model: {
					provider: "openrouter",
					id: process.env.QA_LIVE_MODEL?.trim() || "~anthropic/claude-sonnet-latest",
					name: "Anthropic: Claude Sonnet Latest",
					baseUrl: "https://openrouter.ai/api",
					api: "anthropic-messages",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1048576,
					maxTokens: 32000,
					apiKeyEnv: "OPENROUTER_API_KEY",
				},
			}
		: {
				searchPaths: [DOCS_DIR],
				workspacePath: join(WORK, "workspace"),
				memoryPath: join(WORK, "memory.json"),
				minSync: { enabled: true, autoInstall: false, binaryPath: minsyncStub, embedder: { id: "none" } },
				jikji: false,
				queryDecomposition: {
					model: {
						provider: "dazzi",
						id: "openai/gpt-6-luna",
						name: "GPT-6 Luna",
						baseUrl: "https://api.dazziapp.com/v1",
						api: "openai-responses",
						reasoning: true,
						input: ["text", "image"],
						contextWindow: 1050000,
						maxTokens: 32000,
					},
				},
				model: {
					provider: "dazzi",
					id: MODEL_ID,
					name: MODEL_ID,
					baseUrl: "https://api.dazziapp.com/v1",
					api: "openai-responses",
					reasoning: true,
					input: ["text", "image"],
					contextWindow: 1048576,
					maxTokens: 32000,
				},
			};
writeFileSync(CONFIG, `${JSON.stringify(baseConfig, null, 2)}\n`);
writeFileSync(
	join(USER_DATA, "settings", "settings-state.json"),
	`${JSON.stringify({ settings: { language: "ko", approvalMode: "full" }, permissions: {} }, null, 2)}\n`,
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowFor = (page, name) =>
	page
		.locator('[role="row"]')
		.filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
		.first();

const env = {
	...homeEnv(HOME_DIR),
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_QA_ROOT: DOCS_DIR,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	AUTORAG_PERMISSION_MODE: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: OPENROUTER_KEY ?? "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: USER_DATA, env, language: "ko" });
try {
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(90_000);

	const shot = async (name) => {
		await page.waitForTimeout(350);
		await page.screenshot({ path: join(EVIDENCE, `${name}.png`) });
	};

	const seenCustomizerProgress = [];
	await page.exposeFunction("__recordCustProgress", (text) => seenCustomizerProgress.push(text)).catch(() => undefined);
	await page.evaluate(() => {
		window.autorag.appCustomizer.onEvent((ev) => {
			if (ev.type === "progress") window.__recordCustProgress?.(ev.text);
		});
	});

	// =========================================================================
	// 1. Manual Magic Action Editor UI: Test in temp folder (fail -> fix -> pass)
	// =========================================================================
	await page.locator(".sidebar__item--settings").click();
	await page.locator(".settings-nav-item", { hasText: "우클릭 메뉴" }).click();
	await page.locator("h1.linear-title", { hasText: "우클릭 메뉴" }).waitFor();

	await page.locator('[data-action="add-magic-action"]').click();
	const editor = page.locator('[data-testid="magic-action-editor-modal"]');
	await editor.waitFor();
	await editor.locator('[data-testid="magic-editor-label"]').fill("수동 임시폴더 테스트");
	await editor.locator('[data-testid="magic-editor-kind-script"]').click();
	await editor.locator('[data-testid="magic-editor-command"]').fill('nonexistent_sandbox_cmd_xyz "$@"');
	await editor.locator('[data-action="test-magic-editor"]').click();

	const verifyBox = editor.locator('[data-testid="magic-editor-verify-result"]');
	await verifyBox.waitFor({ timeout: 30_000 });
	const failAttr = await verifyBox.getAttribute("data-verify-ok");
	const failText = await verifyBox.innerText();
	await shot("01-manual-magic-test-fail");
	check(
		"Manual Magic Action editor temp-folder test catches broken script",
		failAttr === "false" && /nonexistent_sandbox_cmd_xyz|not found|127/i.test(failText),
		`ok=${failAttr} text=${failText.replace(/\s+/g, " ").slice(0, 160)}`,
	);

	// Fix the script and re-test
	await editor
		.locator('[data-testid="magic-editor-command"]')
		.fill('tr "a-z" "A-Z" < "$1" > "$(dirname "$1")/upper.txt" && cat "$(dirname "$1")/upper.txt"');
	await editor.locator('[data-action="test-magic-editor"]').click();
	await page.waitForFunction(
		() => document.querySelector('[data-testid="magic-editor-verify-result"]')?.getAttribute("data-verify-ok") === "true",
		null,
		{ timeout: 30_000 },
	);
	const passText = await verifyBox.innerText();
	await shot("02-manual-magic-test-pass");
	check(
		"Manual Magic Action editor temp-folder test passes fixed script and shows created upper.txt diff",
		passText.includes("SAMPLE FILE") && passText.includes("upper.txt"),
		passText.replace(/\s+/g, " ").slice(0, 200),
	);

	await editor.locator('[data-action="cancel-magic-editor"]').click();
	await editor.waitFor({ state: "detached" });

	// =========================================================================
	// 2. Real LLM `app-customizer`: broken command -> temp sandbox failure -> fixed -> verified -> saved
	// =========================================================================
	const panel = page.locator('[data-testid="app-customizer-panel"][data-surface="contextMenu"]');
	await panel.waitFor();
	const custInput = panel.locator('textarea[data-testid="app-customizer-input"]');
	await custInput.click();
	await page.keyboard.type(
		[
			"단일 .txt 파일(extensions: ['txt'], selection: 'single', targetKind: 'file')을 우클릭했을 때 실행되는 스크립트 매직 액션(label: '대문자 사본 생성')을 만들어줘.",
			"일부러 첫 번째 시도에서는 존재하지 않는 명령 `dazzi_broken_cmd_xyz \"$1\"`으로 임시 폴더 테스트를 돌려 실패를 확인한 뒤,",
			"목표대로 실제 작동하도록 입력 파일 내용을 대문자로 변환해 같은 폴더의 `<원본경로>.upper.txt`로 저장하고 변환된 내용을 출력하는 셸 스크립트로 고쳐서 임시 폴더에서 다시 테스트하고 통과하면 저장해줘.",
		].join(" "),
	);
	await page.keyboard.press("Enter");

	await page.waitForFunction(
		() => {
			const p = document.querySelector('[data-testid="app-customizer-panel"]:not([hidden])');
			const settled = p?.querySelector(".customizer-turn__reply, .customizer-turn__error");
			const stopBtn = p?.querySelector('[data-action="stop-customizer-message"]');
			return settled !== null && settled !== undefined && stopBtn === null;
		},
		null,
		{ timeout: 240_000 },
	);
	await shot("03-ai-magic-verified");

	const custErrorCount = await panel.locator(".customizer-turn__error").count();
	const custReply =
		custErrorCount === 0
			? (await panel.locator(".customizer-turn").first().locator(".customizer-turn__reply").allInnerTexts()).join("\n\n")
			: await panel.locator(".customizer-turn__error").first().innerText();
	writeFileSync(join(EVIDENCE, "03-ai-magic-reply.txt"), `${custReply}\n\nPROGRESS:\n${JSON.stringify(seenCustomizerProgress, null, 2)}\n`);
	check("Real LLM app-customizer completed Magic Action test->fix->verify->save turn", custErrorCount === 0, custReply.slice(0, 220));

	const settingsPath = join(USER_DATA, "settings", "settings-state.json");
	const savedMenu = JSON.parse(readFileSync(settingsPath, "utf8")).settings?.contextMenu ?? { magicActions: [] };
	const createdAction = (savedMenu.magicActions ?? []).find((a) => a.execution.kind === "script");
	check(
		"Saved Magic Action has a fixed working script (not the broken command)",
		createdAction !== undefined && !createdAction.execution.command.includes("dazzi_broken_cmd_xyz"),
		JSON.stringify(createdAction),
	);
	check(
		"Real Documents folder was NOT polluted during Magic Action sandbox verification",
		JSON.stringify(readdirSync(DOCS_DIR).sort()) === JSON.stringify(["sample-note.txt"]),
		JSON.stringify(readdirSync(DOCS_DIR)),
	);

	// Execute the saved Magic Action for real on sample-note.txt in Finder
	await page.locator(".settings-sidebar-back").click();
	if (createdAction !== undefined) {
		await page.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
		await rowFor(page, "sample-note.txt").waitFor({ timeout: 20_000 });
		await rowFor(page, "sample-note.txt").click({ button: "right" });
		await page.waitForSelector('[role="menuitem"]');
		await page.locator(`[data-magic-action-id="${createdAction.id}"]`).click();

		const dialog = page.locator('[data-testid="magic-action-dialog"]');
		await dialog.waitFor({ timeout: 15_000 });
		await page.waitForFunction(
			() => document.querySelector('[data-testid="magic-action-dialog"] [data-action="close-magic-action"]') !== null,
			null,
			{ timeout: 60_000 },
		);
		await shot("04-ai-magic-executed");

		const upperCopy = join(DOCS_DIR, "sample-note.txt.upper.txt");
		const altUpperFiles = readdirSync(DOCS_DIR).filter((name) => /upper/i.test(name));
		const upperPath = existsSync(upperCopy) ? upperCopy : altUpperFiles[0] ? join(DOCS_DIR, altUpperFiles[0]) : null;
		const upperContent = upperPath !== null && existsSync(upperPath) ? readFileSync(upperPath, "utf8") : "";
		check(
			"Running the AI-created verified Magic Action on real sample-note.txt creates uppercase copy",
			upperPath !== null && upperContent.includes("HELLO DAZZI SANDBOX"),
			`files=${JSON.stringify(readdirSync(DOCS_DIR))} content=${JSON.stringify(upperContent)}`,
		);
		await dialog.locator('[data-action="close-magic-action"]').click();
		await dialog.waitFor({ state: "detached" });

		// Clean out the Magic Action output so Documents starts clean for the Automation check
		if (upperPath !== null && existsSync(upperPath)) rmSync(upperPath, { force: true });
	}

	// =========================================================================
	// 3. Real LLM AI Agent Automation: verify in temp folder -> save -> real run
	// =========================================================================
	await page.locator(".sidebar .sidebar__item", { hasText: "자동화" }).click();
	await page.waitForSelector('[data-rules-body], [data-daemon]', { timeout: 20_000 });
	const emptyAddBtn = page.locator("button", { hasText: /자동화 만들기|추가|규칙/ }).first();
	if ((await emptyAddBtn.count()) > 0) {
		await emptyAddBtn.click();
	} else {
		await page.locator("[data-rules-body]").click({ button: "right", position: { x: 40, y: 200 } });
		await page.waitForSelector('[role="menu"]');
		await page.locator('[role="menu"] [role="menuitem"]').first().click();
	}

	const AI_PANEL = '[data-ai-tab] section.ai:not([aria-hidden="true"])';
	const COMPOSER = `${AI_PANEL} .compose-box textarea`;
	await page.waitForSelector(COMPOSER, { timeout: 20_000 });
	await page.locator(COMPOSER).click();
	await page.keyboard.press("End");
	await page.keyboard.type(
		` ${DOCS_DIR} 폴더에 새 .txt 파일이 생성(create)되면 해당 파일의 텍스트를 대문자로 변환해 같은 폴더에 <원본경로>.done.log 파일로 저장하는 셸 명령 자동화 규칙을 만들어줘. 일부러 첫 번째 시도에서는 없는 명령 dazzi_missing_auto_cmd 를 test_automation_in_sandbox 로 테스트해 실패를 확인한 뒤, 실제로 동작하는 셸 명령으로 고쳐서 test_automation_in_sandbox 로 임시 폴더에서 .done.log 파일이 대문자로 생성되는지 확인하고 통과하면 저장해줘. 백그라운드 서비스(install_service)는 켜지 마.`,
		{ delay: 4 },
	);
	await page.keyboard.press("Enter");
	await page.waitForSelector(`${AI_PANEL} .user-msg`, { timeout: 20_000 });
	await sleep(1500);
	const settled = await page
		.waitForFunction(
			() => {
				const stop = document.querySelector('button[aria-label="중단"], button[aria-label="중지"], button[aria-label="Stop"]');
				const prose = document.querySelector('[data-ai-tab] section.ai:not([aria-hidden="true"]) .assistant-msg .assistant-prose');
				return stop === null && prose !== null && (prose.textContent ?? "").trim().length > 0;
			},
			null,
			{ timeout: 240_000 },
		)
		.then(() => true, () => false);
	await shot("05-ai-automation-created");

	const autoAnswer = (await page.locator(`${AI_PANEL} .assistant-msg .assistant-prose`).allTextContents())
		.map((entry) => entry.trim())
		.filter(Boolean)
		.join("\n");
	writeFileSync(join(EVIDENCE, "05-ai-automation-reply.txt"), `${autoAnswer}\n\nRULES:\n${existsSync(RULES) ? readFileSync(RULES, "utf8") : "(missing)"}\n`);
	check("Real LLM AI Agent finished automation test->fix->verify->save turn", settled && autoAnswer.length > 0, autoAnswer.slice(0, 220));

	check(
		"Real Documents folder stayed untouched during automation sandbox verification",
		JSON.stringify(readdirSync(DOCS_DIR).sort()) === JSON.stringify(["sample-note.txt"]),
		JSON.stringify(readdirSync(DOCS_DIR)),
	);

	const savedRules = existsSync(RULES) ? JSON.parse(readFileSync(RULES, "utf8")).automations : [];
	const autoRule = savedRules[0];
	check(
		"Saved automation rule watches Documents for .txt files and has fixed command (not broken)",
		autoRule !== undefined &&
			Array.isArray(autoRule.paths) &&
			autoRule.paths.some((p) => p === DOCS_DIR) &&
			Array.isArray(autoRule.include) &&
			autoRule.include.some((g) => g.includes("txt")) &&
			!JSON.stringify(autoRule.run ?? []).includes("dazzi_missing_auto_cmd"),
		JSON.stringify(autoRule),
	);

	// Switch back to Automations tab and screenshot the saved rule
	await page.locator(".tabs .tab").filter({ hasText: "자동화" }).first().click();
	await page.waitForSelector(`[role="row"][data-rule-id="${cssAttr(autoRule?.id ?? "")}"]`, { timeout: 30_000 }).catch(() => undefined);
	await shot("06-automations-list");

	// Prove the saved automation rule genuinely works when run against a real new `.txt` file!
	if (autoRule !== undefined) {
		const liveInput = join(DOCS_DIR, "live-drop.txt");
		writeFileSync(liveInput, "automation live test\n", "utf8");
		const cliEntry = join(ROOT, "node_modules", "@autorag", "librarian", "dist", "cli", "index.js");
		const runRes = spawnSync(
			"node",
			[cliEntry, "automate", "run", autoRule.id, "--json", "--event", `create:${liveInput}`],
			{ env, encoding: "utf8", timeout: 30_000 },
		);
		const logFiles = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".done.log"));
		const logContent = logFiles[0] ? readFileSync(join(DOCS_DIR, logFiles[0]), "utf8") : "";
		check(
			"Executing the saved automation rule on real live-drop.txt produces uppercase .done.log",
			runRes.status === 0 && logFiles.length >= 1 && logContent.includes("AUTOMATION LIVE TEST"),
			`status=${runRes.status} files=${JSON.stringify(readdirSync(DOCS_DIR))} content=${JSON.stringify(logContent)} stderr=${runRes.stderr.slice(0, 160)}`,
		);
	}
} finally {
	await app.close().catch(() => undefined);
	try {
		rmRetry(WORK);
	} catch {
		rmSync(WORK, { recursive: true, force: true });
	}
}

if (failures.length > 0) {
	console.error(`LIVE VERIFY QA FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL LIVE MAGIC ACTION & AUTOMATION SANDBOX VERIFICATION CHECKS PASSED");
