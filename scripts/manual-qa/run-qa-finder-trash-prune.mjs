import { execSync } from "node:child_process";
/**
 * Manual QA: a trashed duplicate leaves the version stack immediately.
 *
 * Proves, against the real app (production build, isolated userData):
 *  1. the head row carries a stack badge for a real dupey family
 *  2. opening the stack shows the duplicate members as child rows
 *  3. trashing a child removes that row from the stack right away — no waiting
 *     for the next scan — and decrements the badge
 *  4. the persisted snapshot is pruned, so a restart cannot resurrect it
 *  5. the file really moved into the OS Trash
 *
 * Fixture: ~/Downloads/ulw-dupey-trash-qa/ with three byte-identical documents,
 * named uniquely so process-table and Trash checks can never false-positive.
 * (Not ~/Desktop: a Desktop synced into iCloud Drive is not trashed into
 * ~/.Trash, so the Trash assertion would be meaningless there.)
 * Evidence: .omo/evidence/ai-finder-app/dupey-trash-prune/.
 * Run from the repo root after `bun run build`:
 *   bun scripts/manual-qa/run-qa-finder-trash-prune.mjs
 */

import { finderWindow, launchFinder } from "./launch-finder.mjs";
import { baseName, isWindows, rmRetry, scrollFinderList } from "./platform.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const EVIDENCE = join(REPO, ".omo", "evidence", "ai-finder-app", "dupey-trash-prune");
mkdirSync(EVIDENCE, { recursive: true });

/** Windows dupey reconciliation and native trash are slower (issue #59). */
const STACK_BADGE_TIMEOUT = isWindows ? 120_000 : 30_000;
const CHILD_ROW_TIMEOUT = isWindows ? 30_000 : 10_000;

const USER_DATA = join(tmpdir(), "pw-electron-qa-trash-prune");
rmSync(USER_DATA, { recursive: true, force: true });
const SNAPSHOT = join(USER_DATA, "dupey-cache", "version-families.json");

const FIXTURE_DIR = join(homedir(), "Downloads", "ulw-dupey-trash-qa");
const FOLDER = "ulw-dupey-trash-qa";
const MEMBERS = ["quarterly-report.txt", "quarterly-report-copy.txt", "quarterly-report (1).txt"];
/** The duplicate this run sends to the Trash (never the head, by construction). */
const VICTIM = "quarterly-report-copy.txt";
const VICTIM_PATH = join(FIXTURE_DIR, VICTIM);
/**
 * This Mac syncs Desktop & Documents into iCloud Drive, so a file under those
 * roots is trashed into the iCloud Drive Trash instead of ~/.Trash. Downloads
 * is local, but check both rather than assume the volume.
 */
