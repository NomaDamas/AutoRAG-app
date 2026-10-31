// Live end-to-end: a long, multi-line question typed into the AI Search composer wraps and scrolls inside the
// field, is sent with Enter, and a real model answers it.
//
// Same harness as run-qa-live-ai-search-table.mjs: a fresh profile signs in through a loopback stand-in for the
// Dazzi web sign-in, and every `/v1/*` call is forwarded unchanged to the live Dazzi API, so the answer is the
// model's own output. The account key comes from QA_DAZZI_TOKEN, else from the `dazzi` entry of the developer's
// `~/.pi/agent/auth.json`; it is only handed to the throwaway profile. Run `bun run build` first, then on this
// machine (the key is not forwarded into a VM):
//
//   bun scripts/manual-qa/run-qa-live-ai-search-composer.mjs
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { finderWindow, launchFinder, openAiSearch, ROOT } from "./launch-finder.mjs";

const REAL_API = "https://api.dazziapp.com";
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/live-ai-search-composer");
mkdirSync(EVIDENCE, { recursive: true });

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

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const WORK = mkdtempSync(join(tmpdir(), "autorag-qa-live-composer-"));
const AGENT_DIR = join(WORK, "pi-agent");
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
mkdirSync(DOCS, { recursive: true });
mkdirSync(join(WORK, "workspace"), { recursive: true });
mkdirSync(join(AUTORAG_HOME, "bin"), { recursive: true });
const minsyncStub = join(AUTORAG_HOME, "bin", "minsync");
writeFileSync(minsyncStub, "#!/bin/sh\nexit 0\n");
chmodSync(minsyncStub, 0o755);
writeFileSync(
	join(DOCS, "plans.txt"),
	["요금제 안내", "Free 플랜: 월 0원, 사용자 1명, 저장공간 5GB.", "Pro 플랜: 월 20,000원, 사용자 5명, 저장공간 100GB.", "Team 플랜: 월 80,000원, 사용자 30명, 저장공간 1TB.", ""].join("\n"),
);
writeFileSync(
	CONFIG,
	`${JSON.stringify({ searchPaths: [DOCS], workspacePath: join(WORK, "workspace"), memoryPath: join(WORK, "memory.json"), minSync: { enabled: true, autoInstall: true, embedder: { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 } }, jikji: false }, null, 2)}\n`,
);

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
		res.writeHead(reply.statusCode ?? 502, reply.headers);
		reply.pipe(res);
	});
	upstream.on("error", () => res.writeHead(502).end());
	req.pipe(upstream);
});
await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${service.address().port}`;

const env = {
	AUTORAG_HOME,
	AUTORAG_CONFIG: CONFIG,
	AUTORAG_BASE_URL: baseUrl,
	PI_CODING_AGENT_DIR: AGENT_DIR,
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	PATH: `${join(AUTORAG_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
};

const app = await launchFinder({ userDataDir: join(WORK, "user-data"), env });
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
	check("Dazzi sign-in completes", status.state === "signedIn", `${status.state} ${status.error ?? ""}`);

	const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
	cfg.model = {
		provider: "dazzi",
		id: "z-ai/glm-5.3-flash",
		name: "GLM 5.3 Flash",
		baseUrl: `${baseUrl}/v1`,
		api: "openai-responses",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1048576,
		maxTokens: 32000,
	};
	writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`);

	await openAiSearch(page);
	const field = page.locator('textarea[aria-label="Ask Dazzi"]');
	const geometry = () =>
		field.evaluate((element) => ({
			height: element.getBoundingClientRect().height,
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			overflowY: getComputedStyle(element).overflowY,
			row: Number.parseFloat(getComputedStyle(element).lineHeight),
		}));

	// A long question: one wrapped paragraph, then a second paragraph after Shift+Enter lines.
	await field.click();
	const empty = await geometry();
	await page.keyboard.insertText("plans.txt를 근거로 Free, Pro, Team 플랜의 월 요금, 사용자 수, 저장공간을 비교해서 정리해줘. 어떤 플랜이 5명짜리 팀에 가장 적합한지도 이유와 함께 설명해주고, 요금 차이가 가장 큰 구간이 어디인지도 알려줘. ".repeat(2));
	await page.keyboard.insertText("답변은 반드시 마크다운 표 하나와 두 문장짜리 결론으로 구성해줘.");
	const wrapped = await geometry();
	check("the long question wraps onto several rows", wrapped.height >= empty.height * 3.5, JSON.stringify(wrapped));
	check("nothing runs off the side and nothing is hidden", wrapped.scrollWidth <= wrapped.clientWidth + 1 && wrapped.scrollHeight <= wrapped.clientHeight + 1, JSON.stringify(wrapped));
	await page.screenshot({ path: join(EVIDENCE, "live-01-wrapped.png") });
	for (const line of ["", "추가 조건:", "- 월 요금은 원 단위로 표기", "- 저장공간 단위는 GB로 통일", "- 근거 파일 이름을 마지막에 한 줄로", "- 불확실한 내용은 추측하지 말 것", "- 존댓말 사용", "- 불필요한 서론 생략", "- 표의 열 순서는 플랜, 요금, 사용자, 저장공간"]) {
		await page.keyboard.press("Shift+Enter");
		if (line !== "") await page.keyboard.insertText(line);
	}
	const capped = await geometry();
	check("past eight rows the field stops growing and scrolls", Math.abs(capped.height - capped.row * 8) < 2 && capped.overflowY === "auto" && capped.scrollHeight > capped.clientHeight, JSON.stringify(capped));
	await page.screenshot({ path: join(EVIDENCE, "live-02-capped.png") });

	await page.keyboard.press("Enter");
	await page.waitForFunction(
		() => {
			const input = document.querySelector('textarea[aria-label="Ask Dazzi"]');
			const done = input !== null && document.querySelector('button[aria-label="Stop"]') === null && document.querySelector(".user-msg") !== null;
			return done || (document.querySelector(".ai")?.textContent ?? "").includes("Something went wrong");
		},
		null,
		{ timeout: 240_000 },
	);
	let error = "";
	if ((await page.locator(".ai", { hasText: "Something went wrong" }).count()) > 0) {
		await page.locator(".ai button", { hasText: "Show details" }).first().click();
		error = (await page.locator(".ai pre").first().innerText()).slice(0, 600);
	}
	check("AI Search shows no error", error === "", error);
	const bubble = await page.locator(".user-msg .bubble").first().evaluate((element) => ({ text: element.textContent ?? "", whiteSpace: getComputedStyle(element).whiteSpace }));
	check("the sent bubble carries the whole multi-line question with its line breaks", bubble.whiteSpace === "pre-wrap" && bubble.text.includes("마크다운 표 하나") && bubble.text.includes("\n- 존댓말 사용\n") && bubble.text.includes("표의 열 순서는"), JSON.stringify(bubble).slice(0, 300));
	const after = await geometry();
	check("the composer is empty and one row again", (await field.inputValue()) === "" && Math.abs(after.height - after.row) < 1.5, JSON.stringify(after));
	const raw = await page.locator(".assistant-msg .assistant-prose").allInnerTexts();
	console.log(`model answer (rendered text): ${raw.join(" ").replace(/\s+/g, " ").slice(0, 400)}`);
	check("a real model answered", raw.join("").trim().length > 0);
	await page.screenshot({ path: join(EVIDENCE, "live-03-answered.png") });
} catch (error) {
	check("run completed", false, String(error).slice(0, 500));
} finally {
	await app.close().catch(() => undefined);
	service.close();
	rmSync(WORK, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
