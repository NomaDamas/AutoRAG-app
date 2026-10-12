import { fileURLToPath } from "node:url";
/**
 * Manual QA — the AI Search chat-history popover of the real AutoRAG app.
 *
 * Proves the user-visible behavior against the v7 Bloom design: a seeded
 * chat store renders the History popover with its day groups (오늘 / 어제 /
 * 지난 7일 / 지난 30일 / 그 이전), each row carries title, snippet, and time,
 * the current chat carries the accent dot on rgba(10,100,216,0.08), the search
 * input filters through the store, Enter opens the first hit, Esc closes the
 * popover without clearing the Finder query, and the click-catcher closes it.
 *
 * Run from the repo root:  bun scripts/manual-qa/run-qa-finder-chat-history.mjs
 * Prereq: bun run build
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_PANEL, launchFinder, finderWindow, openAiSearch } from "./launch-finder.mjs";
import { chord } from "./platform.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-chat-history");
mkdirSync(EVIDENCE, { recursive: true });

const RUN_ID = `ulw-chat-history-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const STORE = join(USER_DATA, "chat-history", "chats.json");

let app;
let swept = false;
const sweep = () => {
	if (swept) return;
	swept = true;
	app?.close().catch(() => undefined);
	rmSync(USER_DATA, { recursive: true, force: true });
	console.log(`cleanup: removed ${USER_DATA}; closed the app`);
};
process.on("exit", sweep);

const failures = [];
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
	if (!ok) failures.push(label);
};

const pad = (value) => String(value).padStart(2, "0");
const at = (daysAgo, hour, minute) => {
	const date = new Date();
	date.setDate(date.getDate() - daysAgo);
	date.setHours(hour, minute, 0, 0);
	return date;
};
const monthDay = (date) => `${date.getMonth() + 1}월 ${date.getDate()}일`;
const clock = (date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** The store's own record shape; the list and the search both read these summaries back verbatim. */
const record = (id, title, snippet, when, question, answer, deepAnswer = null) => ({
	id,
	title,
	snippet,
	updatedAt: when.toISOString(),
	messages: [
		{ role: "user", text: question, attachments: [], at: when.toISOString() },
		{
			role: "assistant",
			sessionId: `${id}-session`,
			quick: { answer, evidence: [], meta: "0.7s · 1 source" },
			deep: deepAnswer === null ? null : { answer: deepAnswer, evidence: [] },
			stopped: false,
			at: when.toISOString(),
		},
	],
});

const today1 = at(0, 0, 42);
const today2 = at(0, 0, 15);
const yesterday = at(1, 17, 30);
const withinWeek = at(4, 11, 2);
const withinMonth = at(9, 11, 2);
const older = at(40, 11, 2);

const CHATS = [
	record("c1", "Q3 마케팅 예산 승인", "9월 12일 Slack #mkt-budget에서 CPA 악화를 이유로 감액이 합의됐습니다.", today1, "Q3 마케팅 예산 승인 근거 찾아줘", "예산은 3.8억으로 확정됐습니다.", "세부 승인 근거는 지라드 규정과 9월 12일 메일을 따릅니다."),
	record("c2", "퍼포먼스 광고 감액 사유", "8월 CPA가 목표 대비 31% 높았습니다.", today2, "퍼포먼스 광고 예산이 왜 4천만 원 줄었어?", "CPA 악화가 감액 사유입니다."),
	record("c3", "CFO 승인 메일 찾기", "9월 15일 오후 4:12에 보낸 메일입니다.", yesterday, "박지훈 CFO가 보낸 예산 승인 메일 찾아줘", "승인 메일을 찾았습니다."),
	record("c4", "v1 vs v3 예산안 차이", "총액이 4.2억에서 3.8억으로 줄었습니다.", withinWeek, "예산안 v1이랑 v3 차이 정리해줘", "퍼포먼스 광고가 가장 크게 줄었습니다."),
	record("c5", "해외법인 분리 여부", "포함되지 않으며 별도 품의로 분리됩니다.", withinMonth, "해외법인 마케팅 예산은 이번 Q3에 포함돼?", "Q4 별도 품의로 분리됩니다."),
	record("c6", "Q3 캠페인 브리프 초안 위치", "Documents › Marketing › Briefs 폴더에 있습니다.", older, "Q3 캠페인 브리프 초안 어디 있어?", "Documents › Marketing › Briefs에 있습니다."),
];

mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
writeFileSync(STORE, `${JSON.stringify(CHATS, null, 2)}\n`);

/** Bounded, event-driven wait for the rendered texts to match — never a fixed sleep. */
const waitForTexts = async (page, selector, expected, timeout = 8000) => {
	try {
		await page.waitForFunction(
			([sel, want]) => {
				const got = [...document.querySelectorAll(sel)].map((element) => element.textContent ?? "");
				return got.length === want.length && got.every((value, index) => value === want[index]);
			},
			[selector, expected],
			{ timeout },
		);
		return true;
	} catch {
		return false;
	}
};

