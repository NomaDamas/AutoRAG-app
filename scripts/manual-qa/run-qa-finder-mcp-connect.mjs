/**
 * Settings → MCP servers → "Connect other agents", on the real built app.
 *
 * What it proves, in the order a user meets it:
 *   1. the section is on the page, in every tab, and what a copy button puts on the system clipboard is exactly the
 *      text on screen (read back through Electron's own clipboard, not the page's);
 *   2. the JSON the user copies is a launch that works: started the way an agent starts it, with nothing from this
 *      app's environment but what the snippet carries, it answers `tools/list`, finds the lane's document by file
 *      name through the same config the app uses, and with Read-only on it no longer offers the writing tools;
 *   3. the page reads well in Korean and in dark mode (screenshots; look at them).
 *
 * Command lines for the real `claude` / `codex` / `gemini` binaries are checked by `run-qa-mcp-clients.mjs`, which
 * needs those programs and no window.
 *
 * Prerequisite: `bun run build`. Run it through `bun run qa script scripts/manual-qa/run-qa-finder-mcp-connect.mjs`
 * so the window never takes the developer's desktop. Screenshots land in $QA_OUT.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";

const OUT = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/mcp-connect");
mkdirSync(OUT, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "autorag-qa-mcp-"));
const docs = join(root, "docs");
mkdirSync(docs, { recursive: true });
writeFileSync(join(docs, "quarterly-plan.md"), "# Quarterly plan\n\nThe zebra-orchid initiative ships in March.\n");
const configPath = join(root, "config.json");
writeFileSync(configPath, `${JSON.stringify({ searchPaths: [docs], workspacePath: join(root, "workspace"), appIndexing: { semanticSearch: false } }, null, 2)}\n`);
const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, PI_CODING_AGENT_DIR: join(root, "pi-agent") };

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};

/** A stdio MCP client in forty lines: newline-delimited JSON-RPC to a child, as every agent speaks it. */
function startServer(launch) {
	// What an agent hands the server: its own environment plus the snippet's, and none of this lane's AutoRAG settings.
	const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AUTORAG_")));
	const child = spawn(launch.command, launch.args, { env: { ...inherited, ...launch.env }, stdio: ["pipe", "pipe", "pipe"] });
	const waiting = new Map();
	let buffer = "";
	let stderr = "";
	let nextId = 1;
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
			const line = buffer.slice(0, end).trim();
			buffer = buffer.slice(end + 1);
			if (line.length === 0) continue;
			const message = JSON.parse(line);
			waiting.get(message.id)?.(message);
			waiting.delete(message.id);
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const request = (method, params) => {
		const { promise, resolve, reject } = Promise.withResolvers();
		const id = nextId++;
		const timer = setTimeout(() => reject(new Error(`${method} timed out; server stderr: ${stderr.slice(-800)}`)), 90_000);
		waiting.set(id, (message) => {
			clearTimeout(timer);
			if (message.error === undefined) resolve(message.result);
			else reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		return promise;
	};
	return {
		async initialize() {
			const result = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "qa-agent", version: "0.0.0" } });
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
			return result;
		},
		tools: async () => (await request("tools/list", {})).tools.map((tool) => tool.name),
		call: (name, args) => request("tools/call", { name, arguments: args }),
		close() {
			child.stdin.end();
			child.kill();
		},
	};
}

