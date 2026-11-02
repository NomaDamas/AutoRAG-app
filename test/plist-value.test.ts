import { describe, expect, it } from "vitest";
import { parsePlist } from "../src/preview/shared/plist-value";

/** A binary property list (`bplist00`) with strings, integers, booleans, data, a date, and an array. */
const BINARY =
	"YnBsaXN0MDDWAQIDBAUGBwgJCg0OVEJsb2JVQ291bnRXRW5hYmxlZFVJdGVtc1NVUkxUV2hlbkQAAQL/EAMJogsMU29uZVN0d29fEB1odHRwczovL2V4YW1wbGUuY29tL2E/Yj0xJmM9MjNBxcrHH4AAAAgVGiAoLjI3PD4/QkZKagAAAAAAAAEBAAAAAAAAAA8AAAAAAAAAAAAAAAAAAABz";

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function xml(body: string): Uint8Array {
	return bytes(`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">${body}</plist>\n`);
}

const BINARY_BYTES = Uint8Array.from(atob(BINARY), (character) => character.charCodeAt(0));

/** Minimal bplist00 writer for a large-data regression fixture: { blob: <bytes> }. */
function binaryPlistWithData(length: number): Uint8Array {
	const tableOffset = 22 + length;
	const bytes = new Uint8Array(tableOffset + 3 + 32);
	const view = new DataView(bytes.buffer);
	new TextEncoder().encodeInto("bplist00", bytes);
	bytes.set([0xd1, 1, 2, 0x54, 98, 108, 111, 98, 0x4f, 0x12], 8);
	view.setUint32(18, length);
	bytes.fill(65, 22, tableOffset);
	bytes.set([8, 11, 16], tableOffset);
	const trailer = bytes.length - 32;
	view.setUint8(trailer + 6, 1);
	view.setUint8(trailer + 7, 1);
	view.setBigUint64(trailer + 8, 3n);
	view.setBigUint64(trailer + 16, 0n);
	view.setBigUint64(trailer + 24, BigInt(tableOffset));
	return bytes;
}

describe("parsePlist XML", () => {
	it("parses dictionaries, arrays, scalars, data, and dates", () => {
		const value = parsePlist(
			xml(`
<dict>
	<key>URL</key><string>https://example.com/a?b=1&amp;c=2</string>
	<key>count</key><integer>42</integer>
	<key>negative</key><integer>-7</integer>
	<key>hex</key><integer>0x1f</integer>
	<key>ratio</key><real>1.5</real>
	<key>exponent</key><real>2.5e-3</real>
	<key>notANumber</key><real>nan</real>
	<key>enabled</key><true/>
	<key>disabled</key><false/>
	<key>when</key><date>2024-03-04T05:06:07Z</date>
	<key>blob</key><data>
		AQID
		BA==
	</data>
	<key>empty</key><data/>
	<key>items</key>
	<array>
		<string>one</string>
		<dict><key>nested</key><string>value</string></dict>
		<array/>
	</array>
</dict>`),
		);
		expect(value).toEqual({
			URL: "https://example.com/a?b=1&c=2",
			count: 42,
			negative: -7,
			hex: 31,
			ratio: 1.5,
			exponent: 0.0025,
			notANumber: Number.NaN,
			enabled: true,
			disabled: false,
			when: new Date("2024-03-04T05:06:07Z"),
			blob: new Uint8Array([1, 2, 3, 4]),
			empty: new Uint8Array(0),
			items: ["one", { nested: "value" }, []],
		});
		expect((value as Record<string, unknown>).blob).toBeInstanceOf(Uint8Array);
	});

	it("keeps special dictionary keys as data instead of changing the dictionary prototype", () => {
		const value = parsePlist(xml('<dict><key>__proto__</key><dict><key>inherited</key><string>no</string></dict><key>safe</key><string>yes</string></dict>'));
		expect(Object.getPrototypeOf(value)).toBeNull();
		expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
		expect((value as Record<string, unknown>).inherited).toBeUndefined();
		expect((value as Record<string, unknown>).safe).toBe("yes");
	});

	it("decodes named and numeric character references", () => {
		expect(parsePlist(xml("<string>&#x1F600; &#65; &quot;q&quot; &apos;a&apos; &lt;tag&gt; &amp;</string>"))).toBe("😀 A \"q\" 'a' <tag> &");
	});

	it("treats CDATA as literal text", () => {
		expect(parsePlist(xml("<string><![CDATA[a & b <c> &#65;]]></string>"))).toBe("a & b <c> &#65;");
	});

	it("parses the plist a .webloc file contains", () => {
		const value = parsePlist(
			bytes(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>URL</key>
	<string>https://example.com/</string>
</dict>
</plist>
`),
		);
		expect(value).toEqual({ URL: "https://example.com/" });
	});

	it("does not resolve custom or external entities", () => {
		const internal = bytes(`<?xml version="1.0"?>
<!DOCTYPE plist [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<plist version="1.0"><string>&xxe;</string></plist>`);
		expect(() => parsePlist(internal)).toThrow();
		expect(() => parsePlist(xml("<string>&unknown;</string>"))).toThrow();
	});

	it("rejects malformed input", () => {
		const cases = [
			"",
			"not xml",
			'<plist version="1.0"></plist>',
			"<dict/>",
			'<plist version="1.0"><dict><key>a</key></dict></plist>',
			'<plist version="1.0"><string>a</dict></plist>',
			'<plist version="1.0"><string>a<dict/></string></plist>',
			'<plist version="1.0"><integer>abc</integer></plist>',
			'<plist version="1.0"><date>not-a-date</date></plist>',
			'<plist version="1.0"><data>!!!!</data></plist>',
			'<plist version="1.0"><unknown>x</unknown></plist>',
			'<plist version="1.0"><array><string>x</string></plist>',
		];
		for (const source of cases) expect(() => parsePlist(bytes(source)), source).toThrow();
	});

	it("rejects invalid UTF-8", () => {
		expect(() => parsePlist(new Uint8Array([0x3c, 0xff, 0x3e]))).toThrow();
	});

	it("rejects excessive nesting", () => {
		const deep = `${"<array>".repeat(80)}<string>x</string>${"</array>".repeat(80)}`;
		expect(() => parsePlist(xml(deep))).toThrow();
	});
});

describe("parsePlist binary", () => {
	it("parses a bplist00 fixture", () => {
		expect(parsePlist(BINARY_BYTES)).toEqual({
			URL: "https://example.com/a?b=1&c=2",
			Count: 3,
			Enabled: true,
			Blob: new Uint8Array([0x00, 0x01, 0x02, 0xff]),
			When: new Date("2024-03-04T05:06:07Z"),
			Items: ["one", "two"],
		});
	});

	it("parses embedded data whose XML representation is larger than the text viewer's 4 MB cap", () => {
		const value = parsePlist(binaryPlistWithData(3_500_000));
		const blob = (value as Record<string, unknown>).blob;
		expect(blob).toBeInstanceOf(Uint8Array);
		expect((blob as Uint8Array).byteLength).toBe(3_500_000);
		expect((blob as Uint8Array)[3_499_999]).toBe(65);
	});

	it("rejects a truncated binary plist", () => {
		expect(() => parsePlist(BINARY_BYTES.slice(0, 40))).toThrow();
	});
});
