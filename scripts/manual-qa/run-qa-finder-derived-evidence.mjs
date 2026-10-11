/**
 * Manual QA — evidence derived from a plain-text librarian answer.
 *
 * The librarian no longer finishes through an answer-emitting tool: the model
 * answers in plain text and the librarian derives `results[]` from its inline
 * citations. A derived result has no `confidence`, its `title` is the source's
 * last path segment, and its `summary` is the cited sentence. This lane seeds
 * a chat with exactly that shape and checks what the real Evidence view shows:
 *
 * - no "관련도" line (and no `NaN%`) when there is no confidence, while a result
 *   that does carry one still shows it,
 * - a datasource chunk is headed by its datasource and instance, never by the
 *   opaque chunk id the derivation leaves in `title`,
 * - a local file keeps its file name.
 *
 * Run from the repo root:  node scripts/manual-qa/run-qa-finder-derived-evidence.mjs
 * Prereq: bun run build
 */
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { finderWindow, launchFinder, openAiSearch } from "./launch-finder.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-derived-evidence");
mkdirSync(EVIDENCE, { recursive: true });
const LOG = join(EVIDENCE, "run.log");
const log = (line) => {
	console.log(line);
	appendFileSync(LOG, `${line}\n`);
};
const failures = [];
const check = (label, ok, detail) => {
	log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` :: ${detail}` : ""}`);
	if (!ok) failures.push(label);
};

const RUN_ID = `derived-evidence-qa-${Date.now().toString(36)}`;
const USER_DATA = join(tmpdir(), RUN_ID);
const DOCS = join(homedir(), "Documents", RUN_ID);
const POLICY = join(DOCS, "refund-policy.md");

let app;
const sweep = () => {
	app?.close().catch(() => undefined);
	for (const dir of [USER_DATA, DOCS]) rmSync(dir, { recursive: true, force: true });
};
process.on("exit", sweep);

mkdirSync(join(USER_DATA, "chat-history"), { recursive: true });
mkdirSync(DOCS, { recursive: true });
writeFileSync(POLICY, "## 승인 규칙\n환불 예외는 지급 전 임원 승인이 필요합니다.\n");

// What the librarian derives: no confidence anywhere; datasource titles are the
// opaque chunk id; the summary is the sentence the citation sat behind.
const derived = [
	{
		number: 1,
		title: basename(POLICY),
		summary: "환불 예외는 지급 전 임원 승인이 필요합니다",
		source: POLICY,
		excerpts: ["환불 예외는 지급 전 임원 승인이 필요합니다."],
	},
	{
		number: 2,
		title: "msg-91",
		summary: "재무팀이 7월 리뷰에서 정책을 확인했습니다",
		source: "/kakao/work/chunks/msg-91",
		excerpts: ["재무팀: 7월 리뷰에서 정책 확인했습니다."],
	},
	// A measured confidence must still be shown.
	{
		number: 3,
		title: "memo.md",
		summary: "승인 체인 원본 첨부 필수",
		source: join(DOCS, "memo.md"),
		excerpts: ["승인 체인 원본 첨부 필수."],
		confidence: 0.81,
	},
];
writeFileSync(join(DOCS, "memo.md"), "승인 체인 원본 첨부 필수.\n");
const now = new Date().toISOString();
const record = {
	id: "c-derived-1",
	title: "환불 예외 승인 규칙",
	snippet: "환불 예외는 임원 승인이 필요합니다.",
	updatedAt: now,
	messages: [
		{ role: "user", text: "환불 예외 승인 규칙 요약해줘", attachments: [], at: now },
		{
			role: "assistant",
			sessionId: "qa-derived-session",
			quick: null,
			deep: {
				answer: "환불 예외는 지급 전 임원 승인이 필요합니다 [1]. 재무팀도 7월 리뷰에서 이를 확인했습니다 [2]. 승인 체인 원본을 첨부해야 합니다 [3].",
				evidence: derived,
			},
			stopped: false,
			at: now,
		},
	],
};
writeFileSync(join(USER_DATA, "chat-history", "chats.json"), `${JSON.stringify([record], null, 2)}\n`);

app = await launchFinder({ userDataDir: USER_DATA });
const page = await finderWindow(app);
page.setDefaultTimeout(8000);
page.on("pageerror", (error) => log(`[pageerror] ${String(error).slice(0, 300)}`));
await page.waitForSelector(".sidebar__item", { timeout: 30_000 });
await openAiSearch(page);

await page.locator('[aria-label="Chat history"]').click();
await page.locator(".history-item").first().waitFor({ state: "visible" });
await page.locator(".history-item").first().click();
const prose = page.locator(".assistant-msg .assistant-prose").first();
await prose.waitFor({ state: "visible" });
const EVIDENCE_HALF = '.inspector-half[aria-label="Evidence"]';
await page.waitForSelector(`${EVIDENCE_HALF} .evidence-tab`);

const chips = await prose.locator(".cite").allTextContents();
check("every derived citation renders as a chip", chips.join(",") === "1,2,3", JSON.stringify(chips));

const title = () => page.locator(`${EVIDENCE_HALF} .preview-title`).first().innerText();
const evidenceText = () => page.locator(EVIDENCE_HALF).innerText();
const select = async (n) => {
	await prose.locator(".cite", { hasText: new RegExp(`^${n}$`) }).first().click();
	await page.waitForFunction((want) => document.querySelector('.inspector-half[aria-label="Evidence"] .preview-title')?.textContent?.startsWith(`${want}.`), n);
};

// 1 — a local file with no confidence.
await select(1);
let text = await evidenceText();
check("a local file keeps its file name as the heading", (await title()) === `1. ${basename(POLICY)}`, await title());
check("no relevance line when no confidence was measured", !text.includes("관련도"), text.replace(/\s+/g, " ").slice(0, 140));
check("never prints NaN", !text.includes("NaN"), text.includes("NaN") ? "NaN present" : "clean");
await page.screenshot({ path: join(EVIDENCE, "1-local-file-no-confidence.png") });

// 2 — a datasource chunk: labelled by where it came from, not by the chunk id.
await select(2);
text = await evidenceText();
check("a datasource chunk is headed by datasource and instance", (await title()) === "2. kakao · work", await title());
check("the opaque chunk id is not the heading", !(await title()).includes("msg-91"), await title());
check("the cited sentence is shown as the summary", text.includes("재무팀이 7월 리뷰에서 정책을 확인했습니다"), text.replace(/\s+/g, " ").slice(0, 140));
check("no relevance line for the datasource chunk either", !text.includes("관련도"), "absent");
await page.screenshot({ path: join(EVIDENCE, "2-datasource-chunk.png") });

// 3 — a result that does carry a confidence still shows it.
await select(3);
text = await evidenceText();
check("a measured confidence is still shown", text.includes("관련도 81%"), text.replace(/\s+/g, " ").slice(0, 140));
await page.screenshot({ path: join(EVIDENCE, "3-with-confidence.png") });

await app.close();
app = undefined;
log(failures.length === 0 ? "ALL PASS" : `${failures.length} FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
