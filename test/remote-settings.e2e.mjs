/**
 * End-to-end live verification of Remote Access (Ovis-inspired pairing, QR codes,
 * the route picker (Same Wi-Fi / Internet), Paired Devices management,
 * and real browser Finder sessions).
 *
 * Run through the QA runner:
 *   bun run qa script test/remote-settings.e2e.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
await writeFile(join(home, "Documents", "remote-live-proof.txt"), "paired remote finder works\n", "utf8");
const userDataDir = await mkdtemp(join(tmpdir(), "dazzi-remote-settings-data-"));
const locales = Object.fromEntries(
	await Promise.all(
		["en", "ko", "ja", "zh"].map(async (language) => [
			language,
			JSON.parse(await readFile(new URL(`../src/shared/i18n/locales/${language}.json`, import.meta.url), "utf8")),
		]),
	),
);
const en = locales.en.settingsCore.remote;
const navRemote = (language) => locales[language].settingsCore.nav.remote;
const navGeneral = (language) => locales[language].settingsCore.nav.general;
const app = await launchFinder({ userDataDir, env: { HOME: home, USERPROFILE: home } });
const originalClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
let page;
try {
	page = await finderWindow(app, 30_000);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.getByRole("button", { name: locales.en.places.settings, exact: true }).click();
	await page.locator(".settings-sidebar").getByRole("button", { name: navRemote("en"), exact: true }).click();
	await expect(page.locator("h1.linear-title")).toHaveText(navRemote("en"));
	const address = () => page.getByRole("textbox", { name: en.address, exact: true });
	const port = page.getByRole("spinbutton", { name: en.port, exact: true });
	const toggle = page.getByRole("switch", { name: en.access, exact: true });
	const section = () => page.locator(".settings-content-wrap");
	const routeAddress = page.getByTestId("remote-route-address");

	// 1. Fresh profile starts off: only the switch, no address, port, or hub.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(address()).toHaveCount(0);
	await expect(port).toHaveCount(0);
	await expect(page.locator(".settings-remote-card")).toHaveCount(0);
	await expect(page.locator(".settings-remote-devices")).toHaveCount(0);
	await section().screenshot({ path: join(out, "01-en-desktop-stopped.png") });

	// 2. Enable -> the Connect a Device card; the token address and port wait behind Details.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("remote-pairing-code").or(page.getByRole("button", { name: en.pairStart, exact: true }))).toBeVisible({
		timeout: 10_000,
	});
	await expect(address()).toBeHidden();
	await page.locator("details.settings-remote-details > summary").click();
	await expect(address()).toHaveValue(/^http:\/\/.+:\d+\/\?token=.+/u, { timeout: 10_000 });

	// 3. Port validation & commit, then restart the server on the free port it asks for.
	await port.fill("-1");
	await port.press("Enter");
	assert.equal(await port.evaluate((input) => input.validity.valid), false);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remotePort), 47833);
	await port.fill("0");
	await port.press("Enter");
	await page.waitForFunction(async () => (await window.autorag.settings.get()).remotePort === 0);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(address()).toHaveCount(0);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	const details = page.locator("details.settings-remote-details");
	if (!(await details.evaluate((element) => element.open))) await details.locator("summary").click();
	await expect(address()).toHaveValue(/^http:\/\/.+:\d+\/\?token=.+/u, { timeout: 10_000 });
	const status = await page.evaluate(() => window.autorag.remote.status());
	const shownAddress = await address().inputValue();
	const origin = new URL(shownAddress).origin;
	assert.equal(status.serving, true);
	assert.equal(shownAddress, status.origin);
	assert.equal(new URL(shownAddress).port, String(status.port));
	assert.notEqual(status.port, 47833, "port 0 asks the OS for a free port");
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), true);

	await details.getByRole("button", { name: en.copyAddress, exact: true }).click();
	await expect(details.getByRole("button", { name: en.addressCopied, exact: true })).toBeVisible();
	assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), shownAddress);
	await details.locator("summary").click();

	// 4. Same Wi-Fi route + a 6-digit pairing code -> QR code of `<LAN address>/?pair=CODE`.
	await page.getByRole("tab", { name: en.routeLan, exact: true }).click();
	await expect(routeAddress).toHaveText(/^http:\/\/\d+\.\d+\.\d+\.\d+:\d+$/u);
	const lanAddress = (await routeAddress.textContent())?.trim() ?? "";
	assert.equal(new URL(lanAddress).port, String(status.port));
	await page.getByRole("button", { name: en.pairStart, exact: true }).click();
	const codeLocator = page.getByTestId("remote-pairing-code");
	await expect(codeLocator).toBeVisible();
	const spacedCode = (await codeLocator.textContent())?.trim() ?? "";
	assert.match(spacedCode, /^\d{3} \d{3}$/u);
	const rawCode = spacedCode.replace(/\s+/g, "");
	await expect(page.locator("svg.settings-remote-qr")).toBeVisible();
	await page.getByRole("button", { name: en.pairLinkCopy, exact: true }).click();
	await expect(page.getByRole("button", { name: en.pairLinkCopied, exact: true })).toBeVisible();
	assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), `${lanAddress}/?pair=${rawCode}`);
	await section().screenshot({ path: join(out, "02-host-pairing-qr.png") });

	if (!existsSync(chromium.executablePath())) {
		execFileSync(process.execPath, ["./node_modules/playwright/cli.js", "install", "chromium"], { stdio: "inherit" });
	}
	const browser = await chromium.launch({ headless: true });
	try {
		// 5. Device #1 (Phone browser): open bare origin (no ?token=) -> sees AccessGate -> enter 6-digit code manually!
		const phoneContext = await browser.newContext({
			viewport: { width: 390, height: 844 },
			userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Version/18.2 Mobile/15E148 Safari/604.1",
			permissions: ["clipboard-read", "clipboard-write"],
		});
		const phone = await phoneContext.newPage();
		await phone.goto(origin);
		await expect(phone.getByTestId("remote-access-gate")).toBeVisible();
		await phone.screenshot({ path: join(out, "03-remote-access-gate-mobile.png") });

		// Wrong code attempt shows error without crashing
		await phone.locator("#pair-code").fill("000000" === rawCode ? "999999" : "000000");
		await phone.locator("#pair-submit").click();
		await expect(phone.locator("#gate-error")).toBeVisible();

		// Enter actual 6-digit pairing code -> unlocks full Dazzi Finder UI with HttpOnly dazzi_device cookie!
		await phone.locator("#pair-code").fill(rawCode);
		await phone.locator("#pair-submit").click();
		// At 390px the remote browser opens the phone shell; widening switches to the desktop Finder shell.
		await expect(phone.getByTestId("mobile-app")).toBeVisible({ timeout: 15_000 });
		assert.equal(phone.url().includes("token="), false, "Paired browser URL stays clean with no ?token=");

		// Browse host Documents folder from the paired browser!
		await phone.setViewportSize({ width: 1280, height: 800 });
		await phone.locator(".sidebar").getByRole("button", { name: locales.en.places.documents, exact: true }).click();
		await expect(phone.locator('[role="row"]').filter({ hasText: "remote-live-proof.txt" }).first()).toBeVisible({ timeout: 10_000 });
		await phone.screenshot({ path: join(out, "04-paired-browser-finder-documents.png") });

		// 6. Verify host Settings live-updates Paired Devices with "iPhone · Safari", rename it, and pair a 2nd browser via ?pair=CODE QR link!
		await expect(page.locator(".settings-remote-device-row").filter({ hasText: "iPhone · Safari" })).toBeVisible({ timeout: 10_000 });
		await page.getByRole("button", { name: "Rename iPhone · Safari", exact: true }).click();
		const renameInput = page.getByRole("textbox", { name: en.deviceNameInput, exact: true });
		await renameInput.fill("Jeffrey iPhone");
		await renameInput.press("Enter");
		await expect(page.locator(".settings-remote-device-row").filter({ hasText: "Jeffrey iPhone" })).toBeVisible();

		// Issue a second pairing code and open the QR link (`<LAN address>/?pair=CODE`) in a second browser
		// The phone spent the code: the host drops it, so a second device needs a fresh one
		await expect(codeLocator).toBeHidden({ timeout: 10_000 });
		await page.getByRole("button", { name: en.pairStart, exact: true }).click();
		await expect(codeLocator).toBeVisible();
		const secondCode = ((await codeLocator.textContent()) ?? "").replace(/\D/g, "");
		assert.equal(secondCode.length, 6);

		const qrContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
		const qrPage = await qrContext.newPage();
		await qrPage.goto(`${lanAddress}/?pair=${secondCode}`);
		await expect(qrPage.locator(".sidebar__item--settings")).toBeVisible({ timeout: 15_000 });
		assert.equal(qrPage.url().includes("pair="), false, "?pair=CODE is stripped from URL history immediately");

		// Check remote Settings inside the QR-paired browser: its own origin (no token) behind Details
		await qrPage.locator(".sidebar__item--settings").click();
		await qrPage.locator(".settings-sidebar").getByRole("button", { name: navRemote("en"), exact: true }).click();
		await qrPage.locator("details.settings-remote-details > summary").click();
		const remoteAddress = qrPage.getByRole("textbox", { name: en.address, exact: true });
		await expect(remoteAddress).toHaveValue(lanAddress);
		await expect(qrPage.locator(".settings-remote-device-badge")).toHaveText(en.deviceCurrent);
		await expect(qrPage.getByRole("button", { name: en.tunnelStart, exact: true })).toHaveCount(0);
		await qrPage.setViewportSize({ width: 1440, height: 1000 });
		await qrPage.locator(".settings-content-wrap").screenshot({ path: join(out, "05-remote-paired-settings-1440.png") });
		assert.equal(await qrPage.locator(".settings-content-wrap").evaluate((element) => element.scrollWidth > element.clientWidth), false);
		// At 390px the phone shell hosts our Remote Access page through its Settings tab.
		await qrPage.setViewportSize({ width: 390, height: 844 });
		await qrPage.getByRole("tab", { name: locales.en.mobile.tabs.settings, exact: true }).click();
		await qrPage.getByTestId("phone-settings-page").filter({ hasText: navRemote("en") }).click();
		await expect(qrPage.locator(".settings-remote-device-badge")).toHaveText(en.deviceCurrent);
		await qrPage.locator(".settings-content-wrap").screenshot({ path: join(out, "05-remote-paired-settings-390.png") });
		assert.equal(await qrPage.locator(".settings-content-wrap").evaluate((element) => element.scrollWidth > element.clientWidth), false);

		// 7. Revoke "Jeffrey iPhone" from host -> verify phone browser loses access immediately and reloads to AccessGate!
		const iphoneRow = page.locator(".settings-remote-device-row").filter({ hasText: "Jeffrey iPhone" });
		await iphoneRow.getByRole("button", { name: en.deviceRevoke, exact: true }).click();
		await iphoneRow.getByRole("button", { name: en.deviceRevokeConfirm, exact: true }).click();
		await expect(iphoneRow).toBeHidden();

		// Revocation closes the phone's event stream and the page reloads itself to the AccessGate;
		// an explicit reload can race that navigation (ERR_ABORTED), which is fine.
		await phone.getByRole("button", { name: locales.en.places.settings, exact: true }).click().catch(() => undefined);
		await phone.reload().catch(() => undefined);
		await expect(phone.getByTestId("remote-access-gate")).toBeVisible({ timeout: 10_000 });
		await phone.screenshot({ path: join(out, "06-revoked-device-returned-to-gate.png") });

		// 8. The Internet route on host Settings
		await page.getByRole("tab", { name: en.routeInternet, exact: true }).click();
		await expect(page.locator("details.settings-remote-domain, .settings-remote-pane[data-route='internet']").first()).toBeVisible();
		await section().screenshot({ path: join(out, "08-host-tunnel-tab.png") });
		await page.getByRole("tab", { name: en.routeLan, exact: true }).click();

		await phoneContext.close();
		await qrContext.close();
		console.log("PASS: live pairing (manual 6-digit + LAN QR ?pair=CODE), Finder folder browse, device rename, instant revocation, and route tabs verified.");
	} finally {
		await browser.close();
	}

	// 9. Verify all 4 locales (en, ko, ja, zh) x 2 appearances (light, dark) x 2 widths (1440, 390) have zero horizontal overflow!
	await details.locator("summary").click();
	let previous = "en";
	for (const language of ["en", "ko", "ja", "zh"]) {
		const generalStrings = locales[previous].settingsCore.general;
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.locator(".settings-sidebar").getByRole("button", { name: navGeneral(previous), exact: true }).click();
		await page.getByRole("combobox", { name: generalStrings.appLanguage, exact: true }).selectOption(language);
		const general = locales[language].settingsCore.general;
		const strings = locales[language].settingsCore.remote;
		previous = language;
		for (const appearance of ["light", "dark"]) {
			await page.setViewportSize({ width: 1440, height: 1000 });
			await page.locator(".settings-sidebar").getByRole("button", { name: navGeneral(language), exact: true }).click();
			await page.getByRole("combobox", { name: general.appearanceName, exact: true }).selectOption(appearance);
			await page.locator(".settings-sidebar").getByRole("button", { name: navRemote(language), exact: true }).click();
			await expect(page.getByRole("switch", { name: strings.access, exact: true })).toBeVisible();
			const pageDetails = page.locator("details.settings-remote-details");
			if (!(await pageDetails.evaluate((element) => element.open))) await pageDetails.locator("summary").click();
			for (const width of [1440, 390]) {
				await page.setViewportSize({ width, height: 1000 });
				const isolate = width === 390 ? await page.addStyleTag({ content: ".settings-view { position: fixed; inset: 0; z-index: 2147483647; }" }) : null;
				const content = page.locator(".settings-content-wrap");
				const urlField = page.getByRole("textbox", { name: strings.address, exact: true });
				await expect(urlField).toHaveValue(shownAddress);
				await content.screenshot({ path: join(out, `locale-${language}-${width}-${appearance}.png`), mask: [urlField] });
				const overflow = await content.evaluate((element) => element.scrollWidth > element.clientWidth);
				assert.equal(overflow, false, `${language} ${width} ${appearance}: remote page overflows`);
				await isolate?.evaluate((element) => element.remove());
			}
		}
	}

	// 10. Revoke remaining devices and disable Remote Access -> returns cleanly to Stopped.
	await page.setViewportSize({ width: 1440, height: 1000 });
	const last = locales[previous].settingsCore.remote;
	const revokeAllBtn = page.getByRole("button", { name: last.devicesRevokeAll, exact: true });
	if (await revokeAllBtn.isVisible()) {
		await revokeAllBtn.click();
		await page.getByRole("button", { name: last.devicesRevokeAllConfirm, exact: true }).click();
	}
	await page.getByRole("switch", { name: last.access, exact: true }).click();
	await expect(page.getByRole("textbox", { name: last.address, exact: true })).toHaveCount(0);
	await expect(page.locator(".settings-remote-card")).toHaveCount(0);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), false);
	console.log("PASS: 16 locale/width/theme captures + clean revoke-all and disable verified.");
} catch (error) {
	await page?.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
	throw error;
} finally {
	await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard);
	await app.close();
}
