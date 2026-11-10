// Live end-to-end: a config an earlier Dazzi wrote (`jev: false`) works with the current librarian, and the agent runs
// with the small chat model (sLLM) deciding in Jev's place.
//
//   1. the profile starts with the retired `jev: false`; launching rewrites it to `jev.backend: "sllm"`
//   2. the legacy value written back while the app runs no longer blocks a Settings edit (the `config:patch`
//      "Config field 'jev' cannot be false" error)
//   3. Settings → AI Models shows Jev as "None" and each role writes a config the librarian accepts
//   4. a real AI Search question is answered by a real model, and the sLLM (not Jev) served the decision calls
//
// Both models are real OpenRouter models released in 2026, reached through a loopback proxy that only counts what
// passes (decision requests are the ones that carry the `submit_decisions` tool). The key comes from
// QA_OPENROUTER_KEY, else OPENROUTER_API_KEY, else the `openrouter` entry of ~/.pi/agent/auth.json; it is only handed
// to the throwaway profile. Pick other models from https://openrouter.ai/api/v1/models, never from memory:
// QA_ANSWER_MODEL, QA_SLLM_MODEL. Run `bun run build` first, then on this machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-jev-sllm.mjs
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-jev-sllm");
mkdirSync(EVIDENCE, { recursive: true });
const ANSWER_MODEL = process.env.QA_ANSWER_MODEL?.trim() || "z-ai/glm-5.3-flash";
const SLLM_MODEL = process.env.QA_SLLM_MODEL?.trim() || "qwen/qwen3.7-flash";

