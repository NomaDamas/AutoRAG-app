// A small, fake home for `make onboarding-skip-index`: four ordinary documents (a duplicate pair, a checklist, meeting
// notes) that are copied into the sandbox and indexed there ahead of time with the real librarian refresh. Nothing in the
// app knows about it: the first run scans, plans, indexes (an incremental no-op by then), builds the tour question with a
// model, and AI Search answers from the real index, exactly as on a machine with these four files.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = join(ROOT, "scripts", "onboarding-fixture", "home");
const DEFAULT_FOLDERS = ["Desktop", "Documents", "Downloads"];

/** How much older than "now" each file is, so the `(최종)` plan is always the newest head of the duplicate pair. */
const AGE_SECONDS = {
	"Documents/2026-3분기-사업기획안.md": 3600,
	"Documents/11월-출시-체크리스트.md": 1800,
	"Desktop/주간-회의록-요약.txt": 900,
	"Documents/2026-3분기-사업기획안 (최종).md": 0,
};

/** Copy the fixture documents into `home` (which becomes the sandbox's Desktop/Documents/Downloads) and date them. */
export function seedFixtureHome(home) {
	mkdirSync(home, { recursive: true });
	cpSync(FIXTURE, home, { recursive: true, force: true });
	for (const folder of DEFAULT_FOLDERS) mkdirSync(join(home, folder), { recursive: true });
	const now = Math.floor(Date.now() / 1000);
	for (const [relative, age] of Object.entries(AGE_SECONDS)) utimesSync(join(home, relative), now - age, now - age);
}

/**
 * Write the sandbox's AutoRAG config and index the fixture with the librarian's own refresh, the keyword-only one the
 * first run runs (parsed mirror + MinSync's SPLADE encoder). The first run then finds everything indexed and only
 * re-checks it. Throws with the CLI's own message when the refresh fails.
 */
export function preindexFixture({ fixtureHome, autoragHome, configPath, minsyncCache }) {
	const cli = join(ROOT, ".upstream", "autorag", "dist", "cli", "index.js");
	if (!existsSync(cli)) throw new Error(`the librarian CLI is not built at ${cli}; run \`make setup\``);
	const workspace = join(autoragHome, "workspace");
	mkdirSync(workspace, { recursive: true });
	const config = {
		workspacePath: workspace,
		searchPaths: DEFAULT_FOLDERS.map((folder) => join(fixtureHome, folder)),
		minSync: { enabled: true, embedder: { id: "none" } },
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`);
	const result = spawnSync("node", [cli, "refresh", "--json", "--method", "parsed,minsync"], {
		encoding: "utf8",
		timeout: 300_000,
		env: { ...process.env, AUTORAG_HOME: autoragHome, AUTORAG_CONFIG: configPath, AUTORAG_WORKSPACE: workspace, FASTEMBED_CACHE_DIR: minsyncCache },
	});
	if (result.status !== 0) throw new Error(`indexing the fixture failed (exit ${String(result.status)}): ${(result.stderr || result.stdout || "").slice(-600)}`);
}
