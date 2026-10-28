import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { filesClipboardPayload } from "../src/main/os-clipboard";

describe("filesClipboardPayload", () => {
	it("is an RFC 2483 file:// list, one URI per CRLF-separated line, in order", () => {
		const payload = filesClipboardPayload(["/d/one.png", "/d/two.png"]);
		expect(payload["text/uri-list"]).toBe("file:///d/one.png\r\nfile:///d/two.png");
	});

	it("percent-encodes names the URI grammar treats specially", () => {
		const path = "/d/내 사진 #1 100%.png";
		const payload = filesClipboardPayload([path]);
		expect(payload["text/uri-list"]).toBe(pathToFileURL(path).href);
		expect(payload["text/uri-list"]).not.toContain(" ");
		expect(payload["text/uri-list"]).not.toContain("#");
	});

	it("carries the file names as plain text, like Finder, so a text field pastes names and not a path", () => {
		const payload = filesClipboardPayload(["/d/sub/one.png", "/e/two.png"]);
		expect(payload["text/plain"]).toBe("one.png\ntwo.png");
	});
});
