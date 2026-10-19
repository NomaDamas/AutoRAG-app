// First-run onboarding follows the OS language. The lane launches the built app
// on a fresh profile with NO seeded interface language (so the app has to derive
// it), opens every onboarding step, and checks the screen's visible copy: the
// right language, no Korean left in the English/Japanese/Chinese screens, and no
// untranslated English prose in the Korean/Japanese/Chinese ones.
//
// How the OS language is set depends on the OS:
//  - macOS: the `-AppleLanguages` argument, which Electron reads like the real
//    preference, so five OS languages run (an unsupported one must land on English).
//  - Windows: Electron reads the user's language list through WinRT and nothing
//    can override it per process, so the lane runs once and expects the app to
//    follow whatever language the machine is really set to.
//  - Linux: not a QA platform of this repo; the lane skips.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
const FIXTURES = join(WORK, "fixtures");
mkdirSync(FIXTURES, { recursive: true });
writeFileSync(join(FIXTURES, "notes.txt"), "Budget summary for the third quarter.\n");

const failures = [];
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

const HEADLINES = { ko: "파일에게", en: "Ask your", ja: "ファイルに", zh: "向文件" };
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
const resolve = (tags) => tags.map((tag) => tag.split(/[-_.@]/u)[0].toLowerCase()).find((tag) => tag in HEADLINES) ?? "en";
const STEPS = ["welcome", "permissions", "account", "folders", "embedding", "sources", "plan", "model"];

/** Latin words a translated screen may keep: product and brand names, file names, keys, units, and the OS terms that stay in English. */
const ALLOWED = new Set(
	[
		"Dazzi", "AutoRAG", "powered", "AI", "API", "BYOK", "Pro", "Air", "Free", "Mac", "PC", "Windows", "macOS", "Finder", "Space", "Quick", "Look",
		"Slack", "Discord", "Telegram", "WhatsApp", "GitHub", "Obsidian", "KakaoTalk", "Google", "Drive", "Notion", "OpenAI", "Anthropic",
		"OpenRouter", "Ollama", "Vault", "Issues", "Pull", "Requests", "Search", "mailcrawl", "node", "modules", "git", "MiB", "GB", "MB",
		"proposal", "final", "docx", "xlsx", "budget", "pdf", "report", "old", "draft", "https", "example", "com", "OCR", "ID", "URL",
		"Ctrl", "Enter", "Esc", "Desktop", "Documents", "HTTP", "BASE", "key", "Claude", "Gemini", "GPT", "OpenAI",
	].map((word) => word.toLowerCase()),
);

function draft(stepId) {
	return {
		version: 1,
		stepId,
		notifications: false,
		network: false,
		launchAtLogin: false,
		folders: [{ path: FIXTURES, selected: true }],
		embed: "none",
		sources: [],
		plan: stepId === "model" ? "byok" : "free",
		planConfirmed: false,
		model: null,
	};
}

for (const { os, lang: injected } of CASES) {
	const userDataDir = join(WORK, `profile-${os}`);
	const env = { AUTORAG_HOME: join(WORK, `home-${os}`), AUTORAG_CONFIG: join(WORK, `config-${os}`, "config.json"), AUTORAG_SKIP_DUPEY_CHECK: "1" };
	for (const step of STEPS) {
		mkdirSync(join(userDataDir, "onboarding"), { recursive: true });
		writeFileSync(join(userDataDir, "onboarding", "state.json"), `${JSON.stringify({ completed: false, draft: draft(step) })}\n`);
		const app = await launchFinder({ userDataDir, env, onboarding: true, language: null, args: injected === null ? [] : ["-AppleLanguages", `(${os})`] });
		try {
			const page = await finderWindow(app, 20_000);
			await page.waitForSelector(".onb .screen", { timeout: 20_000 });
			const lang = injected ?? resolve(await app.evaluate(({ app: electron }) => electron.getPreferredSystemLanguages()));
			const headline = HEADLINES[lang];
			// Let the step's own probes (sources, embedding facts) render their copy.
			await page.waitForTimeout(step === "sources" ? 2500 : 700);
			const label = `${os}/${step}`;
			// Folder names and paths are real directories on this machine, not app copy.
			await page.evaluate(() => document.querySelectorAll(".onb .folder-name, .onb .folder-path").forEach((node) => node.remove()));
			const text = (await page.locator(".onb").innerText()).replace(/\s+/g, " ").trim();
			const htmlLang = await page.evaluate(() => document.documentElement.lang);
			if (step === "welcome") {
				check(`${label}: welcome headline is in ${lang}`, (await page.locator(".onb .screen h1").first().innerText()).replace(/\s+/g, "").includes(headline.replace(/\s+/g, "")), text.slice(0, 80));
				const stored = await page.evaluate(() => window.autorag.settings.get().then((settings) => settings.language));
				check(`${label}: the settings report ${lang}`, stored === lang, stored);
			}
			check(`${label}: <html lang> is ${lang}`, htmlLang === lang, htmlLang);
			if (lang !== "ko") check(`${label}: no Korean on screen`, !/[\uac00-\ud7a3]/u.test(text), text.match(/\S*[\uac00-\ud7a3]\S*/u)?.[0] ?? "");
			if (lang !== "en") {
				// Whole words only: file names (proposal-final.docx, report-q3.pdf) and paths are sample data, not copy.
				const words = text.split(/\s+/u).map((token) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")).filter((token) => /^[A-Za-z]{4,}$/u.test(token));
				const foreign = [...new Set(words.filter((word) => !ALLOWED.has(word.toLowerCase())))];
				check(`${label}: no untranslated English words`, foreign.length === 0, foreign.join(", "));
			}
			await page.locator(".onb").screenshot({ path: join(EVIDENCE, `${os}-${step}.png`) });
		} catch (error) {
			check(`${os}/${step}: opened`, false, error instanceof Error ? error.message : String(error));
		} finally {
			await app.close().catch(() => undefined);
		}
	}
}

await rmRetry(WORK);
if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall onboarding-language checks passed");
