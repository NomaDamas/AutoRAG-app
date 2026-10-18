// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { parseMail } from "../src/preview/shared/mail";
import { renderMailHtml } from "../src/preview/ui/mail-html";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("HTML mail rendering", () => {
	const message = [
		"Content-Type: multipart/related; boundary=r",
		"",
		"--r",
		"Content-Type: text/html; charset=utf-8",
		"",
		'<p onclick="x()">hi</p><script>alert(1)</script><img src="https://tracker.example/p.gif"><img src="cid:logo@x" alt="logo"><a href="javascript:alert(1)">bad</a><iframe title="x"></iframe><form action="https://evil.example"><button>go</button></form>',
		"--r",
		"Content-Type: image/png",
		"Content-ID: <logo@x>",
		"Content-Transfer-Encoding: base64",
		"",
		"iVBORw0KGgo=",
		"--r--",
	].join("\r\n");

	it("drops scripts, handlers, frames, forms, remote images, and script links; keeps cid images inline", () => {
		const html = renderMailHtml(parseMail(enc(message)));
		expect(html).not.toMatch(/script|onclick|iframe|form|button|tracker\.example|javascript:/i);
		expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
		expect(html).toContain("<p>hi</p>");
		expect((html.match(/<img/g) ?? []).length).toBe(1);
	});
});
