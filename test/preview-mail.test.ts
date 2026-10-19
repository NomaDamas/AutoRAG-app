import { describe, expect, it } from "vitest";
import { decodeEncodedWords, listMbox, parseEmlx, parseMail, readMboxMessage } from "../src/preview/shared/mail";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
/** "안녕하세요" in EUC-KR / CP949. */
const HELLO_EUCKR = [0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4];
const eucB64 = Buffer.from(HELLO_EUCKR).toString("base64");

describe("RFC 2047 encoded words", () => {
	it("decodes B and Q words in UTF-8 and EUC-KR, joining adjacent words", () => {
		expect(decodeEncodedWords(`=?UTF-8?B?${Buffer.from("회의 자료").toString("base64")}?=`)).toBe("회의 자료");
		expect(decodeEncodedWords(`=?EUC-KR?B?${eucB64}?=`)).toBe("안녕하세요");
		expect(decodeEncodedWords("=?utf-8?Q?caf=C3=A9_au_lait?=")).toBe("café au lait");
		expect(decodeEncodedWords("=?UTF-8?Q?a?= =?UTF-8?Q?b?= plain")).toBe("ab plain");
	});

	it("keeps text it cannot decode", () => {
		expect(decodeEncodedWords("=?x-unknown-9?B?AAAA?= tail")).toContain("tail");
	});
});

describe("parseMail", () => {
	it("reads headers and a plain body", () => {
		const mail = parseMail(
			enc(
				[
					"From: =?UTF-8?B?" + Buffer.from("김철수").toString("base64") + "?= <kim@example.com>",
					'To: a@example.com, "Lee, Y" <lee@example.com>',
					"Cc: c@example.com",
					"Date: Tue, 20 Oct 2026 14:00:00 +0900",
					"Subject: =?UTF-8?B?" + Buffer.from("주간 보고").toString("base64") + "?=",
					"Content-Type: text/plain; charset=utf-8",
					"",
					"본문입니다.",
				].join("\r\n"),
			),
		);
		expect(mail.subject).toBe("주간 보고");
		expect(mail.from).toEqual(["김철수 <kim@example.com>"]);
		expect(mail.to).toEqual(["a@example.com", "Lee, Y <lee@example.com>"]);
		expect(mail.cc).toEqual(["c@example.com"]);
		expect(mail.date).toBe("2026-10-20T05:00:00.000Z");
		expect(mail.text?.trim()).toBe("본문입니다.");
		expect(mail.html).toBeNull();
	});

	it("decodes a legacy EUC-KR quoted-printable body", () => {
		const qp = HELLO_EUCKR.map((byte) => "=" + byte.toString(16).toUpperCase()).join("");
		const mail = parseMail(
			enc(["Subject: x", 'Content-Type: text/plain; charset="ks_c_5601-1987"', "Content-Transfer-Encoding: quoted-printable", "", `${qp}=\r\n!`].join("\r\n")),
		);
		expect(mail.text?.trim()).toBe("안녕하세요!");
	});

	it("decodes a raw 8-bit EUC-KR header and body without a charset label", () => {
		const raw = Buffer.concat([Buffer.from("Subject: "), Buffer.from(HELLO_EUCKR), Buffer.from("\r\n\r\n"), Buffer.from(HELLO_EUCKR)]);
		const mail = parseMail(new Uint8Array(raw));
		expect(mail.subject).toBe("안녕하세요");
		expect(mail.text).toBe("안녕하세요");
	});

	it("walks multipart/alternative and lists attachments without decoding them", () => {
		const attachment = Buffer.alloc(3000, 7).toString("base64").replace(/(.{76})/g, "$1\r\n");
		const message = [
			"Subject: mixed",
			'Content-Type: multipart/mixed; boundary="outer"',
			"",
			"--outer",
			'Content-Type: multipart/alternative; boundary="inner"',
			"",
			"--inner",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"plain part",
			"--inner",
			"Content-Type: text/html; charset=utf-8",
			"Content-Transfer-Encoding: base64",
			"",
			Buffer.from("<p>html <b>part</b></p>").toString("base64"),
			"--inner--",
			"--outer",
			"Content-Type: application/pdf",
			`Content-Disposition: attachment; filename*=UTF-8''${encodeURIComponent("보고서.pdf")}`,
			"Content-Transfer-Encoding: base64",
			"",
			attachment,
			"--outer--",
			"",
		].join("\r\n");
		const mail = parseMail(enc(message));
		expect(mail.text?.trim()).toBe("plain part");
		expect(mail.html).toBe("<p>html <b>part</b></p>");
		expect(mail.attachments).toEqual([{ name: "보고서.pdf", size: 3000, type: "application/pdf" }]);
	});

	it("reads RFC 2231 continuations and RFC 2047 file names", () => {
		const message = [
			"Content-Type: multipart/mixed; boundary=b",
			"",
			"--b",
			"Content-Type: text/plain",
			"",
			"hi",
			"--b",
			"Content-Type: application/octet-stream",
			"Content-Disposition: attachment;",
			"  filename*0*=UTF-8''%EA%B3%84;",
			"  filename*1*=%ED%9A%8D.txt",
			"",
			"abc",
			"--b",
			"Content-Type: application/octet-stream",
			`Content-Disposition: attachment; filename="=?EUC-KR?B?${eucB64}?=.bin"`,
			"",
			"abc",
			"--b--",
		].join("\r\n");
		expect(parseMail(enc(message)).attachments.map((a) => a.name)).toEqual(["계획.txt", "안녕하세요.bin"]);
	});

	it("maps small inline cid images to data URIs", () => {
		const png = "iVBORw0KGgo=";
		const message = [
			"Content-Type: multipart/related; boundary=r",
			"",
			"--r",
			"Content-Type: text/html",
			"",
			'<img src="cid:logo@x">',
			"--r",
			"Content-Type: image/png",
			"Content-ID: <logo@x>",
			"Content-Disposition: inline",
			"Content-Transfer-Encoding: base64",
			"",
			png,
			"--r--",
		].join("\r\n");
		const mail = parseMail(enc(message));
		expect(mail.inlineImages["logo@x"]).toBe(`data:image/png;base64,${png}`);
		expect(mail.attachments).toEqual([{ name: "logo@x", size: 8, type: "image/png" }]);
	});

	it("survives hostile structure: deep nesting, missing boundary, empty input", () => {
		let message = "Content-Type: multipart/mixed; boundary=a\r\n\r\n";
		for (let i = 0; i < 40; i++) message += "--a\r\nContent-Type: multipart/mixed; boundary=a\r\n\r\n";
		expect(() => parseMail(enc(message))).not.toThrow();
		expect(() => parseMail(enc("Content-Type: multipart/mixed\r\n\r\nbody"))).not.toThrow();
		expect(parseMail(new Uint8Array()).subject).toBe("");
	});

	it("falls back to the raw date text when it does not parse", () => {
		expect(parseMail(enc("Date: someday\r\n\r\nx")).date).toBe("someday");
	});
});

