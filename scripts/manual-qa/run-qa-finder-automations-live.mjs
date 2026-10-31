/**
 * Live end-to-end — the 자동화 (Automations) tab against the real librarian agent,
 * a real model, and a real login service.
 *
 * What the other lane (`run-qa-finder-automations.mjs`) cannot show, this does:
 *   1. "Edit in AI Search" opens a draft; the person types the change and sends it;
 *      the librarian agent's `manage_automations` tool rewrites the rules file, and
 *      the rules list changes by itself, with no click;
 *   2. "Add a rule" does the same for a rule that did not exist;
 *   3. the footer's switch registers and removes the real OS login service
 *      (launchd), the service starts the daemon with a real Node, and a file
 *      change in a watched folder makes the daemon run the rule and the row show
 *      its last run.
 *
 * The model is reached through the Dazzi plan with an account key from `--token` or
 * QA_DAZZI_TOKEN, else the `dazzi` entry of this machine's `~/.pi/agent/auth.json`
 * (a fresh VM has none, so pass the key in: `QA_DAZZI_TOKEN=… bun run qa script …`
 * does not reach the guest, so a throwaway wrapper that sets it and imports this file
 * is the way). The key is written only into the throwaway profile and never printed.
 * QA_MODEL_ID picks another model (it must be a 2026 release). macOS only: the daemon
 * steps register and remove a launchd agent inside a throwaway HOME, so run this in a VM:
 *
 *   bun run build
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-finder-automations-live.mjs
 *
 * Evidence lands in QA_OUT/automations-live, else the ignored `.omo/` tree.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { cssAttr, homeEnv } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ? join(process.env.QA_OUT, "automations-live") : join(ROOT, ".omo/evidence/ai-finder-app/qa-automations-live");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

function realToken() {
	const argIdx = process.argv.indexOf("--token");
	const fromArg = argIdx >= 0 ? process.argv[argIdx + 1]?.trim() : undefined;
	if (fromArg) return fromArg;
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

const TOKEN = realToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine.");
	process.exit(2);
}
if (process.platform !== "darwin") {
	console.error("This lane registers a launchd agent; it runs on macOS only.");
	process.exit(2);
}

const MODEL_CACHE = process.env.FASTEMBED_CACHE_DIR?.trim() || join(homedir(), ".cache", "minsync", "models");
const TURN_MS = Number(process.env.QA_TURN_MS ?? 240_000);
// GLM 5.3 Flash (released 2026-08) is the model the Dazzi-login lane already proves the app drives to an answer.
const MODEL_ID = process.env.QA_MODEL_ID?.trim() || "z-ai/glm-5.3-flash";

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-automations-live-")));
const USER_HOME = join(WORK, "home");
const QA_ROOT = join(WORK, "qa-root");
const HOME = join(WORK, "autorag-home");
const AGENT_DIR = join(WORK, "pi-agent");
const CONFIG = join(WORK, "config.json");
const RULES = join(HOME, "automations.json");
const AGENTS_DIR = join(USER_HOME, "Library", "LaunchAgents");
const DOWNLOADS = join(QA_ROOT, "Downloads");
const NOTES = join(QA_ROOT, "Notes");
for (const dir of [USER_HOME, QA_ROOT, HOME, join(HOME, "bin"), join(HOME, "automations", "logs"), AGENT_DIR, DOWNLOADS, NOTES]) mkdirSync(dir, { recursive: true });
writeFileSync(join(DOWNLOADS, "report.pdf"), "%PDF-1.4\n");
writeFileSync(join(NOTES, "todo.md"), "# todo\n");
const minsync = join(HOME, "bin", "minsync");
writeFileSync(minsync, "#!/bin/sh\nexit 0\n");
chmodSync(minsync, 0o755);
// The Dazzi plan's credential, in the shape the app's account service stores it.
writeFileSync(join(AGENT_DIR, "auth.json"), `${JSON.stringify({ dazzi: { type: "oauth", access: TOKEN, refresh: "", expires: Number.MAX_SAFE_INTEGER } })}\n`, { mode: 0o600 });
writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [QA_ROOT],
			workspacePath: join(WORK, "workspace"),
			memoryPath: join(WORK, "memory.json"),
			// MinSync cannot be disabled; the stub binary above keeps it from indexing anything here.
			minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
			jikji: false,
			// What a signed-in profile pins for query decomposition; without it the librarian looks the default up in a catalog this profile has not fetched.
			queryDecomposition: { model: { provider: "dazzi", id: "openai/gpt-6-luna", name: "GPT-6 Luna", baseUrl: "https://api.dazziapp.com/v1", api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1050000, maxTokens: 32000 } },
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
		},
		null,
		2,
	)}\n`,
);

const ruleA = {
	id: "downloads-pdf-summary",
	paths: [DOWNLOADS],
	events: ["create"],
	include: ["**/*.pdf"],
	run: ["autorag", "search", "Summarize this document in three lines and save it next to the original"],
	appendFiles: true,
};
writeFileSync(RULES, `${JSON.stringify({ automations: [ruleA] }, null, 2)}\n`);
const readRules = () => JSON.parse(readFileSync(RULES, "utf8")).automations;

