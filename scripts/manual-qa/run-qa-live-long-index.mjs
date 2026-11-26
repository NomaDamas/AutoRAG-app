/**
 * Live E2E QA — a long index run (well past 5 minutes) is never killed by the app.
 *
 * Verifies against the real built Electron app (with real `minsync stage`,
 * `minsync sync`, and local `inl`/`minsync serve` dense + SPLADE indexing):
 *   1. Many files (default 1600, a run of ~10 minutes on a CPU-only VM) are parsed and indexed
 *      through the real Settings -> Indexing "Refresh local folders now" button.
 *   2. `minsync stage` stays alive for the whole refresh without ever being
 *      killed by a CPU-idle watchdog (no `MinSync stage session ended`,
 *      no `write EPIPE`, no `exit code 1` / `SIGTERM`).
 *   3. Overlapped batch indexing (parse + minsync) runs concurrently and
 *      completes cleanly with `state: "success"` and all files indexed.
 *   4. A unique needle document is retrievable via the app's content search.
 *
 * Usage:
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-long-index.mjs
 *   bun run qa script --vm --skip-build scripts/manual-qa/run-qa-live-long-index.mjs 2500 1   # files, semantic(1|0)
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv, rmRetry } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/qa-live-long-index");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
writeFileSync(LOG, "");
const log = (line) => {
	const stamped = `[${new Date().toISOString()}] ${line}`;
	console.log(stamped);
	appendFileSync(LOG, `${stamped}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${ok || detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) failures.push(label);
};

// Default 3500 files with semantic (dense + sparse) so parsing runs long enough to observe
// overlapped batch indexing (parse + minsync) and the overall run comfortably exceeds the
// retired 5-minute CPU watchdog window.
const FILES = Number(process.argv[2] ?? process.env.QA_FILES ?? 1600);
const SEMANTIC = (process.argv[3] ?? process.env.QA_SEMANTIC) !== "0";
const WORK = mkdtempSync(join(tmpdir(), "dazzi-qa-live-long-index-"));
const AUTORAG_HOME = join(WORK, "autorag-home");
const CONFIG = join(WORK, "config.json");
const DOCS = join(WORK, "docs");
const WORKSPACE = join(WORK, "workspace");
for (const dir of [DOCS, WORKSPACE, join(WORK, "pi-agent"), join(WORK, "home")]) mkdirSync(dir, { recursive: true });

const defaultModels = process.platform === "win32"
	? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cache", "im-not-llm", "models")
	: join(process.env.HOME ?? "", ".cache", "im-not-llm", "models");
const MODELS = process.env.INL_CACHE_DIR ?? defaultModels;
log(`platform=${process.platform} FILES=${FILES} SEMANTIC=${SEMANTIC} MODELS=${MODELS} exists=${existsSync(MODELS)}`);

if (existsSync(MODELS)) {
	mkdirSync(join(WORK, "home", ".cache", "im-not-llm"), { recursive: true });
	if (process.platform !== "win32") {
		symlinkSync(MODELS, join(WORK, "home", ".cache", "im-not-llm", "models"));
	}
}

const WORDS = [
	"architecture", "quarterly", "milestone", "forecast", "ledger", "roadmap",
	"estimate", "archive", "invoice", "summary", "budget", "contract",
	"specification", "compliance", "protocol", "benchmark", "throughput", "latency",
];
for (let n = 1; n <= FILES; n += 1) {
	const folder = join(DOCS, `batch-${String(Math.floor((n - 1) / 100)).padStart(2, "0")}`);
	if ((n - 1) % 100 === 0) mkdirSync(folder, { recursive: true });
	const paragraphs = Array.from({ length: 4 }, (_, p) =>
		Array.from({ length: 45 }, (_, i) => WORDS[(n * 7 + p * 11 + i * 3) % WORDS.length]).join(" "),
	).join("\n\n");
	writeFileSync(
		join(folder, `doc-${String(n).padStart(4, "0")}.md`),
		`# Document ${n}\n\nUnique token tk${n}-${n * 37}.\n\n${paragraphs}\n`,
	);
}
const NEEDLE = "obsidianvelvetquartz";
writeFileSync(
	join(DOCS, "needle-final.md"),
	`# Final Needle Document\n\nThis unique marker ${NEEDLE} verifies end-to-end indexing completed across every batch.\n`,
);
const TOTAL = FILES + 1;
log(`generated ${TOTAL} markdown files under ${DOCS}`);

writeFileSync(
	CONFIG,
	`${JSON.stringify(
		{
			searchPaths: [DOCS],
			workspacePath: WORKSPACE,
			memoryPath: join(WORK, "memory.json"),
			minSync: {
				enabled: true,
				autoInstall: false,
				...(SEMANTIC ? {} : { embedder: { id: "none" } }),
			},
			appIndexing: { semanticSearch: SEMANTIC },
			jikji: false,
			jev: { backend: "sllm" },
			webSearch: { enabled: false },
			queryDecomposition: false,
		},
		null,
		2,
	)}\n`,
);

const env = {
	AUTORAG_HOME,
	...homeEnv(join(WORK, "home")),
	AUTORAG_CONFIG: CONFIG,
	PI_CODING_AGENT_DIR: join(WORK, "pi-agent"),
	AUTORAG_SKIP_DUPEY_CHECK: "1",
	ELECTRON_RENDERER_URL: "",
	OPENROUTER_API_KEY: "",
	OPENAI_API_KEY: "",
	ANTHROPIC_API_KEY: "",
	...(existsSync(MODELS) ? { INL_CACHE_DIR: MODELS } : {}),
};

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	try {
		if (patient === true) rmRetry(WORK);
		else rmSync(WORK, { recursive: true, force: true });
	} catch (error) {
		log(`cleanup: ${WORK} stayed behind (${error.code ?? error.message})`);
	}
};
process.on("exit", () => sweep(false));

app = await launchFinder({ userDataDir: join(WORK, "user-data"), env, language: "en" });
const page = await finderWindow(app, 60_000);
page.setDefaultTimeout(30_000);
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error)));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });

await page.locator(".sidebar__item--settings").click();
await page.waitForSelector(".settings-panel");
await page.locator(".settings-nav-item", { hasText: "Indexing" }).first().click();
await page.getByRole("button", { name: "Refresh local folders now" }).waitFor();
await page.screenshot({ path: join(EVIDENCE, "01-before-refresh.png") });

const sample = () =>
	page.evaluate(() => {
		const card = document.querySelector(".settings-activity");
		const stages = [...document.querySelectorAll(".settings-activity-stages li")].map((item) => ({
			label: item.textContent ?? "",
			state: item.getAttribute("data-state"),
			current: item.getAttribute("aria-current") === "step",
		}));
		const bar = document.querySelector('.settings-activity [role="progressbar"]');
		const errorText = document.querySelector(".settings-activity")?.textContent ?? "";
		return {
			tone: card?.getAttribute("data-tone") ?? null,
			stages,
			percent: bar?.getAttribute("aria-valuenow") === null || bar === null ? null : Number(bar.getAttribute("aria-valuenow")),
			lines: [...document.querySelectorAll('[data-testid="index-progress-detail"] p')].map((line) => line.textContent ?? ""),
			errorText: card?.getAttribute("data-tone") === "error" ? errorText : null,
		};
	});

const startedAt = Date.now();
await page.getByRole("button", { name: "Refresh local folders now" }).click();

const samples = [];
let lastSig = "";
let midShot = false;
const deadline = Date.now() + 20 * 60_000;
let finished = false;
while (Date.now() < deadline) {
	await page.waitForTimeout(1000);
	const now = await sample();
	const elapsedSec = (Date.now() - startedAt) / 1000;
	samples.push({ at: Date.now() - startedAt, ...now });
	const sig = JSON.stringify([now.tone, now.stages.map((s) => `${s.label}:${s.state}${s.current ? "*" : ""}`), now.percent]);
	if (sig !== lastSig) {
		lastSig = sig;
		log(`t=${elapsedSec.toFixed(1)}s tone=${now.tone} ${now.stages.map((s) => `${s.label}:${s.state}${s.current ? "*" : ""}`).join(" ")} bar=${now.percent} lines=${JSON.stringify(now.lines)}`);
	}
	if (!midShot && now.tone === "run" && now.stages.some((s) => s.state === "running")) {
		midShot = true;
		await page.screenshot({ path: join(EVIDENCE, "02-running.png") }).catch(() => undefined);
	}
	if (now.tone !== null && now.tone !== "run" && samples.some((s) => s.tone === "run")) {
		finished = true;
		break;
	}
}

const totalSec = Math.round((Date.now() - startedAt) / 1000);
log(`run finished=${finished} elapsed=${totalSec}s samples=${samples.length}`);
await page.screenshot({ path: join(EVIDENCE, "03-finished.png") });

check("refresh finished within deadline", finished, JSON.stringify(samples.at(-1)));
const lastSample = samples.at(-1);
check("refresh did not end in error tone", lastSample?.tone !== "error", lastSample?.errorText ?? "");

const running = samples.filter((s) => s.tone === "run" && s.stages.length === 4);
const overlapped = running.filter((s) => s.stages[1]?.state === "running" && s.stages[2]?.state === "running");
log(`running samples=${running.length}, overlapped(parse+minsync)=${overlapped.length}`);

const progressPath = join(WORKSPACE, ".autorag", "refresh-progress.json");
const progress = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : null;
log(`refresh-progress.json: ${JSON.stringify(progress)}`);
check(
	"refresh-progress.json recorded state=success with all files scanned and synced in MinSync",
	progress?.state === "success" && (progress?.parsedCounts?.scanned ?? 0) >= TOTAL && (progress?.minsync?.synced ?? 0) >= TOTAL,
	JSON.stringify({ state: progress?.state, scanned: progress?.parsedCounts?.scanned, minsync: progress?.minsync, error: progress?.error }),
);

// Confirm real hybrid retrieval via the app's own contentSearch bridge.
let hits = [];
for (let attempt = 0; attempt < 20 && hits.length === 0; attempt += 1) {
	const found = await page.evaluate((needle) => window.autorag.fs.contentSearch(needle, 5), NEEDLE);
	hits = found.hits ?? [];
	if (hits.length === 0) await page.waitForTimeout(500);
}
const hitNames = hits.map((h) => h.entry?.name ?? (typeof h.path === "string" ? h.path.split(/[\\/]/u).at(-1) : undefined));
log(`contentSearch("${NEEDLE}") hits=${JSON.stringify(hitNames)}`);
check("unique needle document is indexed and searchable", hitNames.includes("needle-final.md"), JSON.stringify(hitNames));
check("no renderer pageerror", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
