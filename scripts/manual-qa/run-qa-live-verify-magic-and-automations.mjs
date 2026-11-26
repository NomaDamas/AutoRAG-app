/**
 * Live end-to-end QA: Unified temp-folder sandbox verification, customization, and
 * real pi session JSONL trace inspection for BOTH:
 *   - Right-click Magic Actions (created & customized directly from the main AI Agent / AI Search, plus manual UI editor),
 *   - File Automations (created & customized directly from the main AI Agent / AI Search),
 * driven against the real built Electron app and a real 2026+ LLM.
 *
 * Scenarios verified:
 *   1. Manual Magic Action editor modal ("임시 폴더에서 테스트"):
 *      - Broken script -> red failure card with real error.
 *      - Fixed script -> green success card showing stdout and created file diff (`upper.txt`).
 *   2. Main AI Agent (AI Search) Magic Action creation + customization + REAL JSONL TRACE:
 *      - Turn 1: Asks the main AI Agent directly to test a broken command via `test_magic_action`,
 *        observe failure, fix it into an uppercase `.upper.txt` script, re-verify in the temp folder,
 *        and save via `upsert_magic_action`.
 *      - Turn 2 (follow-up in the same chat): Asks the main AI Agent to inspect via `list_magic_actions`,
 *        customize label -> `대문자 v2 사본` and output -> `.v2.txt`, re-verify in temp sandbox, and update.
 *      - Reads the real `<userData>/chat-sessions/*.jsonl` trace and asserts the exact tool call & result chain.
 *      - Confirms Documents stayed clean during verification, right-clicks `sample-note.txt` in Finder,
 *        runs `대문자 v2 사본`, and verifies `sample-note.txt.v2.txt` contains `HELLO DAZZI SANDBOX`.
 *   3. Main AI Agent (AI Search) File Automation creation + customization + REAL JSONL TRACE:
 *      - Turn 1: Opens a new chat from Automations, tests broken `dazzi_missing_auto_cmd` with
 *        `test_automation_in_sandbox`, observes failure, fixes to uppercase `.done.log`, verifies with 0
 *        retrigger warnings, and saves via `manage_automations`.
 *      - Turn 2 (follow-up in the same chat): Customizes the rule to write `.v2.log`, verifies in temp
 *        sandbox, and updates via `manage_automations`.
 *      - Reads the real `<userData>/chat-sessions/*.jsonl` trace and asserts the exact tool call & result chain.
 *      - Confirms Documents stayed clean during verification, screenshots the rule in the Automations tab,
 *        and runs the real librarian CLI against `live-drop.txt` to verify `live-drop.txt.v2.log` is created.
 *
 * Run in a macOS VM (never steals host focus):
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-verify-magic-and-automations.mjs --openrouter-key-file <path>
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const CHAT_SESSIONS_DIR = join(USER_DATA, "chat-sessions");

for (const folder of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
	mkdirSync(join(HOME_DIR, folder), { recursive: true });
}
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "automations", "logs"), { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(USER_DATA, "settings"), { recursive: true });

writeFileSync(join(DOCS_DIR, "sample-note.txt"), "hello dazzi sandbox\nsecond line here\n", "utf8");

// MinSync stub so AI Search starts cleanly without downloading a dense embedding model inside a fresh VM.
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

/** Read all pi session JSONL files under `CHAT_SESSIONS_DIR`, newest last, and extract tool call/result traces. */
function readAllSessionTraces() {
	if (!existsSync(CHAT_SESSIONS_DIR)) return [];
	const files = readdirSync(CHAT_SESSIONS_DIR)
		.filter((name) => name.endsWith(".jsonl"))
		.map((name) => {
			const full = join(CHAT_SESSIONS_DIR, name);
			return { name, full, mtimeMs: statSync(full).mtimeMs };
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);

	return files.map(({ name, full }) => {
		const raw = readFileSync(full, "utf8");
		const steps = [];
		for (const line of raw.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let rec;
			try {
				rec = JSON.parse(trimmed);
			} catch {
				continue;
			}
			if (rec.type !== "message" || !rec.message) continue;
			const msg = rec.message;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part?.type === "toolCall") {
						steps.push({
							kind: "toolCall",
							toolName: part.name,
							id: part.id,
							arguments: part.arguments ?? part.input ?? {},
						});
					}
				}
			} else if (msg.role === "toolResult") {
				const text = Array.isArray(msg.content)
					? msg.content
							.filter((p) => p?.type === "text" && typeof p.text === "string")
							.map((p) => p.text)
							.join("\n")
					: "";
				let parsedJson = null;
				try {
					parsedJson = JSON.parse(text);
				} catch {
					// Not pure JSON (e.g., manage_automations text output)
				}
				steps.push({
					kind: "toolResult",
					toolName: msg.toolName,
					toolCallId: msg.toolCallId,
					isError: msg.isError === true,
					parsedJson,
					textSnippet: text.slice(0, 600),
				});
			}
		}
		return { file: name, steps };
	});
}

