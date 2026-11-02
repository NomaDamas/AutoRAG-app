import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAgentOptions, resolveConfigReadOnly } from "@autorag/librarian";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { chord, rmRetry } from "./platform.mjs";

// Settings > Data Sources must mirror the shared AutoRAG config (the one the
// CLI, TUI, serve, and every agent read) in both directions. Runs against a
// throwaway AUTORAG_HOME so the operator's real config is never touched.
// Production build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/ai-finder-app/datasource-status/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-datasources-"));
const workspace = join(root, "workspace");
const bin = join(root, "bin");
const configPath = join(root, "config.json");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(bin, { recursive: true });
const IS_WIN = process.platform === "win32";
if (IS_WIN) {
	writeFileSync(join(bin, "slacrawl.cmd"), "@echo off\r\nexit /b 0\r\n");
} else {
	writeFileSync(join(bin, "slacrawl"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(bin, "slacrawl"), 0o755);
}
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
	minSync: { enabled: true },
	jikji: false,
	datasources,
}, null, 2)}\n`);
// "CLI not installed" must not depend on what this machine has. The app appends the standard tool
// directories (`~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, ...) to PATH at startup so a
// Finder-launched build finds user-installed CLIs, and the lane cannot hide absolute directories
// like those: a host with rclone or telecrawl installed would report them installed. So the two
// "missing" connections point their executable path (the Settings "Executable path" field) at a file
// that does not exist; a configured path is authoritative and never falls back to PATH.
const NOT_INSTALLED = (name) => join(bin, `${name}-not-installed`);
writeConfig({
	slack: { description: "Team Slack" },
	"my-drive": { type: "cloud-drive", connector: { remote: "drive:", binaryPath: NOT_INSTALLED("rclone") } },
	github: { connector: { repos: ["octo/repo"] } },
	telegram: { enabled: false, connector: { binaryPath: NOT_INSTALLED("telecrawl") } },
	foo: {},
});

