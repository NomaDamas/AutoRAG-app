/**
 * Manual QA — Quick Look for email, contacts, and calendar files (issue #143).
 *
 * Builds real fixtures (EUC-KR and UTF-8 `.eml`, an Outlook `.msg` written as
 * a CFB container, a multi-megabyte `.mbox`, `.vcf`, `.ics`), opens each with
 * Space from the Finder list in the production build (`bun run build` first),
 * checks the panel in the DOM, and screenshots it. HTML mail is the security
 * case: the page must hold no script, form, frame, or remote image, and the
 * preview must make no network request.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as CFB from "cfb";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-mail";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-mail-"));

const b64 = (text) => Buffer.from(text).toString("base64");
const HELLO_EUCKR = Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]);

// ------------------------------------------------------------------ fixtures
writeFileSync(
	join(root, "korean-euckr.eml"),
	Buffer.concat([
		Buffer.from(
			[
				`From: =?EUC-KR?B?${HELLO_EUCKR.toString("base64")}?= <kim@example.com>`,
				"To: lee@example.com",
				"Date: Tue, 20 Oct 2026 14:00:00 +0900",
				`Subject: =?UTF-8?B?${b64("주간 보고서 제출")}?=`,
				"MIME-Version: 1.0",
				'Content-Type: text/plain; charset="ks_c_5601-1987"',
				"Content-Transfer-Encoding: base64",
				"",
				"",
			].join("\r\n"),
		),
		Buffer.from(HELLO_EUCKR.toString("base64")),
	]),
);

const REMOTE_PROBE = "http://127.0.0.1:9/tracker.gif";
writeFileSync(
	join(root, "html-mail.eml"),
	[
		"From: Newsletter <news@example.com>",
		"To: me@example.com",
		"Subject: HTML newsletter",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="outer"',
		"",
		"--outer",
		'Content-Type: multipart/alternative; boundary="alt"',
		"",
		"--alt",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"plain fallback",
		"--alt",
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: base64",
		"",
		b64(
			`<h2 onclick="document.title='pwned'">안녕하세요 뉴스레터</h2><p>본문 <b>굵게</b></p><script>document.title="pwned"</script><img src="${REMOTE_PROBE}" alt="remote"><form action="${REMOTE_PROBE}"><button>send</button></form><iframe src="${REMOTE_PROBE}"></iframe><a href="javascript:alert(1)">bad link</a><meta http-equiv="refresh" content="0;url=${REMOTE_PROBE}">`,
		),
		"--alt--",
		"--outer",
		"Content-Type: application/pdf",
		`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
		"Content-Transfer-Encoding: base64",
		"",
		Buffer.alloc(30_000, 1).toString("base64").replace(/(.{76})/g, "$1\r\n"),
		"--outer--",
		"",
	].join("\r\n"),
);

const utf16 = (text) => Buffer.from(text, "utf16le");
const msg = CFB.utils.cfb_new();
for (const [path, data] of Object.entries({
	"/__substg1.0_0037001F": utf16("Outlook 분기 보고"),
	"/__substg1.0_0C1A001F": utf16("박지민"),
	"/__substg1.0_0C1F001F": utf16("park@example.com"),
	"/__substg1.0_0E04001F": utf16("kim@example.com"),
	"/__substg1.0_1000001F": utf16("Outlook 본문입니다.\r\n두 번째 줄"),
	"/__attach_version1.0_#00000000/__substg1.0_3707001F": utf16("표.xlsx"),
	"/__attach_version1.0_#00000000/__substg1.0_370E001F": utf16("application/vnd.ms-excel"),
	"/__attach_version1.0_#00000000/__substg1.0_37010102": Buffer.alloc(2048),
})) CFB.utils.cfb_add(msg, path, data);
writeFileSync(join(root, "outlook.msg"), Buffer.from(CFB.write(msg, { type: "array" })));

// ~14 MB mailbox: far over the 4MB prefix the viewer reads.
const MBOX_MESSAGES = 6000;
const filler = "x".repeat(2000);
let mbox = "";
for (let index = 0; index < MBOX_MESSAGES; index += 1) {
	mbox += `From sender${index}@example.com Tue Oct 20 14:00:00 2026\nFrom: sender${index}@example.com\nSubject: =?UTF-8?B?${b64(`메일 ${index}`)}?=\nContent-Type: text/plain; charset=utf-8\n\n본문 ${index}\n${filler}\n>From quoted line\n\n`;
}
writeFileSync(join(root, "big.mbox"), mbox);

writeFileSync(
	join(root, "contacts.vcf"),
	[
		"BEGIN:VCARD",
		"VERSION:3.0",
		"FN:김철수",
		"ORG:다찌;개발팀",
		"TITLE:엔지니어",
		"TEL;TYPE=CELL:010-1234-5678",
		"EMAIL:kim@example.com",
		"ADR;TYPE=HOME:;;테헤란로 1;서울;;06000;대한민국",
		"PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"END:VCARD",
		"BEGIN:VCARD",
		"VERSION:3.0",
		"FN:Jane Doe",
		"END:VCARD",
		"",
	].join("\r\n"),
);

writeFileSync(
	join(root, "events.ics"),
	[
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"BEGIN:VEVENT",
		"SUMMARY:팀 회의",
		"DTSTART;TZID=Asia/Seoul:20261020T140000",
		"DTEND;TZID=Asia/Seoul:20261020T150000",
		"LOCATION:회의실 A",
		"RRULE:FREQ=WEEKLY;COUNT=4;BYDAY=TU",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"SUMMARY:Holiday",
		"DTSTART;VALUE=DATE:20261225",
		"DTEND;VALUE=DATE:20261226",
		"END:VEVENT",
		"END:VCALENDAR",
		"",
	].join("\r\n"),
);

// ---------------------------------------------------------------------- run
const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}
async function poll(read, accept, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "ko" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((page) => page.url().includes("quick-look.html")),
		(page) => page !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const requests = [];
	preview.on("request", (request) => requests.push(request.url()));
	preview.on("dialog", (dialog) => {
		check("no dialog from mail content", false, dialog.message());
		void dialog.dismiss();
	});
	const windowState = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window === undefined ? null : { visible: window.isVisible(), bounds: window.getBounds() };
		});
	async function open(name, ready) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		const started = Date.now();
		await poll(() => preview.evaluate(ready).catch(() => false), Boolean, 15_000);
		const elapsed = Date.now() - started;
		await poll(async () => (await windowState())?.visible === true, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 500));
		await preview.screenshot({ path: join(EVIDENCE, `${name.replace(/\W+/g, "-")}.png`) });
		return elapsed;
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await windowState())?.visible === false, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const text = () => preview.locator("body").innerText();

	// Korean EUC-KR eml
	await open("korean-euckr.eml", () => document.body.innerText.includes("주간 보고서 제출"));
	let body = await text();
	check("eml: RFC 2047 UTF-8 subject decoded", body.includes("주간 보고서 제출"));
	check("eml: EUC-KR display name decoded", body.includes("안녕하세요 <kim@example.com>"));
	check("eml: ks_c_5601-1987 body decoded", body.split("주간 보고서 제출").join("").includes("안녕하세요"));
	check("eml: date shown", body.includes("2026"));
	await close();

	// HTML mail
	await open("html-mail.eml", () => document.body.innerText.includes("안녕하세요 뉴스레터"));
	body = await text();
	check("html mail renders sanitized text", body.includes("안녕하세요 뉴스레터") && body.includes("본문"));
	const dom = await preview.evaluate(() => {
		const article = document.querySelector("article.ql-md");
		return {
			active: article === null ? -1 : article.querySelectorAll("script, form, button, iframe, meta, object, embed").length,
			remoteImages: article === null ? -1 : [...article.querySelectorAll("img")].filter((img) => img.getAttribute("src")?.startsWith("http")).length,
			handlers: article === null ? -1 : [...article.querySelectorAll("*")].filter((node) => node.getAttributeNames().some((name) => name.startsWith("on"))).length,
			jsLinks: article === null ? -1 : [...article.querySelectorAll("a")].filter((a) => (a.getAttribute("href") ?? "").startsWith("javascript:")).length,
			title: document.title,
		};
	});
	check("html mail has no active elements", dom.active === 0, JSON.stringify(dom));
	check("html mail has no remote images, handlers, or script links", dom.remoteImages === 0 && dom.handlers === 0 && dom.jsLinks === 0, JSON.stringify(dom));
	check("html mail did not run script", dom.title !== "pwned", dom.title);
	check("attachment listed with name, type, and size", body.includes("보고서.pdf") && body.includes("application/pdf") && /30 KB/.test(body), body.slice(-160).replace(/\s+/g, " "));
	const toggle = preview.getByRole("button", { name: "텍스트" });
	check("rendered/plain toggle offered when both bodies exist", (await toggle.count()) > 0);
	await toggle.click();
	check("plain view shows the text/plain part", (await text()).includes("plain fallback"));
	check("preview made no network request to the remote probe", !requests.some((url) => url.includes("127.0.0.1:9")), requests.filter((url) => url.startsWith("http")).join(","));
	await close();

	// Outlook msg
	await open("outlook.msg", () => document.body.innerText.includes("Outlook 분기 보고"));
	body = await text();
	check("msg: subject, sender, body", body.includes("Outlook 분기 보고") && body.includes("박지민 <park@example.com>") && body.includes("Outlook 본문입니다."));
	check("msg: attachment listed", body.includes("표.xlsx") && body.includes("2 KB"), body.slice(-120).replace(/\s+/g, " "));
	await close();

	// Large mbox
	const started = Date.now();
	await open("big.mbox", () => document.body.innerText.includes("메일 0"));
	const mboxMs = Date.now() - started;
	body = await text();
	const rows = await preview.locator("nav li").count();
	check("mbox: message list bounded to 200 rows", rows === 200, `${rows} rows`);
	check("mbox: reports a lower-bound count for a cut file", /\d[\d,]*통 이상/.test(body), body.match(/메일 [\d,]+통[^\n]*/)?.[0] ?? "");
	check("mbox: first message opened and mboxrd unquoted", body.includes("본문 0") && body.includes("From quoted line") && !body.includes(">From quoted line"));
	await preview.locator("nav li button").nth(5).click();
	await poll(() => text(), (value) => value.includes("본문 5"));
	check("mbox: selecting a row opens that message", (await text()).includes("본문 5"));
	check("mbox opens quickly despite 14MB file", mboxMs < 5000, `${mboxMs}ms`);
	await close();

	// vCard
	await open("contacts.vcf", () => document.body.innerText.includes("김철수"));
	body = await text();
	check("vcf: name, org, phone, email, address", ["김철수", "다찌, 개발팀", "010-1234-5678", "kim@example.com", "테헤란로 1, 서울, 06000, 대한민국"].every((part) => body.includes(part)));
	check("vcf: second contact listed", body.includes("Jane Doe"));
	check("vcf: photo drawn as data URI", (await preview.locator('img[src^="data:image/png;base64,"]').count()) === 1);
	await close();

	// iCalendar
	await open("events.ics", () => document.body.innerText.includes("팀 회의"));
	body = await text();
	check("ics: time zone and range", body.includes("2026-10-20 14:00 (Asia/Seoul) – 15:00"));
	check("ics: location and recurrence summary", body.includes("회의실 A") && body.includes("매주") && body.includes("TU") && body.includes("4회"));
	check("ics: all-day event", body.includes("하루 종일") && body.includes("2026-12-25"));
	await close();
} finally {
	await app.close();
}

const failed = results.filter((item) => !item.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; screenshots in ${EVIDENCE}`);
process.exit(failed.length === 0 ? 0 : 1);
