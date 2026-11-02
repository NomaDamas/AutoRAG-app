/**
 * Manual QA — the sidebar's Discord attachments row (issue #377) on the real built app.
 *
 * A throwaway HOME holds an AutoRAG config with Discord connections and the attachment folders the
 * librarian writes (`<AUTORAG_HOME>/attachments/discord/<connection>/<server>/<channel>/<file>` next to
 * `download-status.json`, `.discrawl/` and `.lock/`). With the app running, real mouse and keyboard input
 * proves:
 *   1. a connection whose sync saved nothing (only the bookkeeping) has no Discord row;
 *   2. the first attachment landing makes the row appear without a restart, in its own `Connections` group (not Cloud);
 *   3. clicking the row opens the connection folder, and the listing shows the server folder but not
 *      `download-status.json`, `.discrawl` or `.lock`; the server and channel folders open and list the files;
 *   4. a file-name search for a name shared by an attachment and the bookkeeping returns only the attachment;
 *   5. the sync rewriting its status file while the folder is open never adds that file to the listing;
 *   6. a second connection with files turns the rows into "Discord - <name>", each opening its own folder;
 *   7. switching a connection off in the config removes its row and switching it back on restores it;
 *   8. the row reads the same in Korean.
 *
 * The file-name index is pointed at an empty XDG dir so the disk walk answers.
 *
 * Run from the repo root:  bun run build && bun run qa script --vm --skip-build scripts/manual-qa/run-qa-finder-discord-attachments.mjs
 * Evidence lands in QA_OUT/discord-attachments, else the ignored `.omo/` tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { homeEnv } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ? join(process.env.QA_OUT, "discord-attachments") : join(ROOT, ".omo/evidence/ai-finder-app/qa-discord-attachments");
rmSync(EVIDENCE, { recursive: true, force: true });
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const home = mkdtempSync(join(tmpdir(), "qa-discord-home-"));
const userDataDir = mkdtempSync(join(tmpdir(), "qa-discord-data-"));
const xdg = mkdtempSync(join(tmpdir(), "qa-discord-xdg-"));
const autorag = join(home, ".autorag");
const configPath = join(autorag, "config.json");
const folderOf = (connection) => join(autorag, "attachments", "discord", connection);

const writeConfig = (datasources) => {
	mkdirSync(autorag, { recursive: true });
	writeFileSync(configPath, `${JSON.stringify({ datasources })}\n`);
};
/** What a sync that downloaded nothing still leaves. */
const writeBookkeeping = (connection) => {
	mkdirSync(join(folderOf(connection), ".discrawl", "logs"), { recursive: true });
	mkdirSync(join(folderOf(connection), ".lock"), { recursive: true });
	writeFileSync(join(folderOf(connection), ".discrawl", "config.toml"), "version = 1\n");
	writeFileSync(join(folderOf(connection), "download-status.json"), '{"version":1}\n');
};
const saveAttachment = (connection, server, channel, name, body = "attachment\n") => {
	const dir = join(folderOf(connection), server, channel);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), body);
};

