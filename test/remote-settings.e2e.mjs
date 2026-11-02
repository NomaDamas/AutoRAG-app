/**
 * The remote address is a running-server result, not a URL assembled from saved
 * preferences. Drive the real settings controls so status, persistence, and
 * clipboard regressions cannot pass behind a mocked preload.
 *
 * Run through the QA runner:
 *   bun run qa script test/remote-settings.e2e.mjs
 * Narrow captures isolate the real Settings surface from Finder's desktop
 * sidebar and inspector; they exercise its existing responsive row layout.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { chromium } from "playwright";
import { finderWindow, launchFinder } from "../scripts/manual-qa/launch-finder.mjs";

const out = process.env.QA_OUT;
assert.ok(out, "Run this script through bun run qa script.");
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "dazzi-remote-settings-home-"));
await mkdir(join(home, "Documents"), { recursive: true });
const userDataDir = await mkdtemp(join(tmpdir(), "dazzi-remote-settings-data-"));
const locales = Object.fromEntries(await Promise.all(["en", "ko", "ja", "zh"].map(async (language) => [
	language,
	JSON.parse(await readFile(new URL(`../src/shared/i18n/locales/${language}.json`, import.meta.url), "utf8")),
])));
const en = locales.en.settingsCore.general;
const app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
let page;
try {
	page = await finderWindow(app, 30_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.getByRole("button", { name: locales.en.places.settings, exact: true }).click();
	const address = () => page.getByRole("textbox", { name: en.remoteAddress, exact: true });
	const port = page.getByRole("spinbutton", { name: en.remotePort, exact: true });
	const toggle = page.getByRole("switch", { name: en.remoteAccess, exact: true });

	// given: a fresh profile does not serve files to the network.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(address()).toHaveValue(en.remoteStopped);
	await expect(page.getByRole("button", { name: en.remoteCopyAddress, exact: true })).toBeDisabled();
	await page.locator(".settings-section").filter({ has: toggle }).screenshot({ path: join(out, "en-desktop-stopped.png") });

	// when: a valid port is committed by Enter, and invalid drafts are rejected.
	await port.fill("0");
	await port.press("Enter");
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remotePort), 0);
	await port.fill("-1");
	await port.press("Enter");
	assert.equal(await port.evaluate((input) => input.validity.valid), false);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remotePort), 0);
	await port.fill("0");
	await port.press("Enter");

	// then: enabling persists the preference and displays the server's actual address.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(address()).toHaveValue(/^http:\/\/.+:\d+\/\?token=.+/u, { timeout: 10_000 });
	const status = await page.evaluate(() => window.autorag.remote.status());
	const shownAddress = await address().inputValue();
	assert.equal(status.serving, true);
	assert.equal(shownAddress, status.origin);
	assert.equal(new URL(shownAddress).port, String(status.port));
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), true);

	// when: Copy Address is clicked, it copies the complete displayed URL.
	await page.getByRole("button", { name: en.remoteCopyAddress, exact: true }).click();
	await expect(page.getByRole("button", { name: en.remoteAddressCopied, exact: true })).toBeVisible();
	assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), shownAddress);

	// given: the same built interface is served to a separate browser session.
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
		const remote = await context.newPage();
		await remote.goto(shownAddress);
		await remote.getByRole("button", { name: locales.en.places.settings, exact: true }).click();
		const origin = new URL(shownAddress).origin;
		const remoteAddress = remote.getByRole("textbox", { name: en.remoteAddress, exact: true });

		// when: remote General settings reads the browser's status bridge.
		await expect(remoteAddress).toHaveValue(origin);
		await remote.getByRole("button", { name: en.remoteCopyAddress, exact: true }).click();
		await expect(remote.getByRole("button", { name: en.remoteAddressCopied, exact: true })).toBeVisible();
		assert.equal(await remote.evaluate(() => navigator.clipboard.readText()), origin);
		const remotePort = remote.getByRole("spinbutton", { name: en.remotePort, exact: true });
		await remotePort.fill("47834");
		await remotePort.press("Enter");
		assert.equal(await remote.evaluate(async () => (await window.autorag.settings.get()).remotePort), 47834);
		await remotePort.fill("0");
		await remotePort.press("Enter");

		// then: serving origin and narrow layout remain usable in the browser.
		for (const width of [1440, 390]) {
			await remote.setViewportSize({ width, height: 1000 });
			const isolate = width === 390 ? await remote.addStyleTag({ content: ".settings-view { position: fixed; inset: 0; z-index: 2147483647; }" }) : null;
			const section = remote.locator(".settings-section").filter({ has: remote.getByRole("switch", { name: en.remoteAccess, exact: true }) });
			await expect(remoteAddress).toHaveValue(origin);
			await section.screenshot({ path: join(out, `remote-en-${width}.png`) });
			assert.equal(await section.evaluate((element) => element.scrollWidth > element.clientWidth), false);
			await isolate?.evaluate((element) => element.remove());
		}
		console.log("PASS: remote browser settings render, show location.origin, copy it, and save the port at desktop and narrow widths.");
		await context.close();
	} finally {
		await browser.close();
	}

	// then: every translation holds at desktop and narrow widths in both themes.
	let previous = en;
	for (const language of ["en", "ko", "ja", "zh"]) {
		await page.getByRole("combobox", { name: previous.appLanguage, exact: true }).selectOption(language);
		const strings = locales[language].settingsCore.general;
		await expect(page.getByRole("switch", { name: strings.remoteAccess, exact: true })).toBeVisible();
		previous = strings;
		for (const appearance of ["light", "dark"]) {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.getByRole("combobox", { name: strings.appearanceName, exact: true }).selectOption(appearance);
			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 1000 });
				const isolate = width === 390 ? await page.addStyleTag({ content: ".settings-view { position: fixed; inset: 0; z-index: 2147483647; }" }) : null;
				const section = page.locator(".settings-section").filter({ has: page.getByRole("switch", { name: strings.remoteAccess, exact: true }) });
				const urlField = page.getByRole("textbox", { name: strings.remoteAddress, exact: true });
				await expect(urlField).toHaveValue(shownAddress);
				await section.screenshot({ path: join(out, `${language}-${width}-${appearance}.png`), mask: [urlField] });
				const overflow = await section.evaluate((element) => element.scrollWidth > element.clientWidth);
				assert.equal(overflow, false, `${language} ${width} ${appearance}: remote section overflows`);
				await isolate?.evaluate((element) => element.remove());
			}
		}
	}

	// when: access is disabled, the row returns to stopped and the preference is saved.
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.getByRole("switch", { name: previous.remoteAccess, exact: true }).click();
	await expect(page.getByRole("textbox", { name: previous.remoteAddress, exact: true })).toHaveValue(previous.remoteStopped);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), false);
	console.log("PASS: desktop remote switch, saved port, invalid input, live address, clipboard, and 16 locale/width/theme captures.");
} catch (error) {
	await page?.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
	throw error;
} finally {
	await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard);
	await app.close();
}
