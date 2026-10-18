import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchFinder, finderWindow, openAiSearch } from "./launch-finder.mjs";
import { chord, rmRetry } from "./platform.mjs";

/**
 * Manual QA & Live E2E — Ask-as-Smart-Folder (Evidence Folder):
 * - Gathers all local evidence files across a multi-turn AI Search session into a
 *   temporary Evidence Folder (symlinks, zero disk duplication).
 * - Opens the Evidence Folder in a new Finder tab on clicking "Evidence Folder"
 *   at the top of the Evidence panel.
 * - Supports Inspector Info, Quick Look preview, inline rename, and copy/paste
 *   (materializing real files at the destination without mutating originals).
 * - Prompts a confirmation modal when closing the Evidence Folder tab; Cancel
 *   keeps the tab and temp folder, Confirm closes the tab and deletes the temp
 *   folder from disk.
 * - Recreates the temp folder when returning to the session history and clicking
 *   "Evidence Folder" again.
 * - Automatically deletes and cleans up the temp folder when navigating away
 *   from the Evidence Folder within that tab.
 * - Verified in both English and Korean UI.
 */

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = process.env.QA_OUT
	? join(process.env.QA_OUT, "qa-evidence-folder")
	: join(ROOT, ".omo/evidence/ai-finder-app/qa-evidence-folder");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const RUN_ID = `ulw-ev-folder-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const DOCS = join(homedir(), "Documents", RUN_ID);
const DEST = join(DOCS, "dest");
const POLICY = join(DOCS, "refund-policy.md");
const MEMO = join(DOCS, "approval-memo.md");
const BUDGET = join(DOCS, "q3-budget.csv");
const POLICY_BODY = "# Refund Policy\n1. Standard refunds settle within 5 business days.\n2. Exceptions require executive sign-off.\n";
const MEMO_BODY = "# Approval Memo\nAttach the full approval chain.\n";
const BUDGET_BODY = "item,amount\nmarketing,380000000\n";

let app;
let swept = false;
const sweep = (patient) => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	for (const dir of [USER_DATA, DOCS]) {
		try {
			if (patient === true) rmRetry(dir);
			else rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			log(`cleanup: ${dir} stayed behind (${error.code ?? error.message})`);
		}
	}
};
process.on("exit", () => sweep(false));

mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
mkdirSync(DEST, { recursive: true });
writeFileSync(POLICY, POLICY_BODY);
writeFileSync(MEMO, MEMO_BODY);
writeFileSync(BUDGET, BUDGET_BODY);

const turn1Evidence = [
	{
		number: 1,
		title: basename(POLICY),
		summary: "Refund policy rules.",
		source: POLICY,
		excerpts: ["1. Standard refunds settle within 5 business days."],
		confidence: 0.94,
	},
	{
		number: 2,
		title: basename(MEMO),
		summary: "Approval chain memo.",
		source: MEMO,
		excerpts: ["Attach the full approval chain."],
		confidence: 0.88,
	},
];

const turn2Evidence = [
	{
		number: 1,
		title: basename(BUDGET),
		summary: "Q3 marketing budget.",
		source: BUDGET,
		excerpts: ["marketing,380000000"],
		confidence: 0.91,
	},
	{
		number: 2,
		title: basename(MEMO),
		summary: "Repeated memo citation.",
		source: MEMO,
		excerpts: ["Attach the full approval chain."],
		confidence: 0.85,
	},
	{
		number: 3,
		title: "Kakao thread",
		summary: "Datasource virtual chunk.",
		source: "/kakao/work/chunks/msg-7",
		excerpts: ["Agreed in thread."],
		confidence: 0.72,
	},
	{
		number: 4,
		title: "Web reference",
		summary: "External web URL.",
		source: "https://example.com/policy",
		excerpts: ["External reference."],
		confidence: 0.65,
	},
];

const record = {
	id: "c-smart-folder-1",
	title: "Q3 refund and budget evidence",
	snippet: "Standard refunds settle within 5 business days.",
	updatedAt: new Date().toISOString(),
	messages: [
		{ role: "user", text: "Summarize the refund policy", attachments: [], at: new Date(Date.now() - 60_000).toISOString() },
		{
			role: "assistant",
			sessionId: "qa-smart-folder-session",
			quick: { answer: "Standard refunds take **5 business days** [1][2].", evidence: turn1Evidence },
			deep: { answer: "## Refund Policy\nStandard refunds take **5 business days** and require the approval memo [1][2].", evidence: turn1Evidence },
			stopped: false,
			at: new Date(Date.now() - 55_000).toISOString(),
		},
		{ role: "user", text: "What about the Q3 marketing budget?", attachments: [], at: new Date(Date.now() - 30_000).toISOString() },
		{
			role: "assistant",
			sessionId: "qa-smart-folder-session",
			quick: { answer: "The Q3 marketing budget is **₩3.8B** [1][2].", evidence: turn2Evidence },
			deep: { answer: "## Q3 Budget\nThe Q3 marketing budget is **₩3.8B** [1][2][3][4].", evidence: turn2Evidence },
			stopped: false,
			at: new Date(Date.now() - 25_000).toISOString(),
		},
		{ role: "user", text: "So what is the bottom-line total?", attachments: [], at: new Date(Date.now() - 10_000).toISOString() },
		{
			role: "assistant",
			sessionId: "qa-smart-folder-session",
			quick: { answer: "The total is **₩3.8B**, settled within 5 business days.", evidence: [] },
			deep: null,
			stopped: false,
			at: new Date(Date.now() - 5_000).toISOString(),
		},
	],
};

writeFileSync(join(USER_DATA, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);

app = await launchFinder({ userDataDir: USER_DATA, language: "en" });
const page = await finderWindow(app);
page.setDefaultTimeout(10_000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);

const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';
const INFO_HALF = '.inspector-half[aria-label="Info"]';
const EV_FOLDER_BTN = `${EVIDENCE_HALF} button[data-action="evidence-folder"]`;

// 1. Load multi-turn chat from History and verify Evidence Folder button in Evidence Panel.
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab`);
await page.locator(EV_FOLDER_BTN).waitFor({ state: "visible" });

