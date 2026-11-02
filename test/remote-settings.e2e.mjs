/**
 * End-to-end live verification of Remote Access (Ovis-inspired pairing, QR codes,
 * Tailscale/Tunnel tabs, Paired Devices management, and real browser Finder sessions).
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

	// 1. Fresh profile starts stopped.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(address()).toHaveValue(en.remoteStopped);
	await expect(page.getByRole("button", { name: en.remoteCopyAddress, exact: true })).toBeDisabled();
	await page.locator(".settings-section").filter({ has: toggle }).screenshot({ path: join(out, "01-en-desktop-stopped.png") });

	// 2. Port validation & commit.
	await port.fill("0");
	await port.press("Enter");
	await page.waitForFunction(async () => (await window.autorag.settings.get()).remotePort === 0);
	await expect(port).toHaveValue("0");
	await port.fill("-1");
	await port.press("Enter");
	assert.equal(await port.evaluate((input) => input.validity.valid), false);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remotePort), 0);
	await port.fill("0");
	await port.press("Enter");
	await expect(port).toHaveValue("0");

	// 3. Enable Remote Access -> server binds and shows live token address + Pairing/Tailscale/Tunnel hub.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(address()).toHaveValue(/^http:\/\/.+:\d+\/\?token=.+/u, { timeout: 10_000 });
	const status = await page.evaluate(() => window.autorag.remote.status());
	const shownAddress = await address().inputValue();
	const origin = new URL(shownAddress).origin;
	assert.equal(status.serving, true);
	assert.equal(shownAddress, status.origin);
	assert.equal(new URL(shownAddress).port, String(status.port));
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), true);

	await page.getByRole("button", { name: en.remoteCopyAddress, exact: true }).click();
	await expect(page.getByRole("button", { name: en.remoteAddressCopied, exact: true })).toBeVisible();
	assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), shownAddress);

	// 4. Generate a 6-digit pairing code on the host -> verify QR code SVG and spaced code render.
	await page.getByRole("button", { name: en.remotePairStart, exact: true }).click();
	const codeLocator = page.getByTestId("remote-pairing-code");
	await expect(codeLocator).toBeVisible();
	const spacedCode = (await codeLocator.textContent())?.trim() ?? "";
	assert.match(spacedCode, /^\d{3} \d{3}$/u);
	const rawCode = spacedCode.replace(/\s+/g, "");
	await expect(page.locator("svg.settings-remote-qr")).toBeVisible();
	await page.locator(".settings-section").filter({ has: toggle }).screenshot({ path: join(out, "02-host-pairing-qr.png") });

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
		await expect(phone.locator(".sidebar__item--settings")).toBeVisible({ timeout: 15_000 });
		assert.equal(phone.url().includes("token="), false, "Paired browser URL stays clean with no ?token=");

		// Browse host Documents folder from the paired browser!
		await phone.setViewportSize({ width: 1280, height: 800 });
		await phone.locator(".sidebar").getByRole("button", { name: locales.en.places.documents, exact: true }).click();
		await expect(phone.locator('[role="row"]').filter({ hasText: "remote-live-proof.txt" }).first()).toBeVisible({ timeout: 10_000 });
		await phone.screenshot({ path: join(out, "04-paired-browser-finder-documents.png") });

		// 6. Verify host Settings live-updates Paired Devices with "iPhone · Safari", rename it, and pair a 2nd browser via ?pair=CODE QR link!
		await expect(page.locator(".settings-remote-device-row").filter({ hasText: "iPhone · Safari" })).toBeVisible({ timeout: 10_000 });
		await page.getByRole("button", { name: "Rename iPhone · Safari", exact: true }).click();
		const renameInput = page.getByRole("textbox", { name: en.remoteDeviceNameInput, exact: true });
		await renameInput.fill("Jeffrey iPhone");
		await renameInput.press("Enter");
		await expect(page.locator(".settings-remote-device-row").filter({ hasText: "Jeffrey iPhone" })).toBeVisible();

		// Issue a second pairing code and open via QR link (`/?pair=CODE`) in a second isolated browser context
		await page.getByRole("button", { name: en.remotePairStart, exact: true }).click();
		await expect(codeLocator).toBeVisible();
		const secondCode = ((await codeLocator.textContent()) ?? "").replace(/\D/g, "");
		assert.equal(secondCode.length, 6);

		const qrContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
		const qrPage = await qrContext.newPage();
		await qrPage.goto(`${origin}/?pair=${secondCode}`);
		await expect(qrPage.locator(".sidebar__item--settings")).toBeVisible({ timeout: 15_000 });
		assert.equal(qrPage.url().includes("pair="), false, "?pair=CODE is stripped from URL history immediately");

		// Check remote Settings inside the QR-paired browser
		await qrPage.locator(".sidebar__item--settings").click();
		const remoteAddress = qrPage.getByRole("textbox", { name: en.remoteAddress, exact: true });
		await expect(remoteAddress).toHaveValue(origin);
		await expect(qrPage.locator(".settings-remote-device-badge")).toHaveText(en.remoteDeviceCurrent);
		for (const width of [1440, 390]) {
			await qrPage.setViewportSize({ width, height: 1000 });
			const isolate = width === 390 ? await qrPage.addStyleTag({ content: ".settings-view { position: fixed; inset: 0; z-index: 2147483647; }" }) : null;
			const section = qrPage.locator(".settings-section").filter({ has: qrPage.getByRole("switch", { name: en.remoteAccess, exact: true }) });
			await section.screenshot({ path: join(out, `05-remote-paired-settings-${width}.png`) });
			assert.equal(await section.evaluate((element) => element.scrollWidth > element.clientWidth), false);
			await isolate?.evaluate((element) => element.remove());
		}

		// 7. Revoke "Jeffrey iPhone" from host -> verify phone browser loses access immediately and reloads to AccessGate!
		const iphoneRow = page.locator(".settings-remote-device-row").filter({ hasText: "Jeffrey iPhone" });
		await iphoneRow.getByRole("button", { name: en.remoteDeviceRevoke, exact: true }).click();
		await iphoneRow.getByRole("button", { name: en.remoteDeviceRevokeConfirm, exact: true }).click();
		await expect(iphoneRow).toBeHidden();

		// Trigger an action on the revoked phone page -> bootstrap receives 403 and reloads to AccessGate
		await phone.getByRole("button", { name: locales.en.places.settings, exact: true }).click().catch(() => undefined);
		await phone.reload();
		await expect(phone.getByTestId("remote-access-gate")).toBeVisible({ timeout: 10_000 });
		await phone.screenshot({ path: join(out, "06-revoked-device-returned-to-gate.png") });

		// 8. Check Tailscale & Quick Tunnel tabs on host Settings
		await page.getByRole("tab", { name: en.remoteTabTailscale, exact: true }).click();
		await page.locator(".settings-section").filter({ has: toggle }).screenshot({ path: join(out, "07-host-tailscale-tab.png") });
		await page.getByRole("tab", { name: en.remoteTabTunnel, exact: true }).click();
		await page.locator(".settings-section").filter({ has: toggle }).screenshot({ path: join(out, "08-host-tunnel-tab.png") });
		await page.getByRole("tab", { name: en.remoteTabPair, exact: true }).click();

		await phoneContext.close();
		await qrContext.close();
		console.log("PASS: live pairing (manual 6-digit + QR ?pair=CODE), Finder folder browse, device rename, instant revocation, and Tailscale/Tunnel tabs verified.");
	} finally {
		await browser.close();
	}

	// 9. Verify all 4 locales (en, ko, ja, zh) x 2 appearances (light, dark) x 2 widths (1440, 390) have zero horizontal overflow!
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
				await section.screenshot({ path: join(out, `locale-${language}-${width}-${appearance}.png`), mask: [urlField] });
				const overflow = await section.evaluate((element) => element.scrollWidth > element.clientWidth);
				assert.equal(overflow, false, `${language} ${width} ${appearance}: remote section overflows`);
				await isolate?.evaluate((element) => element.remove());
			}
		}
	}

	// 10. Revoke remaining devices and disable Remote Access -> returns cleanly to Stopped.
	await page.setViewportSize({ width: 1440, height: 1000 });
	const revokeAllBtn = page.getByRole("button", { name: previous.remoteDevicesRevokeAll, exact: true });
	if (await revokeAllBtn.isVisible()) {
		await revokeAllBtn.click();
		await page.getByRole("button", { name: previous.remoteDevicesRevokeAllConfirm, exact: true }).click();
	}
	await page.getByRole("switch", { name: previous.remoteAccess, exact: true }).click();
	await expect(page.getByRole("textbox", { name: previous.remoteAddress, exact: true })).toHaveValue(previous.remoteStopped);
	assert.equal(await page.evaluate(async () => (await window.autorag.settings.get()).remoteAccess), false);
	console.log("PASS: 16 locale/width/theme captures + clean revoke-all and disable verified.");
} catch (error) {
	await page?.screenshot({ path: join(out, "failure.png") }).catch(() => undefined);
	throw error;
} finally {
	await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), originalClipboard);
	await app.close();
}