const texts = (page, selector) => page.locator(selector).allInnerTexts();
const openHistory = async (page) => {
	await page.locator('[aria-label="Chat history"]').click();
	await page.locator(".history").waitFor({ state: "visible", timeout: 5000 });
	await page.locator(".history input").waitFor({ state: "visible", timeout: 5000 });
};
const popoverClosed = async (page) => {
	await page.locator(".history").waitFor({ state: "detached", timeout: 5000 });
	return (await page.locator(".history").count()) === 0;
};

app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
await page.waitForSelector('[role="row"]');
await openAiSearch(page);

// 1. The popover renders the seeded history in the reference's day groups.
await openHistory(page);
const groups = await texts(page, ".history-group");
check(
	"the popover groups history as Today / Yesterday / Previous 7 days / Previous 30 days / Earlier",
	JSON.stringify(groups) === JSON.stringify(["Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Earlier"]),
	JSON.stringify(groups),
);
const expectedTitles = CHATS.map((chat) => chat.title);
const expectedSnippets = CHATS.map((chat) => chat.snippet);
const expectedTimes = [clock(today1), clock(today2), clock(yesterday), monthDay(withinWeek), monthDay(withinMonth), monthDay(older)];
check("every seeded chat is listed, newest first", await waitForTexts(page, ".hist-copy b", expectedTitles), JSON.stringify(await texts(page, ".hist-copy b")));
check("each row carries its first Quick answer as the snippet", JSON.stringify(await texts(page, ".hist-copy small")) === JSON.stringify(expectedSnippets));
check("each row carries the reference time label", JSON.stringify(await texts(page, ".hist-time")) === JSON.stringify(expectedTimes), JSON.stringify(await texts(page, ".hist-time")));

const box = await page.locator(".history").boundingBox();
const popoverStyle = await page.locator(".history").evaluate((element) => {
	const style = getComputedStyle(element);
	return { width: style.width, radius: style.borderRadius, shadow: style.boxShadow };
});
check("the popover is the v7 360px / radius 12 / menu shadow surface", Math.round(box.width) === 360 && popoverStyle.radius === "12px" && popoverStyle.shadow.includes("35px"), JSON.stringify({ box, popoverStyle }));
check("no row is marked current before any chat is opened", (await page.locator(".history-item.current").count()) === 0);

const layout = await page.evaluate((selector) => {
	const panel = document.querySelector(selector).getBoundingClientRect();
	const popover = document.querySelector(".history").getBoundingClientRect();
	const row = document.querySelector(".history-item").getBoundingClientRect();
	const dot = document.querySelector(".hist-dot").getBoundingClientRect();
	const text = document.querySelector(".hist-copy").getBoundingClientRect();
	const title = document.querySelector(".hist-copy b").getBoundingClientRect();
	const snippet = document.querySelector(".hist-copy small").getBoundingClientRect();
	const time = document.querySelector(".hist-time").getBoundingClientRect();
	return { panel, popover, row, dot, text, title, snippet, time };
}, AI_PANEL);
const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
check("the popover sits inside the AI column, clear of its header", inside(layout.popover, layout.panel) && layout.popover.top >= layout.panel.top + 36, JSON.stringify({ popover: layout.popover.top, panel: layout.panel.top }));
check("the row reads dot → title/snippet → time with no overlap", layout.dot.right <= layout.text.left && layout.text.right <= layout.time.left && inside(layout.dot, layout.row) && inside(layout.time, layout.row));
check("the title sits above its snippet", layout.title.bottom <= layout.snippet.top + 1 && layout.title.left === layout.snippet.left);
await page.screenshot({ path: join(EVIDENCE, "history-open.png") });
await page.locator(".history").screenshot({ path: join(EVIDENCE, "app-history-popover.png") });

// 2. Opening a row loads that chat and marks it current with the accent dot.
await page.locator(".history-item").first().click();
check("clicking a row closes the popover", await popoverClosed(page));
await page.locator(".assistant-msg").first().waitFor({ state: "visible", timeout: 5000 });
const loadedAnswer = await page.locator(".assistant-msg .assistant-prose").first().innerText();
check("the clicked chat's answer is loaded into the conversation", loadedAnswer.includes("예산은 3.8억으로 확정됐습니다."), loadedAnswer);
const loadedQuestion = await page.locator(".user-msg .bubble").innerText();
check("the clicked chat's question is loaded", loadedQuestion === "Q3 마케팅 예산 승인 근거 찾아줘", loadedQuestion);
await page.screenshot({ path: join(EVIDENCE, "history-item-loaded.png") });