const btnText = (await page.locator(EV_FOLDER_BTN).textContent())?.trim() ?? "";
check("Evidence Folder button is visible at the top of the Evidence panel", btnText === "Evidence Folder", `text="${btnText}"`);
await page.screenshot({ path: join(EVIDENCE, "01-evidence-folder-button-en.png") });
await page.locator(EVIDENCE_HALF).screenshot({ path: join(EVIDENCE, "01b-evidence-panel-header.png") });

// 1b. Clicking citation chips in earlier turns (Turn 1 and Turn 2) shows their detailed evidence in the Inspector even when Turn 3 has no citations.
const turn1Prose = page.locator(".assistant-msg .assistant-prose").nth(0);
await turn1Prose.locator(".cite", { hasText: /^1$/ }).first().click();
await page.waitForFunction(
	(sel) => document.querySelector(sel)?.textContent?.includes("refund-policy.md"),
	`${EVIDENCE_HALF} .preview-title`,
);
const turn1EvTitle = (await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent())?.trim() ?? "";
check("Clicking citation [1] in Turn 1 displays Turn 1's evidence in the right panel", turn1EvTitle.includes("refund-policy.md"), `title="${turn1EvTitle}"`);

const turn2Prose = page.locator(".assistant-msg .assistant-prose").nth(2);
await turn2Prose.locator(".cite", { hasText: /^1$/ }).first().click();
await page.waitForFunction(
	(sel) => document.querySelector(sel)?.textContent?.includes("q3-budget.csv"),
	`${EVIDENCE_HALF} .preview-title`,
);
const turn2EvTitle = (await page.locator(`${EVIDENCE_HALF} .preview-title`).textContent())?.trim() ?? "";
check("Clicking citation [1] in Turn 2 displays Turn 2's evidence in the right panel", turn2EvTitle.includes("q3-budget.csv"), `title="${turn2EvTitle}"`);