/** Starts the snippet's launch and runs the checks every agent would make of it. */
async function liveServer(label, launch, { expectWriting }) {
	const server = startServer(launch);
	try {
		const init = await server.initialize();
		check(`${label}: the copied launch answers the MCP handshake`, typeof init.serverInfo?.name === "string", JSON.stringify(init.serverInfo));
		const tools = await server.tools();
		check(`${label}: offers search`, tools.includes("autorag.search") && tools.includes("autorag.search.files"), `${tools.length} tools`);
		const writing = ["autorag.refresh", "autorag.report"];
		check(`${label}: ${expectWriting ? "offers" : "hides"} the writing tools`, writing.every((name) => tools.includes(name) === expectWriting), writing.map((name) => `${name}=${tools.includes(name)}`).join(" "));
		if (expectWriting) {
			const refresh = await server.call("autorag.refresh", { methods: ["parsed"] });
			check(`${label}: refresh indexes the lane's folder (the app's config reached the server)`, refresh.structuredContent?.ok === true && refresh.structuredContent?.scanned === 1, JSON.stringify(refresh.structuredContent).slice(0, 160));
			const files = await server.call("autorag.search.files", { query: "quarterly" });
			const paths = (files.structuredContent?.results ?? []).map((entry) => entry.path);
			check(`${label}: finds the document by file name`, paths.some((path) => path.endsWith("quarterly-plan.md")), paths.join(", "));
		}
	} finally {
		server.close();
	}
}

const clipboard = {
	clear: (app) => app.evaluate(({ clipboard: board }) => board.clear()),
	/** What the page put on the system clipboard after the last `clear`: it writes asynchronously, so poll for it. */
	async read(app) {
		for (let attempt = 0; attempt < 30; attempt++) {
			const text = await app.evaluate(({ clipboard: board }) => board.readText());
			if (text.length > 0) return text;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return "";
	},
};

async function openMcpPage(page, { navLabel }) {
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: navLabel }).click();
	await page.waitForSelector(".settings-seg", { timeout: 15_000 }).catch(async (error) => {
		await page.screenshot({ path: join(OUT, "00-no-section.png") });
		console.log(`The page shows: ${(await page.locator(".settings-content").innerText()).slice(0, 600)}`);
		throw error;
	});
}

async function englishLight() {
	const app = await launchFinder({ userDataDir: join(root, "user-data-en"), env });
	try {
		const page = await finderWindow(app);
		await page.waitForSelector('[role="row"]');
		await openMcpPage(page, { navLabel: "MCP Servers" });
		const section = page.locator(".settings-section", { has: page.locator(".settings-seg") });
		check("the section is on the page", (await section.locator(".linear-section-title").innerText()) === "Connect other agents");
		const tabs = await page.locator(".settings-seg [role=tab]").allInnerTexts();
		check("one tab per agent, then manual", JSON.stringify(tabs) === JSON.stringify(["Claude Code", "Codex", "Gemini CLI", "JSON", "Manual"]), tabs.join(" | "));
		await page.screenshot({ path: join(OUT, "01-en-light-claude.png") });

		const shown = () => page.locator("pre.settings-snippet").innerText();
		const copied = {};
		for (const [index, label] of ["Claude Code", "Codex", "Gemini CLI", "JSON"].entries()) {
			await page.locator(".settings-seg [role=tab]", { hasText: new RegExp(`^${label}$`, "u") }).click();
			await clipboard.clear(app);
			await page.locator(".settings-copy-btn").click();
			await page.waitForFunction(() => document.querySelector(".settings-copy-btn")?.textContent === "Copied");
			const onBoard = await clipboard.read(app);
			check(`${label}: the clipboard holds exactly what is shown`, onBoard.length > 0 && onBoard === (await shown()), onBoard.slice(0, 90));
			copied[label] = onBoard;
			await page.screenshot({ path: join(OUT, `0${index + 2}-en-light-${label.toLowerCase().replaceAll(" ", "-")}-copied.png`) });
		}
		check("Claude Code line registers dazzi for the user", /^claude mcp add --scope user dazzi /u.test(copied["Claude Code"]));
		check("Codex line registers dazzi", /^codex mcp add dazzi /u.test(copied.Codex));
		check("Gemini line registers dazzi for the user", /^gemini mcp add --scope user .* dazzi /u.test(copied["Gemini CLI"]));

		// Clicking the text copies it; ending a drag-selection inside it does not.
		await page.locator(".settings-seg [role=tab]", { hasText: /^Claude Code$/u }).click();
		await clipboard.clear(app);
		await page.locator("pre.settings-snippet").click();
		check("a click on the text copies it", (await clipboard.read(app)) === (await shown()));

		const json = JSON.parse(copied.JSON);
		const launch = json.mcpServers?.dazzi;
		check("the JSON is the standard mcpServers entry", typeof launch?.command === "string" && Array.isArray(launch?.args));
		check("the app's own config selection travels with it", launch?.env?.AUTORAG_CONFIG === configPath && launch?.env?.AUTORAG_HOME === root, JSON.stringify(launch?.env));
		await liveServer("full", launch, { expectWriting: true });

		// The manual tab: one value per row, each copied alone.
		await page.locator(".settings-seg [role=tab]", { hasText: /^Manual$/u }).click();
		for (const field of ["name", "transport", "command", "args"]) {
			const row = page.locator(`[data-mcp-field="${field}"]`);
			const value = await row.locator(".settings-field-value").innerText();
			await clipboard.clear(app);
			await row.click();
			check(`manual: the ${field} row copies its own value`, (await clipboard.read(app)) === value, value.slice(0, 80));
		}
		await page.screenshot({ path: join(OUT, "06-en-light-manual.png") });

		// Read-only: what is shown, what is copied, and what the started server offers all change together.
		await page.locator('[role=switch][aria-label="Read-only"]').click();
		await page.locator(".settings-seg [role=tab]", { hasText: /^JSON$/u }).click();
		await clipboard.clear(app);
		await page.locator(".settings-copy-btn").click();
		const readOnlyJson = JSON.parse(await clipboard.read(app));
		const readOnlyLaunch = readOnlyJson.mcpServers.dazzi;
		check("read-only puts the server's switch in the copied launch", readOnlyLaunch.env?.AUTORAG_MCP_READ_ONLY === "1", JSON.stringify(readOnlyLaunch.env));
		await page.screenshot({ path: join(OUT, "07-en-light-json-readonly.png") });
		await liveServer("read-only", readOnlyLaunch, { expectWriting: false });
	} finally {
		await app.close();
	}
}

