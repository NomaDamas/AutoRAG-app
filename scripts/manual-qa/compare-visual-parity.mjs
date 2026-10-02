/**
 * Manual QA — compare two `run-qa-finder-visual-parity.mjs` output directories.
 *
 * Byte-identical PNGs pass outright. Anything else is measured with ffmpeg's
 * SSIM filter (1.0 = identical) and written out as a difference image next to
 * the "after" file, so a regression is visible rather than asserted.
 *
 *   bun scripts/manual-qa/compare-visual-parity.mjs <beforeDir> <afterDir> [--threshold 0.999]
 *
 * Exits non-zero when any screenshot falls below the threshold.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [beforeDir, afterDir] = process.argv.slice(2);
if (beforeDir === undefined || afterDir === undefined) {
	console.error("usage: bun scripts/manual-qa/compare-visual-parity.mjs <beforeDir> <afterDir> [--threshold 0.999]");
	process.exit(1);
}

const thresholdIndex = process.argv.indexOf("--threshold");
const threshold = thresholdIndex === -1 ? 0.999 : Number(process.argv[thresholdIndex + 1]);

const manifest = JSON.parse(readFileSync(join(beforeDir, "manifest.json"), "utf8"));
const rows = [];

const ffmpeg = async (args) => {
	const process_ = Bun.spawn(["ffmpeg", "-hide_banner", "-nostdin", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(process_.stdout).text(),
		new Response(process_.stderr).text(),
	]);
	await process_.exited;
	return `${stdout}${stderr}`;
};

for (const name of manifest.shots) {
	const before = join(beforeDir, `${name}.png`);
	const after = join(afterDir, `${name}.png`);
	if (!existsSync(before) || !existsSync(after)) {
		rows.push({ name, status: "MISSING", ssim: null });
		continue;
	}
	const beforeBytes = readFileSync(before);
	const afterBytes = readFileSync(after);
	if (beforeBytes.equals(afterBytes)) {
		rows.push({ name, status: "IDENTICAL", ssim: 1 });
		continue;
	}
	const output = await ffmpeg(["-i", before, "-i", after, "-lavfi", "ssim", "-f", "null", "-"]);
	const match = /All:\s*([0-9.]+)/.exec(output);
	const ssim = match === null ? null : Number(match[1]);
	const diff = join(afterDir, `${name}.diff.png`);
	await ffmpeg(["-y", "-i", before, "-i", after, "-lavfi", "blend=all_mode=difference", diff]);
	rows.push({
		name,
		status: ssim === null ? "INCOMPARABLE" : ssim >= threshold ? "WITHIN-TOLERANCE" : "REGRESSED",
		ssim,
		diff,
	});
}

const width = Math.max(...rows.map((row) => row.name.length));
for (const row of rows) {
	const score = row.ssim === null ? "n/a" : row.ssim.toFixed(6);
	const suffix = row.diff === undefined ? "" : `  diff: ${row.diff}`;
	console.log(`${row.status.padEnd(16)} ${row.name.padEnd(width)}  ssim=${score}${suffix}`);
}

const failed = rows.filter((row) => row.status !== "IDENTICAL" && row.status !== "WITHIN-TOLERANCE");
console.log(`\n${rows.length - failed.length}/${rows.length} within tolerance (threshold ${threshold})`);
if (failed.length > 0) process.exitCode = 1;