async function waitForAiTurnSettled(page, panelSelector, expectedAssistantCount) {
	await sleep(1500);
	return page
		.waitForFunction(
			({ sel, count }) => {
				const stop = document.querySelector('button[aria-label="중단"], button[aria-label="중지"], button[aria-label="Stop"]');
				const panel = document.querySelector(sel);
				if (!panel || stop !== null) return false;
				const msgs = [...panel.querySelectorAll(".assistant-msg .assistant-prose")];
				if (msgs.length < count) return false;
				const latest = msgs[msgs.length - 1];
				return latest !== undefined && (latest.textContent ?? "").trim().length > 0;
			},
			{ sel: panelSelector, count: expectedAssistantCount },
			{ timeout: 240_000 },
		)
		.then(() => true, () => false);
}

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
	await page.locator(".settings-sidebar-back").click();

	// =========================================================================
	// 2. Main AI Agent (AI Search): Create + Verify (fail->fix->pass) + Customize Magic Action + REAL TRACE
	// =========================================================================
	await page.locator(".sidebar .sidebar__item", { hasText: "AI 에이전트" }).click();
	const AI_PANEL = '[data-ai-tab] section.ai:not([aria-hidden="true"])';
	const COMPOSER = `${AI_PANEL} .compose-box textarea`;
	await page.waitForSelector(COMPOSER, { timeout: 20_000 });

	// Turn 1: Create + verify fail -> fix -> pass -> save
	await page.locator(COMPOSER).click();
	await page.keyboard.type(
		[
			"단일 .txt 파일(extensions: ['txt'], selection: 'single', targetKind: 'file')을 우클릭했을 때 실행되는 스크립트 매직 액션(id: 'ai-upper-copy', label: '대문자 사본 생성')을 만들어줘.",
			"일부러 1차 시도에서는 없는 명령 `dazzi_broken_main_magic_xyz \"$1\"`으로 test_magic_action을 돌려 임시 폴더 실패를 확인한 뒤,",
			"실제로 작동하도록 입력 파일 내용을 대문자로 변환해 `$1.upper.txt`로 저장하고 출력하는 셸 스크립트(`tr '[:lower:]' '[:upper:]' < \"$1\" > \"$1.upper.txt\" && cat \"$1.upper.txt\"`)로 고쳐서 test_magic_action으로 재검증 통과 후 upsert_magic_action으로 저장해줘.",
		].join(" "),
		{ delay: 2 },
	);
	await page.keyboard.press("Enter");
	await page.waitForSelector(`${AI_PANEL} .user-msg`, { timeout: 20_000 });
	const magicTurn1Settled = await waitForAiTurnSettled(page, AI_PANEL, 1);
	await shot("03-main-agent-magic-created");

	const settingsPath = join(USER_DATA, "settings", "settings-state.json");
	const savedMenuV1 = JSON.parse(readFileSync(settingsPath, "utf8")).settings?.contextMenu ?? { magicActions: [] };
	const magicV1 = (savedMenuV1.magicActions ?? []).find((a) => a.execution.kind === "script");
	check(
		"Main AI Agent Turn 1 created and saved verified Magic Action directly from AI Search",
		magicTurn1Settled && magicV1 !== undefined && !magicV1.execution.command.includes("dazzi_broken_main_magic_xyz"),
		JSON.stringify(magicV1),
	);

	// Turn 2: Customize existing Magic Action in the same AI Search chat
	const existingProseCount = await page.locator(`${AI_PANEL} .assistant-msg .assistant-prose`).count();
	await page.locator(COMPOSER).click();
	await page.keyboard.type(
		"방금 만든 매직 액션을 list_magic_actions로 확인하고, 라벨을 '대문자 v2 사본'으로 바꾸고 출력 파일명을 `$1.v2.txt`로 저장하도록 커스텀 수정한 뒤 임시 폴더에서 test_magic_action으로 다시 검증하고 upsert_magic_action으로 업데이트해줘.",
		{ delay: 2 },
	);
	await page.keyboard.press("Enter");
	const magicTurn2Settled = await waitForAiTurnSettled(page, AI_PANEL, existingProseCount + 1);
	await shot("04-main-agent-magic-customized");

	const savedMenuV2 = JSON.parse(readFileSync(settingsPath, "utf8")).settings?.contextMenu ?? { magicActions: [] };
	const magicV2 = (savedMenuV2.magicActions ?? []).find((a) => a.execution.kind === "script");
	check(
		"Main AI Agent Turn 2 customized Magic Action to v2 (.v2.txt) after re-verification",
		magicTurn2Settled &&
			magicV2 !== undefined &&
			magicV2.label.includes("v2") &&
			magicV2.execution.command.includes(".v2.txt"),
		JSON.stringify(magicV2),
	);
	check(
		"Real Documents folder was NOT polluted during main-agent Magic Action verification/customization",
		JSON.stringify(readdirSync(DOCS_DIR).sort()) === JSON.stringify(["sample-note.txt"]),
		JSON.stringify(readdirSync(DOCS_DIR)),
	);

	// Inspect REAL pi session JSONL trace for Scenario 2!
	const magicTraces = readAllSessionTraces();
	const magicSessionTrace = magicTraces.find((t) => t.steps.some((s) => s.toolName === "test_magic_action"));
	writeFileSync(
		join(EVIDENCE, "04-main-agent-magic-trace.json"),
		`${JSON.stringify(magicSessionTrace ?? { missing: true, allFiles: magicTraces.map((t) => t.file) }, null, 2)}\n`,
	);
	const magicTestResults = (magicSessionTrace?.steps ?? []).filter((s) => s.kind === "toolResult" && s.toolName === "test_magic_action");
	const magicUpsertResults = (magicSessionTrace?.steps ?? []).filter((s) => s.kind === "toolResult" && s.toolName === "upsert_magic_action");
	const magicListCalled = (magicSessionTrace?.steps ?? []).some((s) => s.kind === "toolCall" && s.toolName === "list_magic_actions");
	const hasMagicFailThenPass =
		magicTestResults.some((r) => r.parsedJson?.ok === false) &&
		magicTestResults.some((r) => r.parsedJson?.ok === true && (r.parsedJson?.diff?.created ?? []).some((f) => String(f.path).includes(".upper.txt")));
	const hasMagicV2Verified =
		magicTestResults.some((r) => r.parsedJson?.ok === true && (r.parsedJson?.diff?.created ?? []).some((f) => String(f.path).includes(".v2.txt"))) ||
		magicUpsertResults.some((r) => r.parsedJson?.saved === true && r.parsedJson?.verified === true && (r.parsedJson?.verification?.diff?.created ?? []).some((f) => String(f.path).includes(".v2.txt")));

	const magicToolNames = (magicSessionTrace?.steps ?? []).filter((s) => s.kind === "toolCall").map((s) => s.toolName);
	check(
		"REAL JSONL TRACE proves Magic Action fail -> fix -> pass -> save -> list -> customize + re-verify (no revise_answer strikethroughs)",
		magicSessionTrace !== undefined &&
			hasMagicFailThenPass &&
			magicListCalled &&
			hasMagicV2Verified &&
			!magicToolNames.includes("revise_answer") &&
			magicUpsertResults.filter((r) => r.parsedJson?.saved === true && r.parsedJson?.verified === true).length >= 2,
		`tools=${JSON.stringify(magicToolNames)}`,
	);

	// Execute the main-agent-created & customized Magic Action in Finder right-click menu!
	if (magicV2 !== undefined) {
		await page.locator(".sidebar .sidebar__item", { hasText: "문서" }).click();
		await rowFor(page, "sample-note.txt").waitFor({ timeout: 20_000 });
		await rowFor(page, "sample-note.txt").click({ button: "right" });
		await page.waitForSelector('[role="menuitem"]');
		await page.locator(`[data-magic-action-id="${magicV2.id}"]`).click();

		const dialog = page.locator('[data-testid="magic-action-dialog"]');
		await dialog.waitFor({ timeout: 15_000 });
		await page.waitForFunction(
			() => document.querySelector('[data-testid="magic-action-dialog"] [data-action="close-magic-action"]') !== null,
			null,
			{ timeout: 60_000 },
		);
		await shot("05-main-agent-magic-executed");

		const v2Files = readdirSync(DOCS_DIR).filter((name) => name.includes(".v2.txt"));
		const v2Path = v2Files[0] ? join(DOCS_DIR, v2Files[0]) : null;
		const v2Content = v2Path !== null && existsSync(v2Path) ? readFileSync(v2Path, "utf8") : "";
		check(
			"Right-click running the main-agent customized Magic Action on real sample-note.txt creates .v2.txt",
			v2Path !== null && v2Content.includes("HELLO DAZZI SANDBOX"),
			`files=${JSON.stringify(readdirSync(DOCS_DIR))} content=${JSON.stringify(v2Content)}`,
		);
		await dialog.locator('[data-action="close-magic-action"]').click();
		await dialog.waitFor({ state: "detached" });
		if (v2Path !== null && existsSync(v2Path)) rmSync(v2Path, { force: true });
	}

	// =========================================================================
	// 3. Main AI Agent (AI Search): Create + Verify (fail->fix->pass) + Customize Automation + REAL TRACE
	// =========================================================================
	const sessionFilesBeforeAuto = new Set(existsSync(CHAT_SESSIONS_DIR) ? readdirSync(CHAT_SESSIONS_DIR) : []);
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

	await page.waitForSelector(COMPOSER, { timeout: 20_000 });
	await page.locator(COMPOSER).click();
	await page.keyboard.press("End");
	await page.keyboard.type(
		` ${DOCS_DIR} 폴더에 새 .txt 파일이 생성(create)되면 해당 파일 내용을 대문자로 변환해 같은 폴더에 <원본경로>.done.log 파일로 저장하는 셸 명령 자동화 규칙(id: 'txt-upper-done-log')을 만들어줘. 일부러 1차 시도에서는 없는 명령 dazzi_missing_auto_cmd 를 test_automation_in_sandbox 로 테스트해 실패를 확인한 뒤, 실제로 동작하는 셸 명령으로 고쳐서 test_automation_in_sandbox 로 임시 폴더에서 .done.log 파일이 대문자로 생성되고 재트리거 경고가 없는지 확인한 뒤 manage_automations로 저장해줘. 백그라운드 서비스(install_service)는 켜지 마.`,
		{ delay: 2 },
	);
	await page.keyboard.press("Enter");
	await page.waitForSelector(`${AI_PANEL} .user-msg`, { timeout: 20_000 });
	const autoTurn1Settled = await waitForAiTurnSettled(page, AI_PANEL, 1);
	await shot("06-main-agent-automation-created");

	const rulesV1 = existsSync(RULES) ? JSON.parse(readFileSync(RULES, "utf8")).automations : [];
	check(
		"Main AI Agent Turn 1 created and saved verified automation rule",
		autoTurn1Settled && rulesV1.length >= 1 && !JSON.stringify(rulesV1[0].run ?? []).includes("dazzi_missing_auto_cmd"),
		JSON.stringify(rulesV1[0]),
	);

	// Turn 2: Customize existing Automation in the same chat to output .v2.log
	const autoProseBefore = await page.locator(`${AI_PANEL} .assistant-msg .assistant-prose`).count();
	await page.locator(COMPOSER).click();
	await page.keyboard.type(
		"방금 만든 txt-upper-done-log 자동화 규칙을 커스텀해서 출력 파일명을 `<원본경로>.v2.log`로 변경하고, 임시 폴더에서 test_automation_in_sandbox로 `.v2.log` 생성을 다시 검증한 뒤 manage_automations로 저장해줘. 백그라운드 서비스는 켜지 마.",
		{ delay: 2 },
	);
	await page.keyboard.press("Enter");
	const autoTurn2Settled = await waitForAiTurnSettled(page, AI_PANEL, autoProseBefore + 1);
	await shot("07-main-agent-automation-customized");

	const rulesV2 = existsSync(RULES) ? JSON.parse(readFileSync(RULES, "utf8")).automations : [];
	const finalAutoRule = rulesV2.find((r) => r.id === "txt-upper-done-log") ?? rulesV2[0];
	check(
		"Main AI Agent Turn 2 customized automation rule to .v2.log and kept Documents untouched",
		autoTurn2Settled &&
			finalAutoRule !== undefined &&
			JSON.stringify(finalAutoRule.run ?? []).includes(".v2.log") &&
			JSON.stringify(readdirSync(DOCS_DIR).sort()) === JSON.stringify(["sample-note.txt"]),
		`rule=${JSON.stringify(finalAutoRule)} docs=${JSON.stringify(readdirSync(DOCS_DIR))}`,
	);

	// Inspect REAL pi session JSONL trace for Scenario 3!
	const allTracesAfterAuto = readAllSessionTraces();
	const autoSessionTrace =
		allTracesAfterAuto.find((t) => !sessionFilesBeforeAuto.has(t.file) && t.steps.some((s) => s.toolName === "test_automation_in_sandbox")) ??
		allTracesAfterAuto.find((t) => t.steps.some((s) => s.toolName === "test_automation_in_sandbox"));
	writeFileSync(
		join(EVIDENCE, "07-main-agent-automation-trace.json"),
		`${JSON.stringify(autoSessionTrace ?? { missing: true }, null, 2)}\n`,
	);
	const autoTestResults = (autoSessionTrace?.steps ?? []).filter((s) => s.kind === "toolResult" && s.toolName === "test_automation_in_sandbox");
	const autoManageResults = (autoSessionTrace?.steps ?? []).filter((s) => s.kind === "toolResult" && s.toolName === "manage_automations");
	const hasAutoFailThenPass =
		autoTestResults.some((r) => r.parsedJson?.ok === false) &&
		autoTestResults.some((r) => r.parsedJson?.ok === true && (r.parsedJson?.diff?.created ?? []).some((f) => String(f.path).includes(".done.log")) && (r.parsedJson?.retriggerWarnings ?? []).length === 0);
	const hasAutoV2Verified =
		autoTestResults.some((r) => r.parsedJson?.ok === true && (r.parsedJson?.diff?.created ?? []).some((f) => String(f.path).includes(".v2.log"))) ||
		autoManageResults.some((r) => r.textSnippet.includes("Verified in temporary sandbox") && r.textSnippet.includes(".v2.log"));
	const verifiedSaves = autoManageResults.filter((r) => r.textSnippet.includes("Verified in temporary sandbox"));

	check(
		"REAL JSONL TRACE proves Automation fail -> fix -> pass -> save -> customize + re-verify",
		autoSessionTrace !== undefined && hasAutoFailThenPass && hasAutoV2Verified && verifiedSaves.length >= 2,
		`tools=${JSON.stringify((autoSessionTrace?.steps ?? []).filter((s) => s.kind === "toolCall").map((s) => s.toolName))}`,
	);

	// Switch back to Automations tab and screenshot the saved customized rule
	await page.locator(".tabs .tab").filter({ hasText: "자동화" }).first().click();
	await page.waitForSelector(`[role="row"][data-rule-id="${cssAttr(finalAutoRule?.id ?? "")}"]`, { timeout: 30_000 }).catch(() => undefined);
	await shot("08-automations-list");

	// Prove the customized automation rule genuinely runs on a real newly created `.txt` file!
	if (finalAutoRule !== undefined) {
		const liveInput = join(DOCS_DIR, "live-drop.txt");
		writeFileSync(liveInput, "automation live v2 test\n", "utf8");
		const cliEntry = join(ROOT, "node_modules", "@autorag", "librarian", "dist", "cli", "index.js");
		const runRes = spawnSync(
			"node",
			[cliEntry, "automate", "run", finalAutoRule.id, "--json", "--event", `create:${liveInput}`],
			{ env, encoding: "utf8", timeout: 30_000 },
		);
		const logFiles = readdirSync(DOCS_DIR).filter((name) => name.endsWith(".v2.log"));
		const logContent = logFiles[0] ? readFileSync(join(DOCS_DIR, logFiles[0]), "utf8") : "";
		check(
			"Executing customized automation rule on real live-drop.txt produces uppercase .v2.log",
			runRes.status === 0 && logFiles.length >= 1 && logContent.includes("AUTOMATION LIVE V2 TEST"),
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
console.log("ALL UNIFIED LIVE MAGIC ACTION & AUTOMATION VERIFICATION + TRACE CHECKS PASSED");