await openHistory(page);
const current = page.locator(".history-item.current");
check("the opened chat is the single current row", (await current.count()) === 1);
const currentStyle = await current.evaluate((element) => ({
	background: getComputedStyle(element).backgroundColor,
	dot: getComputedStyle(element.querySelector(".hist-dot")).backgroundColor,
	title: element.querySelector(".hist-copy b").textContent,
}));
check("the current row uses the v7 accent wash and dot", currentStyle.background === "rgba(10, 100, 216, 0.08)" && currentStyle.dot === "rgb(10, 100, 216)", JSON.stringify(currentStyle));
check("the current row is the chat that was opened", currentStyle.title === "Q3 마케팅 예산 승인", currentStyle.title);
await page.screenshot({ path: join(EVIDENCE, "history-current-chat.png") });

// 3. The search input filters through the store, reading the whole conversation
// body — every question and every Quick/Deep answer — not just the row summary.
await page.locator(".history input").fill("예산");
check(
	'searching "예산" keeps every chat whose question, answer, title or snippet matches, regrouped',
	await waitForTexts(page, ".hist-copy b", ["Q3 마케팅 예산 승인", "퍼포먼스 광고 감액 사유", "CFO 승인 메일 찾기", "v1 vs v3 예산안 차이", "해외법인 분리 여부"]),
	JSON.stringify(await texts(page, ".hist-copy b")),
);
check(
	"the regrouped hits keep the day order",
	JSON.stringify(await texts(page, ".history-group")) === JSON.stringify(["Today", "Yesterday", "Previous 7 days", "Previous 30 days"]),
	JSON.stringify(await texts(page, ".history-group")),
);
await page.screenshot({ path: join(EVIDENCE, "history-search.png") });

// 3b. A needle that lives only in the conversation body still finds its chat:
// "지라드" is in c1's Deep answer, "근거" only in c1's question and Deep answer.
await page.locator(".history input").fill("지라드");
check(
	"a Deep answer word matches the chat that contains it",
	await waitForTexts(page, ".hist-copy b", ["Q3 마케팅 예산 승인"]),
	JSON.stringify(await texts(page, ".hist-copy b")),
);
await page.locator(".history input").fill("근거");
check(
	"a question word outside the row title and snippet matches too",
	await waitForTexts(page, ".hist-copy b", ["Q3 마케팅 예산 승인"]),
	JSON.stringify(await texts(page, ".hist-copy b")),
);
await page.screenshot({ path: join(EVIDENCE, "history-search-body.png") });

await page.locator(".history input").fill("zzz-no-hit");
await page.locator(".history-list > span").waitFor({ state: "visible", timeout: 5000 });
const emptyText = await page.locator(".history-list > span").innerText();
check('the empty state names the query in the reference copy', emptyText === 'No chats matching "zzz-no-hit"', emptyText);
await page.screenshot({ path: join(EVIDENCE, "history-empty.png") });

// 4. Enter opens the first hit of the current query.
await page.locator(".history input").fill("CFO");
await waitForTexts(page, ".hist-copy b", ["CFO 승인 메일 찾기"]);
await page.keyboard.press("Enter");
check("Enter closes the popover", await popoverClosed(page));
await page.waitForFunction(() => document.querySelector(".user-msg .bubble")?.textContent === "박지훈 CFO가 보낸 예산 승인 메일 찾아줘", null, { timeout: 5000 });
check("Enter opened the first hit of the query", (await page.locator(".user-msg .bubble").innerText()) === "박지훈 CFO가 보낸 예산 승인 메일 찾아줘");
await page.screenshot({ path: join(EVIDENCE, "history-enter.png") });

// 5. Esc closes the popover and leaves the Finder query alone (it must not bubble to the Finder keymap).
await page.locator(".side-search input").fill("qa-marker");
await openHistory(page);
await page.locator(".history input").press("Escape");
check("Esc closes the popover", await popoverClosed(page));
const finderQuery = await page.locator(".side-search input").inputValue();
check("Esc in the history search leaves the Finder query untouched", finderQuery === "qa-marker", finderQuery);
await page.screenshot({ path: join(EVIDENCE, "history-esc.png") });
await page.locator(".side-search input").fill("");
await page.waitForFunction(() => document.querySelector(".side-search input")?.value === "");

// 6. The transparent click-catcher closes the popover without reaching the composer.
await openHistory(page);
const body = await page.locator(`${AI_PANEL} .ai-body`).boundingBox();
await page.mouse.click(body.x + 30, body.y + body.height - 40);
check("clicking behind the popover closes it", await popoverClosed(page));
check("the click-catcher swallowed the click", (await page.locator(`${AI_PANEL} .composer input`).inputValue()) === "");
await page.screenshot({ path: join(EVIDENCE, "history-backdrop.png") });

