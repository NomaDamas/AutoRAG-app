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
	{ name: "video-thumbnails", script: "run-qa-finder-video-thumbnails.mjs", timeout: 300 },
	{ name: "thumbnail-scroll", script: "run-qa-finder-thumbnail-scroll.mjs", timeout: 300 },
	{ name: "live-sync", script: "run-qa-finder-live-sync.mjs", timeout: 900 },
	{ name: "sidebar-search", script: "run-qa-finder-sidebar-search.mjs", timeout: 240 },
	{ name: "search-system-folders", script: "run-qa-finder-search-system-folders.mjs", timeout: 240 },
	{ name: "path-bar", script: "run-qa-finder-path-bar.mjs", timeout: 300 },
	{ name: "kind", script: "run-qa-finder-kind.mjs", timeout: 240 },
	{ name: "app-bundles", script: "run-qa-finder-app-bundles.mjs", timeout: 300 },
	{ name: "info-metadata", script: "run-qa-finder-info-metadata.mjs", timeout: 240 },
	{ name: "file-actions", script: "run-qa-finder-file-actions.mjs", timeout: 300 },
	{ name: "convert-rename", script: "run-qa-finder-convert-rename.mjs", timeout: 480 },
	{ name: "context-menu", script: "run-qa-finder-context-menu.mjs", timeout: 300 },
	{ name: "new-file", script: "run-qa-finder-new-file.mjs", timeout: 300 },
	{ name: "native-drag-out", script: "run-qa-finder-drag-out.mjs", timeout: 300 },
	{ name: "external-drop", script: "run-qa-finder-external-drop.mjs", timeout: 300 },
	{ name: "share", script: "run-qa-finder-share.mjs", timeout: 300 },
	{ name: "nav-guard", script: "run-qa-finder-nav-guard.mjs", timeout: 240 },
	{ name: "no-console-flash", script: "run-qa-finder-no-console-flash.mjs", timeout: 300 },
	{ name: "dupey-cache", script: "run-qa-finder-dupey-cache.mjs", timeout: 600 },
	{ name: "trash-prune", script: "run-qa-finder-trash-prune.mjs", timeout: 480 },
	{ name: "trash-restore", script: "run-qa-finder-trash-restore.mjs", timeout: 480 },
	{ name: "undo-history", script: "run-qa-finder-undo-history.mjs", timeout: 480 },
	{ name: "evidence-panel", script: "run-qa-finder-evidence-panel.mjs", timeout: 300 },
	{ name: "evidence-folder", script: "run-qa-finder-evidence-folder.mjs", timeout: 300 },
	{ name: "split-panes", script: "run-qa-finder-split-panes.mjs", timeout: 300 },
	{ name: "ai-search-images", script: "run-qa-finder-ai-search-images.mjs", timeout: 300 },
	{ name: "ai-search-table", script: "run-qa-finder-ai-search-table.mjs", timeout: 300 },
	{ name: "ai-search-links", script: "run-qa-finder-ai-search-links.mjs", timeout: 300 },
	{ name: "ai-search-code", script: "run-qa-finder-ai-search-code.mjs", timeout: 300 },
	{ name: "ai-search-steer", script: "run-qa-finder-ai-search-steer.mjs", timeout: 300 },
	{ name: "ai-search-follow-up", script: "run-qa-finder-ai-search-follow-up.mjs", timeout: 300 },
	{ name: "automations", script: "run-qa-finder-automations.mjs", timeout: 420 },
	{ name: "datasource-status", script: "run-qa-finder-datasource-status.mjs", timeout: 240 },
	{ name: "models-status", script: "run-qa-finder-models-status.mjs", timeout: 240 },
	{ name: "settings-redesign", script: "run-qa-settings-redesign.mjs", timeout: 300 },
	{ name: "settings-open-latency", script: "run-qa-settings-open-latency.mjs", timeout: 240 },
	{ name: "refresh-schedule", script: "run-qa-refresh-schedule.mjs", timeout: 300 },
	{ name: "global-appearance", script: "run-qa-global-appearance.mjs", timeout: 300 },
	{ name: "quick-look-reference", script: "run-qa-quick-look-reference.mjs", timeout: 420 },
	{ name: "quick-look-data", script: "run-qa-quick-look-data.mjs", timeout: 300 },
	{ name: "quick-look-mail", script: "run-qa-quick-look-mail.mjs", timeout: 300 },
	{ name: "quick-look-heic", script: "run-qa-quick-look-heic.mjs", timeout: 240 },
	{ name: "quick-look-tiff", script: "run-qa-quick-look-tiff.mjs", timeout: 240 },
	{ name: "quick-look-legacy-office", script: "run-qa-quick-look-legacy-office.mjs", timeout: 240 },
	{ name: "quick-look-sheet-large", script: "run-qa-quick-look-sheet-large.mjs", timeout: 240 },
	{ name: "quick-look-csv-korean", script: "run-qa-quick-look-csv-korean.mjs", timeout: 240 },
	{ name: "fs-worker-crash", script: "run-qa-finder-fs-worker-crash.mjs", timeout: 180 },
	{ name: "quit-clean", script: "run-qa-finder-quit-clean.mjs", timeout: 600 },
	{ name: "onboarding", script: "run-qa-onboarding.mjs", timeout: 900 },
	{ name: "onboarding-language", script: "run-qa-onboarding-language.mjs", timeout: 900 },
	{ name: "local-embedding-spec", script: "run-qa-local-embedding-spec.mjs", timeout: 900 },
	{ name: "analytics", script: "run-qa-analytics.mjs", timeout: 600 }
];

/**
 * Kill one lane's own process tree (its bun process and the Electron it
 * launched). Never kills by image name: a developer (or CI) may be running
 * other Electron apps alongside the sweep.
 */
function reapLane(pid) {
	if (isWindows) sh(`taskkill /F /T /PID ${pid}`);
	else {
		sh(`pkill -P ${pid}`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone.
		}
	}
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
			if (child.pid !== undefined) reapLane(child.pid);
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
		const ok = !result.timedOut && result.exit === 0 && result.failures === 0;
		summary.push({ name: lane.name, ok, exit: result.exit, timedOut: result.timedOut, failures: result.failures, seconds: result.seconds });
		// Written per lane: a later lane's timeout (or a job-level cancel) must
		// not lose the results gathered so far.
		writeFileSync(join(OUT, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
		process.stdout.write(
			`--- ${lane.name}: ${ok ? "PASS" : "FAIL"} (exit=${result.exit ?? "?"}${result.timedOut ? " timeout" : ""}, ${result.failures} FAIL lines, ${result.seconds}s)\n`,
		);
	}

const failed = summary.filter((lane) => !lane.ok);
	process.stdout.write(`QA_SWEEP_DONE ${summary.length - failed.length}/${summary.length} passed\n`);
	if (failed.length > 0) process.exitCode = 1;
}

await main();
