/**
 * Live verification of Settings → MCP Servers → Cloud agents: the real built app starts the librarian's HTTP MCP
 * server behind its own Cloudflare tunnel, and a real MCP client reaches a real index through it.
 *
 * Needs `cloudflared` on PATH and a built app. Run through the QA runner:
 *   bun run qa script test/agent-connect.e2e.mjs
 *
 * Environment (all optional):
 *   QA_HOLD_SECONDS  keep the app and tunnel up this long after the checks, so a person or another agent can connect
 *                    to the address printed as `AGENT_ADDRESS=`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { finderWindow, launchFinder } from "../scripts/manual-qa/launch-finder.mjs";

const out = process.env.QA_OUT;
assert.ok(out, "Run this script through bun run qa script.");
await mkdir(out, { recursive: true });

// Everything the app and the librarian write goes under one temp root, never the real ~/.autorag.
const root = await mkdtemp(join(tmpdir(), "dazzi-agent-connect-"));
const home = join(root, "home");
const autoragHome = join(root, "autorag-home");
const docs = join(home, "Documents");
const userDataDir = join(root, "profile");
await mkdir(docs, { recursive: true });
await mkdir(autoragHome, { recursive: true });
await writeFile(join(docs, "refund-policy.txt"), "Refund exceptions require director approval before payout.\n");
await writeFile(join(docs, "vendor-onboarding.txt"), "Vendor onboarding needs a signed NDA and a W-9 before the first invoice.\n");
const config = join(autoragHome, "config.json");
assert.ok(config.startsWith(root), "the config must be inside the QA root");

const env = { HOME: home, USERPROFILE: home, AUTORAG_HOME: autoragHome, AUTORAG_CONFIG: config };
// Build the real index the app will serve: the same parsed + MinSync index the CLI builds.
const run = (args) =>
	execFileSync(process.execPath, [join(process.cwd(), "node_modules/@autorag/librarian/dist/cli/index.js"), ...args], {
		env: { ...process.env, ...env },
		encoding: "utf8",
		timeout: 280_000,
	});
run(["lite", "init", "--search-paths", docs, "--workspace", root, "--force"]);
const refreshed = JSON.parse(run(["lite", "refresh", "--method", "parsed,minsync", "--json"]));
assert.equal(refreshed.ok, true, "the index must build before the app serves it");

const app = await launchFinder({ userDataDir, env });
// The window may not be focused on a shared machine, so a write to the OS clipboard is not reliable to read back.
// Record what the page asks to copy instead; this is exactly the text a user would paste.
const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
let page;
const copiedText = () => page.evaluate(() => window.__qaCopied?.at(-1) ?? "");
const results = {};
try {
	page = await finderWindow(app, 30_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.evaluate(() => {
		window.__qaCopied = [];
		const original = navigator.clipboard.writeText.bind(navigator.clipboard);
		navigator.clipboard.writeText = async (text) => {
			window.__qaCopied.push(text);
			return original(text).catch(() => undefined);
		};
	});
	const en = JSON.parse(await readFile(new URL("../src/shared/i18n/locales/en.json", import.meta.url), "utf8")).settingsCore;
	await page.getByRole("button", { name: JSON.parse(await readFile(new URL("../src/shared/i18n/locales/en.json", import.meta.url), "utf8")).places.settings, exact: true }).click();
	await page.locator(".settings-sidebar").getByRole("button", { name: en.nav.mcp, exact: true }).click();
	await expect(page.locator("h1.linear-title")).toHaveText(en.nav.mcp);

	const agents = en.mcp.agents;
	const toggle = page.getByRole("switch", { name: agents.access, exact: true });
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(page.getByRole("button", { name: agents.copyAddress, exact: true })).toHaveCount(0);
	await page.locator(".settings-content-wrap").screenshot({ path: join(out, "01-agents-off.png") });
	results.offByDefault = true;

	await toggle.click();
	const copyAddress = page.getByRole("button", { name: agents.copyAddress, exact: true });
	await expect(copyAddress).toBeVisible({ timeout: 90_000 });
	await page.locator(".settings-content-wrap").screenshot({ path: join(out, "02-agents-on.png") });
	await copyAddress.click();
	const address = await copiedText();
	assert.match(address, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/mcp$/, `the address the app hands out: ${address}`);
	results.address = address;
	console.log(`AGENT_ADDRESS=${address}`);

	// The token is never on the page; copying it goes straight to the clipboard.
	await expect(page.locator(".settings-content-wrap")).not.toContainText(/[A-Za-z0-9_-]{43}/);
	await page.getByRole("button", { name: agents.copyToken, exact: true }).click();
	const token = await copiedText();
	assert.ok(token.length >= 32 && token !== address, "the token is copied, not the address");
	const tokenFile = join(userDataDir, "settings", "agent-mcp-token");
	assert.ok(existsSync(tokenFile), "the owner token is kept in the profile's private settings directory");
	if (process.platform !== "win32") assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
	results.tokenFileMode = "0600";

	// 1. The rehearsal a vendor dialog does not give you: the librarian's own --check, against the app's address.
	const checked = JSON.parse(
		execFileSync(process.execPath, [join(process.cwd(), "node_modules/@autorag/librarian/dist/mcp/index.js"), "--check", address, "--json"], {
			env: { ...process.env, AUTORAG_MCP_TOKEN: token },
			encoding: "utf8",
		}),
	);
	assert.equal(checked.ok, true, JSON.stringify(checked.steps));
	assert.deepEqual(checked.steps.map((step) => step.status), ["pass", "pass", "pass", "pass", "pass", "pass"]);
	results.check = checked.steps.map((step) => `${step.status} ${step.name}`);

	// 2. Bearer access, and the read-only default: no write tool is offered.
	const rpc = async (method, params, id, auth = `Bearer ${token}`, session) => {
		const response = await fetch(address, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: auth, ...(session ? { "mcp-session-id": session } : {}) },
			body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		});
		const body = await response.text();
		const data = body.startsWith("event:") || body.includes("\ndata:") ? body.split("\n").find((line) => line.startsWith("data:"))?.slice(5) ?? "{}" : body;
		return { status: response.status, json: data.trim() === "" ? {} : JSON.parse(data), session: response.headers.get("mcp-session-id") };
	};
	const init = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "agent-connect-e2e", version: "1" } }, 1);
	assert.equal(init.status, 200);
	const tools = (await rpc("tools/list", {}, 2, `Bearer ${token}`, init.session)).json.result.tools.map((tool) => tool.name);
	for (const writer of ["autorag.refresh", "autorag.report", "autorag.convert"]) assert.ok(!tools.includes(writer), `${writer} must not be offered by default`);
	assert.ok(tools.includes("autorag.search"));
	results.tools = tools;
	const found = await rpc("tools/call", { name: "autorag.search", arguments: { query: "who must approve a refund before it is paid out", topK: 3 } }, 3, `Bearer ${token}`, init.session);
	const hit = JSON.parse(found.json.result.content[0].text).results[0];
	assert.match(hit.content, /director approval/i);
	assert.ok(hit.source.startsWith(await (await import("node:fs/promises")).realpath(docs)), `the hit is a real file under the QA corpus: ${hit.source}`);
	results.search = { source: hit.source, method: hit.method };
	assert.equal((await rpc("initialize", {}, 9, "Bearer wrong")).status, 401);
	assert.equal((await rpc("initialize", {}, 9, "")).status, 401);

	// 3. OAuth, the way ChatGPT/dots, Muse and Claude connectors sign in.
	const base = new URL(address).origin;
	const registered = await (await fetch(`${base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "agent-connect-e2e", redirect_uris: ["https://chatgpt.com/connector/oauth/callback"] }) })).json();
	const verifier = randomBytes(32).toString("base64url");
	const authorize = new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: "https://chatgpt.com/connector/oauth/callback", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "s1", resource: address });
	const consent = await fetch(`${base}/authorize?${authorize}`);
	assert.equal(consent.status, 200);
	const approved = await fetch(`${base}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...Object.fromEntries(authorize), owner_token: token }) });
	assert.equal(approved.status, 302);
	const code = new URL(approved.headers.get("location")).searchParams.get("code");
	const issued = await (await fetch(`${base}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: registered.client_id, redirect_uri: "https://chatgpt.com/connector/oauth/callback", code_verifier: verifier, resource: address }) })).json();
	assert.ok(issued.access_token);
	assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "oauth", version: "1" } }, 4, `Bearer ${issued.access_token}`)).status, 200);
	results.oauth = "code + PKCE + token accepted";

	// 4. Write access is a separate switch, off until turned on, and the app restarts the server with it.
	const write = page.getByRole("switch", { name: agents.write, exact: true });
	await expect(write).toHaveAttribute("aria-checked", "false");
	await write.click();
	await expect(write).toHaveAttribute("aria-checked", "true");
	await expect.poll(async () => {
		const reopened = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "w", version: "1" } }, 5);
		if (reopened.status !== 200) return "down";
		const listed = (await rpc("tools/list", {}, 6, `Bearer ${token}`, reopened.session)).json.result?.tools?.map((tool) => tool.name) ?? [];
		return listed.includes("autorag.refresh") ? "writes" : "readonly";
	}, { timeout: 60_000 }).toBe("writes");
	await write.click();
	await expect(write).toHaveAttribute("aria-checked", "false");
	results.writeToggle = "off -> on -> off";

	// 5. The owner token resets on request and the old one is refused.
	await page.getByRole("button", { name: agents.resetToken, exact: true }).click();
	await page.getByRole("button", { name: agents.resetTokenConfirm, exact: true }).click();
	await expect.poll(async () => (await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "old", version: "1" } }, 7)).status, { timeout: 60_000 }).toBe(401);
	await page.getByRole("button", { name: agents.copyToken, exact: true }).click();
	const rotated = await copiedText();
	assert.notEqual(rotated, token);
	assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "new", version: "1" } }, 8, `Bearer ${rotated}`)).status, 200);
	assert.equal((await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "stale-oauth", version: "1" } }, 8, `Bearer ${issued.access_token}`)).status, 401);
	results.reset = "old bearer and old OAuth token refused, new token works";
	await page.locator(".settings-content-wrap").screenshot({ path: join(out, "03-agents-after-reset.png") });
	console.log(`AGENT_TOKEN_FILE=${tokenFile}`);
	console.log(`AGENT_TOKEN=${rotated}`);

	const hold = Number(process.env.QA_HOLD_SECONDS ?? 0);
	if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold * 1000));

	// 6. Off stops the server and the tunnel together.
	await toggle.click();
	await expect(copyAddress).toHaveCount(0, { timeout: 30_000 });
	await expect.poll(async () => fetch(address, { method: "POST", headers: { authorization: `Bearer ${rotated}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.status, () => "unreachable"), { timeout: 30_000 }).not.toBe(200);
	results.off = "address no longer serves";
} finally {
	await page?.screenshot({ path: join(out, "99-final.png") }).catch(() => undefined);
	await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard).catch(() => undefined);
	await app.close().catch(() => undefined);
	console.log(JSON.stringify(results, null, 2));
	await writeFile(join(out, "result.json"), `${JSON.stringify(results, null, 2)}\n`);
	await rm(root, { recursive: true, force: true });
}