// The PATH still holds only the fake `slacrawl`, so no other datasource CLI is found by name.
// System32 stays for Windows system lookups.
const windowsPath = `${bin};${process.env.SystemRoot ?? "C:\\Windows"}\\System32;${process.env.SystemRoot ?? "C:\\Windows"}`;
const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, PATH: IS_WIN ? windowsPath : `${bin}:/usr/bin:/bin`, GITHUB_TOKEN: "", AUTORAG_SKIP_DUPEY_CHECK: "1" };
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
	const openSources = async () => {
		await page.locator(".sidebar__item--settings").click();
		await page.waitForSelector(".settings-panel");
		await page.locator(".settings-nav-item", { hasText: "All Connections" }).click();
		await page.locator(".settings-content .linear-title", { hasText: "Connected apps" }).waitFor();
	};
	const closeSettings = async () => {
		await page.keyboard.press(chord("w"));
		await page.waitForFunction(() => document.querySelector(".settings-panel") === null);
	};
	const row = (id) => page.locator(`.settings-source[data-source-id="${id}"]`);
	// Nav items carry the connection alias; their label is the kind ("Slack"), not the alias.
	const sourceTab = (id) => page.locator(`.settings-nav-item--source[data-source-alias="${id}"]`);
	const openConnection = async (id) => {
		if ((await page.locator(".settings-panel").count()) === 0) await openSources();
		await sourceTab(id).click();
		await page.waitForSelector(`.settings-source[data-source-id="${id}"]`);
	};
	const stateOf = async (id) => (await page.evaluate(() => window.autorag.settings.sourcesList())).sources.find((source) => source.id === id);

	await openSources();
	check("Data Sources overview hides connection editors", (await page.locator(".settings-source").count()) === 0);
	const directTabs = await page.locator(".settings-nav-item--source").allTextContents();
	check("exposes one direct Settings tab per configured datasource", directTabs.length === 5, JSON.stringify(directTabs));
	await openConnection("slack");
	check("direct datasource tab opens only the selected connection", (await page.locator(".settings-source").count()) === 1 && (await row("slack").count()) === 1);

	const expected = {
		// The fake slacrawl prints nothing parseable, so its archive is unreadable — not "empty".
		slack: { install: "installed", agent: "connected", index: "not-indexed", status: "ready" },
		"my-drive": { install: "missing", agent: "connected", index: "indexed", status: "attention" },
		github: { install: "credential-missing", agent: "connected", index: "not-indexed", status: "attention" },
		telegram: { install: "missing", agent: "disabled", status: "paused" },
		foo: { install: "unsupported", agent: "unsupported", status: "attention" },
	};
	for (const [id, want] of Object.entries(expected)) {
		await openConnection(id);
		const source = await stateOf(id);
		const got = {
			install: source?.install.state,
			agent: source?.agent.state,
			...(want.index === undefined ? {} : { index: source?.index.state }),
			status: source?.status,
		};
		check(`${id} states`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
	}
	await openConnection("my-drive");
	const driveText = await row("my-drive").innerText();
	check("my-drive shows its chunk count", driveText.includes("3 documents"), driveText.slice(0, 200));
	await page.screenshot({ path: join(EVIDENCE, "01-sources-expanded.png") });

	await openConnection("slack");
	const description = row("slack").locator('textarea[aria-label="Description"]');
	await description.fill("Release and incident chatter");
	await description.press("Tab");
	await page.waitForTimeout(900);
	const described = JSON.parse(readFileSync(configPath, "utf8"));
	check("datasource fields autosave into the shared config", described.datasources.slack.description === "Release and incident chatter", JSON.stringify(described.datasources.slack));
	const agentDescription = (buildAgentOptions(resolveConfigReadOnly({ flags: {}, env: { ...process.env, ...env }, cwd: root })).datasourceSkills ?? [])
		.find((skill) => skill.describe().name === "slack")?.describe().description;
	check("a fresh AutoRAG agent reads the new description", agentDescription === "Release and incident chatter", agentDescription);
	await page.screenshot({ path: join(EVIDENCE, "01b-description-autosaved.png") });

	check("agent sees slack before the toggle", agentSkills().includes("slack"), JSON.stringify(agentSkills()));
	await row("slack").locator('[role="switch"][aria-label="Enabled"]').click();
	await page.waitForFunction(() => window.autorag.settings.sourcesList().then((s) => s.sources.find((x) => x.id === "slack")?.status === "paused"));
	const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
	check("toggle wrote enabled:false into the shared config", onDisk.datasources.slack.enabled === false && onDisk.datasources.slack.description === "Release and incident chatter", JSON.stringify(onDisk.datasources.slack));
	check("toggle left no datasourceAccess behind", onDisk.datasourceAccess === undefined);
	check("a fresh AutoRAG agent no longer loads slack", !agentSkills().includes("slack"), JSON.stringify(agentSkills()));
	check("slack agent state now reads disabled", (await stateOf("slack"))?.agent.state === "disabled");
	await page.screenshot({ path: join(EVIDENCE, "02-slack-toggled-off.png") });

	writeConfig({ ...onDisk.datasources, rss: { connector: { feeds: [{ url: "https://example.com/feed.xml" }] } } });
	// A Settings mount reads a fresh config snapshot; close/reopen is the supported
	// external-edit refresh boundary and avoids clobbering an in-progress draft.
	await closeSettings();
	await openSources();
	await openConnection("rss");
	check("an external config edit appears after reopening Settings", (await stateOf("rss"))?.install.state === "builtin");
	writeConfig({ ...onDisk.datasources, notion: {} });
	await closeSettings();
	await openSources();
	check("reopening Settings re-reads the config (no app-side copy)", (await sourceTab("notion").count()) === 1 && (await sourceTab("rss").count()) === 0);
	await page.screenshot({ path: join(EVIDENCE, "03-external-edit.png") });
} finally {
	await app.close();
	// Electron can still hold the temp profile for a moment after close on Windows (EBUSY).
	rmRetry(root);
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Data Sources mirrors the shared AutoRAG config — evidence in ${EVIDENCE}`);
}