// 2. Click Evidence Folder button -> opens new tab with temporary Evidence Folder containing all 3 session local files.
const tabsBefore = await page.locator(".tabs .tab").count();
await page.locator(EV_FOLDER_BTN).click();
await page.waitForFunction((count) => document.querySelectorAll(".tabs .tab").length === count + 1, tabsBefore);

const activeTabTitle = (await page.locator(".tabs .tab--active .tab__title").textContent())?.trim() ?? "";
check("Clicking Evidence Folder opens a new active tab titled 'Evidence Folder'", activeTabTitle === "Evidence Folder", `title="${activeTabTitle}"`);

// Wait for the 3 rows to render in the Evidence Folder tab.
await page.waitForFunction(() => document.querySelectorAll('[role="row"]').length === 3);
const rowPaths = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-path") ?? ""));
const firstTempFolder = rowPaths[0] ? join(rowPaths[0], "..") : "";
const rowNames = rowPaths.map((p) => basename(p)).sort();
check(
	"Evidence Folder gathers unique local evidence files across all turns in the session (excluding web and datasource chunks)",
	JSON.stringify(rowNames) === JSON.stringify(["approval-memo.md", "q3-budget.csv", "refund-policy.md"]),
	JSON.stringify(rowNames),
);
check(
	"Entries inside the Evidence Folder are symlinks on disk (no disk duplication)",
	rowPaths.every((p) => lstatSync(p).isSymbolicLink()),
	JSON.stringify(rowPaths),
);
await page.screenshot({ path: join(EVIDENCE, "02-evidence-folder-tab.png") });

// 3. Select a file -> Inspector Info shows real metadata & symlink target; Quick Look previews content.
const policyRow = page.locator('[role="row"]', { hasText: "refund-policy.md" }).first();
await policyRow.click();
await page.waitForSelector(INFO_HALF);
await page.waitForFunction(
	([half, expected]) => document.querySelector(half)?.textContent?.includes(expected),
	[INFO_HALF, "Symbolic Link"],
);
const infoText = (await page.locator(INFO_HALF).textContent()) ?? "";
check("Inspector Info shows Symbolic Link metadata for the Evidence Folder entry", infoText.includes("Symbolic Link"), infoText.slice(0, 200));
await page.screenshot({ path: join(EVIDENCE, "03-evidence-folder-inspector-info.png") });

// Quick Look via Space
await page.keyboard.press("Space");
const qlPage = await (async () => {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const found = app.windows().find((w) => w.url().includes("quick-look.html"));
		if (found) return found;
		await sleep(100);
	}
	return null;
})();
if (qlPage !== null) {
	await qlPage.waitForSelector('[data-quicklook-state="ready"]', { timeout: 8000 });
	const qlText = (await qlPage.locator("body").textContent()) ?? "";
	check("Quick Look previews the real content of the symlinked file in Evidence Folder", qlText.includes("Standard refunds settle within 5 business days"), qlText.slice(0, 120));
	await page.keyboard.press("Space");
	await sleep(300);
} else {
	check("Quick Look window found", false, "quick-look.html window not found");
}

// 4. Inline rename inside Evidence Folder (⌘R) -> renames link, leaves original file untouched.
await page.bringToFront();
await policyRow.click();
await page.keyboard.press(chord("r"));
const renameInput = page.locator("input.row__rename");
await renameInput.waitFor({ state: "visible" });
await renameInput.fill("yoink-policy.md");
await renameInput.press("Enter");
await page.waitForFunction(() => [...document.querySelectorAll('[role="row"]')].some((r) => r.textContent?.includes("yoink-policy.md")));
check(
	"Renaming a file in the Evidence Folder renames the temp entry while keeping the original file intact",
	existsSync(join(firstTempFolder, "yoink-policy.md")) && existsSync(POLICY),
	`temp=${existsSync(join(firstTempFolder, "yoink-policy.md"))} orig=${existsSync(POLICY)}`,
);
await page.screenshot({ path: join(EVIDENCE, "04-renamed-in-evidence-folder.png") });