describe("parseEmlx", () => {
	it("skips the byte-count line and the trailing plist", () => {
		const message = "Subject: hello\r\n\r\nbody";
		const emlx = `${message.length}\n${message}<?xml version="1.0"?><plist></plist>`;
		const mail = parseEmlx(enc(emlx));
		expect(mail.subject).toBe("hello");
		expect(mail.text).toBe("body");
	});
});

describe("mbox", () => {
	const box = [
		"From a@example.com Tue Oct 20 14:00:00 2026",
		"Subject: first",
		"From: a@example.com",
		"",
		"one",
		">From the start",
		"",
		"From b@example.com Tue Oct 20 15:00:00 2026",
		"Subject: =?UTF-8?B?" + Buffer.from("둘째").toString("base64") + "?=",
		"From: b@example.com",
		"",
		"two",
		"",
	].join("\n");

	it("lists messages and unescapes mboxrd quoting when opened", () => {
		const bytes = enc(box);
		const listing = listMbox(bytes, false);
		expect(listing.count).toBe(2);
		expect(listing.complete).toBe(true);
		expect(listing.messages.map((m) => m.subject)).toEqual(["first", "둘째"]);
		const first = readMboxMessage(bytes, listing.messages[0]!);
		expect(first.text).toContain("From the start");
		expect(first.text).not.toContain(">From the start");
		expect(readMboxMessage(bytes, listing.messages[1]!).text?.trim()).toBe("two");
	});

	it("marks a truncated prefix as incomplete and caps summaries", () => {
		let many = "";
		for (let i = 0; i < 700; i++) many += `From x@example.com Tue Oct 20 14:00:00 2026\nSubject: m${i}\n\nb\n\n`;
		const listing = listMbox(enc(many), true);
		expect(listing.count).toBe(700);
		expect(listing.complete).toBe(false);
		expect(listing.messages.length).toBe(200);
	});

	it("treats a file with no From_ line as one message", () => {
		const listing = listMbox(enc("Subject: lone\n\nbody"), false);
		expect(listing.count).toBe(1);
		expect(listing.messages[0]?.subject).toBe("lone");
	});
});
