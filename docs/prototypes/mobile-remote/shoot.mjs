#!/usr/bin/env node
/**
 * Screenshot every review scene of the prototype at phone size.
 *
 *   python3 -m http.server 47900 --bind 127.0.0.1   # from the repo root
 *   node docs/prototypes/mobile-remote/shoot.mjs <outDir> [scene …] [--dark] [--frame]
 *
 * Without --frame the page runs at 393 × 852 with touch and DPR 2, so the
 * phone-width media query draws the app edge to edge, the way a phone's browser
 * shows the remote session. --frame shoots the desktop review page instead.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith("--")) ?? "/tmp/mobile-proto";
const wanted = args.filter((a) => !a.startsWith("--")).slice(1);
const dark = args.includes("--dark");
const frame = args.includes("--frame");
const base = process.env.PROTO_URL ?? "http://127.0.0.1:47900/docs/prototypes/mobile-remote/index.html";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext(
	frame
		? { viewport: { width: 1000, height: 940 }, deviceScaleFactor: 1 }
		: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true },
);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });

await page.goto(`${base}${dark ? "?theme=dark" : ""}`);
await page.waitForTimeout(300);
const scenes = wanted.length ? wanted : await page.$$eval("[data-review='scene']", (els) => els.map((e) => e.dataset.arg));
let i = 0;
for (const scene of scenes) {
	await page.evaluate((name) => reviewAction("scene", name), scene);
	await page.waitForTimeout(700);
	const file = `${out}/${String(++i).padStart(2, "0")}-${scene.replace(/[^\p{L}\p{N}]+/gu, "_")}${dark ? "-dark" : ""}.png`;
	await page.screenshot({ path: file });
	console.log(file);
}
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