// 5. Copy the renamed file (⌘C) in the Evidence Folder.
const renamedRow = page.locator('[role="row"]', { hasText: "yoink-policy.md" }).first();
await renamedRow.click();
await page.keyboard.press(chord("c"));
await sleep(200);

// 6. Close the Evidence Folder tab -> Confirmation Modal appears.
await page.locator(".tabs .tab--active .tab__close").click();
const dialog = page.locator('[role="alertdialog"][aria-label="Close Evidence Folder"]');
await dialog.waitFor({ state: "visible" });
const dialogText = (await dialog.textContent()) ?? "";
check(
	"Closing the Evidence Folder tab opens the confirmation modal",
	dialogText.includes("Close Evidence Folder") && dialogText.includes("temporary Evidence Folder"),
	dialogText,
);
await page.screenshot({ path: join(EVIDENCE, "05-close-confirm-modal-en.png") });
await dialog.screenshot({ path: join(EVIDENCE, "05b-close-confirm-dialog-box.png") });

// Click Cancel -> tab stays open and temp folder remains on disk.
await dialog.locator("button", { hasText: "Cancel" }).click();
await dialog.waitFor({ state: "detached" });
check(
	"Cancelling the close modal keeps the Evidence Folder tab open and preserves the temp folder on disk",
	existsSync(firstTempFolder) && ((await page.locator(".tabs .tab--active .tab__title").textContent())?.trim() === "Evidence Folder"),
	`exists=${existsSync(firstTempFolder)}`,
);

// Click Close on tab again and Confirm -> tab closes and temp folder is deleted from disk.
await page.locator(".tabs .tab--active .tab__close").click();
await dialog.waitFor({ state: "visible" });
await dialog.locator("button.is-danger", { hasText: "Close" }).click();
await dialog.waitFor({ state: "detached" });
await page.waitForFunction((dir) => !document.querySelector(`[data-path^="${dir}"]`), firstTempFolder);
// Give the async fs removal a brief moment to settle.
for (let i = 0; i < 20 && existsSync(firstTempFolder); i++) await sleep(50);
check(
	"Confirming the close modal closes the tab and deletes the temporary Evidence Folder from disk",
	!existsSync(firstTempFolder) && existsSync(POLICY) && existsSync(MEMO) && existsSync(BUDGET),
	`tempExists=${existsSync(firstTempFolder)} origExists=${existsSync(POLICY)}`,
);
await page.screenshot({ path: join(EVIDENCE, "06-after-confirm-close.png") });

// 7. Paste (⌘V) the copied file into DEST folder -> materializes a real file with the renamed name.
// Open a new tab, navigate to DEST via path bar (⌘L), and paste (⌘V).
await page.keyboard.press(chord("t"));
await page.keyboard.press(chord("l"));
const pathInput = page.locator(".pathbar input");
await pathInput.waitFor({ state: "visible" });
await pathInput.fill(DEST);
await pathInput.press("Enter");
await sleep(400);
await page.keyboard.press(chord("v"));
for (let i = 0; i < 30 && !existsSync(join(DEST, "yoink-policy.md")); i++) await sleep(100);
const pastedPath = join(DEST, "yoink-policy.md");
check(
	"Pasting a file copied from the Evidence Folder creates a real standalone file with the renamed name even after the Evidence Folder was closed",
	existsSync(pastedPath) && !lstatSync(pastedPath).isSymbolicLink() && readFileSync(pastedPath, "utf8") === POLICY_BODY,
	`exists=${existsSync(pastedPath)}`,
);

