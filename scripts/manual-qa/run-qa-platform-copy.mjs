/**
 * Manual QA — copy that names the machine (real Electron).
 *
 * "This Mac" is wrong on a PC. The two Settings sentences that say where a local server runs and where an
 * embedding key is kept must read "this PC" on Windows and keep "this Mac" on macOS, in every interface language.
 * The onboarding lane covers the account and folders steps.
 *
 * `bun run build` first, then `bun scripts/manual-qa/run-qa-platform-copy.mjs`.
 */
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, isWindows } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ? join(process.env.QA_OUT, "platform-copy") : join(ROOT, ".omo/evidence/ai-finder-app/qa-platform-copy");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const ROOT_TEXT = (language) => JSON.parse(readFileSync(join(ROOT, "src", "shared", "i18n", "locales", `${language}.json`), "utf8"));
const OTHER = isWindows ? /\bMac\b|맥/u : /\bPC\b|电脑/u;

for (const language of ["en", "ko", "ja", "zh"]) {
	const copy = ROOT_TEXT(language);
	const wantLocal = copy.settingsCore.ai.server[isWindows ? "bodyLocalPc" : "bodyLocal"];
	const wantKey = copy.settingsCore.embedding[isWindows ? "apiKeyHintPc" : "apiKeyHint"];
	const app = await launchFinder({ userDataDir: mkdtempSync(join(tmpdir(), `qa-platform-copy-${language}-`)), language });
	try {
		const page = await finderWindow(app, 30_000);
		page.setDefaultTimeout(15_000);
		await page.waitForSelector(".toolbar-title", { timeout: 30_000 });
		await page.keyboard.press(chord("Comma"));
		await page.locator(".settings-nav-item", { hasText: copy.settingsCore.nav.ai }).first().click();

		// Add a local server: the dialog says where such a server has to run.
		await page.locator(".settings-add-row").first().click();
		await page.locator(".settings-menu-item", { hasText: copy.settingsCore.ai.menu.addLocalServer }).click();
		const modal = page.locator(".settings-modal");
		await modal.waitFor();
		const body = (await modal.innerText()).replace(/\s+/gu, " ");
		check(`${language}: the local-server dialog says where the server runs`, body.includes(wantLocal) && !OTHER.test(wantLocal), body.slice(0, 160));
		await page.screenshot({ path: join(EVIDENCE, `${language}-local-server.png`) });
		await page.keyboard.press("Escape");

		// Embedding → own server: where the key is kept.
		await page.locator("button.settings-trigger[aria-haspopup='dialog']").first().click();
		const radios = page.locator('input[name="embedding-profile"]');
		await radios.first().waitFor();
		for (let index = 0; index < (await radios.count()); index += 1) {
			await radios.nth(index).check({ force: true }).catch(() => undefined);
			if ((await page.locator('input[name="embedding-api-key"]').count()) > 0) break;
		}
		await page.locator('input[name="embedding-api-key"]').waitFor();
		const hint = (await page.locator(".settings-modal").innerText()).replace(/\s+/gu, " ");
		check(`${language}: the embedding key hint says where the key is kept`, hint.includes(wantKey) && !OTHER.test(wantKey), wantKey);
		await page.screenshot({ path: join(EVIDENCE, `${language}-embedding-key.png`) });
	} catch (error) {
		check(`${language}: run completed`, false, String(error).slice(0, 700));
	} finally {
		await app.close().catch(() => undefined);
	}
}

if (failures.length > 0) {
	console.log(`${failures.length} check(s) failed`);
	process.exitCode = 1;
} else console.log("ALL PASS");
