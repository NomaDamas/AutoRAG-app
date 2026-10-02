/**
 * Manual QA — folder disclosure triangles in the list view (Finder "List").
 *
 * Drives the real production build (out/) via launchFinder against a fixture
 * tree created in ~/Documents that mirrors the reference screenshot:
 *
 *   <root>/data_multi_page/partial_results.json
 *   <root>/ko_vlm_benchmark/multi_hop_question/generate.py
 *   <root>/run_multi_hop_generate.py
 *
 * Checks nesting (aria-level), collapse, remembered nested expansion, the
 * arrow keys, and that search hits carry no triangles. Evidence goes to
 * .omo/evidence/ai-finder-app/qa-folder-tree/.
 *
 * Run from the repo root after `bun run build`:
 * `bun scripts/manual-qa/run-qa-finder-folder-tree.mjs`
 */

import { mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const EVIDENCE = `${ROOT}/.omo/evidence/ai-finder-app/qa-folder-tree`;
mkdirSync(EVIDENCE, { recursive: true });

const stamp = Date.now();
const rootName = `ulw-tree-qa-${stamp}`;
const tree = `${process.env.HOME}/Documents/${rootName}`;
await Bun.write(`${tree}/data_multi_page/partial_results.json`, "{}\n");
await Bun.write(`${tree}/ko_vlm_benchmark/multi_hop_question/generate.py`, "print('qa')\n");
await Bun.write(`${tree}/run_multi_hop_generate.py`, "print('qa')\n");

const results = [];
const check = (label, actual, expected) => {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ label, actual, expected, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}: got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);
};

let app;
try {
	app = await launchFinder();
	let page = await finderWindow(app);
	await page.waitForSelector('[role="row"]', { timeout: 30000 });
	await page.getByLabel("Places").getByRole("button", { name: "Documents", exact: true }).click();

	const row = (name) =>
		page.locator('[role="row"]').filter({ has: page.locator(".row__label", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) });
	const level = async (name) => ((await row(name).count()) === 0 ? null : await row(name).first().getAttribute("aria-level"));
	const toggle = (name, verb) => row(name).getByRole("button", { name: `${name} ${verb}`, exact: true }).click();
	const settle = (name, present) => row(name).first().waitFor({ state: present ? "visible" : "detached", timeout: 10000 });

	await settle(rootName, true);
	check("root row starts collapsed at level 1", [await level(rootName), await row(rootName).getAttribute("aria-expanded")], ["1", "false"]);
	check("children hidden before expanding", await level("data_multi_page"), null);

	await toggle(rootName, "펼치기");
	await settle("run_multi_hop_generate.py", true);
	check("expanded children at level 2", [await level("data_multi_page"), await level("ko_vlm_benchmark"), await level("run_multi_hop_generate.py")], ["2", "2", "2"]);
	check("folders sort before files inside the expansion", await page.locator('[role="row"] .row__label').evaluateAll((labels, name) => {
		const names = labels.map((label) => label.textContent);
		const at = names.indexOf(name);
		return names.slice(at + 1, at + 4);
	}, rootName), ["data_multi_page", "ko_vlm_benchmark", "run_multi_hop_generate.py"]);

	await toggle("ko_vlm_benchmark", "펼치기");
	await settle("multi_hop_question", true);
	await toggle("multi_hop_question", "펼치기");
	await settle("generate.py", true);
	await toggle("data_multi_page", "펼치기");
	await settle("partial_results.json", true);
	check("nested levels 3 and 4", [await level("partial_results.json"), await level("multi_hop_question"), await level("generate.py")], ["3", "3", "4"]);
	await row(rootName).scrollIntoViewIfNeeded();
	await page.screenshot({ path: `${EVIDENCE}/expanded-tree.png` });
	await page.locator(".list").screenshot({ path: `${EVIDENCE}/expanded-tree-list.png` });

	await toggle(rootName, "접기");
	await settle("data_multi_page", false);
	check("collapsing the root hides every descendant", [await level("data_multi_page"), await level("generate.py"), await level("partial_results.json")], [null, null, null]);

	await toggle(rootName, "펼치기");
	await settle("generate.py", true);
	check("re-expanding restores nested expansion", [await level("generate.py"), await level("partial_results.json")], ["4", "3"]);

	await row("multi_hop_question").click();
	await page.keyboard.press("ArrowLeft");
	await settle("generate.py", false);
	check("ArrowLeft collapses the focused open folder", await level("generate.py"), null);
	await page.keyboard.press("ArrowLeft");
	check("ArrowLeft on a closed nested folder selects its parent", await row("ko_vlm_benchmark").getAttribute("aria-selected"), "true");
	await page.keyboard.press("ArrowLeft");
	await settle("multi_hop_question", false);
	check("ArrowLeft collapses the parent next", await level("multi_hop_question"), null);
	await page.keyboard.press("ArrowRight");
	await settle("multi_hop_question", true);
	check("ArrowRight expands it again", await level("multi_hop_question"), "3");

	await row("partial_results.json").click();
	await toggle(rootName, "접기");
	await settle("partial_results.json", false);
	check("collapsing over a hidden selection selects the collapsed folder", await row(rootName).getAttribute("aria-selected"), "true");

	await page.getByPlaceholder("Instant search").fill("multi_hop");
	await settle("run_multi_hop_generate.py", true);
	check("search results carry no disclosure triangles", await page.locator(".list .row__disclosure").count(), 0);
	check("search results use a flat grid", await page.locator('.list [role="treegrid"]').count(), 0);
	await page.screenshot({ path: `${EVIDENCE}/search-flat.png` });

	await page.getByPlaceholder("Instant search").fill("");
	await settle(rootName, true);
	await page.screenshot({ path: `${EVIDENCE}/after-search.png` });
	await Bun.write(`${EVIDENCE}/result.json`, JSON.stringify({ platform: process.platform, checks: results }, null, 2));
} finally {
	if (app !== undefined) await app.close();
	await rm(tree, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0 || results.length === 0) process.exitCode = 1;