// The home the app starts with: Documents for the usual favorites, one connection that saved nothing yet.
for (const dir of ["Desktop", "Documents", "Downloads"]) mkdirSync(join(home, dir), { recursive: true });
writeConfig({ nomadamas: { type: "discord", enabled: true } });
writeBookkeeping("nomadamas");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let app;
try {
	app = await launchFinder({ userDataDir, env: { ...homeEnv(home), AUTORAG_HOME: "", AUTORAG_CONFIG: "", XDG_DATA_HOME: xdg } });
	const page = await finderWindow(app);
	page.setDefaultTimeout(10_000);
	page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 200)}`));
	await page.waitForSelector(".sidebar__item", { timeout: 30_000 });

	// The group heading is translated, the row's Discord label is not: find the row by its own text.
	const discordRows = () => page.locator(".sidebar__item").filter({ hasText: /^Discord/ });
	const rowLabels = () => page.locator('[role="row"] .row__label').allInnerTexts();
	const rowNames = async () => (await rowLabels()).map((name) => name.trim()).sort();
	const waitForRows = async (expected, timeoutMs = 15_000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const labels = (await discordRows().allInnerTexts()).map((text) => text.trim()).sort();
			if (JSON.stringify(labels) === JSON.stringify([...expected].sort())) return labels;
			if (Date.now() >= deadline) return labels;
			await sleep(250);
		}
	};
	const waitForListing = async (predicate, timeoutMs = 10_000) => {
		const deadline = Date.now() + timeoutMs;
		let names = await rowNames();
		while (!predicate(names) && Date.now() < deadline) {
			await sleep(250);
			names = await rowNames();
		}
		return names;
	};
	const listingTitle = () => page.locator(".toolbar-title").first().innerText();

	// 1. Bookkeeping alone is not an attachment.
	await sleep(3000); // two polls of the worker's signature
	check("a connection that saved nothing has no Discord row", (await discordRows().count()) === 0, JSON.stringify(await discordRows().allInnerTexts()));
	await page.screenshot({ path: join(EVIDENCE, "01-no-row.png") });

	// 2. The first attachment makes the row appear, with no restart and no reload.
	saveAttachment("nomadamas", "Guild 1512354544628011068", "general", "status-report.pdf");
	saveAttachment("nomadamas", "Guild 1512354544628011068", "random", "photo.png");
	check("the first saved attachment adds the Discord row", JSON.stringify(await waitForRows(["Discord"])) === JSON.stringify(["Discord"]), JSON.stringify(await discordRows().allInnerTexts()));
	check("the row carries the connection folder as its tooltip", (await discordRows().first().locator("xpath=ancestor-or-self::button").getAttribute("title")) === folderOf("nomadamas"), await discordRows().first().locator("xpath=ancestor-or-self::button").getAttribute("title"));
	await page.screenshot({ path: join(EVIDENCE, "02-row.png") });
	// The row is in its own Connections group, not in Cloud, and that group sits above Locations.
	const groupOfRow = await discordRows().first().evaluate((node) => node.closest(".side-group")?.querySelector(".side-label")?.textContent ?? null);
	check("the row sits in its own `Connections` group", groupOfRow === "Connections", String(groupOfRow));
	const groupLabels = await page.locator(".side-group .side-label").allInnerTexts();
	check("the groups read Favorites, Connections, Locations (no Cloud group is added for it)", JSON.stringify(groupLabels.filter((label) => ["Favorites", "Cloud", "Connections", "Locations"].includes(label))) === JSON.stringify(["Favorites", "Connections", "Locations"]), JSON.stringify(groupLabels));
	await page.locator(".side-group").filter({ has: page.locator(".side-label", { hasText: "Connections" }) }).screenshot({ path: join(EVIDENCE, "02-connections-group.png") });

	// 3. Clicking the row opens the folder without the sync's own entries.
	await discordRows().first().click();
	const top = await waitForListing((names) => names.length > 0);
	check("the row opens the connection folder", (await listingTitle()).includes("nomadamas"), await listingTitle());
	check("the listing shows the server folder and hides download-status.json, .discrawl and .lock", JSON.stringify(top) === JSON.stringify(["Guild 1512354544628011068"]), JSON.stringify(top));
	await page.screenshot({ path: join(EVIDENCE, "03-connection-folder.png") });

	await page.locator('[role="row"]').filter({ hasText: "Guild 1512354544628011068" }).first().dblclick();
	const channels = await waitForListing((names) => names.includes("general"));
	check("the server folder lists its channels", JSON.stringify(channels) === JSON.stringify(["general", "random"]), JSON.stringify(channels));
	await page.locator('[role="row"]').filter({ hasText: "general" }).first().dblclick();
	const files = await waitForListing((names) => names.includes("status-report.pdf"));
	check("a channel folder lists the attachments", JSON.stringify(files) === JSON.stringify(["status-report.pdf"]), JSON.stringify(files));
	await page.screenshot({ path: join(EVIDENCE, "04-channel.png") });

	// 3b. An attachment previews like any file: select it and open Quick Look with Space.
	await page.locator('[role="row"]').filter({ hasText: "status-report.pdf" }).first().click();
	await page.keyboard.press("Space");
	await sleep(1200);
	await page.screenshot({ path: join(EVIDENCE, "05-quick-look.png") });
	await page.keyboard.press("Escape");

	// 4. File-name search skips the bookkeeping, finds the attachment.
	const search = page.locator(".side-search input");
	const commit = async (query) => {
		await search.click();
		await search.fill(query);
		await search.press("Enter");
		await page.waitForSelector(".scope", { timeout: 10_000 });
		await page.waitForFunction(() => document.querySelectorAll('[role="row"] .row__label').length > 0, null, { timeout: 8000 }).catch(() => undefined);
		await sleep(1500);
		return rowNames();
	};
	const status = await commit("status");
	check("searching `status` finds the attachment but not download-status.json", JSON.stringify(status) === JSON.stringify(["status-report.pdf"]), JSON.stringify(status));
	await page.screenshot({ path: join(EVIDENCE, "06-search-status.png") });
	const bookkeeping = [...(await commit("discrawl")), ...(await commit("config.toml")), ...(await commit("logs"))];
	check("searching the bookkeeping's own names finds nothing", bookkeeping.length === 0, JSON.stringify(bookkeeping));

	// 5. Back to the connection folder; a rewritten status file never shows up.
	// While the search field has focus its scope chips push the rows below it down by one chip row, and they unmount on
	// blur. Record what a click on a built-in row (control) and on the Discord row does in that state, then leave the
	// field the way a user does and click the row again.
	await page.locator(".sidebar__item", { hasText: /^Documents$/ }).click();
	await sleep(600);
	console.log(`NOTE control: first click on Documents while the search field has focus: title=${await listingTitle()}`);
	await commit("logs");
	await discordRows().first().click();
	await sleep(600);
	console.log(`NOTE first click on the Discord row while the search field has focus: title=${await listingTitle()}`);
	await page.locator(".toolbar-title").first().click();
	await sleep(400);
	await discordRows().first().click();
	const reopened = await waitForListing((names) => names.includes("Guild 1512354544628011068"));
	check("the row reopens the connection folder after a search", JSON.stringify(reopened) === JSON.stringify(["Guild 1512354544628011068"]) && (await listingTitle()).includes("nomadamas"), `${JSON.stringify(reopened)} title=${await listingTitle()}`);
	await page.screenshot({ path: join(EVIDENCE, "06b-reopened.png") });
	for (let index = 0; index < 4; index += 1) {
		writeFileSync(join(folderOf("nomadamas"), "download-status.json"), `{"version":1,"run":${index}}\n`);
		await sleep(400);
	}
	await sleep(1500);
	check("a status file rewritten while the folder is open does not appear", JSON.stringify(await rowNames()) === JSON.stringify(["Guild 1512354544628011068"]), JSON.stringify(await rowNames()));
	// A file the user drops there still shows.
	writeFileSync(join(folderOf("nomadamas"), "my-notes.txt"), "mine\n");
	check("a file the user adds to the folder appears", JSON.stringify(await waitForListing((names) => names.includes("my-notes.txt"))) === JSON.stringify(["Guild 1512354544628011068", "my-notes.txt"]), JSON.stringify(await rowNames()));

	// 6. A second connection with attachments: each row names its connection.
	writeConfig({ nomadamas: { type: "discord", enabled: true }, friends: { type: "discord" } });
	writeBookkeeping("friends");
	saveAttachment("friends", "DM", "alice", "hello.txt");
	const both = await waitForRows(["Discord - nomadamas", "Discord - friends"]);
	check("two connections read `Discord - <name>`", JSON.stringify(both) === JSON.stringify(["Discord - friends", "Discord - nomadamas"]), JSON.stringify(both));
	await page.locator(".sidebar__item").filter({ hasText: "Discord - friends" }).click();
	const friends = await waitForListing((names) => names.includes("DM"));
	check("the second row opens its own folder", JSON.stringify(friends) === JSON.stringify(["DM"]) && (await listingTitle()).includes("friends"), `${JSON.stringify(friends)} ${await listingTitle()}`);
	await page.screenshot({ path: join(EVIDENCE, "07-two-connections.png") });

	// 7. Switching a connection off removes its row; back on restores it. Files stay on disk throughout.
	writeConfig({ nomadamas: { type: "discord", enabled: false }, friends: { type: "discord" } });
	check("disabling a connection removes its row", JSON.stringify(await waitForRows(["Discord"])) === JSON.stringify(["Discord"]), JSON.stringify(await discordRows().allInnerTexts()));
	writeConfig({ nomadamas: { type: "discord", enabled: true }, friends: { type: "discord" } });
	check("enabling it again restores the row", JSON.stringify(await waitForRows(["Discord - nomadamas", "Discord - friends"])) === JSON.stringify(["Discord - friends", "Discord - nomadamas"]), JSON.stringify(await discordRows().allInnerTexts()));
	writeConfig({ nomadamas: { type: "discord", enabled: true } });
	check("removing a connection drops its row, one left reads `Discord`", JSON.stringify(await waitForRows(["Discord"])) === JSON.stringify(["Discord"]), JSON.stringify(await discordRows().allInnerTexts()));

	// 8. Korean.
	await page.locator(".sidebar__item--settings").click();
	await page.waitForSelector('select[aria-label="App Language"]', { timeout: 15_000 }).catch(async () => {
		await page.locator(".settings-nav-item", { hasText: "General" }).click();
		await page.waitForSelector('select[aria-label="App Language"]', { timeout: 15_000 });
	});
	await page.selectOption('select[aria-label="App Language"]', "ko");
	await page.waitForFunction(() => document.querySelector(".sidebar__item--settings")?.getAttribute("aria-label") === "설정", null, { timeout: 10_000 });
	const korean = (await discordRows().allInnerTexts()).map((text) => text.trim());
	check("the row keeps its product name in Korean", JSON.stringify(korean) === JSON.stringify(["Discord"]), JSON.stringify(korean));
	const koreanGroup = await discordRows().first().evaluate((node) => node.closest(".side-group")?.querySelector(".side-label")?.textContent ?? null);
	check("its group reads `연결` in Korean", koreanGroup === "연결", String(koreanGroup));
	await page.screenshot({ path: join(EVIDENCE, "08-korean.png") });
} catch (error) {
	console.error(`capture failed: ${String(error).slice(0, 600)}`);
	failures.push("harness error");
} finally {
	await app?.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
	rmSync(xdg, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nRESULT: ALL PASS" : `\nRESULT: ${failures.length} FAILURES: ${failures.join(" | ")}`);
console.log(`evidence: ${EVIDENCE}`);
process.exitCode = failures.length === 0 ? 0 : 1;
