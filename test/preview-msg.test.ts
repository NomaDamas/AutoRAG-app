import * as CFB from "cfb";
import { describe, expect, it } from "vitest";
import { parseMsg } from "../src/preview/shared/msg";

function utf16(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "utf16le"));
}

function container(streams: Readonly<Record<string, Uint8Array>>): Uint8Array {
	const file = CFB.utils.cfb_new();
	for (const [path, data] of Object.entries(streams)) CFB.utils.cfb_add(file, path, data as unknown as number[]);
	return new Uint8Array(CFB.write(file, { type: "array" }) as ArrayLike<number>);
}

describe("parseMsg", () => {
	it("reads subject, sender, recipients, body, and attachments from the substorage streams", () => {
		const bytes = container({
			"/__substg1.0_0037001F": utf16("분기 보고서"),
			"/__substg1.0_0C1A001F": utf16("김철수"),
			"/__substg1.0_0C1F001F": utf16("kim@example.com"),
			"/__substg1.0_0E04001F": utf16("이영희; park@example.com"),
			"/__substg1.0_0E03001F": utf16("cc@example.com"),
			"/__substg1.0_1000001F": utf16("본문\r\n두 번째 줄"),
			"/__attach_version1.0_#00000000/__substg1.0_3707001F": utf16("보고서.pdf"),
			"/__attach_version1.0_#00000000/__substg1.0_370E001F": utf16("application/pdf"),
			"/__attach_version1.0_#00000000/__substg1.0_37010102": new Uint8Array(1234),
		});
		const mail = parseMsg(bytes);
		expect(mail.subject).toBe("분기 보고서");
		expect(mail.from).toEqual(["김철수 <kim@example.com>"]);
		expect(mail.to).toEqual(["이영희", "park@example.com"]);
		expect(mail.cc).toEqual(["cc@example.com"]);
		expect(mail.text).toBe("본문\r\n두 번째 줄");
		expect(mail.html).toBeNull();
		expect(mail.attachments).toEqual([{ name: "보고서.pdf", size: 1234, type: "application/pdf" }]);
	});

	it("falls back to ANSI (CP949) strings and the HTML body stream", () => {
		const hello = Uint8Array.from([0xbe, 0xc8, 0xb3, 0xe7]);
		const bytes = container({
			"/__substg1.0_0037001E": hello,
			"/__substg1.0_10130102": new TextEncoder().encode("<p>hi</p>"),
		});
		const mail = parseMsg(bytes);
		expect(mail.subject).toBe("안녕");
		expect(mail.html).toBe("<p>hi</p>");
	});

	it("rejects bytes that are not a compound file", () => {
		expect(() => parseMsg(new Uint8Array([1, 2, 3, 4]))).toThrow();
	});
});
