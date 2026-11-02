import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
/**
 * Manual QA — the Kind column shows the OS-detected kind (Finder's Kind).
 *
 * Drives the real production build (out/) via launchFinder and
 * reads the Kind cell for fixtures created in ~/Documents. The expected value
 * is taken straight from `/usr/bin/mdls` (polled until Spotlight answers, since
 * a brand-new file can briefly report no kind), so the assertion is the OS's
 * own answer, not a copy of the app's table. Evidence goes to
 * .omo/evidence/ai-finder-app/qa-os-kind/.
 *
 * Run from the repo root: `bun scripts/manual-qa/run-qa-finder-kind.mjs`
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-os-kind/`;
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const documents = `${homedir()}/Documents`;
const folderName = `ulw-kind-qa-${stamp}-dir`;
const fixtures = [
	{ name: `ulw-kind-qa-${stamp}.mp4`, value: "QA fixture\n", expect: "MPEG-4 movie" },
	{ name: `ulw-kind-qa-${stamp}.pdf`, value: "%PDF-1.4\n", expect: "PDF document" },
];
const fallbackName = `ulw-kind-qa-${stamp}.weird`;

const windowsKind = (path) => {
	// The same registry chain the app reads (src/main/file-kind.ts windowsKindQuery, which
	// batches many extensions into one process): extension → ProgID → the ProgID's own
	// (default) description, nothing else. This oracle stays one process per path on purpose,
	// so it does not share the app's batching. A FriendlyTypeName/raw-ProgID fallback would
	// expect strings the app never shows, and FriendlyTypeName is usually an unresolved
	// indirect string.
	const literal = path.replace(/'/g, "''");
	const script = [
		`$path = '${literal}'`,
		"$ext = [System.IO.Path]::GetExtension($path)",
		"if ([string]::IsNullOrEmpty($ext)) { return }",
		"$progId = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $ext) -ErrorAction SilentlyContinue).'(default)'",
		"if ([string]::IsNullOrEmpty($progId)) { return }",
		"$typeName = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $progId) -ErrorAction SilentlyContinue).'(default)'",
		"if (-not [string]::IsNullOrEmpty($typeName)) { [Console]::Out.Write($typeName) }",
	].join("; ");
	// argv array, not a shell string: backslashes in the registry path survive quoting.
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
	}).trim();
};
const mdlsKind = (path) => {
	try {
		if (process.platform === "win32") return windowsKind(path);
		return execSync(`/usr/bin/mdls -name kMDItemKind -raw ${JSON.stringify(path)}`, { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};

/** Spotlight reports no kind for a just-created file; wait for its answer. */
const osKindReady = async (path, timeoutMs = 10000) => {
	const start = Date.now();
	for (; ;) {
		const value = mdlsKind(path);
		if (value !== "" && value !== "(null)") return value;
		if (Date.now() - start > timeoutMs) return null;
		await Bun.sleep(250);
	}
};

const results = [];
const check = (label, actual, expected) => {
	const pass = actual === expected;
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: app=${JSON.stringify(actual)} os=${JSON.stringify(expected)}`);
};

mkdirSync(`${documents}/${folderName}`, { recursive: true });
for (const fixture of fixtures) await Bun.write(`${documents}/${fixture.name}`, fixture.value);
await Bun.write(`${documents}/${fallbackName}`, "unknown extension\n");

for (const fixture of fixtures) {
	const expected = await osKindReady(`${documents}/${fixture.name}`);
	if (expected === null) {
		// The OS probe could not answer (registry/Spotlight), so there is nothing
		// authoritative to compare the app against; skip rather than false-fail.
		fixture.skip = true;
		console.log(`SKIP  ${fixture.name}: the OS kind probe returned nothing; cannot assert`);
	}
	fixture.expected = expected ?? fixture.expect;
}

let app;
try {
	app = await launchFinder();
	let page = await finderWindow(app);
	await page.waitForSelector('[role="row"]', { timeout: 30000 });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();
	const rowFor = (name) => page.locator('[role="row"]').filter({ hasText: name }).first();
	// The folder's listing can land after the sidebar click, replacing whatever
	// the list showed: sweep it top to bottom, and sweep again until the row
	// mounts. One sweep that ends on the previous folder would otherwise leave
	// the list scrolled past a folder row sorted to the top.
	const mountRow = async (name) => {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			await page.locator(".list").evaluate((node) => {
				node.scrollTop = 0;
			});
			for (let attempt = 0; attempt < 160; attempt += 1) {
				if ((await rowFor(name).count()) > 0) return rowFor(name);
				const atEnd = await page.locator(".list").evaluate((node) => {
					node.scrollTop = node.scrollTop + node.clientHeight * 0.9;
					return node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
				});
				await page.waitForTimeout(25);
				// The target can sit in the last window: check after scrolling, before
				// the loop stops on `atEnd`.
				if ((await rowFor(name).count()) > 0) return rowFor(name);
				if (atEnd) break;
			}
			await page.waitForTimeout(250);
		}
		throw new Error(`row ${name} never mounted`);
	};
	await mountRow(fixtures[0].name);
	// The OS kind now lands through background enrichment, and rows mount
	// through virtualization: mount each row and poll until its Kind cell shows
	// the OS's own answer.
	const kindCell = async (name) => {
		await mountRow(name);
		const cells = await page
			.locator('[role="row"]')
			.filter({ hasText: name })
			.first()
			.locator('[role="gridcell"]')
			.allInnerTexts();
		return cells[3]?.trim() ?? "";
	};
	const kindCellReady = async (name, expected, timeoutMs = 15000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await kindCell(name);
			if (value === expected || Date.now() >= deadline) return value;
			await page.waitForTimeout(100);
		}
	};

	const observed = [];
	for (const fixture of fixtures) {
		const kind = await kindCellReady(fixture.name, fixture.expected);
		observed.push({ name: fixture.name, kind });
		if (fixture.skip === true) continue;
		check(fixture.name, kind, fixture.expected);
	}
	/** Read a Kind cell once the row is mounted and its cell has text. */
	const kindCellFilled = async (name, timeoutMs = 15000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const value = await kindCell(name);
			if (value !== "" || Date.now() >= deadline) return value;
			await page.waitForTimeout(100);
		}
	};
	const fallbackKind = await kindCellFilled(fallbackName);
	observed.push({ name: fallbackName, kind: fallbackKind });
	results.push({ label: fallbackName, actual: fallbackKind, expected: "non-empty fallback", pass: fallbackKind !== "" });
	console.log(`${fallbackKind !== "" ? "PASS" : "FAIL"}  ${fallbackName}: app=${JSON.stringify(fallbackKind)} (fallback row, non-empty)`);

	const folderKind = await kindCellFilled(folderName);
	observed.push({ name: folderName, kind: folderKind });
	check(folderName, folderKind, "Folder");

	check(`${fixtures[0].name} is not Markdown`, observed[0].kind === "Markdown" ? "Markdown" : "not-Markdown", "not-Markdown");

	const row = await mountRow(fixtures[0].name);
	await page.screenshot({ path: `${EVIDENCE}/documents-list.png` });
	await row.screenshot({ path: `${EVIDENCE}/mp4-row.png` });
	await Bun.write(
		`${EVIDENCE}/result.json`,
		JSON.stringify({ platform: process.platform, checks: results, observedRows: observed }, null, 2),
	);
} finally {
	if (app !== undefined) await app.close();
	for (const fixture of fixtures) await rm(`${documents}/${fixture.name}`, { force: true });
	await rm(`${documents}/${fallbackName}`, { force: true });
	await rm(`${documents}/${folderName}`, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
