/**
 * One-command QA sweep for macOS and Windows.
 *
 * Runs the real-Electron lanes sequentially, captures each lane's combined
 * stdout/stderr to `.omo/evidence/<lane>.log`, and writes a JSON summary. A lane
 * fails on a non-zero exit code, a "FAIL " line in its output, or a timeout.
 * The scripts themselves are platform-aware via `./platform.mjs`; this runner
 * adds only the surrounding process management.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-all.mjs            # whole sweep
 *   bun scripts/manual-qa/run-all.mjs live-sync kind   # selected lanes
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWindows, repoRoot, sh } from "./platform.mjs";

const ROOT = repoRoot(import.meta.url);
const OUT = process.env.QA_OUT ?? join(ROOT, ".omo", "evidence", "win-qa");

/**
 * The lanes that must pass on Windows (issue #57 acceptance). Names match the
 * `run-qa-finder-*` scripts; `timeout` is seconds.
 */
const LANES = [
	{ name: "dev-label", script: "run-qa-finder-dev-label.mjs", timeout: 180 },
	{ name: "shortcut-hints", script: "run-qa-finder-shortcut-hints.mjs", timeout: 180 },
	{ name: "view-modes", script: "run-qa-finder-view-modes.mjs", timeout: 240 },
	{ name: "sort", script: "run-qa-finder-sort.mjs", timeout: 240 },
	{ name: "folder-tree", script: "run-qa-finder-folder-tree.mjs", timeout: 240 },
	{ name: "recents", script: "run-qa-finder-recents.mjs", timeout: 300 },
	{ name: "thumbnails", script: "run-qa-finder-thumbnails.mjs", timeout: 240 },
	{ name: "thumbnail-scroll", script: "run-qa-finder-thumbnail-scroll.mjs", timeout: 300 },
	{ name: "live-sync", script: "run-qa-finder-live-sync.mjs", timeout: 300 },
	{ name: "sidebar-search", script: "run-qa-finder-sidebar-search.mjs", timeout: 240 },
	{ name: "path-bar", script: "run-qa-finder-path-bar.mjs", timeout: 300 },
	{ name: "kind", script: "run-qa-finder-kind.mjs", timeout: 240 },
	{ name: "info-metadata", script: "run-qa-finder-info-metadata.mjs", timeout: 240 },
	{ name: "file-actions", script: "run-qa-finder-file-actions.mjs", timeout: 300 },
	{ name: "nav-guard", script: "run-qa-finder-nav-guard.mjs", timeout: 240 },
	{ name: "dupey-cache", script: "run-qa-finder-dupey-cache.mjs", timeout: 300 },
	{ name: "trash-prune", script: "run-qa-finder-trash-prune.mjs", timeout: 300 },
	{ name: "evidence-panel", script: "run-qa-finder-evidence-panel.mjs", timeout: 300 },
	{ name: "datasource-status", script: "run-qa-finder-datasource-status.mjs", timeout: 240 },
	{ name: "models-status", script: "run-qa-finder-models-status.mjs", timeout: 240 },
	{ name: "global-appearance", script: "run-qa-global-appearance.mjs", timeout: 300 },
	{ name: "quick-look-reference", script: "run-qa-quick-look-reference.mjs", timeout: 420 },
];

/** Kill any Electron left behind by a timed-out lane so the next one starts clean. */
function reapElectron() {
	if (isWindows) sh("taskkill /F /IM electron.exe /T");
	else sh("pkill -f 'electron .'");
}

/** Run one lane to completion or its deadline; resolves with its result. */
function runLane(lane) {
	return new Promise((resolve) => {
		const started = Date.now();
		const child = spawn("bun", [join("scripts", "manual-qa", lane.script)], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => (output += chunk));
		child.stderr.on("data", (chunk) => (output += chunk));
		const timer = setTimeout(() => {
			reapElectron();
			child.kill("SIGKILL");
		}, lane.timeout * 1000);
		child.on("close", (code) => {
			clearTimeout(timer);
			const timedOut = Date.now() - started >= lane.timeout * 1000;
			const failures = output.split("\n").filter((line) => line.startsWith("FAIL "));
			resolve({
				name: lane.name,
				script: lane.script,
				exit: code,
				timedOut,
				failures: failures.length,
				seconds: Math.round((Date.now() - started) / 1000),
				output,
			});
		});
	});
}

async function main() {
	mkdirSync(OUT, { recursive: true });
	const only = process.argv.slice(2);
	const lanes = only.length === 0 ? LANES : LANES.filter((lane) => only.includes(lane.name));
	if (lanes.length === 0) {
		console.error(`No lane matched: ${only.join(", ")}`);
		process.exitCode = 1;
		return;
	}

	const summary = [];
	for (const lane of lanes) {
		process.stdout.write(`=== ${lane.name} ===\n`);
		const result = await runLane(lane);
		writeFileSync(join(OUT, `${lane.name}.log`), result.output);
		reapElectron();
		const ok = !result.timedOut && result.exit === 0 && result.failures === 0;
		process.stdout.write(
			`--- ${lane.name}: ${ok ? "PASS" : "FAIL"} (exit=${result.exit ?? "?"}${result.timedOut ? " timeout" : ""}, ${result.failures} FAIL lines, ${result.seconds}s)\n`,
		);
		summary.push({ name: lane.name, ok, exit: result.exit, timedOut: result.timedOut, failures: result.failures, seconds: result.seconds });
		// Keep `output` out of the JSON summary; it is already in the lane log.
		delete result.output;
	}

	writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	const failed = summary.filter((lane) => !lane.ok);
	process.stdout.write(`QA_SWEEP_DONE ${summary.length - failed.length}/${summary.length} passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

await main();