async function koreanDark() {
	const profile = join(root, "user-data-ko");
	mkdirSync(join(profile, "settings"), { recursive: true });
	writeFileSync(join(profile, "settings", "settings-state.json"), `${JSON.stringify({ settings: { language: "ko", appearance: "dark" }, permissions: {} }, null, 2)}\n`);
	const app = await launchFinder({ userDataDir: profile, env });
	try {
		const page = await finderWindow(app);
		await page.waitForSelector('[role="row"]');
		await openMcpPage(page, { navLabel: "MCP 서버" });
		const title = await page.locator(".settings-section .linear-section-title").first().innerText();
		check("Korean: the section title is translated", title === "다른 에이전트에 연결", title);
		const dark = await page.evaluate(() => document.documentElement.getAttribute("data-appearance"));
		check("dark appearance is on", dark === "dark", String(dark));
		await page.screenshot({ path: join(OUT, "08-ko-dark-claude.png") });
		await page.locator(".settings-seg [role=tab]", { hasText: /^JSON$/u }).click();
		await page.screenshot({ path: join(OUT, "09-ko-dark-json.png") });
		await page.locator(".settings-seg [role=tab]", { hasText: "직접 입력" }).click();
		await page.locator(".settings-field").first().hover();
		await page.screenshot({ path: join(OUT, "10-ko-dark-manual.png") });
		await page.setViewportSize({ width: 900, height: 760 });
		await page.screenshot({ path: join(OUT, "11-ko-dark-narrow.png") });
	} finally {
		await app.close();
	}
}

try {
	await englishLight();
	await koreanDark();
} finally {
	rmSync(root, { recursive: true, force: true });
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Settings > MCP > Connect other agents — evidence in ${OUT}`);
}
