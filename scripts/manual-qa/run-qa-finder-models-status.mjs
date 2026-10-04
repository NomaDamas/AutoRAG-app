import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed } from "@autorag/librarian/core";
import { launchFinder, finderWindow } from "./launch-finder.mjs";

// Settings opens as a tab. The LLM panel reads the shared AutoRAG config and
// shows the resolved provider/model rows after the editable connection fields.
// Production build first: bun run build
const EVIDENCE = new URL("../../.omo/evidence/ai-finder-app/models-status/", import.meta.url).pathname;
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-models-"));
const configPath = join(root, "config.json");
const writeConfig = (model) => writeFileSync(configPath, `${JSON.stringify({
	searchPaths: [root],
	workspacePath: root,
	model,
}, null, 2)}\n`);

const MODEL = {
	provider: "openrouter",
	id: "deepseek/deepseek-v4.1-flash",
	baseUrl: "https://openrouter.ai/api/v1",
	api: "openai-completions",
	apiKeyEnv: "OPENROUTER_API_KEY",
};
writeConfig(MODEL);

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, OPENROUTER_API_KEY: "qa-key", PATH: "/usr/bin:/bin" };
const resolvedRole = async () => (await resolveAgentModelDetailed(
	resolveConfigReadOnly({ flags: {}, env: { ...process.env, ...env }, cwd: root }),
	{ env: { ...process.env, ...env } },
)).role;

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
try {
	const page = await finderWindow(app);
	await page.waitForSelector('[role="row"]');
	const settingsOpen = () => page.locator(".settings-panel").count();
	const openModels = async () => {
		await page.locator(".sidebar__item", { hasText: "Settings" }).click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "LLM Models" }).click();
		await page.getByText("LLM Models Configuration", { exact: true }).waitFor();
		await page.locator(".linear-row").filter({ has: page.locator(".linear-row-name", { hasText: /^Model ID$/u }) }).last().waitFor();
		await page.waitForFunction(() => document.querySelectorAll(".linear-value").length > 0);
	};
	const closeSettings = async () => {
		await page.keyboard.press("Meta+w");
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};

	await openModels();
	const resolvedProvider = await page.locator(".linear-row").filter({ has: page.locator(".linear-row-name", { hasText: /^Provider$/u }) }).last().locator(".linear-value").textContent();
	const resolvedModel = await page.locator(".linear-row").filter({ has: page.locator(".linear-row-name", { hasText: /^Model ID$/u }) }).last().locator(".linear-value").textContent();
	check("LLM panel names the resolved provider", (resolvedProvider ?? "").trim() === MODEL.provider, resolvedProvider ?? "");
	check("LLM panel carries the resolved model id", (resolvedModel ?? "").trim() === MODEL.id, resolvedModel ?? "");
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	// The card is live: editing the shared config and re-entering the pane shows
	// the new identity.
	writeConfig({ ...MODEL, id: "anthropic/claude-sonnet-4.5" });
	const roleAfterEdit = await resolvedRole();
	check("a fresh AutoRAG agent resolves the edited model", roleAfterEdit.modelId === "anthropic/claude-sonnet-4.5", roleAfterEdit.modelId);
	await closeSettings();
	check("⌘W closes the Settings tab", (await settingsOpen()) === 0);
	await openModels();
	const editedModel = await page.locator(".linear-row").filter({ has: page.locator(".linear-row-name", { hasText: /^Model ID$/u }) }).last().locator(".linear-value").textContent();
	check("reopening LLM Models shows the edited model", (editedModel ?? "").trim() === "anthropic/claude-sonnet-4.5", editedModel ?? "");
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });

	writeConfig(MODEL);
	await closeSettings();
	await openModels();
	check("switching back resolves the original model", (await resolvedRole()).modelId === MODEL.id);
	check("LLM panel has no stale model card", (await page.locator(".settings-model-card").count()) === 0);
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Settings > Models renders the v7 card and opens/closes as a tab — evidence in ${EVIDENCE}`);
}
