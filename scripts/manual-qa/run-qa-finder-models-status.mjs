import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed } from "@autorag/librarian/core";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

// Settings opens as a tab and its Models pane renders the shared AutoRAG
// config's resolved provider/model card; ⌘W closes the tab. The card mirrors
// the librarian's model resolution (provider name, then `displayName · modelId`)
// and re-reads the config every time the pane is entered, so this lane edits a
// throwaway AUTORAG_CONFIG and re-enters the pane to prove it is live.
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
	id: "deepseek/deepseek-v4.1-flash",
	baseUrl: "https://openrouter.ai/api/v1",
	api: "openai-completions",
	apiKeyEnv: "OPENROUTER_API_KEY",
};
writeConfig(MODEL);

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, OPENROUTER_API_KEY: "qa-key", PATH: "/usr/bin:/bin" };
const resolvedRole = async () =>
	(await resolveAgentModelDetailed(
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
		// Settings opens as a tab; the categories are the left nav items.
		await page.locator(".settings-nav-item", { hasText: "Models" }).click();
		await page.waitForSelector(".settings-model-card");
		// `modelsResolve` is async: wait until the card carries a resolved
		// `displayName · modelId` line instead of the unresolved placeholder.
		await page.waitForFunction(() => (document.querySelector(".settings-model-card__provider")?.textContent ?? "").includes(" · "));
	};
	const closeSettings = async () => {
		await page.keyboard.press(chord("w"));
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};

	await openModels();
	const name = await page.locator(".settings-model-card__name").textContent();
	const provider = await page.locator(".settings-model-card__provider").textContent();
	// The card mirrors the shared AutoRAG config's resolved model: the provider
	// name on top, and `displayName · modelId` underneath.
	check("Models card names the resolved provider", (name ?? "").trim() === MODEL.provider, name ?? "");
	check("Models card carries the resolved model id", (provider ?? "").includes(MODEL.id), provider ?? "");
	check("card carries no avatar tile", (await page.locator(".settings-model-tile").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	// The card is live: editing the shared config and re-entering the pane shows
	// the new identity.
	writeConfig({ ...MODEL, id: "anthropic/claude-sonnet-4.5" });
	const roleAfterEdit = await resolvedRole();
	check("a fresh AutoRAG agent resolves the edited model", roleAfterEdit.modelId === "anthropic/claude-sonnet-4.5", roleAfterEdit.modelId);
	await closeSettings();
	check("⌘W closes the Settings tab", (await settingsOpen()) === 0);
	await openModels();
	const editedProvider = await page.locator(".settings-model-card__provider").textContent();
	check("reopening Models shows the edited model", (editedProvider ?? "").includes("anthropic/claude-sonnet-4.5"), editedProvider ?? "");
	check("reopening Settings reaches the Models pane again", (await page.locator(".settings-panel .settings-model-card__name").count()) === 1);
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });

	writeConfig(MODEL);
	await closeSettings();
	await openModels();
	check("switching back resolves the original model", (await resolvedRole()).modelId === MODEL.id);
	check("Models card has no extra badges", (await page.locator(".settings-model-card em").count()) === 0);
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