function openRouterKey() {
	const fromEnv = process.env.QA_OPENROUTER_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim();
	if (fromEnv) return fromEnv;
	try {
		const entry = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8")).openrouter;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : typeof entry?.key === "string" ? entry.key : null;
	} catch {
		return null;
	}
}
const KEY = openRouterKey();
if (KEY === null) {
	console.error("An OpenRouter key is required: set QA_OPENROUTER_KEY or OPENROUTER_API_KEY.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-jev-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(join(DOCS, "refund-policy.txt"), ["환불 정책", "구매 후 7일 이내에는 사유와 관계없이 전액 환불이 가능합니다.", "7일이 지난 뒤에는 제품 결함이 확인된 경우에만 환불합니다.", ""].join("\n"));

// A loopback proxy in front of OpenRouter that counts, and never alters, what passes.
const traffic = { decision: [], other: [], statuses: [] };
const proxy = createServer((req, res) => {
	const chunks = [];
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		const body = Buffer.concat(chunks);
		let model = "";
		let decision = false;
		try {
			const parsed = JSON.parse(body.toString("utf8"));
			model = String(parsed.model ?? "");
			decision = Array.isArray(parsed.tools) && parsed.tools.some((tool) => (tool?.function?.name ?? tool?.name) === "submit_decisions");
		} catch {
			// not JSON: pass it through
		}
		(decision ? traffic.decision : traffic.other).push(model);
		const headers = { ...req.headers, host: "openrouter.ai", "content-length": String(body.length) };
		delete headers["accept-encoding"];
		const upstream = httpsRequest(`https://openrouter.ai${req.url}`, { method: req.method, headers }, (reply) => {
			traffic.statuses.push(`${decision ? "decision" : "chat"} ${model} -> ${reply.statusCode}`);
			res.writeHead(reply.statusCode ?? 502, reply.headers);
			reply.pipe(res);
		});
		upstream.on("error", () => res.writeHead(502).end());
		upstream.end(body);
	});
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const PROXY_URL = `http://127.0.0.1:${proxy.address().port}/api/v1`;

const modelBlock = (id) => ({ provider: "openrouter-qa", id, name: id, baseUrl: PROXY_URL, api: "openai-completions", apiKeyEnv: "OPENROUTER_API_KEY", reasoning: false, input: ["text"], contextWindow: 262144, maxTokens: 16000 });
const readConfig = () => JSON.parse(readFileSync(CONFIG, "utf8"));
const writeConfig = (config) => writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
writeConfig({
	searchPaths: [DOCS],
	workspacePath: join(WORK, "workspace"),
	memoryPath: join(WORK, "memory.json"),
	minSync: { enabled: true, autoInstall: false, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } },
	jikji: false,
	// What an earlier Dazzi wrote: the librarian now refuses it outright.
	jev: false,
	webSearch: { enabled: false },
	model: modelBlock(ANSWER_MODEL),
	queryDecomposition: { model: modelBlock(SLLM_MODEL) },
});

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}:${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: KEY,
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

console.log(`answer model: ${ANSWER_MODEL}; sLLM (decision) model: ${SLLM_MODEL}`);
const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
let page = null;
try {
	page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(30_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	await page.waitForSelector(".sidebar__item");

	// 1. launch repairs the legacy value
	check("launch rewrote `jev: false` to the small chat model", JSON.stringify(readConfig().jev) === JSON.stringify({ backend: "sllm" }), JSON.stringify(readConfig().jev));
	const snapshot = await page.evaluate(() => window.autorag.settings.configGet());
	check("the librarian accepts the repaired config", snapshot.error === null, String(snapshot.error));

	// 2. the legacy value written back while the app runs must not block a Settings edit
	const repaired = readConfig();
	repaired.jev = false;
	writeConfig(repaired);
	const patched = await page.evaluate(() => window.autorag.settings.configPatch([{ path: ["rerank"], value: false }]).then((snap) => ({ ok: true, error: snap.error }), (error) => ({ ok: false, error: String(error) })));
	check("config:patch succeeds over a legacy `jev: false` (the reported error)", patched.ok && patched.error === null, JSON.stringify(patched));
	check("…and leaves the small chat model as the decision model", JSON.stringify(readConfig().jev) === JSON.stringify({ backend: "sllm" }), JSON.stringify(readConfig().jev));

	// 3. Settings → AI Models
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
	await page.locator(".settings-nav-item", { hasText: "AI Models" }).first().click();
	await page.waitForSelector('.settings-trigger[data-role="jev"]');
	const jevRow = page.locator('.settings-trigger[data-role="jev"]');
	check("Settings shows Jev as \"None\" (the small chat model)", /None/u.test(await jevRow.innerText()), (await jevRow.innerText()).trim());
	await page.screenshot({ path: join(EVIDENCE, "settings-ai-models.png") });
	await jevRow.click();
	const menu = page.locator('[role="dialog"], [role="menu"], [role="listbox"]').last();
	await menu.getByText("None", { exact: true }).first().click();
	await page.waitForTimeout(1500);
	check("picking None writes `jev.backend: sllm`", JSON.stringify(readConfig().jev) === JSON.stringify({ backend: "sllm" }), JSON.stringify(readConfig().jev));
	const afterPick = await page.evaluate(() => window.autorag.settings.configGet());
	check("the librarian accepts the config after the pick", afterPick.error === null, String(afterPick.error));
	const decompositionRow = page.locator('.settings-trigger[data-role="decomposition"]');
	check("the question-splitting model shows the configured sLLM", (await decompositionRow.innerText()).includes(SLLM_MODEL), (await decompositionRow.innerText()).trim());

	// 4. a real question, answered by a real model, with the sLLM deciding
	await page.locator(".settings-sidebar-back").click();
	await openAiSearch(page);
	await page.fill('textarea[aria-label="Ask Dazzi"]', "refund-policy.txt 문서를 근거로, 구매 후 10일이 지났을 때 환불이 되는지 알려줘.");
	await page.keyboard.press("Enter");
	const finished = () =>
		page.evaluate(() => {
			const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
			const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
			return done || Boolean(document.querySelector(".ai .text-danger-text")?.textContent);
		});
	const deadline = Date.now() + 240_000;
	let approvals = 0;
	while (!(await finished())) {
		if (Date.now() > deadline) throw new Error("the answer did not finish within 240s");
		const allow = page.locator('[role="alertdialog"] button', { hasText: "Allow once" });
		if ((await allow.count()) > 0) {
			approvals += 1;
			await allow.first().click();
		}
		await page.waitForTimeout(500);
	}
	console.log(`approval cards allowed: ${approvals}`);
	const error = (await page.locator(".ai .text-danger-text").first().textContent({ timeout: 1000 }).catch(() => null)) ?? "";
	if (error !== "" || traffic.statuses.some((status) => !status.endsWith("-> 200"))) {
		console.log(`upstream statuses: ${JSON.stringify(traffic.statuses)}`);
		await page.getByText("Show details", { exact: true }).first().click({ timeout: 2000 }).catch(() => undefined);
		console.log(`error panel: ${((await page.locator(".ai").first().innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 900)}`);
	}
	check("AI Search shows no error", error === "", error);
	const proses = page.locator(".assistant-msg .assistant-prose");
	let answer = "";
	for (let index = 0; index < (await proses.count()); index += 1) answer += `${await proses.nth(index).innerText()}\n`;
	await page.screenshot({ path: join(EVIDENCE, "live-answer.png") });
	console.log(`answer: ${answer.replace(/\s+/g, " ").slice(0, 500)}`);
	check("the agent produced an answer", answer.trim().length > 20, `${answer.length} chars`);
	check("the answer reflects the document (7 days, defect only)", /7일|7 days|결함|defect/iu.test(answer));
	check("the sLLM served decision requests (not Jev)", traffic.decision.length >= 1, `decision requests=${traffic.decision.length} models=${[...new Set(traffic.decision)].join(",")}`);
	check("decision requests went to the configured sLLM model", traffic.decision.every((model) => model === SLLM_MODEL), [...new Set(traffic.decision)].join(","));
	check("the answer model ran separately", traffic.other.some((model) => model === ANSWER_MODEL), [...new Set(traffic.other)].join(","));
	check("no renderer page error", pageErrors.length === 0, pageErrors.slice(0, 2).join(" | "));
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
	if (page !== null) {
		await page.screenshot({ path: join(EVIDENCE, "failure.png") }).catch(() => undefined);
		console.log(`page text at failure: ${((await page.locator("body").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").slice(0, 600)}`);
	}
} finally {
	await app.close().catch(() => undefined);
	proxy.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
