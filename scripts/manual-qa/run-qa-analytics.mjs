/**
 * Manual QA — usage statistics (opt-in, anonymous, content-free).
 *
 * Drives the built app against a local PostHog-compatible capture server and
 * proves, over real HTTP from a real Electron process:
 *   A. a fresh profile sends nothing and creates no install id (default off);
 *   B. turning "Send Usage Statistics" on in Settings starts sending: the
 *      toggle change, Settings pages visited, and an AI search that carries a
 *      canary query — and the canary, the home and profile paths, and the host
 *      name appear nowhere in what was sent;
 *   C. a relaunch keeps the same anonymous id and sends `app_opened`;
 *   D. turning it off deletes the id and sends nothing more (not even what was
 *      still queued); turning it on again starts a different id;
 *   F. onboarding's welcome checkboxes (usage statistics and error reports) are
 *      ticked by default, save nothing until the user continues, save each box's
 *      value when continuing, and an unticked box stays off;
 *   E. only `/batch/` is ever requested (no flags, config or decide traffic).
 * The capture server stands in for PostHog through the unpackaged-run override
 * `AUTORAG_ANALYTICS_KEY` / `AUTORAG_ANALYTICS_HOST`. No model key is needed.
 * Run `bun run build` first. Evidence lands in `$QA_OUT` or `.omo/evidence/`.
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { AI_PANEL, finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const OUT = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/analytics");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, timeoutMs, label) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(100);
	}
}

// ── the capture server ──────────────────────────────────────────────────────
const requests = [];
const server = createServer((request, response) => {
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		const raw = Buffer.concat(chunks);
		const body = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw;
		requests.push({ method: request.method, path: (request.url ?? "").split("?")[0], text: body.toString("utf8") });
		response.writeHead(200, { "content-type": "application/json" });
		response.end('{"status":1}');
	});
});
const listening = Promise.withResolvers();
server.listen(0, "127.0.0.1", listening.resolve);
await listening.promise;
const PORT = server.address().port;

const sentEvents = () =>
	requests
		.filter((entry) => entry.path === "/batch/")
		.flatMap((entry) => JSON.parse(entry.text).batch)
		.map((event) => ({ name: event.event, id: event.distinct_id, properties: event.properties }));
const countBefore = () => sentEvents().length;

// ── fixtures ────────────────────────────────────────────────────────────────
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-analytics-")));
const HOME = join(WORK, "home");
mkdirSync(HOME, { recursive: true });
const CANARY = "CANARY-분기매출-9f3a";
const launch = (profile, language, onboarding = false) =>
	launchFinder({
		userDataDir: profile,
		language,
		onboarding,
		env: { ...homeEnv(HOME), AUTORAG_ANALYTICS_KEY: "phc_qa_local", AUTORAG_ANALYTICS_HOST: `http://127.0.0.1:${PORT}` },
	});
const idFile = (profile) => join(profile, "analytics", "install-id");
const savedSettings = (profile) => JSON.parse(readFileSync(join(profile, "settings", "settings-state.json"), "utf8")).settings;

async function openSettings(page) {
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector(".settings-panel");
}
const switchFor = (page, label) => page.locator(".linear-row", { hasText: label }).locator('[role="switch"]');
async function gotoPage(page, label) {
	await page.locator(".settings-nav-item", { hasText: label }).click();
	await sleep(250);
}

// ── A. default off, Korean ──────────────────────────────────────────────────
const profileA = join(WORK, "profile-a");
{
	const app = await launch(profileA, "ko");
	const page = await finderWindow(app);
	await page.waitForSelector(".sidebar__item");
	await openSettings(page);
	const toggle = switchFor(page, "사용 통계 보내기");
	await toggle.waitFor();
	check("A: the usage-statistics switch is off on a fresh profile", (await toggle.getAttribute("data-state")) === "unchecked");
	check("A: the error-report switch is a separate switch", (await switchFor(page, "오류 보고서 보내기").count()) === 1);
	await toggle.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await sleep(300);
	await page.screenshot({ path: join(OUT, "a-ko-default-off.png") });
	await gotoPage(page, "AI 모델");
	await gotoPage(page, "인덱싱");
	await app.close();
}
check("A: nothing was sent while off", requests.length === 0, `${requests.length} request(s)`);
check("A: no install id was created", !existsSync(idFile(profileA)));

// ── B. opt in, English ──────────────────────────────────────────────────────
const profileB = join(WORK, "profile-b");
let idB = "";
{
	const app = await launch(profileB, "en");
	const page = await finderWindow(app);
	await page.waitForSelector(".sidebar__item");
	await openSettings(page);
	const toggle = switchFor(page, "Send Usage Statistics");
	await toggle.waitFor();
	check("B: the switch starts off in English too", (await toggle.getAttribute("data-state")) === "unchecked");
	await toggle.evaluate((element) => element.scrollIntoView({ block: "center" }));
	await page.screenshot({ path: join(OUT, "b-en-before.png") });
	await toggle.click();
	await until(() => savedSettings(profileB).usageAnalytics === true, 5000, "the opt-in to be saved");
	await until(async () => (await toggle.getAttribute("data-state")) === "checked", 5000, "the switch to render as on");
	check("B: the click turns the switch on", (await toggle.getAttribute("data-state")) === "checked");
	check("B: the error-report setting is unchanged", savedSettings(profileB).errorReporting !== true);
	await page.screenshot({ path: join(OUT, "b-en-on.png") });
	await gotoPage(page, "AI Models");
	await gotoPage(page, "Indexing");
	await gotoPage(page, "General");
	await switchFor(page, "Show Hidden Files").click();
	await sleep(400);
	await page.locator(".sidebar__item", { hasText: "AI Search" }).click();
	const composer = page.locator(`${AI_PANEL} input[aria-label="Ask Dazzi"]`);
	await composer.waitFor();
	await composer.fill(CANARY);
	await composer.press("Enter");
	await sleep(4000);
	await app.close();
}
{
	const events = sentEvents();
	const names = events.map((event) => event.name);
	console.log(`B events: ${names.join(", ")}`);
	idB = events[0]?.id ?? "";
	check("B: events arrived at the capture server", events.length > 0);
	const find = (name, match) => events.find((event) => event.name === name && Object.entries(match).every(([key, value]) => event.properties[key] === value));
	check("B: the opt-in itself was reported", find("settings_changed", { setting: "usageAnalytics", value: "on" }) !== undefined);
	check("B: the AI Models page view was reported", find("settings_page_viewed", { page: "ai" }) !== undefined);
	check("B: the Indexing page view was reported", find("settings_page_viewed", { page: "indexing" }) !== undefined);
	check("B: a setting change was reported by name only", find("settings_changed", { setting: "showHiddenFiles", value: "on" }) !== undefined);
	check("B: the AI search start was reported without its content", find("ai_search_started", { has_attachments: false, follow_up: false }) !== undefined);
	check("B: the AI search end was reported", names.includes("ai_search_finished"), JSON.stringify(events.find((event) => event.name === "ai_search_finished")?.properties));
	check("B: one anonymous id for every event", new Set(events.map((event) => event.id)).size === 1);
	check("B: the id is a random uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(idB), idB);
	check("B: the id file on disk is that id", existsSync(idFile(profileB)) && readFileSync(idFile(profileB), "utf8").trim() === idB);
	check("B: no person profile is built", events.every((event) => event.properties.$process_person_profile === false));
	check("B: geo lookup is off", events.every((event) => event.properties.$geoip_disable === true));
	const allowed = /^(has_attachments|follow_up|outcome|deepened|duration|setting|value|page|app_version|platform|arch|packaged|language|\$lib|\$lib_version|\$is_server|\$process_person_profile|\$geoip_disable)$/u;
	const stray = events.flatMap((event) => Object.keys(event.properties)).filter((key) => !allowed.test(key));
	check("B: events hold only allowlisted property names", stray.length === 0, stray.join(", "));
	const wire = requests.map((entry) => entry.text).join("\n");
	for (const [label, needle] of [
		["the canary query", CANARY],
		["the home path", HOME],
		["the profile path", profileB],
		["the host name", hostname()],
		["the user name", process.env.USER ?? process.env.USERNAME ?? "\u0000none"],
	]) {
		check(`B: ${label} is nowhere in what was sent`, !wire.includes(needle));
	}
}

// ── C. relaunch keeps the id ────────────────────────────────────────────────
{
	const before = countBefore();
	const app = await launch(profileB, "en");
	const page = await finderWindow(app);
	await page.waitForSelector(".sidebar__item");
	await sleep(1500);
	await app.close();
	const fresh = sentEvents().slice(before);
	check("C: relaunch sends app_opened", fresh.some((event) => event.name === "app_opened"), fresh.map((event) => event.name).join(", "));
	check("C: relaunch reuses the same anonymous id", fresh.length > 0 && fresh.every((event) => event.id === idB));
}

// ── D. opt out deletes the id and silences everything ───────────────────────
{
	const before = countBefore();
	const app = await launch(profileB, "en");
	const page = await finderWindow(app);
	await page.waitForSelector(".sidebar__item");
	await openSettings(page);
	const toggle = switchFor(page, "Send Usage Statistics");
	await toggle.waitFor();
	check("D: the opt-in survived the relaunch", (await toggle.getAttribute("data-state")) === "checked");
	await toggle.click();
	await until(() => savedSettings(profileB).usageAnalytics === false, 5000, "the opt-out to be saved");
	await until(async () => (await toggle.getAttribute("data-state")) === "unchecked", 5000, "the switch to render as off");
	await sleep(1000);
	check("D: the switch still shows off a moment after the opt-out", (await toggle.getAttribute("data-state")) === "unchecked", await toggle.getAttribute("data-state"));
	await page.screenshot({ path: join(OUT, "d-en-off.png") });
	check("D: the id file is deleted at once", !existsSync(idFile(profileB)));
	await gotoPage(page, "AI Models");
	await gotoPage(page, "Indexing");
	await app.close();
	check("D: nothing at all was sent after the opt-out, queued events included", sentEvents().length === before, `${sentEvents().length - before} event(s)`);
	check("D: no id file was recreated", !existsSync(idFile(profileB)));
}

// ── D2. opt in again: a new identity ────────────────────────────────────────
{
	const before = countBefore();
	const app = await launch(profileB, "en");
	const page = await finderWindow(app);
	await page.waitForSelector(".sidebar__item");
	await openSettings(page);
	const toggle = switchFor(page, "Send Usage Statistics");
	await toggle.click();
	await until(() => savedSettings(profileB).usageAnalytics === true, 5000, "the second opt-in to be saved");
	await gotoPage(page, "Indexing");
	await app.close();
	const fresh = sentEvents().slice(before);
	check("D2: events flow again after opting back in", fresh.length > 0);
	check("D2: the new id is not the old one", fresh.length > 0 && fresh.every((event) => event.id !== idB));
}

// ── F. onboarding: the welcome checkboxes are the consent ───────────────────
// Both are ticked by default; the choice is saved only when the user continues, as each box stands.
const consentBoxes = (page) => page.locator(".onb .usage-consent input");
const boxStates = async (page) => [await consentBoxes(page).nth(0).isChecked(), await consentBoxes(page).nth(1).isChecked()];
const welcome = async (profile, language) => {
	const app = await launch(profile, language, true);
	const page = await finderWindow(app, 20_000);
	await consentBoxes(page).first().waitFor({ timeout: 20_000 });
	await sleep(900); // the step fades in
	return { app, page };
};

// F1: Korean, look and leave without continuing.
const profileF1 = join(WORK, "profile-f1");
{
	const before = countBefore();
	const { app, page } = await welcome(profileF1, "ko");
	check("F1: there are two privacy checkboxes", (await consentBoxes(page).count()) === 2);
	check("F1: both checkboxes are ticked by default", (await boxStates(page)).every(Boolean), JSON.stringify(await boxStates(page)));
	check("F1: each links to the privacy policy", (await page.locator(".onb .usage-consent .inline-link").count()) === 2);
	await page.screenshot({ path: join(OUT, "f1-ko-welcome-ticked-by-default.png") });
	await app.close();
	check("F1: closing the window without continuing saves no consent", savedSettings(profileF1).usageAnalytics !== true && savedSettings(profileF1).errorReporting !== true);
	check("F1: nothing was sent and no id was created", sentEvents().length === before && !existsSync(idFile(profileF1)));
}

// F2: continue with both boxes as they come.
const profileF2 = join(WORK, "profile-f2");
{
	const before = countBefore();
	const { app, page } = await welcome(profileF2, "ko");
	check("F2: nothing is saved before continuing", savedSettings(profileF2).usageAnalytics !== true && savedSettings(profileF2).errorReporting !== true);
	await page.locator(".onb .footer button.primary").click();
	await until(() => savedSettings(profileF2).usageAnalytics === true && savedSettings(profileF2).errorReporting === true, 5000, "the onboarding consent to be saved");
	check("F2: continuing with the default boxes turns usage statistics on", savedSettings(profileF2).usageAnalytics === true);
	check("F2: continuing with the default boxes turns error reports on", savedSettings(profileF2).errorReporting === true);
	await sleep(1500);
	await app.close();
	const fresh = sentEvents().slice(before);
	check("F2: the consent itself is reported once it is given", fresh.some((event) => event.name === "settings_changed" && event.properties.setting === "usageAnalytics" && event.properties.value === "on"), fresh.map((event) => event.name).join(", "));
}

// F3: untick both, then continue: both stay off and nothing is sent.
const profileF3 = join(WORK, "profile-f3");
{
	const before = countBefore();
	const { app, page } = await welcome(profileF3, "en");
	await consentBoxes(page).nth(0).uncheck();
	await consentBoxes(page).nth(1).uncheck();
	check("F3: both boxes can be unticked", (await boxStates(page)).every((state) => !state), JSON.stringify(await boxStates(page)));
	await page.screenshot({ path: join(OUT, "f3-en-welcome-unticked.png") });
	await page.locator(".onb .footer button.primary").click();
	await until(() => savedSettings(profileF3).usageAnalytics === false && savedSettings(profileF3).errorReporting === false, 5000, "the declined choices to be saved");
	await sleep(1500);
	await app.close();
	check("F3: unticking both keeps usage statistics off", savedSettings(profileF3).usageAnalytics === false);
	check("F3: unticking both keeps error reports off", savedSettings(profileF3).errorReporting === false);
	check("F3: nothing was sent and no id was created", sentEvents().length === before && !existsSync(idFile(profileF3)));
}

// F4: untick only usage statistics: the two choices are independent.
const profileF4 = join(WORK, "profile-f4");
{
	const before = countBefore();
	const { app, page } = await welcome(profileF4, "en");
	await consentBoxes(page).nth(0).uncheck();
	check("F4: only the usage box changed", JSON.stringify(await boxStates(page)) === "[false,true]", JSON.stringify(await boxStates(page)));
	await page.locator(".onb .footer button.primary").click();
	await until(() => savedSettings(profileF4).errorReporting === true, 5000, "the error-report choice to be saved");
	await sleep(1500);
	await app.close();
	check("F4: usage statistics stay off", savedSettings(profileF4).usageAnalytics === false);
	check("F4: error reports are on", savedSettings(profileF4).errorReporting === true);
	check("F4: no usage events were sent and no id was created", sentEvents().length === before && !existsSync(idFile(profileF4)));
}

// ── E. the only traffic is event batches ────────────────────────────────────
const paths = [...new Set(requests.map((entry) => `${entry.method} ${entry.path}`))];
check("E: only POST /batch/ was ever requested", paths.length === 1 && paths[0] === "POST /batch/", paths.join(" | "));

server.close();
rmSync(WORK, { recursive: true, force: true });
if (failures.length > 0) {
	console.log(`\nFAILED: ${failures.length} check(s)\n- ${failures.join("\n- ")}`);
	process.exitCode = 1;
} else {
	console.log("\nPASS: usage statistics are anonymous and content-free, and the onboarding checkboxes behave as chosen");
}
