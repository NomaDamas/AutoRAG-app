import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { launchFinder, finderWindow } from "./launch-finder.mjs";

// Settings > Data Sources must mirror the shared AutoRAG config (the one the
// CLI, TUI, serve, and every agent read) in both directions. Runs against a
// throwaway AUTORAG_HOME so the operator's real config is never touched.
// Production build first: bun run build
const EVIDENCE = new URL("../../.omo/evidence/ai-finder-app/datasource-status/", import.meta.url).pathname;
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-datasources-"));
const workspace = join(root, "workspace");
const bin = join(root, "bin");
const configPath = join(root, "config.json");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "slacrawl"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "slacrawl"), 0o755);
const chunkStore = join(workspace, ".autorag", "datasources", "my-drive", "my-drive");
mkdirSync(chunkStore, { recursive: true });
writeFileSync(join(chunkStore, "chunks.json"), JSON.stringify({
	version: 1,
	skill: "my-drive",
	instance: "my-drive",
	updatedAt: Date.now(),
	chunks: [
		{ chunkId: "c1", docId: "d1", hierarchy: [], content: "one", metadata: {} },
		{ chunkId: "c2", docId: "d1", hierarchy: [], content: "two", metadata: {} },
		{ chunkId: "c3", docId: "d2", hierarchy: [], content: "three", metadata: {} },
	],
}));
const writeConfig = (datasources) => writeFileSync(configPath, `${JSON.stringify({
	searchPaths: [join(workspace, "docs")],
	workspacePath: workspace,
	minSync: { enabled: false },
	jikji: false,
	datasources,
	datasourceAccess: { allowedTags: ["chat", "documents"] },
}, null, 2)}\n`);
writeConfig({
	slack: { description: "Team Slack" },
	"my-drive": { type: "cloud-drive", connector: { remote: "drive:" } },
	github: { connector: { repos: ["octo/repo"] } },
	telegram: false,
	foo: {},
});

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, PATH: `${bin}:/usr/bin:/bin`, GITHUB_TOKEN: "" };
const agentSkills = () =>
	(buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: { ...process.env, ...env }, cwd: root })).datasourceSkills ?? [])
		.map((skill) => skill.describe().name);

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
try {
	const page = await finderWindow(app);
	await page.waitForSelector('[role="row"]');
	const selectCategory = (label) => page.locator(".settings-sidebar__item", { hasText: label }).click();
	const openSources = async () => {
		await page.locator(".sidebar__item", { hasText: "Settings" }).click();
		await page.waitForSelector(".settings-panel");
		// Settings opens as a tab; the categories are the left nav items.
		await selectCategory("Data Sources");
		await page.waitForSelector('.settings-source[data-source-id="slack"]');
	};
	const closeSettings = async () => {
		await page.keyboard.press("Meta+w");
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};
	const row = (id) => page.locator(`.settings-source[data-source-id="${id}"]`);
	const fact = async (id, key) => {
		const source = row(id);
		// v7 gives a disabled source row `pointer-events: none`, so expand it via a
		// dispatched click rather than a hit-tested one.
		if ((await source.locator(".settings-source-facts").count()) === 0) await source.locator(".settings-source__chevron").dispatchEvent("click");
		return source.locator(`.settings-source-fact[data-fact="${key}"]`).getAttribute("data-state");
	};

	await openSources();
	// v7 dropped the config-path readout and the refresh button from this pane; the
	// list itself is the observable, so the config path is covered by the ids below.
	const ids = await page.locator(".settings-source").evaluateAll((els) => els.map((el) => el.dataset.sourceId));
	check("lists every configured datasource, including disabled ones", JSON.stringify(ids) === JSON.stringify(["slack", "my-drive", "github", "telegram", "foo"]), JSON.stringify(ids));

	const expected = {
		slack: { install: "installed", agent: "connected", index: "external", status: "Ready" },
		"my-drive": { install: "missing", agent: "connected", index: "indexed", status: "Needs attention" },
		github: { install: "credential-missing", agent: "blocked", index: "not-indexed", status: "Needs attention" },
		telegram: { install: "missing", agent: "disabled", status: "Paused" },
		foo: { install: "unsupported", agent: "unsupported", status: "Needs attention" },
	};
	for (const [id, want] of Object.entries(expected)) {
		const got = {
			install: await fact(id, "install"),
			agent: await fact(id, "agent"),
			...(want.index === undefined ? {} : { index: await fact(id, "index") }),
			status: await row(id).locator(".settings-status").textContent(),
		};
		check(`${id} states`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
	}
	const driveCount = await row("my-drive").locator(".settings-source__pct").textContent();
	check("my-drive shows its chunk count", driveCount === "3 chunks", driveCount ?? "");
	await page.screenshot({ path: join(EVIDENCE, "01-sources-expanded.png") });

	await fact("slack", "agent");
	const slackDesc = row("slack").locator(".settings-source-desc");
	check("chat edit button is gone", (await page.getByRole("button", { name: "채팅으로 수정" }).count()) === 0);
	await slackDesc.locator(".settings-source-desc__edit").click();
	await slackDesc.locator(".settings-source-desc__input").fill("Release and incident chatter");
	await page.screenshot({ path: join(EVIDENCE, "01b-description-editing.png") });
	await slackDesc.getByRole("button", { name: "저장" }).click();
	await slackDesc.locator("p", { hasText: "Release and incident chatter" }).waitFor();
	const described = JSON.parse(readFileSync(configPath, "utf8"));
	check("inline save wrote the description into the shared config", described.datasources.slack.description === "Release and incident chatter", JSON.stringify(described.datasources.slack));
	const agentDescription = (buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: { ...process.env, ...env }, cwd: root })).datasourceSkills ?? [])
		.find((skill) => skill.describe().name === "slack")?.describe().description;
	check("a fresh AutoRAG agent reads the new description", agentDescription === "Release and incident chatter", agentDescription);
	await slackDesc.locator(".settings-source-desc__edit").click();
	await slackDesc.locator(".settings-source-desc__input").fill("discard me");
	await slackDesc.locator(".settings-source-desc__input").press("Escape");
	check("Escape cancels without writing", (await slackDesc.locator("p").textContent()) === "Release and incident chatter"
		&& JSON.parse(readFileSync(configPath, "utf8")).datasources.slack.description === "Release and incident chatter");
	check("Escape in the editor keeps Settings open", (await page.locator(".settings-panel").count()) === 1);
	await page.screenshot({ path: join(EVIDENCE, "01c-description-saved.png") });

	check("agent sees slack before the toggle", agentSkills().includes("slack"), JSON.stringify(agentSkills()));
	await row("slack").locator(".settings-switch").click();
	await page.waitForFunction(() =>
		document.querySelector('.settings-source[data-source-id="slack"] .settings-status')?.textContent === "Paused");
	const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
	check("toggle wrote enabled:false into the shared config", onDisk.datasources.slack.enabled === false && onDisk.datasources.slack.description === "Release and incident chatter", JSON.stringify(onDisk.datasources.slack));
	check("toggle preserved datasourceAccess", JSON.stringify(onDisk.datasourceAccess) === JSON.stringify({ allowedTags: ["chat", "documents"] }));
	check("a fresh AutoRAG agent no longer loads slack", !agentSkills().includes("slack"), JSON.stringify(agentSkills()));
	check("slack agent fact now reads disabled", (await fact("slack", "agent")) === "disabled");
	await page.screenshot({ path: join(EVIDENCE, "02-slack-toggled-off.png") });

	writeConfig({ ...onDisk.datasources, rss: { connector: { feeds: [{ url: "https://example.com/feed.xml" }] } } });
	// v7 has no refresh button; switching the category away and back re-reads the config.
	await selectCategory("General");
	await selectCategory("Data Sources");
	await page.waitForSelector('.settings-source[data-source-id="rss"]');
	check("an external config edit appears after the pane re-reads", (await fact("rss", "install")) === "builtin");
	await closeSettings();
	writeConfig({ ...onDisk.datasources, notion: {} });
	await openSources();
	check("reopening Settings re-reads the config (no app-side copy)", (await row("notion").count()) === 1 && (await row("rss").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "03-external-edit.png") });
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Data Sources mirrors the shared AutoRAG config — evidence in ${EVIDENCE}`);
}
