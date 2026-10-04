/**
 * Manual QA — the persisted Light/Dark appearance controls Finder and Quick Look.
 *
 * Run after `bun run build`:
 *   bun scripts/manual-qa/run-qa-global-appearance.mjs [evidence-dir]
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const evidence = process.argv[2] ?? "/tmp/autorag-global-appearance";
mkdirSync(evidence, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-appearance-root-"));
const userDataDir = mkdtempSync(join(tmpdir(), "autorag-appearance-data-"));
const file = join(root, "appearance.md");
writeFileSync(file, "# Global appearance\n\nThis file stays loaded while the theme changes.\n");

const results = [];
const check = (label, pass, detail = "") => {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
};
const poll = async (read, accept, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
};

let app;
try {
	app = await launchFinder({
		userDataDir,
		env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	});
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((page) => page.url().includes("quick-look.html")),
		(page) => page !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");

	const row = main.getByRole("row", { name: /appearance\.md/ }).first();
	await row.waitFor({ timeout: 30_000 });
	await row.click();
	await main.keyboard.press("Space");
	await poll(() => preview.evaluate(() => document.querySelector('[data-quicklook-state="ready"]') !== null), Boolean);

	const initial = await Promise.all([
		main.evaluate(() => ({
			appearance: document.documentElement.dataset.appearance,
			background: getComputedStyle(document.documentElement).getPropertyValue("--bg-window").trim(),
		})),
		preview.evaluate(() => ({
			appearance: document.documentElement.dataset.appearance,
			ink: getComputedStyle(document.documentElement).getPropertyValue("--ql-ink").trim(),
			name: document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
		})),
	]);
	check("default appearance is light in Finder", initial[0].appearance === "light" && (initial[0].background === "#fff" || initial[0].background === "#ffffff"), JSON.stringify(initial[0]));
	check("default appearance is light in Quick Look", initial[1].appearance === "light" && initial[1].ink === "#1d1d1f", JSON.stringify(initial[1]));
	check("preview is loaded before switching", initial[1].name === "appearance.md", JSON.stringify(initial[1]));

	await main.keyboard.press("Meta+2");
	await main.locator(".sidebar__item", { hasText: "Settings" }).click();
	const appearance = main.locator('select[aria-label="Appearance"]');
	await appearance.waitFor({ timeout: 15_000 });
	await appearance.selectOption("dark");
	const dark = await poll(
		() =>
			Promise.all([
				main.evaluate(() => ({ appearance: document.documentElement.dataset.appearance, background: getComputedStyle(document.documentElement).getPropertyValue("--bg-window").trim() })),
				preview.evaluate(() => ({
					appearance: document.documentElement.dataset.appearance,
					ink: getComputedStyle(document.documentElement).getPropertyValue("--ql-ink").trim(),
					ready: document.querySelector('[data-quicklook-state="ready"]') !== null,
					name: document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
				})),
			]),
		(value) => value[0].appearance === "dark" && value[1].appearance === "dark",
	);
	check("dark setting updates Finder", dark[0].appearance === "dark" && dark[0].background === "#1e1e20", JSON.stringify(dark[0]));
	check("dark setting updates already-open Quick Look", dark[1].appearance === "dark" && dark[1].ink === "#f5f5f7", JSON.stringify(dark[1]));
	check("theme switch does not reload the previewed file", dark[1].ready && dark[1].name === "appearance.md", JSON.stringify(dark[1]));
	await main.screenshot({ path: join(evidence, "dark-finder-settings.png") });

	await main.keyboard.press("Meta+w");
	await poll(() => main.locator(".settings-panel").count(), (count) => count === 0);
	await preview.screenshot({ path: join(evidence, "dark-open-preview.png") });
	await app.close();

	app = await launchFinder({
		userDataDir,
		env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	});
	const restarted = await finderWindow(app, 30_000);
	const persisted = await poll(
		() => restarted.evaluate(() => document.documentElement.dataset.appearance),
		(value) => value === "dark",
	);
	check("dark appearance survives restart", persisted === "dark", String(persisted));
	await restarted.keyboard.press("Meta+2");
	await restarted.locator(".sidebar__item", { hasText: "Settings" }).click();
	const persistedSelect = restarted.locator('select[aria-label="Appearance"]');
	await persistedSelect.waitFor({ timeout: 15_000 });
	check("settings reload the persisted dark choice", (await persistedSelect.inputValue()) === "dark", await persistedSelect.inputValue());
} finally {
	await app?.close().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed; evidence in ${evidence}`);
process.exit(failed.length === 0 ? 0 : 1);
