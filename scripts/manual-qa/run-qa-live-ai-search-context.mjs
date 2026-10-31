// Live end-to-end (issue #389): a real context overflow in the real app, the way it happened on 2026-10-31, when a
// Spotlight search handed the model 1.73M characters of raw PDF bytes and every retry failed with the same 400.
//
// Same harness as run-qa-live-ai-search-composer.mjs: a fresh profile signs in through a loopback stand-in for the Dazzi
// web sign-in, and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so every refusal, summary and answer
// is the real server's. The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the developer's
// `~/.pi/agent/auth.json`; it is only handed to the throwaway profile. The fixtures are files of random noise a tokenizer
// cannot compress, in a folder under ~/Documents that Spotlight indexes (`mdimport`), searched through a real `spotlight`
// data source; the folder is removed afterwards. The context guard sizes requests at chars/4, and noise costs far more:
// printable ASCII about 0.76 tokens a character, random Hangul syllables over 1 (both measured on the live server), which
// is how the 2026-10-31 PDF bytes got past it. Each scenario runs in its own app process, since the librarian keeps a
// model's post-overflow ceiling for the life of the process.
//
//   1. recovered: five files of 400k printable characters overflow the 1,048,576-token window; the panel shows the
//      summarising line, then the divider; the retry is held to half and answers, and the panel notes the cut result.
//   2. failed: six files of 400k Hangul syllables (2.4M characters, past even the server's request-size limit); the
//      retry, held to half the refused request, still carries some 1.2M tokens and is refused again; the panel explains
//      it and offers New chat and Ask narrower.
//
// Run `bun run build` first, then on this machine (the key is not forwarded into a VM; a window takes focus):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-context.mjs            # both scenarios
//   bun scripts/manual-qa/run-qa-live-ai-search-context.mjs recovered  # one of them
//
// It reads about 1-3M input tokens of the account's credits per scenario.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const MODEL_ID = process.env.QA_LIVE_MODEL ?? "z-ai/glm-5.3-flash";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-context");
mkdirSync(EVIDENCE, { recursive: true });
const ONLY = process.argv[2];

function realToken() {
	const fromEnv = process.env.QA_DAZZI_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const entry = JSON.parse(readFileSync(authPath, "utf8")).dazzi;
		return typeof entry?.access === "string" && entry.access.length > 0 ? entry.access : null;
	} catch {
		return null;
	}
}

