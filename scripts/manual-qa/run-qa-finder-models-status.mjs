import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfigReadOnly } from "@autorag/librarian";
import { resolveAgentModelDetailed } from "@autorag/librarian/core";
import { launchFinder } from "./launch-finder.mjs";

// Settings > Models must show the provider/model the shared AutoRAG config
// resolves for the agent — read live, not a persisted copy. Runs against a
// throwaway AUTORAG_CONFIG so the operator's real config is never touched.
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
	const page = await app.firstWindow();
	await page.waitForSelector('[role="row"]');
	const openModels = async () => {
		await page.locator(".sidebar__item", { hasText: "Settings" }).click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-panel__tabs button", { hasText: "Models" }).click();
		// The card resolves the model asynchronously; wait past the loading label.
		await page.waitForFunction(() => {
			const text = document.querySelector(".settings-model-card__provider")?.textContent ?? "";
			return text.length > 0 && text !== "불러오는 중…";
		});
	};

	await openModels();
	const name = await page.locator(".settings-model-card__name").textContent();
	const provider = await page.locator(".settings-model-card__provider").textContent();
	check("card names the resolved model", name === MODEL.id, name ?? "");
	check("card shows provider and api", provider === `${MODEL.provider} · ${MODEL.api}`, provider ?? "");
	check("card carries no avatar tile", (await page.locator(".settings-model-tile").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "01-models.png") });

	// An edit from another AutoRAG surface must show up on refresh (live read).
	writeConfig({ ...MODEL, id: "anthropic/claude-sonnet-4.5" });
	const roleAfterEdit = resolvedRole();
	check("a fresh AutoRAG agent resolves the edited model", roleAfterEdit.modelId === "anthropic/claude-sonnet-4.5", roleAfterEdit.modelId);
	await page.locator(".settings-models-header .settings-intro__refresh").click();
	await page.waitForFunction(
		(id) => document.querySelector(".settings-model-card__name")?.textContent === id,
		"anthropic/claude-sonnet-4.5",
	);
	check("refresh reflects the external edit", (await page.locator(".settings-model-card__name").textContent()) === "anthropic/claude-sonnet-4.5");
	await page.screenshot({ path: join(EVIDENCE, "02-models-edited.png") });

	// Reopening Settings must re-read the config (no app-side copy).
	await page.locator(".settings-panel__header .icon-button[aria-label='Close Settings']").click();
	writeConfig(MODEL);
	await openModels();
	check("reopening Settings re-reads the config", (await page.locator(".settings-model-card__name").textContent()) === MODEL.id);
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Models mirrors the shared AutoRAG config — evidence in ${EVIDENCE}`);
}
