import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord, isolatedToolPath, rmRetry } from "./platform.mjs";

// Redesigned Settings (docs/prototypes/settings) against the real app:
// prototype IA + search, real Pi provider catalog and /login session, role
// model writes, local server discovery, global embedding plan/apply with
// datasource propagation, datasource detail writes, and config pages.
// Runs against a throwaway AUTORAG_HOME and Pi agent dir; never touches the
// operator's real config or credentials. Production build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/settings-redesign/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-settings-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "pi-agent");
const configPath = join(root, "config.json");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(agentDir, { recursive: true });
const qaBin = join(root, "bin");
mkdirSync(qaBin, { recursive: true });
const qaPath = isolatedToolPath(qaBin);

// A loopback stand-in for Ollama / an OpenAI-compatible server: model list,
// chat model list, and real-shaped embedding vectors of the declared size.
const EMBED_DIM = 8;
const server = createServer((request, response) => {
	let body = "";
	request.on("data", (chunk) => { body += chunk; });
	request.on("end", () => {
		const send = (status, payload) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(payload)); };
		if (request.url === "/v1/models" || request.url === "/models") return send(200, { object: "list", data: [{ id: "qa-chat", object: "model" }, { id: "qa-embed", object: "model" }] });
		if (request.url === "/api/tags") return send(200, { models: [{ name: "qa-chat" }, { name: "qa-embed" }] });
		if (request.url?.endsWith("/embeddings")) {
			const parsed = JSON.parse(body || "{}");
			const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? parsed.prompt ?? ""];
			return send(200, { object: "list", data: inputs.map((_, index) => ({ object: "embedding", index, embedding: Array.from({ length: EMBED_DIM }, (_, i) => (i + 1) / 10) })), model: parsed.model ?? "qa-embed" });
		}
		send(404, { error: "not found" });
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const serverUrl = `http://127.0.0.1:${server.address().port}`;

writeFileSync(configPath, `${JSON.stringify({
	searchPaths: [join(workspace, "docs")],
	workspacePath: workspace,
	minSync: { enabled: true, embedder: { profile: "qwen3-embedding-0.6b", dimension: 1024 } },
	jikji: false,
	unknownTopLevel: { keep: true },
	datasources: {
		mail: { type: "mailcrawl", connector: { account: "qa", dataDir: join(root, "mailcrawl"), env: { MAILCRAWL_KIWI_MODEL: "/keep/me" } } },
		slack: { description: "Team Slack", connector: { workspace: "T0QA" } },
	},
}, null, 2)}\n`);
const readConfig = () => JSON.parse(readFileSync(configPath, "utf8"));

const env = {
	AUTORAG_CONFIG: configPath,
	AUTORAG_HOME: root,
	PI_CODING_AGENT_DIR: agentDir,
	// The lane picks "This computer" in the embedding picker, which the spec guard
	// (#252) disables on a machine below Pro/Max ≥32 GB (the default 12 GB QA VM).
	// Pretend to be a capable machine, the sanctioned AUTORAG_QA_HARDWARE override
	// (honored only by unpackaged builds), so the picker flow is testable anywhere.
	AUTORAG_QA_HARDWARE: JSON.stringify({ platform: "darwin", arch: "arm64", cpuModel: "Apple M4 Max", memoryBytes: 64 * 1024 ** 3, gpus: [] }),
	OPENROUTER_API_KEY: "qa-openrouter-key",
	// Only `dupey` (required by the Finder) is visible: host datasource CLIs
	// (mailcrawl, discrawl, …) must never run against the operator's archives
	// when the embedding change triggers a rebuild.
	PATH: qaPath,
};

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};
const waitFor = async (predicate, timeoutMs = 8000) => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await predicate();
		if (value) return value;
		if (Date.now() > deadline) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