// 8. Return to the AI Search tab, reload session from Chat History, and click Evidence Folder again -> recreates temp folder.
await page.locator('.tabs .tab[data-ai-search="true"]').click();
await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
await page.locator(EV_FOLDER_BTN).waitFor({ state: "visible" });
await page.locator(EV_FOLDER_BTN).click();
await page.waitForFunction(() => document.querySelector(".tabs .tab--active .tab__title")?.textContent?.trim() === "Evidence Folder");
await page.waitForFunction(() => document.querySelectorAll('[role="row"]').length === 3);

const secondRowPaths = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-path") ?? ""));
const secondTempFolder = secondRowPaths[0] ? join(secondRowPaths[0], "..") : "";
check(
	"Returning to session history and clicking Evidence Folder recreates a fresh temporary folder",
	secondTempFolder !== "" && secondTempFolder !== firstTempFolder && existsSync(secondTempFolder),
	`secondTempFolder=${secondTempFolder}`,
);

// 9. Navigate away from the Evidence Folder within that same tab (Sidebar -> Documents) -> temp folder is automatically cleaned up.
await page.locator(".sidebar__item", { hasText: "Documents" }).click();
await page.waitForFunction(() => document.querySelector(".tabs .tab--active .tab__title")?.textContent?.trim() === "Documents");
for (let i = 0; i < 20 && existsSync(secondTempFolder); i++) await sleep(50);
check(
	"Navigating the Evidence Folder tab to another location automatically deletes and cleans up the temporary folder",
	!existsSync(secondTempFolder),
	`exists=${existsSync(secondTempFolder)}`,
);

// 10. Switch Interface language to Korean via Settings and verify Korean UI ("근거 폴더" button & "근거 폴더 닫기" modal).
await page.locator(".sidebar__item", { hasText: "Settings" }).click();
const langSelect = page.locator("select.linear-select").nth(1);
await langSelect.waitFor({ state: "visible" });
await langSelect.selectOption("ko");
await page.locator('.tabs .tab[data-ai-search="true"]').click();
const koEvHalf = '.inspector-half[aria-label="근거"]';
const koEvBtn = `${koEvHalf} button[data-action="evidence-folder"]`;
await page.locator(koEvBtn).waitFor({ state: "visible" });
const koBtnText = (await page.locator(koEvBtn).textContent())?.trim() ?? "";
check("Korean UI renders '근거 폴더' button in Evidence panel", koBtnText === "근거 폴더", `text="${koBtnText}"`);
await page.screenshot({ path: join(EVIDENCE, "07-evidence-folder-button-ko.png") });

await page.locator(koEvBtn).click();
await page.waitForFunction(() => document.querySelector(".tabs .tab--active .tab__title")?.textContent?.trim() === "근거 폴더");
await page.waitForFunction(() => document.querySelectorAll('[role="row"]').length === 3);
const thirdRowPaths = await page.locator('[role="row"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-path") ?? ""));
const thirdTempFolder = thirdRowPaths[0] ? join(thirdRowPaths[0], "..") : "";
await page.screenshot({ path: join(EVIDENCE, "08-evidence-folder-tab-ko.png") });

await page.locator(".tabs .tab--active .tab__close").click();
const koDialog = page.locator('[role="alertdialog"][aria-label="근거 폴더 닫기"]');
await koDialog.waitFor({ state: "visible" });
await page.screenshot({ path: join(EVIDENCE, "09-close-confirm-modal-ko.png") });
await koDialog.locator("button.is-danger", { hasText: "닫기" }).click();
await koDialog.waitFor({ state: "detached" });
for (let i = 0; i < 20 && existsSync(thirdTempFolder); i++) await sleep(50);
check("Korean confirm modal closes tab and removes temporary folder", !existsSync(thirdTempFolder), `exists=${existsSync(thirdTempFolder)}`);

log(`RESULT ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURES: ${failures.join(" | ")}`}`);
await app?.close().catch(() => undefined);
sweep(true);
process.exitCode = failures.length === 0 ? 0 : 1;
