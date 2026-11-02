import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

// Settings opens as a tab. The AI 모델 page shows the configured answer model
// from the shared AutoRAG config and re-reads it on reopen (no app-side copy).
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
	name: "QA Custom Model",
	baseUrl: "https://openrouter.ai/api/v1",
	api: "openai-completions",
	apiKeyEnv: "OPENROUTER_API_KEY",
};
writeConfig(MODEL);

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, PI_CODING_AGENT_DIR: join(root, "pi-agent"), OPENROUTER_API_KEY: "qa-key", PATH: process.env.PATH ?? "/usr/bin:/bin" };

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
	const answer = () => page.locator('[data-role="answer"] .settings-trigger-label').innerText();
	const openModels = async () => {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "AI Models" }).click();
		await page.locator('[data-role="answer"]').waitFor();
	};
	const closeSettings = async () => {
		await page.keyboard.press(chord("w"));
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};

	await openModels();
	check("AI page shows the configured answer model", (await answer()) === MODEL.name, await answer());
	const text = await page.locator(".settings-content").innerText();
	for (const label of ["Reasoning model", "Accepts text input", "Context window", "Max output tokens"]) {
		check(`AI page hides ${label}`, !text.includes(label));
	}
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	writeConfig({ ...MODEL, name: "QA Edited Model" });
	await closeSettings();
	check("⌘W closes the Settings tab", (await settingsOpen()) === 0);
	await openModels();
	check("reopening AI Models shows the edited model", (await answer()) === "QA Edited Model", await answer());
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Settings > AI Models mirrors the shared config — evidence in ${EVIDENCE}`);
}