const errors = [];
try {
	const page = await finderWindow(app);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
	await page.waitForSelector('[role="row"]');
	await page.locator(".sidebar__item", { hasText: "Settings" }).click();
	await page.waitForSelector(".settings-panel");
	const nav = (label) => page.locator(".settings-nav-item", { hasText: label }).first().click();
	const title = () => page.locator(".settings-content .linear-title").first().innerText();

	// --- IA + search ------------------------------------------------------
	// textContent, not innerText: the group titles are uppercased by CSS.
	const groups = await page.locator(".settings-sidebar-group-title").evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ""));
	check("sidebar groups follow the prototype", JSON.stringify(groups.slice(0, 5)) === JSON.stringify(["Account", "General", "AI", "Search", "Connected Apps"]), JSON.stringify(groups));
	for (const [label, heading] of [["My Account", "My Account"], ["Subscription & Usage", "Subscription & Usage"], ["General", "General"], ["AI Models", "AI Models"], ["Web Search", "Web search"], ["Indexing", "Indexing"], ["Search Scope", "Search scope"], ["Document Reading", "Document reading"], ["Duplicate Cleanup", "Duplicate cleanup"], ["All Connections", "Connected apps"]]) {
		await nav(label);
		const got = await waitFor(async () => ((await title()) === heading ? heading : null));
		const overflow = await page.evaluate(() => { const el = document.querySelector(".settings-content"); return el.scrollWidth - el.clientWidth; });
		check(`page ${label} renders`, got === heading, await title());
		check(`page ${label} has no horizontal overflow`, overflow <= 1, String(overflow));
	}
	await page.locator('input[aria-label="Search settings"]').fill("Embedding");
	const filtered = await page.locator(".settings-nav-item").allInnerTexts();
	check("search filters to matching pages", filtered.length >= 1 && filtered.every((text) => text.includes("AI Models")), JSON.stringify(filtered));
	await page.locator('input[aria-label="Search settings"]').fill("");
	const sourceTabs = await page.locator(".settings-nav-item--source").allInnerTexts();
	check("each configured datasource has its own nav item", sourceTabs.length === 2, JSON.stringify(sourceTabs));
	await nav("General");
	await page.screenshot({ path: join(EVIDENCE, "01-general.png") });

	// --- General writes app settings --------------------------------------
	const hidden = page.locator('.linear-row:has-text("Hidden Files") [role="switch"]');
	const before = await hidden.getAttribute("aria-checked");
	await hidden.click();
	await waitFor(async () => (await hidden.getAttribute("aria-checked")) !== before);
	check("general toggle flips (app settings)", (await hidden.getAttribute("aria-checked")) !== before);
	await hidden.click();

	// --- AI page: real providers + roles ---------------------------------
	await nav("AI Models");
	await page.waitForSelector(".settings-list-row");
	const connected = await waitFor(async () => (await page.locator(".settings-list-title", { hasText: "OpenRouter" }).count()) > 0);
	check("env-configured OpenRouter appears as a connected Pi provider", Boolean(connected));
	await page.screenshot({ path: join(EVIDENCE, "02-ai.png") });

	await page.locator('[data-role="answer"]').click();
	await page.waitForSelector(".settings-menu");
	const menuText = await page.locator(".settings-menu").innerText();
	check("answer picker lists real catalog models", menuText.includes("OpenRouter") && (await page.locator(".settings-menu .settings-menu-item").count()) > 10);
	await page.locator(".settings-menu input").fill("qwen3.7-flash");
	const pick = page.locator(".settings-menu .settings-menu-item").first();
	const pickedId = await pick.locator("small").innerText();
	await pick.click();
	const answer = await waitFor(() => readConfig().model?.id === pickedId ? readConfig().model : null);
	check("answer model choice writes config.model", answer?.provider === "openrouter" && answer?.id === pickedId, JSON.stringify(readConfig().model));
	check("unknown config keys survive role writes", readConfig().unknownTopLevel?.keep === true);

	await page.locator('[aria-label="Answer Model thinking depth"]').click();
	await page.locator(".settings-menu .settings-menu-item", { hasText: "Medium" }).click();
	const thinking = await waitFor(() => readConfig().thinking?.final === "medium");
	check("thinking menu writes thinking.final", Boolean(thinking), JSON.stringify(readConfig().thinking));

	await page.locator('[data-role="decomposition"]').click();
	await page.locator(".settings-menu .settings-menu-item", { hasText: "Same as Answer Model" }).click();
	check("decomposition 'same as answer' writes queryDecomposition:false", Boolean(await waitFor(() => readConfig().queryDecomposition === false)));

	await page.locator('[data-role="rerank"]').click();
	await page.waitForSelector(".settings-menu");
	const rerankItems = await page.locator(".settings-menu .settings-menu-item small").allInnerTexts();
	check("rerank picker only offers rerank models", rerankItems.length > 0 && rerankItems.every((id) => /rerank/u.test(id)), JSON.stringify(rerankItems));
	await page.locator(".settings-menu .settings-menu-item small", { hasText: "rerank" }).first().click();
	check("rerank choice writes rerank block", Boolean(await waitFor(() => typeof readConfig().rerank?.model === "string" && /rerank/u.test(readConfig().rerank.model))), JSON.stringify(readConfig().rerank));

	await page.locator('[data-role="jev"]').click();
	await page.locator(".settings-menu .settings-menu-item", { hasText: "Disabled" }).click();
	check("jev off writes jev:false", Boolean(await waitFor(() => readConfig().jev === false)));

	// Real /login session: API-key login for an unconfigured provider prompts for the key.
	await page.locator(".settings-add-row").click();
	await page.waitForSelector(".settings-menu");
	const groupsInMenu = await page.locator(".settings-menu .settings-menu-group").allInnerTexts();
	check("connect menu groups subscription / API key / local", groupsInMenu.includes("Subscription Account") && groupsInMenu.includes("API Keys") && groupsInMenu.includes("This Computer"), JSON.stringify(groupsInMenu));
	const subscriptions = await page.locator(".settings-menu .settings-menu-item").allInnerTexts();
	check("subscription logins come from the Pi runtime (Claude, ChatGPT, Copilot)", ["Anthropic", "OpenAI Codex", "GitHub Copilot"].every((name) => subscriptions.some((text) => text.includes(name))), JSON.stringify(subscriptions.slice(0, 12)));
	await page.locator(".settings-menu .settings-menu-item", { hasText: "Groq" }).first().click();
	const prompt = await waitFor(async () => (await page.locator('.settings-modal input[type="password"]').count()) > 0, 10000);
	check("API-key /login opens the real Pi secret prompt", Boolean(prompt));
	await page.screenshot({ path: join(EVIDENCE, "03-login-prompt.png") });
	await page.locator('.settings-modal input[type="password"]').fill("gsk_qa_secret");
	await page.locator(".settings-modal button", { hasText: "Submit" }).click();
	const stored = await waitFor(() => {
		try { return JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8")).groq; } catch { return null; }
	}, 10000);
	check("completed /login persists the key to Pi auth.json", stored?.type === "api_key" && stored?.key === "gsk_qa_secret");
	check("the key never lands in config.json", !readFileSync(configPath, "utf8").includes("gsk_qa_secret"));
	const groqRow = await waitFor(async () => (await page.locator(".settings-list-title", { hasText: "Groq" }).count()) > 0);
	check("logged-in provider shows as connected", Boolean(groqRow));

	// OAuth session start + cancel (no browser completion in CI).
	await page.locator(".settings-add-row").click();
	await page.locator(".settings-menu .settings-menu-item", { hasText: "GitHub Copilot" }).first().click();
	const oauth = await waitFor(async () => (await page.locator(".settings-modal").count()) > 0 && ((await page.locator(".settings-modal").innerText()).includes("GitHub Copilot")));
	check("subscription login opens a live OAuth session", Boolean(oauth));
	await page.screenshot({ path: join(EVIDENCE, "04-oauth.png") });
	await page.locator(".settings-modal button", { hasText: "Cancel" }).last().click();
	check("cancel closes the login session", Boolean(await waitFor(async () => (await page.locator(".settings-modal").count()) === 0)));

	// Local server discovery + persistence in Pi models.json.
	await page.locator(".settings-add-row").click();
	await page.locator(".settings-menu .settings-menu-item", { hasText: "Add Local Server" }).click();
	await page.locator(".settings-modal label:has-text('Server URL') input").fill(serverUrl);
	await page.locator(".settings-modal button", { hasText: "Connect" }).last().click();
	const models = await waitFor(() => { try { return JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8")); } catch { return null; } }, 10000);
	const local = models === null ? undefined : Object.values(models.providers ?? {}).find((provider) => provider.baseUrl?.startsWith(serverUrl));
	check("local server discovery writes discovered models to Pi models.json", local !== undefined && local.models.some((model) => model.id === "qa-chat"), JSON.stringify(models));

	// --- Embedding: plan + apply propagates to datasources ---------------
	await page.locator(".settings-trigger[aria-haspopup='dialog']").click();
	await page.waitForSelector(".settings-modal input[name='embedding-profile']");
	await page.locator(".settings-modal .settings-list-row").filter({ has: page.locator(".settings-list-title", { hasText: "This computer" }) }).click();
	await page.locator(".settings-modal button", { hasText: "Review Plan" }).click();
	const planText = await waitFor(async () => { const text = await page.locator(".settings-modal").innerText(); return text.includes("mail") ? text : null; });
	check("embedding plan lists per-datasource adoption", planText !== null && planText.includes("mail") && planText.includes("slack"), planText ?? "");
	await page.screenshot({ path: join(EVIDENCE, "05-embedding-plan.png") });
	await page.locator(".settings-modal button", { hasText: "Apply" }).click();
	const applied = await waitFor(() => (readConfig().minSync?.embedder?.id === "native:Qwen/Qwen3-Embedding-0.6B" ? readConfig() : null), 30000);
	check("embedding apply writes minSync.embedder", applied !== null, JSON.stringify(readConfig().minSync));
	// mailcrawl embeds through the shared embedding server: no embedding override is written into its env, and the user's own variables stay.
	const mailEnv = readConfig().datasources.mail.connector.env ?? {};
	check("embedding change writes no embedding override into the mailcrawl CLI env", !Object.keys(mailEnv).some((key) => /^MAILCRAWL_(EMBED|NATIVE_)/.test(key)), JSON.stringify(mailEnv));
	check("propagation preserves unrelated CLI env", mailEnv.MAILCRAWL_KIWI_MODEL === "/keep/me");
	check("propagation preserves other datasource config", readConfig().datasources.slack.connector.workspace === "T0QA");
	// Apply also runs the per-source rebuilds; the result line appears when they settle.
	const settled = await waitFor(async () => ((await page.locator(".settings-modal").innerText()).includes("Applied") ? true : null), 60000);
	check("embedding apply reports the per-source rebuild result", Boolean(settled), await page.locator(".settings-modal").innerText());
	await page.screenshot({ path: join(EVIDENCE, "06-embedding-applied.png") });
	await page.locator(".settings-modal button", { hasText: "Close" }).click();

	// --- Datasource detail writes ----------------------------------------
	await page.locator('.settings-nav-item--source[data-source-alias="slack"]').click();
	await page.waitForSelector('.settings-source[data-source-id="slack"]');
	await page.locator('select[aria-label="Refresh interval"]').selectOption({ label: "1 hour" });
	check("polling interval writes pollingIntervalMs", Boolean(await waitFor(() => readConfig().datasources.slack.pollingIntervalMs === 3_600_000)));
	await page.locator('.settings-source[data-source-id="slack"] [role="switch"][aria-label="Enabled"]').click();
	check("enable toggle writes enabled:false", Boolean(await waitFor(() => readConfig().datasources.slack.enabled === false)));
	check("toggle keeps description", readConfig().datasources.slack.description === "Team Slack");
	await page.screenshot({ path: join(EVIDENCE, "07-source-detail.png") });

	// Add a new datasource from the gallery.
	await nav("All Connections");
	await page.locator(".settings-list-row:has-text('RSS') button", { hasText: "Connect" }).click();
	await page.locator(".settings-modal input").fill("news");
	await page.locator(".settings-modal button", { hasText: "Add connection" }).click();
	check("gallery add writes datasources.<alias> with type", Boolean(await waitFor(() => readConfig().datasources.news?.type === "rss")));

	// --- Config pages -----------------------------------------------------
	await nav("Web Search");
	await page.locator('.linear-row:has-text("Use web search") [role="switch"]').click();
	check("web search toggle writes webSearch.enabled:false", Boolean(await waitFor(() => readConfig().webSearch?.enabled === false)));
	await nav("Duplicate Cleanup");
	await page.locator('.linear-row:has-text("exact duplicate") [role="switch"]').click();
	check("duplicates toggle writes excludeExactDuplicates", Boolean(await waitFor(() => readConfig().excludeExactDuplicates === false)));
	await nav("Search Scope");
	await page.locator("button", { hasText: "Add folder" }).click();
	await page.locator(".settings-modal input").fill(join(workspace, "docs"));
	await page.locator(".settings-modal .settings-btn-primary").click();
	await page.screenshot({ path: join(EVIDENCE, "08-scope.png") });

	// Account/plan are UI-only: no fabricated account data.
	await nav("Subscription & Usage");
	const planPage = await page.locator(".settings-content").innerText();
	check("plan page shows no fabricated usage numbers", !/812|1,000 credits?/u.test(planPage));
	await page.screenshot({ path: join(EVIDENCE, "09-plan.png") });

	await page.keyboard.press(chord("w"));
	check("no renderer errors during the run", errors.length === 0, JSON.stringify(errors.slice(0, 5)));
} finally {
	await app.close();
	server.close();
	rmRetry(root);
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: redesigned Settings drives the real config, Pi auth, and embedding propagation — evidence in ${EVIDENCE}`);
}
