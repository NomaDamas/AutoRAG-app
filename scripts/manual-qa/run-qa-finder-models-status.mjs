import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

// Settings opens as a tab. This QA covers the simplified model surface: provider/model
// connection remains editable while runtime capabilities stay catalog- or model-driven.
// Production build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/ai-finder-app/models-status/", import.meta.url));
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
	id: "qa/custom-model",
	baseUrl: "https://openrouter.ai/api/v1",
	api: "openai-completions",
	apiKeyEnv: "OPENROUTER_API_KEY",
};
writeConfig(MODEL);

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, OPENROUTER_API_KEY: "qa-key", PATH: "/usr/bin:/bin" };

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
		await page.locator('input[aria-label="Custom model id"]').waitFor();
	};
	const closeSettings = async () => {
		await page.keyboard.press(chord("w"));
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};

	await openModels();
	const modelId = await page.locator('input[aria-label="Custom model id"]').inputValue();
	check("LLM panel loads the configured custom model", modelId === MODEL.id, modelId);
	const llmText = await page.locator(".settings-content").innerText();
	for (const label of ["Reasoning model", "Accepts text input", "Accepts image input", "Context window", "Max output tokens", "Resolved for the agent"]) {
		check(`LLM panel hides ${label}`, !llmText.includes(label));
	}
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	writeConfig({ ...MODEL, id: "qa/edited-model" });
	await closeSettings();
	check("⌘W closes the Settings tab", (await settingsOpen()) === 0);
	await openModels();
	const editedModel = await page.locator('input[aria-label="Custom model id"]').inputValue();
	check("reopening LLM Models shows the edited model", editedModel === "qa/edited-model", editedModel);
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });

} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: simplified Settings > Models behavior verified — evidence in ${EVIDENCE}`);
}
