/**
 * Live E2E QA — First-run onboarding fallback when target folders have 0 or tiny (<200 char) files.
 *
 * Verifies that when indexing genuinely finishes (`result.ok === true`) on a brand-new or lightly
 * populated computer where no personalized question can be synthesized, onboarding:
 *   1. Reaches `stage === "ready"` (`progress === 100`) instead of failing with "Setup paused".
 *   2. Populates `status.demo` with `{ fallback: true, question: <localized default> }`.
 *   3. Opens the Ready screen ("Start Dazzi") -> transitions to the Tour -> types the default
 *      example question into the AI composer AND shows the fallback coach copy explaining that
 *      there weren't enough files for a custom question.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFinder, onboardingWindow } from "./launch-finder.mjs";
import { homeEnv, sleep } from "./platform.mjs";

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const work = realpathSync(mkdtempSync(join(tmpdir(), "qa-onboarding-fallback-")));
const home = join(work, "home");
const userDataDir = join(work, "user-data");
const configPath = join(work, "config.json");
for (const dir of ["Desktop", "Documents", "Downloads"]) {
	mkdirSync(join(home, dir), { recursive: true });
}
// Put only tiny (<200 char) notes — the exact condition of a fresh/sparse PC that previously stuck on "Setup paused"!
writeFileSync(join(home, "Documents", "memo.txt"), "짧은 메모 한 줄.\n");
writeFileSync(join(home, "Downloads", "todo.md"), "# 할 일\n- 우유 사기\n");

const app = await launchFinder({
	userDataDir,
	onboarding: true,
	language: "ko",
	env: {
		...homeEnv(home),
		AUTORAG_ONBOARDING_FIXTURE_HOME: home,
		AUTORAG_HOME: work,
		AUTORAG_CONFIG: configPath,
		AUTORAG_SKIP_DUPEY_CHECK: "1",
	},
});

try {
	const page = await onboardingWindow(app, 30_000);
	const pageErrors = [];
	page.on("pageerror", (err) => pageErrors.push(String(err)));

	// Wait for initial folder picker screen and start setup
	const startFoldersBtn = page.locator('[data-action="first-run-read"], .fr-folders button.fr-btn--primary, .fr-btn--primary').first();
	await startFoldersBtn.waitFor({ timeout: 30_000 });
	await startFoldersBtn.click();

	// Poll onboarding status until `ready` or `failed`
	let status = null;
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		status = await page.evaluate(() => window.autorag.onboarding.status());
		if (status.stage === "ready" || status.stage === "failed") break;
		await sleep(500);
	}

	check(
		"sparse-files onboarding reaches stage='ready' instead of 'failed' ('Setup paused')",
		status?.stage === "ready" && status?.progress === 100 && status?.error === null,
		JSON.stringify({ stage: status?.stage, progress: status?.progress, error: status?.error }),
	);
	check(
		"status.demo carries fallback=true and localized Korean default question",
		status?.demo?.fallback === true && (status?.demo?.question ?? "").includes("최근에 저장한 파일"),
		JSON.stringify(status?.demo),
	);

	// Wait for Ready screen button and enter the tour
	const readyStartBtn = page.locator('[data-action="first-run-start"]');
	await readyStartBtn.waitFor({ timeout: 30_000 });
	await readyStartBtn.click();

	// Wait for reveal to finish and Tour coach card + typed fallback question to appear
	let bodyText = "";
	let composerValue = "";
	for (let i = 0; i < 120; i += 1) {
		const probe = await page.evaluate(() => {
			const body = document.body.innerText ?? "";
			const textarea = document.querySelector("[data-ai-tab]:not(.hidden) form.composer textarea");
			return { body, val: textarea instanceof HTMLTextAreaElement ? textarea.value : "" };
		});
		bodyText = probe.body;
		composerValue = probe.val;
		if (bodyText.includes("파일이 적어서 맞춤 질문은 만들지 못했어요") && composerValue.includes("최근에 저장한 파일")) {
			break;
		}
		await sleep(250);
	}

	check(
		"Tour coach card explains custom question could not be built due to few files",
		bodyText.includes("파일이 적어서 맞춤 질문은 만들지 못했어요"),
		bodyText.slice(0, 200),
	);
	check(
		"Tour types the default fallback question into the AI composer",
		composerValue.includes("최근에 저장한 파일들을 정리해서 요약해 줘"),
		composerValue,
	);
	check("zero uncaught page errors", pageErrors.length === 0, JSON.stringify(pageErrors));
} finally {
	await app.close();
	rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
	console.error(`FAILED (${failures.length}): ${failures.join(", ")}`);
	process.exit(1);
}
console.log("ALL ONBOARDING FALLBACK LIVE E2E CHECKS PASSED");
