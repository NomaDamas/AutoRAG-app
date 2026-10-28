/**
 * Manual QA — the sidebar footer: gear (Settings), chart (AI usage), update control.
 *
 * Against the built app (an unpackaged build never updates, so the update control is
 * its disabled "unsupported" state; the live update flow is run-qa-finder-app-update.mjs):
 *   1. the footer holds three icon buttons, no text labels: gear at the far left, chart next to it, update at the far right;
 *   2. the gear opens Settings (General page) and is marked current while it is open;
 *   3. the chart opens Settings on the Subscription & Usage page ("AI usage" row);
 *   4. the update control is disabled and says why in its tooltip;
 *   5. the footer reads the same in Korean;
 *   6. in a short window the footer stays on screen and the list above it scrolls instead.
 *
 * Run `bun run build` first. Evidence lands in the ignored `.omo/` tree.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-sidebar-footer");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const home = mkdtempSync(join(tmpdir(), "footer-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "footer-data-"));

const FOOTER = ".side-footer";
const GEAR = `${FOOTER} .sidebar__item--settings`;
const USAGE = `${FOOTER} [data-action="open-usage"]`;
const UPDATE = `${FOOTER} [data-action="app-update"]`;

let app;
try {
	app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
	const page = await finderWindow(app);
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(GEAR, { timeout: 30_000 });
	await page.waitForSelector(UPDATE, { timeout: 30_000 });

	// 1. Layout.
	// One evaluate: separate boundingBox() calls can straddle the window's first resize.
	const boxes = await page.evaluate(
		([footer, gear, usage, update]) => {
			const rect = (selector) => {
				const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
				return { x, y, width, height };
			};
			return { footer: rect(footer), gear: rect(gear), usage: rect(usage), update: rect(update) };
		},
		[FOOTER, GEAR, USAGE, UPDATE],
	);
	const buttonText = await page.locator(`${GEAR}, ${USAGE}, ${UPDATE}`).evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
	check("the three footer buttons carry no text label", buttonText.every((text) => text === ""), JSON.stringify(buttonText));
	check(
		"gear sits at the far left, chart right after it, update at the far right",
		boxes.gear.x < boxes.usage.x && boxes.usage.x < boxes.update.x && boxes.gear.x - boxes.footer.x < 16 && boxes.footer.x + boxes.footer.width - (boxes.update.x + boxes.update.width) < 16,
		JSON.stringify({ footerX: boxes.footer.x, footerW: boxes.footer.width, gear: boxes.gear.x, usage: boxes.usage.x, update: boxes.update.x }),
	);
	check(
		"the three buttons share one row",
		Math.abs(boxes.gear.y - boxes.usage.y) < 1 && Math.abs(boxes.gear.y - boxes.update.y) < 1,
		JSON.stringify({ gear: boxes.gear.y, usage: boxes.usage.y, update: boxes.update.y }),
	);
	// The footer's own padding: the gap above the buttons (border → button) equals the gap below (button → window edge).
	const gaps = await page.evaluate(([footer, gear]) => {
		const f = document.querySelector(footer).getBoundingClientRect();
		const g = document.querySelector(gear).getBoundingClientRect();
		return { above: Math.round((g.top - f.top) * 10) / 10, below: Math.round((f.bottom - g.bottom) * 10) / 10 };
	}, [FOOTER, GEAR]);
	check("the gap below the footer buttons equals the gap above them", Math.abs(gaps.above - gaps.below) <= 1.5, JSON.stringify(gaps));
	check("gear is named Settings for assistive tech and tooltip", (await page.locator(GEAR).getAttribute("aria-label")) === "Settings" && ((await page.locator(GEAR).getAttribute("title")) ?? "").startsWith("Settings"));
	await page.locator(FOOTER).screenshot({ path: join(EVIDENCE, "01-footer-resting.png") });

	// 4. Update control on an unpackaged build.
	check("the update control is disabled on a build that cannot update", await page.locator(UPDATE).isDisabled());
	check("its tooltip says the build does not update", /does not update automatically/.test((await page.locator(UPDATE).getAttribute("title")) ?? ""), await page.locator(UPDATE).getAttribute("title"));

	// 2. Gear → Settings.
	await page.locator(GEAR).click();
	await page.waitForSelector('select[aria-label="Appearance"]', { timeout: 15_000 });
	check("the gear opens Settings on the General page", (await page.locator(".settings-nav-item.is-active").innerText()).includes("General"));
	check("the gear is marked current while Settings is open", (await page.locator(GEAR).getAttribute("aria-current")) === "true");
	await page.screenshot({ path: join(EVIDENCE, "02-settings-general.png") });

	// 3. Chart → Subscription & Usage.
	await page.locator(USAGE).click();
	await page.waitForSelector(".settings-meter", { timeout: 15_000 });
	await page.waitForTimeout(400);
	check("the chart opens Settings on Subscription & Usage", (await page.locator(".settings-nav-item.is-active").innerText()).includes("Subscription"));
	check("the AI usage meter is on screen", await page.locator(".settings-meter").isVisible());
	await page.screenshot({ path: join(EVIDENCE, "03-settings-usage.png") });

	// 5. Korean.
	await page.locator(GEAR).click();
	await page.locator(".settings-nav-item", { hasText: "General" }).click();
	await page.selectOption('select[aria-label="App Language"]', "ko");
	await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "설정", GEAR, { timeout: 10_000 });
	check("the footer names follow the interface language", (await page.locator(USAGE).getAttribute("aria-label")) === "AI 사용량", await page.locator(USAGE).getAttribute("aria-label"));
	await page.locator(FOOTER).screenshot({ path: join(EVIDENCE, "04-footer-ko.png") });
	// 6. Short window: the footer is pinned, the nav list scrolls.
	for (const height of [900, 600, 420]) {
		await app.evaluate(({ BrowserWindow }, h) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.setContentSize(1200, h), height);
		await page.waitForTimeout(600);
		const m = await page.evaluate(
			([footer, gear, update]) => {
				const box = (selector) => document.querySelector(selector).getBoundingClientRect();
				const scroll = document.querySelector(".side-scroll");
				return { vh: innerHeight, aside: document.querySelector("aside.sidebar").getBoundingClientRect().bottom, footerBottom: box(footer).bottom, gearTop: box(gear).top, gearBottom: box(gear).bottom, updateBottom: box(update).bottom, scrollable: scroll.scrollHeight > scroll.clientHeight, scrollClient: scroll.clientHeight };
			},
			[FOOTER, GEAR, UPDATE],
		);
		check(
			`${height}px window: the sidebar fits the window and the footer (gear, update) is fully on screen`,
			m.aside <= m.vh + 0.5 && m.footerBottom <= m.vh + 0.5 && m.gearBottom <= m.vh && m.updateBottom <= m.vh && m.gearTop >= 0,
			JSON.stringify(m),
		);
		if (height <= 600) check(`${height}px window: the list above the footer scrolls`, m.scrollable && m.scrollClient > 0, JSON.stringify(m));
		await page.screenshot({ path: join(EVIDENCE, `05-window-${height}.png`) });
	}
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 600)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
