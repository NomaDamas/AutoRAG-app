import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed } from "@autorag/librarian/core";
import { launchFinder, finderWindow } from "./launch-finder.mjs";

// Settings opens as a tab and its Models pane renders the v7 connected-model
// card; ⌘W closes the tab. The card no longer mirrors the shared AutoRAG
// config's model id (v6 behavior) — this lane asserts the v7 card copy plus
// that the throwaway AUTORAG_CONFIG still resolves through the librarian.
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
const resolvedRole = () => resolveAgentModelDetailed(
	resolveConfigReadOnly({ flags: {}, env: { ...process.env, ...env }, cwd: root }),
	{ env: { ...process.env, ...env } },
).role;

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
		// Settings opens as a tab; the categories are the left nav items.
		await page.locator(".settings-sidebar__item", { hasText: "Models" }).click();
		await page.waitForSelector(".settings-model-card");
	};
	const closeSettings = async () => {
		await page.keyboard.press("Meta+w");
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};

	await openModels();
	const name = await page.locator(".settings-model-card__name").textContent();
	const provider = await page.locator(".settings-model-card__provider").textContent();
	// v7 replaced the config-driven model row with a static connected-model card;
	// the pane no longer mirrors the shared AutoRAG config's model id.
	check("Models pane renders the connected-model card", (name ?? "").trim().length > 0, name ?? "");
	check("the card carries the v7 model copy", provider === "Quick 및 Deep 답변에 공통으로 연결된 고성능 AI 모델입니다.", provider ?? "");
	check("card carries no avatar tile", (await page.locator(".settings-model-tile").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	// The card is static now, but the config the app was handed must still resolve
	// through the librarian (guards the shared config file).
	writeConfig({ ...MODEL, id: "anthropic/claude-sonnet-4.5" });
	const roleAfterEdit = resolvedRole();
	check("a fresh AutoRAG agent resolves the edited model", roleAfterEdit.modelId === "anthropic/claude-sonnet-4.5", roleAfterEdit.modelId);
	await closeSettings();
	check("⌘W closes the Settings tab", (await settingsOpen()) === 0);
	await openModels();
	check("reopening Settings reaches the Models pane again", (await page.locator(".settings-panel .settings-model-card__name").count()) === 1);
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });

	writeConfig(MODEL);
	await closeSettings();
	await openModels();
	check("switching back resolves the original model", resolvedRole().modelId === MODEL.id);
	check("card shows no Quick/Deep badge", (await page.locator(".settings-model-card em").count()) === 0);
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
