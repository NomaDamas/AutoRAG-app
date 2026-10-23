import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, finderWindow } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

// Opening Settings must not wait for the datasource scan. Each backend CLI
// (slacrawl, discrawl, ...) is asked what it holds, and a real one takes a few
// hundred milliseconds, so several connections made the page sit on "Loading"
// for seconds. Here every fake CLI sleeps SLOW_MS: the page has to be usable
// long before the scan can finish, say "Checking…" instead of "no data sources"
// while it runs, and show the counts once it has.
// Runs against a throwaway AUTORAG_HOME. Production build first: bun run build
const EVIDENCE = fileURLToPath(new URL("../../.omo/evidence/settings-open-latency/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });

const SLOW_MS = 1500;
// Backend CLIs the scan runs one after another per binary; these are three different binaries (three lanes).
const FAKE_CLIS = [
	{ id: "slack", binary: "slacrawl", output: { messages: 179, last_sync_at: "2026-10-08T04:52:09Z" } },
	{ id: "discord", binary: "discrawl", output: { last_sync_at: "2026-08-16T09:12:29Z", counts: [{ id: "messages", value: 3536 }] } },
	{ id: "telegram", binary: "telecrawl", output: { messages: 976, last_import_at: "2026-09-22T01:04:28Z" } },
];

const IS_WIN = process.platform === "win32";
if (IS_WIN) {
	console.log("SKIP: the fake backend CLIs are POSIX shell scripts");
	process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "autorag-qa-open-latency-"));
const workspace = join(root, "workspace");
const bin = join(root, "bin");
const configPath = join(root, "config.json");
mkdirSync(join(workspace, "docs"), { recursive: true });
mkdirSync(bin, { recursive: true });
for (const cli of FAKE_CLIS) {
	writeFileSync(join(bin, cli.binary), `#!/bin/sh\nsleep ${SLOW_MS / 1000}\nprintf '%s\\n' '${JSON.stringify(cli.output)}'\n`);
	chmodSync(join(bin, cli.binary), 0o755);
}
writeFileSync(configPath, `${JSON.stringify({
	searchPaths: [join(workspace, "docs")],
	workspacePath: workspace,
	minSync: { enabled: true },
	jikji: false,
	datasources: Object.fromEntries(FAKE_CLIS.map((cli) => [cli.id, {}])),
}, null, 2)}\n`);

const env = { AUTORAG_CONFIG: configPath, AUTORAG_HOME: root, PATH: `${bin}:/usr/bin:/bin`, GITHUB_TOKEN: "", AUTORAG_SKIP_DUPEY_CHECK: "1" };

const fails = [];
const check = (name, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` — ${detail}`}`);
	if (!ok) fails.push(name);
};

const app = await launchFinder({ userDataDir: join(root, "user-data"), env });
try {
	const page = await finderWindow(app);
	await page.waitForSelector('[role="row"]');
	// Let the shell's own startup scan finish so it cannot share the CLIs' per-binary lanes with the page under test.
	await page.waitForTimeout(SLOW_MS + 1500);

	const clickedAt = Date.now();
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector('select[aria-label="Appearance"]', { timeout: SLOW_MS });
	const usableMs = Date.now() - clickedAt;
	check("General page is usable before the slow scan can finish", usableMs < SLOW_MS, `${usableMs} ms (scan needs >= ${SLOW_MS} ms)`);
	check("sidebar lists every configured connection at once", (await page.locator(".settings-nav-item--source").count()) === FAKE_CLIS.length);
	await page.screenshot({ path: join(EVIDENCE, "01-general-scan-running.png") });

	await page.locator(".settings-nav-item:not(.settings-nav-item--source)", { hasText: "Indexing" }).first().click();
	const pending = await page.locator(".settings-content-wrap").innerText();
	check("Indexing says Checking… while the scan runs", pending.includes("Checking…"));
	check("Indexing never claims there are no data sources while the scan runs", !pending.includes("No data sources connected"));
	await page.screenshot({ path: join(EVIDENCE, "02-indexing-checking.png") });

	await page.waitForFunction(() => document.querySelectorAll(".settings-sync-row").length === 4, null, { timeout: 30_000 });
	const settled = await page.locator(".settings-content-wrap").innerText();
	check("counts appear once the scan finishes", settled.includes("179 messages") && settled.includes("3,536 messages") && settled.includes("976 messages"));
	check("Checking… is gone once the scan finishes", !settled.includes("Checking…"));
	await page.screenshot({ path: join(EVIDENCE, "03-indexing-counts.png") });

	await page.locator('.settings-nav-item--source[data-source-alias="slack"]').click();
	await page.waitForSelector('.settings-source[data-source-id="slack"]');
	const update = page.getByRole("button", { name: "Update now" });
	check("a connection's Update button works once its state is known", await update.isEnabled());
} finally {
	await app.close();
	rmRetry(root);
}

if (fails.length > 0) {
	console.log("FAIL:", fails);
	process.exitCode = 1;
} else {
	console.log(`PASS: Settings opens without waiting for the datasource scan — evidence in ${EVIDENCE}`);
}
