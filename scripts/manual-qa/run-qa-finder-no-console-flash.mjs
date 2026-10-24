/**
 * Manual QA — entering and leaving folders never flashes a console window.
 *
 * On Windows the Kind column asks PowerShell for each new extension's type, and
 * a console program started without `windowsHide` makes the OS flash a black
 * console window. This lane drives the real production build (out/) with real
 * clicks: it double-clicks into folders whose files carry extensions the app
 * has never seen (each one forces a fresh lookup), goes Back out, and repeats.
 * A watcher process polls the desktop for visible console windows
 * (`ConsoleWindowClass`, Windows Terminal's `CASCADIA_HOSTING_WINDOW_CLASS`)
 * that did not exist when it started and reports every one it sees.
 *
 * The watcher is proven first: a console program started the way the app used
 * to start its helpers (detached, no hidden window) must be caught, otherwise
 * the lane fails as "blind" rather than passing on silence.
 *
 * On macOS and Linux there is no console window; the lane still checks that the
 * navigation works and the Kind cells fill, and the window watch is skipped.
 *
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-no-console-flash.mjs
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { homeEnv, isWindows, repoRoot, rmRetry, sleep } from "./platform.mjs";

const ROOT = repoRoot(import.meta.url);
const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo", "evidence", "ai-finder-app", "qa-no-console-flash");
mkdirSync(EVIDENCE, { recursive: true });

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `: ${detail}`}`);
};

const WATCHER = `
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ConsoleWatch {
	delegate bool EnumProc(IntPtr h, IntPtr l);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	public static List<string> Scan() {
		var found = new List<string>();
		EnumWindows((h, l) => {
			if (!IsWindowVisible(h)) return true;
			var name = new StringBuilder(256);
			GetClassName(h, name, 256);
			var cls = name.ToString();
			if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS") {
				uint pid; GetWindowThreadProcessId(h, out pid);
				found.Add(h.ToInt64() + " " + cls + " " + pid);
			}
			return true;
		}, IntPtr.Zero);
		return found;
	}
}
"@
$known = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($entry in [ConsoleWatch]::Scan()) { [void]$known.Add($entry.Split(' ')[0]) }
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
	foreach ($entry in [ConsoleWatch]::Scan()) {
		$handle = $entry.Split(' ')[0]
		if ($known.Add($handle)) { [Console]::Out.WriteLine('HIT ' + $entry); [Console]::Out.Flush() }
	}
	Start-Sleep -Milliseconds 5
}
`;

/** Starts the window watcher; resolves with its hit list once it has taken its baseline. */
async function startWatcher(dir) {
	const script = join(dir, "console-watch.ps1");
	writeFileSync(script, WATCHER);
	const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], {
		windowsHide: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	const hits = [];
	let ready = false;
	let buffer = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		const lines = buffer.split(/\r?\n/u);
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line === "READY") ready = true;
			else if (line.startsWith("HIT ")) hits.push(line.slice(4));
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const deadline = Date.now() + 60_000;
	while (!ready) {
		if (Date.now() > deadline || child.exitCode !== null) throw new Error(`console watcher did not start: ${stderr}`);
		await sleep(100);
	}
	return { hits, stop: () => child.kill() };
}

const work = mkdtempSync(join(tmpdir(), "autorag-qa-console-"));
const home = join(work, "home");
const documents = join(home, "Documents");
const FOLDERS = 4;
const fixtureFiles = (folder) => [`a.qa${folder}x`, `b.qa${folder}y`];
for (let folder = 1; folder <= FOLDERS; folder += 1) {
	mkdirSync(join(documents, `dir-${folder}`), { recursive: true });
	for (const name of fixtureFiles(folder)) writeFileSync(join(documents, `dir-${folder}`, name), "fixture\n");
}

let app;
let watcher;
try {
	if (isWindows) {
		watcher = await startWatcher(work);
		// Positive control: a console program started without a hidden window must be seen.
		const control = spawn("cmd.exe", ["/c", "ping -n 4 127.0.0.1 >nul"], { detached: true, stdio: "ignore" });
		control.unref();
		const seenBy = Date.now() + 5000;
		while (watcher.hits.length === 0 && Date.now() < seenBy) await sleep(50);
		check("the watcher sees a console window that is not hidden", watcher.hits.length > 0, watcher.hits.join("; "));
		await sleep(4000);
	} else {
		console.log("SKIP  console window watch: only Windows shows console windows for helper processes");
	}
	const controlHits = watcher?.hits.length ?? 0;

	app = await launchFinder({ env: homeEnv(home) });
	const page = await finderWindow(app, 30_000);
	await page.waitForSelector('[role="row"]', { timeout: 30_000 });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();

	for (let round = 0; round < 2; round += 1) {
		for (let folder = 1; folder <= FOLDERS; folder += 1) {
			const name = `dir-${folder}`;
			const row = page.locator('[role="row"]').filter({ hasText: name }).first();
			await row.waitFor({ timeout: 30_000 });
			await row.dblclick();
			await page.waitForFunction((title) => document.querySelector(".toolbar-title")?.textContent === title, name, { timeout: 30_000 });
			const [first] = fixtureFiles(folder);
			const fileRow = page.locator('[role="row"]').filter({ hasText: first }).first();
			await fileRow.waitFor({ timeout: 30_000 });
			// The Kind cell fills once the OS lookup returns: the lookup has run when it has text.
			const deadline = Date.now() + 30_000;
			let kind = "";
			while (kind === "" && Date.now() < deadline) {
				kind = ((await fileRow.locator('[role="gridcell"]').allInnerTexts())[3] ?? "").trim();
				if (kind === "") await sleep(100);
			}
			if (round === 0) check(`${name}/${first} shows a Kind`, kind !== "", JSON.stringify(kind));
			await page.getByLabel("Back").click();
			await page.waitForFunction((title) => document.querySelector(".toolbar-title")?.textContent !== title, name, { timeout: 30_000 });
		}
	}
	await sleep(1000);
	await page.screenshot({ path: join(EVIDENCE, "documents.png") });

	if (watcher !== undefined) {
		const flashes = watcher.hits.slice(controlHits);
		check("entering and leaving folders flashed no console window", flashes.length === 0, flashes.join("; "));
	}
} catch (error) {
	check("lane ran to completion", false, error instanceof Error ? error.message : String(error));
} finally {
	watcher?.stop();
	if (app !== undefined) await app.close().catch(() => undefined);
	try {
		rmRetry(work);
	} catch {
		rmSync(work, { recursive: true, force: true });
	}
}

await Bun.write(join(EVIDENCE, "result.json"), JSON.stringify({ platform: process.platform, checks: results }, null, 2));
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
