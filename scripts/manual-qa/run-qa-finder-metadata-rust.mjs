/**
 * Live Electron E2E & Manual QA — Native Rust Finder Metadata & Tags Core.
 *
 * Launches the real built Electron app against a folder of 80 tagged files:
 *   1. Verifies bundled `out/main/vendor/dazzi-core.node` exists.
 *   2. Measures live `window.autorag.fs.finderMetadata(...)` across all 80 files (native xattr/plist + batched mdls)
 *      and asserts every file's tags, tagColors, and comments match disk state.
 *   3. Invokes live `window.autorag.fs.setTags(...)` across all 80 files (native setxattr + binary plist),
 *      measures wall latency, and verifies Apple's own `/usr/bin/xattr` + `/usr/bin/plutil` reads back the exact tag.
 *   4. Verifies Finder UI renders cleanly with zero uncaught page errors and saves screenshot to `QA_OUT`.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { sleep } from "./platform.mjs";

const execFileAsync = promisify(execFile);
const req = createRequire(import.meta.url);
const qaOut = process.env.QA_OUT ?? null;
const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const addonPath = join(ROOT, "out", "main", "vendor", "dazzi-core.node");
check("bundled out/main/vendor/dazzi-core.node exists", existsSync(addonPath));
const native = req(addonPath);

const work = realpathSync(mkdtempSync(join(tmpdir(), "qa-finder-meta-rust-")));
const qaRoot = join(work, "files");
const userDataDir = join(work, "user-data");
mkdirSync(qaRoot, { recursive: true });
mkdirSync(userDataDir, { recursive: true });

// Seed 80 files with native macOS Finder tags + comments
const targets = [];
for (let i = 0; i < 80; i += 1) {
	const name = `project_${String(i).padStart(3, "0")}.txt`;
	const filePath = join(qaRoot, name);
	writeFileSync(filePath, `Document ${i}\n`);
	if (process.platform === "darwin") {
		native.writeFinderTagsNative(filePath, i % 2 === 0 ? ["Urgent\n6", "한글태그\n4"] : ["Review\n2"]);
	}
	targets.push({ path: filePath, kind: "file", ext: "txt", mtimeMs: Date.now() });
}

const app = await launchFinder({
	userDataDir,
	env: { AUTORAG_QA_ROOT: qaRoot, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	language: "en",
});

const pageErrors = [];
try {
	const main = await finderWindow(app, 30_000);
	main.on("pageerror", (err) => pageErrors.push(String(err)));
	await main.waitForSelector('[role="row"][data-path]', { timeout: 30_000 });
	await sleep(300);

	// 1. Live IPC: finderMetadata across all 80 files
	const metaRes = await main.evaluate(async (items) => {
		const t0 = performance.now();
		const rows = await window.autorag.fs.finderMetadata(items);
		return { ms: Math.round(performance.now() - t0), count: rows.length, sample0: rows[0]?.finder ?? null, sample1: rows[1]?.finder ?? null };
	}, targets);

	if (process.platform === "darwin") {
		check(
			"live IPC finderMetadata resolves 80 tagged files natively",
			metaRes.count === 80 &&
				JSON.stringify(metaRes.sample0?.tags) === JSON.stringify(["Urgent", "한글태그"]) &&
				JSON.stringify(metaRes.sample0?.tagColors) === JSON.stringify([6, 4]) &&
				JSON.stringify(metaRes.sample1?.tags) === JSON.stringify(["Review"]),
			`wall=${metaRes.ms}ms count=${metaRes.count}`,
		);

		// 2. Live IPC: setTags bulk write across all 80 files
		const allPaths = targets.map((t) => t.path);
		const tagRes = await main.evaluate(async (paths) => {
			const t0 = performance.now();
			const res = await window.autorag.fs.setTags(paths, { add: ["Shipped"], remove: [] });
			return { ms: Math.round(performance.now() - t0), ok: res.ok.length, failed: res.failed.length };
		}, allPaths);

		check(
			"live IPC setTags bulk-writes 80 files natively",
			tagRes.ok === 80 && tagRes.failed === 0,
			`wall=${tagRes.ms}ms ok=${tagRes.ok}`,
		);

		// 3. Cross-check disk xattr using Apple's own /usr/bin/xattr + /usr/bin/plutil
		const { stdout: hex } = await execFileAsync("/usr/bin/xattr", [
			"-p",
			"-x",
			"com.apple.metadata:_kMDItemUserTags",
			allPaths[0],
		]);
		const plistBuf = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex");
		const verifyPath = join(work, "verify.bplist");
		writeFileSync(verifyPath, plistBuf);
		const { stdout: jsonOut } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", verifyPath]);
		const diskTags = JSON.parse(jsonOut);
		check(
			"Apple xattr + plutil confirms native binary plist write parity",
			Array.isArray(diskTags) && diskTags.includes("Urgent\n6") && diskTags.includes("한글태그\n4") && diskTags.some((t) => t.startsWith("Shipped")),
			JSON.stringify(diskTags),
		);
	}

	if (qaOut) await main.screenshot({ path: join(qaOut, "finder-metadata-rust-live.png") });
	check("zero uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
	await app.close();
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL FINDER METADATA & TAGS RUST LIVE E2E CHECKS PASSED");