const TRASH_ROOTS = [
	join(homedir(), "Library", "Mobile Documents", ".Trash"),
	join(homedir(), ".Trash"),
];
const windowsRecycleHas = (name) => {
	try {
		const out = execSync(
			'powershell.exe -NoProfile -NonInteractive -Command "(New-Object -ComObject Shell.Application).Namespace(10).Items() | ForEach-Object { $_.Name + \'|\' + $_.ExtendedProperty(\'System.Recycle.DeletedFrom\') }"',
			{ encoding: "utf8" },
		);
		// FolderItem.Name is the shell display name: with "hide known extensions"
		// on (the Windows default) a recycled .txt reports without its extension.
		const stem = name.replace(/\.[^.]+$/, "");
		return out
			.split(/\r?\n/)
			.map((line) => line.trim())
			.some((row) => {
				const [itemName, deletedFrom] = row.split("|");
				if (itemName !== name && itemName !== stem) return false;
				// When the origin is reported it must be this run's fixture folder,
				// so a same-named file trashed earlier from elsewhere cannot pass.
				return deletedFrom === "" || deletedFrom === FIXTURE_DIR;
			});
	} catch {
		return false;
	}
};
const trashedAt = () =>
	process.platform === "win32"
		? (windowsRecycleHas(VICTIM) ? "RecycleBin" : null)
		: (TRASH_ROOTS.find((root) => existsSync(join(root, VICTIM))) ?? null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture() {
	mkdirSync(FIXTURE_DIR, { recursive: true });
	const body = `${"Refund exceptions require director approval before payout. ".repeat(60)}\n`;
	for (const name of MEMBERS) writeFileSync(join(FIXTURE_DIR, name), body, "utf8");
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

async function waitFor(predicate, { timeoutMs, label, stepMs = 250 }) {
	const deadline = Date.now() + timeoutMs;
	let last;
	while (Date.now() < deadline) {
		last = await predicate();
		if (last) return last;
		await sleep(stepMs);
	}
	throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

function check(label, value, expected) {
	const ok = value === expected;
	console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(value)} (expected ${JSON.stringify(expected)})`);
	if (!ok) process.exitCode = 1;
}

/** The family the scan wrote for the fixture folder, if any. */
function fixtureFamily(snapshot) {
	const paths = new Set(MEMBERS.map((name) => join(FIXTURE_DIR, name)));
	return (snapshot?.families ?? []).find(
		(family) => paths.has(family.head) && family.members.some((member) => paths.has(member.path)),
	);
}

/**
 * v7 stack children carry a relation vtag (동일본/유사본/포함본); the old
 * `.row--child` class was removed with the v6 row markup.
 */
const childRows = (page) =>
	page.locator('[role="row"]').filter({ has: page.locator(".vtag", { hasText: /동일본|유사본|포함본/ }) });

fixture();
if (process.platform !== "win32") rmSync(join(homedir(), ".Trash", VICTIM), { force: true });
if (process.platform !== "win32") rmSync(join(homedir(), "Library", "Mobile Documents", ".Trash", VICTIM), { force: true });

const app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
page.setViewportSize({ width: 1440, height: 900 });
await page.waitForSelector('[role="row"]', { timeout: 60_000 });
await page.screenshot({ path: join(EVIDENCE, "0-launch.png") });

// 1. Wait for the cold scan to record the fixture family in the snapshot.
const family = await waitFor(async () => fixtureFamily(readJson(SNAPSHOT)), {
	timeoutMs: 420_000,
	label: "the startup scan to write the fixture family",
});
const head = family.head;
const headName = baseName(head);
console.log("SCAN family:", JSON.stringify({ head, members: family.members.map((m) => m.path) }));

// 2. Navigate into the fixture folder and open the stack. Scoping every
// locator to the head row keeps a neighbouring listing's badge out of the way.
await page.getByRole("button", { name: "Downloads" }).click();
// Downloads can be long and the list virtualizes: sweep it until the fixture
// folder's row is mounted, then open it.
const fixtureRow = page.locator('[role="row"]', { hasText: FOLDER });
await waitFor(async () => (await fixtureRow.count()) > 0 || (await scrollFinderList(page), false), {
	timeoutMs: 60_000,
	label: "the fixture folder row to mount",
});
await fixtureRow.first().dblclick();
const headRow = page.locator('[role="row"]', { hasText: headName });
await headRow.waitFor({ timeout: STACK_BADGE_TIMEOUT });

// v7: the stack toggle is the head row's disclosure button and the count is
// the `.vcount` chip (`.row__stackbadge` was the v6 class).
const badge = headRow.locator(".row__disclosure");
const badgeCount = headRow.locator(".vcount");
const badgeText = async () => (await badgeCount.textContent({ timeout: STACK_BADGE_TIMEOUT }))?.trim() ?? null;
check("badge count before", await badgeText(), `+${family.members.length}`);
await badge.click();
await childRows(page).first().waitFor({ timeout: CHILD_ROW_TIMEOUT });

const childrenBefore = await childRows(page).locator(".row__label").allInnerTexts();
check("child rows before", childrenBefore.length, family.members.length);
check("victim is a child row", childrenBefore.includes(VICTIM), true);
await page.screenshot({ path: join(EVIDENCE, "1-stack-open.png") });

// 3. Trash the duplicate through the real context menu.
const victimRow = childRows(page).filter({ hasText: VICTIM });
await victimRow.click({ button: "right" });
await page.getByRole("menuitem", { name: "휴지통으로 이동" }).click();

// The row must be gone the moment the trash lands — not after the next scan.
const vanished = await waitFor(async () => !(await childRows(page).locator(".row__label").allInnerTexts()).includes(VICTIM), {
	timeoutMs: isWindows ? 15_000 : 5000,
	label: "the trashed duplicate to leave the stack",
	stepMs: 100,
}).catch(() => false);
const childrenAfter = await childRows(page).locator(".row__label").allInnerTexts();
check("trashed row disappeared immediately", vanished, true);
check("child rows after", childrenAfter.length, family.members.length - 1);
check("badge count after", await badgeText(), `+${family.members.length - 1}`);
await page.screenshot({ path: join(EVIDENCE, "2-after-trash.png") });

// 4. The file left its folder, landed in an OS Trash, and the snapshot no
// longer mentions it.
check("file left the fixture folder", existsSync(VICTIM_PATH), false);
const trashRoot = trashedAt();
console.log(`INFO trashed into: ${trashRoot ?? "NOWHERE"}`);
check("file is in an OS Trash", trashRoot !== null, true);
const after = readJson(SNAPSHOT);
const pruned = fixtureFamily(after);
check("snapshot still lists the family", pruned !== undefined, true);
check(
	"snapshot dropped the trashed member",
	(pruned?.members ?? []).some((member) => member.path === VICTIM_PATH),
	false,
);
check("snapshot kept the surviving members", (pruned?.members ?? []).length, family.members.length - 1);

// 5. Restart: the snapshot is the only source, so the deleted row cannot come back.
await app.close();
const relaunch = await launchFinder({ userDataDir: USER_DATA });
const second = await finderWindow(relaunch);
second.setViewportSize({ width: 1440, height: 900 });
await second.waitForSelector('[role="row"]', { timeout: 60_000 });
await second.getByRole("button", { name: "Downloads" }).click();
const relaunchedRow = second.locator('[role="row"]', { hasText: FOLDER });
await waitFor(async () => (await relaunchedRow.count()) > 0 || (await scrollFinderList(second), false), {
	timeoutMs: 60_000,
	label: "the fixture folder row to mount after relaunch",
});
await relaunchedRow.first().dblclick();
await second.locator('[role="row"]', { hasText: baseName(family.head) }).waitFor({ timeout: STACK_BADGE_TIMEOUT });
await second.locator('[role="row"]', { hasText: baseName(family.head) }).locator(".row__disclosure").click();
await childRows(second).first().waitFor({ timeout: CHILD_ROW_TIMEOUT });
const restarted = await childRows(second).locator(".row__label").allInnerTexts();
check("restart does not resurrect the trashed member", restarted.includes(VICTIM), false);
await second.screenshot({ path: join(EVIDENCE, "3-after-restart.png") });
await relaunch.close();

// Cleanup: only this run's own artifacts.
rmRetry(FIXTURE_DIR);
for (const root of TRASH_ROOTS) rmSync(join(root, VICTIM), { force: true });
console.log(`EVIDENCE ${EVIDENCE}`);
console.log(process.exitCode === 1 ? "RESULT FAIL" : "RESULT PASS");
