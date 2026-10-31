/**
 * Manual QA — the AI Search composer wraps and scrolls a long draft.
 *
 * Drives the built app in real Chromium (layout and scrolling are the browser's own) and proves, in English
 * and Korean:
 *   1. an empty composer is one row; the approval-mode pill sits bottom-left and Send bottom-right;
 *   2. a long one-line draft wraps (no horizontal overflow) and the field grows;
 *   3. an unbroken string longer than the field wraps instead of scrolling sideways;
 *   4. Shift+Enter adds a line; past the row cap the field stops growing and scrolls inside itself, and the
 *      first line is still reachable;
 *   5. the mode menu opens upward from the pill and covers neither the pill nor the draft's Send button;
 *   6. Enter sends the multi-line draft, the bubble keeps its line breaks, and the field returns to one row;
 *   7. clearing the draft shrinks the field back.
 * No model key is needed: nothing waits on an answer. Run `bun run build` first. Evidence lands in the ignored
 * `.omo/` tree (or `$QA_OUT`).
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, homeEnv } from "./platform.mjs";

const EVIDENCE = process.env.QA_OUT ?? join(ROOT, ".omo/evidence/ai-finder-app/qa-ai-search-composer");
mkdirSync(EVIDENCE, { recursive: true });

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const COPY = {
	en: {
		ask: "Ask Dazzi",
		sentence: "Please compare the refund policy with last quarter's finance review and list every exception that needs director approval, with the document each one comes from. ",
	},
	ko: {
		ask: "Dazzi에게 물어보기",
		sentence: "환불 정책과 지난 분기 재무 검토 내용을 비교해서, 이사 승인이 필요한 예외를 모두 찾고 각각의 출처 문서를 함께 정리해 주세요. ",
	},
};

async function run(language) {
	const copy = COPY[language];
	const work = mkdtempSync(join(tmpdir(), `autorag-qa-composer-${language}-`));
	const app = await launchFinder({
		userDataDir: join(work, "user-data"),
		language,
		env: { ...homeEnv(join(work, "home")), AUTORAG_SKIP_DUPEY_CHECK: "1", ELECTRON_RENDERER_URL: "" },
	});
	try {
		const page = await finderWindow(app, 30_000);
		page.setDefaultTimeout(15_000);
		page.on("pageerror", (error) => console.log(`[pageerror] ${String(error).slice(0, 300)}`));
		await page.locator(".sidebar__item", { hasText: /AI Search|AI 검색/u }).first().click();
		await page.waitForSelector('section.ai:not([aria-hidden="true"]) textarea', { timeout: 30_000 });
		const panel = page.locator('section.ai:not([aria-hidden="true"])');
		const field = panel.locator(`textarea[aria-label="${copy.ask}"]`);
		const box = panel.locator(".compose-box");
		const pill = panel.locator('.composer-toolbar button[aria-haspopup="menu"]');
		const send = panel.locator('.composer-actions button[type="submit"]');
		const tag = `[${language}]`;
		const shot = (name) => page.screenshot({ path: join(EVIDENCE, `${language}-${name}.png`) });
		const geometry = () =>
			field.evaluate((element) => {
				const style = getComputedStyle(element);
				return {
					height: element.getBoundingClientRect().height,
					scrollHeight: element.scrollHeight,
					clientHeight: element.clientHeight,
					scrollWidth: element.scrollWidth,
					clientWidth: element.clientWidth,
					overflowY: style.overflowY,
					row: Number.parseFloat(style.lineHeight),
				};
			});

		await field.click();
		const empty = await geometry();
		const emptyBox = await box.boundingBox();
		const pillBox = await pill.boundingBox();
		const sendBox = await send.boundingBox();
		const fieldBox = await field.boundingBox();
		check(`${tag} the empty composer is one row`, Math.abs(empty.height - empty.row) < 1.5, JSON.stringify(empty));
		check(
			`${tag} the mode pill sits bottom-left, below the field`,
			pillBox !== null && fieldBox !== null && emptyBox !== null && pillBox.y >= fieldBox.y + fieldBox.height - 1 && pillBox.x - emptyBox.x < 40,
			JSON.stringify({ pillBox, fieldBox, emptyBox }),
		);
		check(
			`${tag} Send sits bottom-right`,
			sendBox !== null && emptyBox !== null && emptyBox.x + emptyBox.width - (sendBox.x + sendBox.width) < 40 && sendBox.y >= (fieldBox?.y ?? 0),
			JSON.stringify(sendBox),
		);
		await shot("01-empty");

		// 2. A long single-line draft wraps.
		await field.fill("");
		await page.keyboard.insertText(copy.sentence.repeat(3));
		const wrapped = await geometry();
		check(`${tag} a long draft wraps onto several rows`, wrapped.height >= empty.height * 2.5, JSON.stringify(wrapped));
		check(`${tag} the wrapped draft has no horizontal overflow`, wrapped.scrollWidth <= wrapped.clientWidth + 1, JSON.stringify(wrapped));
		check(`${tag} the whole draft is visible (field fits its content)`, wrapped.scrollHeight <= wrapped.clientHeight + 1 && wrapped.overflowY === "hidden", JSON.stringify(wrapped));
		const wrappedBox = await box.boundingBox();
		check(`${tag} the composer grew upward, the bottom edge stayed put`, wrappedBox !== null && emptyBox !== null && wrappedBox.height > emptyBox.height + 20 && Math.abs(wrappedBox.y + wrappedBox.height - (emptyBox.y + emptyBox.height)) < 2, JSON.stringify({ wrappedBox, emptyBox }));
		await shot("02-wrapped");

		// 3. A string with no break opportunity wraps too.
		await field.fill("");
		await page.keyboard.insertText("A".repeat(400));
		const unbroken = await geometry();
		check(`${tag} an unbroken string wraps instead of scrolling sideways`, unbroken.scrollWidth <= unbroken.clientWidth + 1 && unbroken.height > empty.height * 1.5, JSON.stringify(unbroken));

		// 4. Shift+Enter lines, then the row cap.
		await field.fill("");
		await page.keyboard.insertText("line 1");
		for (let n = 2; n <= 4; n += 1) {
			await page.keyboard.press("Shift+Enter");
			await page.keyboard.insertText(`line ${n}`);
		}
		const four = await geometry();
		check(`${tag} Shift+Enter adds a line without sending`, four.height >= empty.height * 3.5 && (await panel.locator(".user-msg").count()) === 0, JSON.stringify(four));
		for (let n = 5; n <= 30; n += 1) {
			await page.keyboard.press("Shift+Enter");
			await page.keyboard.insertText(`line ${n}`);
		}
		const capped = await geometry();
		check(`${tag} the field stops growing at eight rows`, Math.abs(capped.height - capped.row * 8) < 2, JSON.stringify(capped));
		check(`${tag} beyond the cap the field scrolls`, capped.overflowY === "auto" && capped.scrollHeight > capped.clientHeight + 10, JSON.stringify(capped));
		const stuckAtEnd = await field.evaluate((element) => element.scrollTop > 0);
		check(`${tag} the caret line (the last) is in view while typing`, stuckAtEnd);
		await field.evaluate((element) => {
			element.scrollTop = 0;
		});
		check(`${tag} the first line is still reachable by scrolling`, (await field.evaluate((element) => element.scrollTop)) === 0);
		const bodyBox = await panel.locator(".ai-body").boundingBox();
		check(`${tag} the conversation area keeps room`, bodyBox !== null && bodyBox.height > 120, JSON.stringify(bodyBox));
		await shot("03-capped-scroll");

		// 5. The mode menu opens upward from the bottom-left pill.
		await pill.click();
		const menu = page.locator('[role="menu"]');
		await menu.waitFor();
		// The menu rises in over a few hundred ms; measure it where it settles.
		await page.waitForTimeout(500);
		const menuBox = await menu.boundingBox();
		const pillNow = await pill.boundingBox();
		check(`${tag} the mode menu opens above the pill`, menuBox !== null && pillNow !== null && menuBox.y + menuBox.height <= pillNow.y + 1, JSON.stringify({ menuBox, pillNow }));
		check(`${tag} the menu is left-aligned with the pill`, menuBox !== null && pillNow !== null && Math.abs(menuBox.x - pillNow.x) < 2, JSON.stringify({ menuBox, pillNow }));
		check(`${tag} the menu lists the three modes`, (await menu.locator('[role="menuitemradio"]').count()) === 3);
		await shot("04-mode-menu");
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		check(`${tag} Escape closes the menu and returns to the pill`, (await pill.evaluate((element) => document.activeElement === element)) === true);

		// 7. Clearing shrinks the field.
		await field.click();
		await page.keyboard.press(chord("a"));
		await page.keyboard.press("Backspace");
		const cleared = await geometry();
		check(`${tag} clearing the draft shrinks the field to one row`, Math.abs(cleared.height - cleared.row) < 1.5 && cleared.overflowY === "hidden", JSON.stringify(cleared));

		// 6. Enter sends; the bubble keeps the line breaks.
		await page.keyboard.insertText("first line");
		await page.keyboard.press("Shift+Enter");
		await page.keyboard.insertText("second line");
		await page.keyboard.press("Enter");
		const bubble = panel.locator(".user-msg .bubble").first();
		await bubble.waitFor();
		const bubbleInfo = await bubble.evaluate((element) => ({ text: element.textContent, whiteSpace: getComputedStyle(element).whiteSpace, height: element.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(element).lineHeight) }));
		check(`${tag} Enter sends the draft`, bubbleInfo.text === "first line\nsecond line", JSON.stringify(bubbleInfo));
		check(`${tag} the sent bubble keeps the line break`, bubbleInfo.whiteSpace === "pre-wrap" && bubbleInfo.height >= bubbleInfo.line * 2, JSON.stringify(bubbleInfo));
		await field.waitFor();
		const afterSend = await geometry();
		check(`${tag} the field is empty and one row again`, (await field.inputValue()) === "" && Math.abs(afterSend.height - afterSend.row) < 1.5, JSON.stringify(afterSend));
		await shot("05-sent");
	} finally {
		await app.close().catch(() => undefined);
		rmSync(work, { recursive: true, force: true });
	}
}

for (const language of ["en", "ko"]) {
	try {
		await run(language);
	} catch (error) {
		check(`[${language}] run completed`, false, String(error).slice(0, 500));
	}
}

if (failures.length > 0) {
	console.log(`\n${failures.length} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
