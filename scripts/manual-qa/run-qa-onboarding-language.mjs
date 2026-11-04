// The zero-question first run follows the OS language. The lane launches the
// built app on a fresh profile with NO seeded interface language (so the app has
// to derive it) and checks the first-run overlay's visible copy: the right
// language on `<html lang>`, the settings, and the screens' own text, with no
// Korean left in the English/Japanese/Chinese screens and no raw key in Korean.
//
// The overlay is now one window with four screens reached without asking
// anything: permission (macOS, while Full Disk Access is not granted) → setup
// (the progress bar) → ready → tour. The lane checks the first screen it lands
// on and stops the app before the first index finishes; the language is fixed at
// launch, so one screen is enough.
//
// How the OS language is set depends on the OS:
//  - macOS: the `-AppleLanguages` argument, which Electron reads like the real
//    preference, so five OS languages run (an unsupported one must land on English).
//  - Windows: Electron reads the user's language list through WinRT and nothing
//    can override it per process, so the lane runs once and expects the app to
//    follow whatever language the machine is really set to.
//  - Linux: not a QA platform of this repo; the lane skips.
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { rmRetry } from "./platform.mjs";

if (process.platform !== "darwin" && process.platform !== "win32") {
	console.log(`SKIP onboarding-language: ${process.platform} is not a manual-QA platform`);
	process.exit(0);
}

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/onboarding-language");
mkdirSync(EVIDENCE, { recursive: true });
const WORK = mkdtempSync(join(tmpdir(), "autorag-onb-lang-"));

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const SHIPPED = ["ko", "en", "ja", "zh"];
/** OS language -> the interface language the app must pick; `lang: null` expects whatever the real OS is set to. */
const CASES =
	process.platform === "darwin"
		? [
				{ os: "ko-KR", lang: "ko" },
				{ os: "en-US", lang: "en" },
				{ os: "ja-JP", lang: "ja" },
				{ os: "zh-Hans-CN", lang: "zh" },
				{ os: "fr-FR", lang: "en" },
			]
		: [{ os: "system", lang: null }];
/** The language an OS preference list resolves to: the first shipped one, else English. */
const resolve = (tags) => tags.map((tag) => tag.split(/[-_.@]/u)[0].toLowerCase()).find((tag) => SHIPPED.includes(tag)) ?? "en";
const HANGUL = /[\uac00-\ud7a3]/u;
/** The overlay's current screen, or null once it is gone. */
const screenOf = (page) => page.evaluate(() => document.querySelector(".fr-root")?.getAttribute("data-screen") ?? null);

for (const { os, lang: injected } of CASES) {
	const userDataDir = join(WORK, `profile-${os}`);
	const env = { AUTORAG_HOME: join(WORK, `home-${os}`), AUTORAG_CONFIG: join(WORK, `config-${os}`, "config.json"), AUTORAG_SKIP_DUPEY_CHECK: "1" };
	const app = await launchFinder({ userDataDir, env, onboarding: true, language: null, args: injected === null ? [] : ["-AppleLanguages", `(${os})`] });
	try {
		const page = await finderWindow(app, 20_000);
		const lang = injected ?? resolve(await app.evaluate(({ app: electron }) => electron.getPreferredSystemLanguages()));
		await page.waitForSelector(".fr-root[data-screen]", { timeout: 30_000 });
		const screen = await screenOf(page);
		const label = `${os}/${screen}`;
		// The permission card carries prose only; setup and ready carry the h1.fr-title.
		if (screen === "permission") check(`${label}: the permission card shows its copy`, (await page.locator(".fr-permission").innerText()).trim().length > 0);
		else await page.waitForSelector(".fr-root h1.fr-title", { timeout: 60_000 });
		const htmlLang = await page.evaluate(() => document.documentElement.lang);
		check(`${label}: <html lang> is ${lang}`, htmlLang === lang, htmlLang);
		const stored = await page.evaluate(() => window.autorag.settings.get().then((settings) => settings.language));
		check(`${label}: the settings report ${lang}`, stored === lang, stored);
		const text = (await page.locator(".fr-root").innerText()).replace(/\s+/g, " ").trim();
		if (lang !== "ko") check(`${label}: no Korean on screen`, !HANGUL.test(text), text.match(/\S*[\uac00-\ud7a3]\S*/u)?.[0] ?? "");
		else check(`${label}: the copy is Korean, not a raw key`, HANGUL.test(text) && !text.includes("firstRun."), text.slice(0, 80));
		await page.locator(".fr-root").screenshot({ path: join(EVIDENCE, `${os}-${screen}.png`) });
	} catch (error) {
		check(`${os}: opened`, false, error instanceof Error ? error.message : String(error));
	} finally {
		// The first index is still running, and closing the last window then asks before quitting
		// (`closeDecision`), so a plain close would wait on that dialog forever. End the process instead.
		const child = app.process();
		const exited = new Promise((done) => child.once("exit", done));
		child.kill("SIGKILL");
		await Promise.race([exited, new Promise((done) => setTimeout(done, 10_000))]);
		if (process.platform !== "win32") spawnSync("pkill", ["-9", "-f", WORK]);
	}
}

await rmRetry(WORK);
if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall onboarding-language checks passed");