const ROW = (id) => `[role="row"][data-rule-id="${id}"]`;
const AI_PANEL = '[data-ai-tab] section.ai:not([aria-hidden="true"])';
const COMPOSER = `${AI_PANEL} .compose-box textarea`;
const text = async (page, selector) => ((await page.locator(selector).first().innerText({ timeout: 5000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
const rowIds = (page) => page.$$eval('[role="row"][data-rule-id]', (rows) => rows.map((row) => row.getAttribute("data-rule-id")));
const sidebarItem = (page, label) => page.locator(".sidebar__item", { hasText: label }).first();
const aiTabCount = (page) => page.$$eval(".tabs .tab", (tabs) => tabs.filter((tab) => tab.getAttribute("data-ai-search") === "true").length);

/** The launchd definition the librarian wrote, if any. */
function serviceDefinition() {
	const name = existsSync(AGENTS_DIR) ? readdirSync(AGENTS_DIR).find((entry) => /^com\.autorag\.automate.*\.plist$/.test(entry)) : undefined;
	if (name === undefined) return null;
	const plist = readFileSync(join(AGENTS_DIR, name), "utf8");
	const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1] ?? "";
	return { label: name.replace(/\.plist$/, ""), path: join(AGENTS_DIR, name), program };
}

/** Whatever the lane registered is removed, whatever happened. */
function removeService() {
	const definition = serviceDefinition();
	if (definition === null) return;
	spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${definition.label}`], { stdio: "ignore" });
	rmSync(definition.path, { force: true });
}

async function waitFor(label, probe, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	let last;
	for (;;) {
		last = await probe();
		if (last === true) return true;
		if (Date.now() >= deadline) {
			console.log(`  (gave up waiting for: ${label}; last: ${JSON.stringify(last)})`);
			return false;
		}
		await sleep(500);
	}
}

/** Type the change after the draft, send it, and wait for the agent's turn to end. */
async function sendChange(page, change, shot) {
	await page.locator(COMPOSER).click();
	await page.keyboard.press("End");
	await page.keyboard.type(change, { delay: 8 });
	const sent = await page.locator(COMPOSER).inputValue();
	await page.keyboard.press("Enter");
	await page.waitForSelector(`${AI_PANEL} .user-msg`, { timeout: 20_000 });
	await sleep(1500);
	const settled = await page
		.waitForFunction(() => document.querySelector('button[aria-label="Stop"]') === null, null, { timeout: TURN_MS })
		.then(() => true, () => false);
	if (!settled) {
		await page.screenshot({ path: join(EVIDENCE, `stalled-${shot}`) });
		writeFileSync(join(EVIDENCE, `stalled-${shot.replace(/\.png$/, "")}.txt`), (await page.locator(AI_PANEL).first().innerText().catch(() => "")) ?? "");
		// What the app is running right now: a rule test that spawned a second app would show here.
		const processes = spawnSync("ps", ["-axo", "pid,ppid,etime,command"], { encoding: "utf8" }).stdout.split("\n").filter((line) => /Electron|Dazzi|autorag|dist\/cli/i.test(line) && !/ps -axo/.test(line)).map((line) => line.slice(0, 260)).join("\n");
		const logs = existsSync(join(HOME, "automations", "logs")) ? readdirSync(join(HOME, "automations", "logs")).join(", ") : "";
		writeFileSync(join(EVIDENCE, "stalled-processes.txt"), `${processes}\n\nrules file:\n${readFileSync(RULES, "utf8")}\nlogs: ${logs}\n`);
		throw new Error(`the agent's turn did not end in ${TURN_MS / 1000} s (see stalled-${shot})`);
	}
	await sleep(500);
	const answer = (await page.locator(`${AI_PANEL} .assistant-msg .assistant-prose`).allTextContents()).map((entry) => entry.trim()).filter(Boolean).join("\n");
	const error = (await page.locator(`${AI_PANEL} .text-danger-text`).first().textContent({ timeout: 500 }).catch(() => null)) ?? "";
	await page.screenshot({ path: join(EVIDENCE, shot) });
	writeFileSync(join(EVIDENCE, `${shot.replace(/\.png$/, "")}.txt`), `SENT:\n${sent}\n\nANSWER:\n${answer}\n\nERROR:\n${error}\n`);
	return { sent, answer, error };
}

const app = await launchFinder({
	userDataDir: join(WORK, "user-data"),
	language: "en",
	env: {
		...homeEnv(USER_HOME),
		AUTORAG_HOME: HOME,
		AUTORAG_CONFIG: CONFIG,
		AUTORAG_QA_ROOT: QA_ROOT,
		PI_CODING_AGENT_DIR: AGENT_DIR,
		// The throwaway HOME would hide the embedding model the first query waits for; the real cache is reused.
		FASTEMBED_CACHE_DIR: MODEL_CACHE,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		ELECTRON_RENDERER_URL: "",
		PATH: `${join(HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		OPENROUTER_API_KEY: "",
		OPENAI_API_KEY: "",
		ANTHROPIC_API_KEY: "",
	},
});

try {
	const mainLog = join(EVIDENCE, "main.log");
	for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", (chunk) => appendFileSync(mainLog, chunk));
	app.process().stderr?.on("data", (chunk) => {
		const line = String(chunk).trim();
		if (/\[automations\]|\[providers\]|No API key|\[account\]/.test(line)) console.log(`[main:err] ${line.slice(0, 300)}`);
	});
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(15_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
	await page.waitForSelector(`[data-path="${cssAttr(DOWNLOADS)}"]`, { timeout: 30_000 });
	await sidebarItem(page, "Automations").click();
	await page.waitForSelector(ROW(ruleA.id), { timeout: 30_000 });
	check("the seeded rule is listed", (await text(page, ROW(ruleA.id))).includes("New PDF"), await text(page, ROW(ruleA.id)));
	check("the background service starts off", (await text(page, "[data-daemon]")).includes("Off · rules are not running"), await text(page, "[data-daemon]"));

	// 1. Edit a rule through the AI Search draft, with the real agent.
	await page.locator(ROW(ruleA.id)).click();
	await page.keyboard.press("Enter");
	await page.waitForSelector(COMPOSER);
	const draft = await page.locator(COMPOSER).inputValue();
	check("Enter opens the edit draft naming the rule", draft.startsWith("Edit this automation rule — downloads-pdf-summary") && draft.endsWith(": "), JSON.stringify(draft));
	const edit = await sendChange(page, "Watch for new Word documents (.docx) instead of PDF files. Keep the instruction and everything else exactly as it is.", "01-edit-run.png");
	check("the agent's turn ended without an error", edit.error === "" && edit.answer.length > 0, edit.error || edit.answer.slice(0, 200));
	const edited = readRules().find((rule) => rule.id === ruleA.id);
	check("the rule keeps its id and its instruction", edited !== undefined && JSON.stringify(edited.run) === JSON.stringify(ruleA.run) && readRules().length === 1, JSON.stringify(readRules()));
	check("the rule now watches Word documents, not PDF files", edited !== undefined && edited.include.some((glob) => /\.docx?$/.test(glob)) && !edited.include.some((glob) => glob.endsWith(".pdf")), JSON.stringify(edited?.include));
	await page.locator(".tabs .tab").filter({ hasText: "Automations" }).first().click();
	check("the list shows the change without a click", await waitFor("Word in the row", async () => (await text(page, ROW(ruleA.id))).includes("Word"), 30_000), await text(page, ROW(ruleA.id)));
	await sleep(350);
	await page.screenshot({ path: join(EVIDENCE, "02-list-after-edit.png") });

	// 2. Add a rule through the AI Search draft.
	await page.locator("[data-rules-body]").click({ button: "right", position: { x: 40, y: 300 } });
	await page.waitForSelector('[role="menu"]');
	await page.locator('[role="menu"] [role="menuitem"]').click();
	await page.waitForSelector(COMPOSER);
	const aiTabs = await aiTabCount(page);
	check("add opens a creation draft", (await page.locator(COMPOSER).inputValue()).startsWith("Create a new automation rule."), JSON.stringify(await page.locator(COMPOSER).inputValue()));
	const add = await sendChange(
		page,
		`When a Markdown file in the folder ${NOTES} is created or changed, keep the search index fresh with the refresh command. Only create the rule; do not start the background service.`,
		"03-add-run.png",
	);
	check("the agent's turn ended without an error", add.error === "" && add.answer.length > 0, add.error || add.answer.slice(0, 200));
	const added = readRules().find((rule) => rule.id !== ruleA.id);
	check("a second rule exists, watching Notes, running the refresh", added !== undefined && added.paths.includes(NOTES) && added.run[0] === "autorag" && added.run[1] === "refresh", JSON.stringify(added));
	check("the rule is limited to Markdown files", added !== undefined && added.include.some((glob) => /\.(md|markdown)$/.test(glob)), JSON.stringify(added?.include));
	check("the add stayed in its own AI tab", (await aiTabCount(page)) === aiTabs);
	await page.locator(".tabs .tab").filter({ hasText: "Automations" }).first().click();
	check("the new rule appears in the list without a click", added !== undefined && (await waitFor("the new row", async () => (await rowIds(page)).includes(added.id), 30_000)), JSON.stringify(await rowIds(page)));
	check("the count follows", (await text(page, "[data-daemon]")).includes("Rules: 2"), await text(page, "[data-daemon]"));
	await sleep(350);
	await page.screenshot({ path: join(EVIDENCE, "04-list-after-add.png") });
	const agentService = serviceDefinition();
	console.log(`INFO the agent ${agentService === null ? "did not register" : "registered"} a login service`);
	if (agentService !== null) {
		check("the service the agent registered starts Node, not the Dazzi app", /(^|\/)node$/.test(agentService.program), agentService.program);
		removeService();
		await page.locator(ROW(ruleA.id)).click();
	}

	// 3. The footer's switch: the real login service and the daemon.
	await waitFor("the footer settles", async () => (await text(page, "[data-daemon]")).includes("Off · rules are not running"), 30_000);
	await page.locator("[data-daemon] button").click();
	const on = await waitFor("daemon on", async () => (await text(page, "[data-daemon]")).includes("Running in the background"), 90_000);
	check("Turn on starts the background service", on, await text(page, "[data-daemon]"));
	const service = serviceDefinition();
	check("a launchd agent was registered", service !== null, service?.path);
	check("it starts Node with the librarian CLI, not the Dazzi app", service !== null && /(^|\/)node$/.test(service.program), service?.program);
	await sleep(350);
	await page.screenshot({ path: join(EVIDENCE, "05-daemon-on.png") });

	// 4. A file change in a watched folder runs the rule.
	if (added !== undefined) {
		writeFileSync(join(NOTES, "meeting.md"), "# meeting\nnew note\n");
		const ran = await waitFor("the rule's last run", async () => (await page.locator(`${ROW(added.id)} [data-run-tone]`).first().getAttribute("data-run-tone").catch(() => "never")) !== "never", 90_000);
		check("the daemon ran the rule and the row shows its last run", ran, await text(page, ROW(added.id)));
		await sleep(350);
		await page.screenshot({ path: join(EVIDENCE, "06-after-run.png") });
	}

	// 5. Turn it off again.
	await page.locator("[data-daemon] button").click();
	const off = await waitFor("daemon off", async () => (await text(page, "[data-daemon]")).includes("Off · rules are not running"), 60_000);
	check("Turn off stops the service", off, await text(page, "[data-daemon]"));
	check("the launchd agent is gone", serviceDefinition() === null, serviceDefinition()?.path);
	check("the rules were not touched by the switch", readRules().length === 2);
} catch (error) {
	check("run completed", false, String(error).slice(0, 600));
} finally {
	removeService();
	await app.close().catch(() => undefined);
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