const TOKEN = realToken();
if (TOKEN === null) {
	console.error("A Dazzi account key is required: set QA_DAZZI_TOKEN or sign in to Dazzi on this machine.");
	process.exit(2);
}
if (process.platform !== "darwin") {
	console.error("This lane drives macOS Spotlight.");
	process.exit(2);
}

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`);
	if (!ok) failures.push(name);
};

const EN = JSON.parse(readFileSync(join(ROOT, "src/shared/i18n/locales/en.json"), "utf8"));
const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-context-"));
// Spotlight does not index temporary folders; ~/Documents it does.
const FIXTURES = join(homedir(), "Documents", `dazzi-qa-context-${Date.now().toString(36)}`);
const FILE_CHARS = 400_000;
const ALPHABET = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~";

/** `FILE_CHARS` characters of noise: printable ASCII, or Hangul syllables (U+AC00…U+D7A3). */
function noise(kind) {
	const bytes = randomBytes(FILE_CHARS * 2);
	let body = "";
	for (let i = 0; i < FILE_CHARS; i++) {
		body += kind === "hangul" ? String.fromCharCode(0xac00 + (bytes.readUInt16LE(i * 2) % 11172)) : ALPHABET[bytes[i] % ALPHABET.length];
	}
	return body;
}

/** A file Spotlight finds by `keyword`, whose body is noise. */
function writeNoise(keyword, kind, index) {
	writeFileSync(join(FIXTURES, `${keyword}-ledger-${String(index).padStart(2, "0")}.txt`), `${keyword} ledger files export archive\n${noise(kind)}\n`);
}

function spotlightFinds(keyword) {
	const result = spawnSync("mdfind", ["-onlyin", FIXTURES, `(kMDItemContentTypeTree == "public.text") AND ("${keyword}")`], { encoding: "utf8" });
	return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

const SCENARIOS = [
	{ name: "recovered", keyword: "zebrafinch", kind: "printable", files: 5 },
	{ name: "failed", keyword: "quokka", kind: "hangul", files: 6 },
].filter((scenario) => ONLY === undefined || scenario.name === ONLY);

mkdirSync(FIXTURES, { recursive: true });
for (const scenario of SCENARIOS) for (let i = 1; i <= scenario.files; i++) writeNoise(scenario.keyword, scenario.kind, i);
spawnSync("mdimport", [FIXTURES]);
for (const scenario of SCENARIOS) {
	const deadline = Date.now() + 60_000;
	while (spotlightFinds(scenario.keyword) < scenario.files && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
	check(`Spotlight finds the ${scenario.keyword} fixtures`, spotlightFinds(scenario.keyword) === scenario.files, `${spotlightFinds(scenario.keyword)}/${scenario.files}`);
}

const service = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/desktop/authorize") {
		const target = new URL(url.searchParams.get("redirect_uri"));
		target.searchParams.set("code", "qa-code");
		target.searchParams.set("state", url.searchParams.get("state"));
		res.writeHead(302, { location: target.toString() }).end();
		return;
	}
	if (url.pathname === "/api/desktop/token") {
		req.resume();
		res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: TOKEN }));
		return;
	}
	const headers = { ...req.headers, host: new URL(REAL_API).host };
	delete headers["accept-encoding"];
	const upstream = httpsRequest(`${REAL_API}${req.url}`, { method: req.method, headers }, (reply) => {
		if ((reply.statusCode ?? 200) >= 400) console.log(`[api] ${req.method} ${url.pathname} -> ${reply.statusCode}`);
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => res.writeHead(502).end());
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

async function runScenario({ name, keyword }) {
	console.log(`\n── ${name} ──`);
	const root = join(WORK, name);
	const agentDir = join(root, "pi-agent");
	const home = join(root, "autorag-home");
	const config = join(root, "config.json");
	const userData = join(root, "user-data");
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "workspace"), { recursive: true });
	mkdirSync(join(home, "bin"), { recursive: true });
	const minsyncStub = join(home, "bin", "minsync");
	writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
	chmodSync(minsyncStub, 0o755);
	const datasources = {
		"mac-files": {
			type: "spotlight",
			description: "macOS Spotlight over the ledger export folder",
			// A Hangul file is 1.2 MB of UTF-8: past the connector's default 256 KiB, which would skip it.
			connector: { queries: ['kMDItemContentTypeTree == "public.text"'], onlyIn: FIXTURES, maxContentChars: 500_000, maxBytesPerFile: 2_000_000 },
		},
	};
	writeFileSync(
		config,
		`${JSON.stringify({ searchPaths: [join(root, "docs")], workspacePath: join(root, "workspace"), memoryPath: join(root, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false, datasources }, null, 2)}\n`,
	);
	const env = {
		AUTORAG_HOME: home,
		AUTORAG_CONFIG: config,
		AUTORAG_BASE_URL: baseUrl,
		PI_CODING_AGENT_DIR: agentDir,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
		ELECTRON_RENDERER_URL: "",
		PATH: `${join(home, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		OPENROUTER_API_KEY: "",
		OPENAI_API_KEY: "",
		ANTHROPIC_API_KEY: "",
	};
	const app = await launchFinder({ userDataDir: userData, env });
	try {
		const page = await finderWindow(app, 30_000);
		page.setDefaultTimeout(30_000);
		page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
		await app.evaluate(({ shell }) => {
			shell.openExternal = async (url) => {
				await fetch(url);
			};
		});
		const status = await page.evaluate(() => window.autorag.account.signIn());
		check(`${name}: Dazzi sign-in completes`, status.state === "signedIn", `${status.state} ${status.error ?? ""}`);
		const cfg = JSON.parse(readFileSync(config, "utf8"));
		cfg.model = { provider: "dazzi", id: MODEL_ID, name: MODEL_ID, baseUrl: `${baseUrl}/v1`, api: "openai-responses", reasoning: true, input: ["text", "image"], contextWindow: 1048576, maxTokens: 32000 };
		cfg.datasources = datasources;
		writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`);

		await openAiSearch(page);
		const field = page.locator('textarea[aria-label="Ask Dazzi"]');
		const ask = async (text, timeout) => {
			const before = await page.locator(".user-msg").count();
			await field.click();
			await page.keyboard.insertText(text);
			await page.keyboard.press("Enter");
			await page.waitForFunction((count) => document.querySelectorAll(".user-msg").length > count, before);
			let compactingSeen = false;
			const deadline = Date.now() + timeout;
			while (Date.now() < deadline) {
				if (!compactingSeen && (await page.locator('[data-context="compacting"]').count()) > 0) {
					compactingSeen = true;
					await page.screenshot({ path: join(EVIDENCE, `${name}-01-compacting.png`) });
					console.log(`${name}: the summarising line is on screen`);
				}
				if ((await page.locator('button[aria-label="Stop"]').count()) === 0) break;
				await page.waitForTimeout(150);
			}
			return compactingSeen;
		};

		// An earlier turn, so the conversation has something to summarise, as a chat in use does.
		await ask("Hi! In one short sentence, what can you help me with?", 240_000);
		const compactingSeen = await ask(
			`Search the mac-files Spotlight source for "${keyword}" and summarize what those ${keyword} ledger files contain.`,
			900_000,
		);
		await page.waitForTimeout(600);
		const dividers = await page.locator('[data-context="compacted"]').count();
		const trims = await page.locator('[data-context="trimmed"]').count();
		const alert = page.locator('.ai [role="alert"]');
		const alertText = (await alert.count()) > 0 ? await alert.first().innerText() : "";
		const sessions = join(userData, "chat-sessions");
		const compactions = existsSync(sessions)
			? readdirSync(sessions)
					.filter((file) => file.endsWith(".jsonl"))
					.flatMap((file) => readFileSync(join(sessions, file), "utf8").split("\n"))
					.filter((line) => line.includes('"type":"compaction"')).length
			: 0;
		console.log(`${name}: dividers=${dividers} trims=${trims} compaction entries=${compactions} alert=${JSON.stringify(alertText.slice(0, 300))}`);
		check(`${name}: pi wrote a summary into the conversation`, compactions > 0, `${compactions} compaction entries`);
		check(`${name}: the panel showed the summarising line while it was written`, compactingSeen);
		check(`${name}: a divider marks where the earlier turns were summarised`, dividers >= 1, String(dividers));
		await page.screenshot({ path: join(EVIDENCE, `${name}-02-settled.png`), fullPage: true });

		if (name === "recovered") {
			const answer = (await page.locator(".assistant-msg").last().locator(".assistant-prose").allInnerTexts()).join(" ").trim();
			console.log(`${name}: answer: ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
			check(`${name}: the retry answered, with no error`, answer.length > 0 && alertText === "", alertText);
			check(`${name}: the panel notes that the oversized result was only partly used`, trims >= 1, String(trims));
		} else {
			check(`${name}: the error says the model's limit was passed`, alertText.includes(EN.appError.contextOverflow.title) && alertText.includes(EN.appError.contextOverflow.hint), alertText);
			const labels = await alert.first().locator("button").allInnerTexts();
			check(`${name}: it offers New chat and Ask narrower, and no AI fix`, labels.includes(EN.aiSearch.newChat) && labels.includes(EN.appError.askNarrower) && !labels.some((label) => label.includes(EN.appError.fixAction)), JSON.stringify(labels));
			await alert.first().locator("button", { hasText: EN.appError.askNarrower }).click();
			check(`${name}: Ask narrower puts the question back in the composer`, (await field.inputValue()).includes(keyword), await field.inputValue());
			await page.screenshot({ path: join(EVIDENCE, `${name}-03-ask-narrower.png`) });
		}
	} catch (error) {
		check(`${name}: run completed`, false, String(error).slice(0, 500));
	} finally {
		await app.close().catch(() => undefined);
	}
}

try {
	for (const scenario of SCENARIOS) await runScenario(scenario);
} finally {
	service.close();
	rmSync(FIXTURES, { recursive: true, force: true });
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed: ${failures.join(" | ")}`);
	process.exit(1);
}
console.log("\nall checks passed");