// 7. The advertised ⌘⇧H shortcut toggles the popover.
await page.keyboard.press(chord("Shift", "H"));
await page.locator(".history").waitFor({ state: "visible", timeout: 5000 });
check("⌘⇧H opens the popover", (await page.locator(".history").count()) === 1);
await page.keyboard.press(chord("Shift", "H"));
check("⌘⇧H closes it again", await popoverClosed(page));

// 8. Adjacent Finder surfaces still work after the popover keyboard work.
await page.locator(".sidebar__item", { hasText: "Recents" }).first().click();
await page.waitForFunction(() => document.querySelector(".list__empty")?.textContent === "No recently opened files", null, { timeout: 5000 });
check("the Recents view still renders its empty state", (await page.locator(".list__empty").innerText()) === "No recently opened files");
await page.screenshot({ path: join(EVIDENCE, "finder-regression.png") });

// 9. v7 surface metrics. The v7 handoff prototype draws this popover at
// 330px / radius 10 while the app keeps the 360px / radius 12 / menu-shadow
// chrome, so the popover *surface* is compared against its own spec. Its
// *contents* — the flat search field, the list paddings and the row type
// scale — follow the prototype exactly.
const APP_METRICS = {
	popover: [".history", ["width", "borderRadius", "backgroundColor", "boxShadow"]],
	input: [".history input", ["height", "borderBottomWidth", "borderBottomStyle", "borderBottomColor", "borderRadius", "fontSize", "paddingLeft", "paddingRight"]],
	group: [".history-group", ["fontSize", "fontWeight", "padding"]],
	row: [".history-item.current", ["borderRadius", "backgroundColor", "padding", "gap", "fontSize"]],
	dot: [".history-item.current .hist-dot", ["width", "height", "marginTop", "backgroundColor"]],
	title: [".hist-copy b", ["fontSize", "fontWeight"]],
	time: [".hist-time", ["fontSize", "color"]],
};

await openAiSearch(page);
await openHistory(page);
const appMetrics = await page.evaluate((spec) => {
	const out = {};
	for (const [name, [selector, keys]] of Object.entries(spec)) {
		const style = getComputedStyle(document.querySelector(selector));
		out[name] = Object.fromEntries(keys.map((key) => [key, style[key]]));
	}
	return out;
}, APP_METRICS);
console.log(`app metrics: ${JSON.stringify(appMetrics)}`);
check(
	"the popover keeps the v7 360px / radius 12 surface",
	Math.round(Number.parseFloat(appMetrics.popover.width)) === 360 && appMetrics.popover.borderRadius === "12px",
	JSON.stringify(appMetrics.popover),
);
check(
	"the popover has a flat reference search field, not a pill or a clear button",
	appMetrics.input.height === "38px" &&
		appMetrics.input.borderBottomWidth === "1px" &&
		appMetrics.input.borderBottomStyle === "solid" &&
		appMetrics.input.borderBottomColor === "rgb(231, 231, 234)" &&
		appMetrics.input.borderRadius === "0px" &&
		appMetrics.input.fontSize === "13px" &&
		appMetrics.input.paddingLeft === "12px" &&
		appMetrics.input.paddingRight === "12px",
	JSON.stringify(appMetrics.input),
);
const historyChildren = await page.locator(".history > *").evaluateAll((nodes) => nodes.map((node) => node.tagName.toLowerCase()));
check("the popover is only the search field and the list — no clear button", JSON.stringify(historyChildren) === JSON.stringify(["input", "div"]), JSON.stringify(historyChildren));
check(
	"the current row keeps the accent wash and dot",
	appMetrics.row.backgroundColor === "rgba(10, 100, 216, 0.08)" && appMetrics.dot.backgroundColor === "rgb(10, 100, 216)",
	JSON.stringify({ row: appMetrics.row, dot: appMetrics.dot }),
);
check(
	"the row and group geometry follow the reference",
	appMetrics.row.borderRadius === "7px" && appMetrics.row.padding === "8px" && appMetrics.row.gap === "8px" && appMetrics.row.fontSize === "13px" &&
		appMetrics.dot.width === "5px" && appMetrics.dot.height === "5px" &&
		appMetrics.group.fontSize === "10px" && appMetrics.group.fontWeight === "700" && appMetrics.group.padding === "8px",
	JSON.stringify({ row: appMetrics.row, dot: appMetrics.dot, group: appMetrics.group }),
);
check(
	"the row type scale follows the reference",
	appMetrics.title.fontWeight === "700" && appMetrics.title.fontSize === "13px" && appMetrics.time.fontSize === "10px" && appMetrics.time.color === "rgb(110, 110, 115)",
	JSON.stringify({ title: appMetrics.title, time: appMetrics.time }),
);

sweep();
console.log(failures.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failures.join(", ")})`);
console.log(`evidence: ${EVIDENCE}`);
process.exit(failures.length === 0 ? 0 : 1);
