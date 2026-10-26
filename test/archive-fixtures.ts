/**
 * Archive fixtures shared by the extraction and listing tests. The tree is the
 * same in every container: `readme.md`, `docs/a.txt`, `docs/sub/b.txt`, and a
 * Korean-named folder, each with a fixed date (UTC) so listings can assert them.
 * They were written once by bsdtar (libarchive's own writer); the RAR files are
 * libarchive's test archives (BSD-2-Clause), embedded because no RAR writer exists.
 */

import { gunzipSync, gzipSync } from "fflate";

/** The dates the fixture tree carries, ms since the epoch. */
export const FIXTURE_DATES = {
	readme: Date.UTC(2022, 4, 6, 7, 8),
	docs: Date.UTC(2024, 0, 2, 3, 4),
	docsSub: Date.UTC(2022, 0, 1, 0, 0),
	korean: Date.UTC(2025, 2, 4, 5, 6),
} as const;

/** gzip of the fixture tree as a ustar tar. */
export const FIXTURE_TAR_GZ = "H4sIAKHw3moCA+2XQW7CMBBFs+4pfAI6tmfs84TGCFWJUiVBtLseot31AIUTcCYQd8BGAiEkIAtshDJv4ywiZaKf/+encXlRuVFVZPEAAIMowmmN2Z+ewxlAIVFpkoikQIDUqCATEHGmI7O2yxs/yrubTBr3dfG++dS58vpLnryUSDH6Pejqj5dnmZW5P0X91r5GfkbwPdE1/4P3PyEa63Mi+F8ZSZkg9n8a/dvZOOY30E9/abSVaPy1z39tFeufTP981H12j9z/5sz/moL+vP/jM3VlWXMDGPb+D/k/jpcB/fx/mv+oift/EuZ1Uxbs/8Gy/f1br77j/gH063/Wd34gsHv/g9bc/xLqv1n8bJb/kVbA7fynM/2tr4Cc/ymoXMX1j2EYZoDsACjuntMAGgAA";
/** The fixture tree as a 7z. */
export const FIXTURE_7Z = "N3q8ryccAANyHdVj+gAAAAAAAAAiAAAAAAAAAIDg3VUAOhvKYLUMUlVweHXUW6Fv0ExyvcMDUJC3Sv/+HZAAAACBMweuD8/88GwP6+qeAQ1iA43TTEI/Dn3dHUfkszdOp8QebdmXS/MVGPGx1AVTAuubuNVYjMXsEk76p37tCK7pTt9DV2DVlrNLbwo009d4h47/WyHGoZWWa7eOTrUwHzj2IFfh6qinj3zNdtEGtcHBanEk5zA1XKUuzi52c6N7PuYITBUELhNwwzrgMgCVWlN7dK0ehpCedzuircrlNETnd9s27RqDfh8V5P5Tg7/k1YFq36NsDfFWaG/vhrMSfm4ZUFGT4QbdTbv1EO2ZTGEYWfNmNf/j0OAAFwYfAQmA2wAHCwEAASMDAQEFXQAAgAAMgZEKASYTXp4AAA==";
/** The fixture tree as a tar.bz2. */
export const FIXTURE_TAR_BZ2 = "QlpoOTFBWSZTWZGpdZQAAZb/+dGQAoBAAf+AAACRqH9W3uBAAAYEBHAAQAAaAKgwATgEQoAJg0JoYEwRoGjBoeqGGhoAAANAAAAACKIQUbSanih6g9TTMU2oyejUAZ3r2rxevJ1HUEZ183IIToBR06ryb6XgvFbhb4ULwXu6eM1F0C7FhdgZmoYLrutMxazv/G/fHLvJgnSGvHIFyik9dIgFzkAuS7VgXd2du6nDhcuAsLn6YHNnLBBCpRiZKkGTYtUm0cDbaSmiby1Q3QVaQVGLyshBBixRuuoYE3OLOC3FTGxeXhKFSSl5hFGpgSvQL89nYs+BtDw3/Hz/J52+nJfFclmtVovivkuHqWq2jNy+11a41DTjo0LqyWnkGpdZze5erQyc15opuC+I6gcgOBhHYgICAxdXFwAf4u5IpwoSEjUusoA=";
/** The fixture tree as a tar.xz. */
export const FIXTURE_TAR_XZ = "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Bn/AQhdADkZSEhq/qOiAhBFL1l0mh2YTXqMrDEj4LRfO+wmo2MZ8Yst4gEow3mXll62TfsXnH80sZJ1bDlmdftY34zoiFAnTK9o7b16sc1hxwQpqSZCdyQ0I4jd24rcBnUy6z9vJ3yo7TQYHJ3q81x6ECUXI7syympQyWgIk/45Lb/gODBJpFXxX2u/UGO4MmZ/DFRlDj/fAz+mIDOwXNLdvP9kndeVq94aET/7+T0V2YR8kjneMvoECqQ+TGosY2im6uHongxUdPyzhyl2HY/YnmqwzLFnh+FrrcNkYQOLbwvjAS/8oVdOJbicucR9KppLiAySPsQcs35JD9C8L+yZHbxIh5iExEwjrDYfIABpWmUp3heIegABpAKANAAAMi8j9bHEZ/sCAAAAAARZWg==";
/** The fixture tree as an SVR4 (newc) cpio, the payload an RPM carries. */
export const FIXTURE_CPIO = "MDcwNzAxMThhOWFkOTcwMDAwODFhNDAwMDAwMWY2MDAwMDAwMDAwMDAwMDAwMTYyNzRjOTUwMDAwMDAwMDQwMDAwMDAwMTAwMDAwMDBmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBhMDAwMDAwMDByZWFkbWUubWQAdG9wCjA3MDcwMTE4YTlhZDkyMDAwMDQxZWQwMDAwMDFmNjAwMDAwMDAwMDAwMDAwMDQ2NTkzN2QyMDAwMDAwMDAwMDAwMDAwMDEwMDAwMDAwZjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNTAwMDAwMDAwZG9jcwAAMDcwNzAxMThhOWFkOTMwMDAwNDFlZDAwMDAwMWY2MDAwMDAwMDAwMDAwMDAwMzYxY2Y5OTgwMDAwMDAwMDAwMDAwMDAwMTAwMDAwMDBmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA5MDAwMDAwMDBkb2NzL3N1YgAAMDcwNzAxMThhOWFkOTUwMDAwODFhNDAwMDAwMWY2MDAwMDAwMDAwMDAwMDAwMTY1OTM3ZDIwMDAwMDAwMDYwMDAwMDAwMTAwMDAwMDBmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBiMDAwMDAwMDBkb2NzL2EudHh0AAAAAGhlbGxvCgAAMDcwNzAxMThhOWFkOTYwMDAwODFhNDAwMDAwMWY2MDAwMDAwMDAwMDAwMDAwMTYxY2Y5OTgwMDAwMDAwMDYwMDAwMDAwMTAwMDAwMDBmMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDBmMDAwMDAwMDBkb2NzL3N1Yi9iLnR4dAAAAAB3b3JsZAoAADA3MDcwMTE4YTlhZDk0MDAwMDQxZWQwMDAwMDFmNjAwMDAwMDAwMDAwMDAwMDM2N2M2OGEzODAwMDAwMDAwMDAwMDAwMDEwMDAwMDAwZjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwNzAwMDAwMDAw7ZWc6riAAAAAADA3MDcwMTE4YTlhZDk4MDAwMDgxYTQwMDAwMDFmNjAwMDAwMDAwMDAwMDAwMDE2N2M2OGEzODAwMDAwMDA1MDAwMDAwMDEwMDAwMDAwZjAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMjAwMDAwMDAw7ZWc6riAL+uplOuqqC50eHQAbWVtbwoAAAAwNzA3MDEwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAxMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMGIwMDAwMDAwMFRSQUlMRVIhISEAAAAA";
/** gzip of the fixture tree as an ISO 9660 image (mostly empty sectors, so it compresses to a few hundred bytes). */
export const FIXTURE_ISO_GZ = "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";

/** libarchive's test_read_format_rar.rar: test.txt, a symlink, testdir/test.txt, and two directories. */
export const RAR4_TREE =
	"UmFyIRoHAM+QcwAADQAAAAAAAACEUnQgkDIAFAAAABQAAAADQqLIvrd22j4UMAgApIEAAHRlc3QudHh0gAi3dto+t3baPnRlc3QgdGV4dCBkb2N1bWVudA0KnS90IJAyAAgAAAAIAAAAA3tEybbRTNg+FDAIAP+hAAB0ZXN0bGlua8AI0UzYPlBf2j50ZXN0LnR4dM3gdCCQOgAUAAAAFAAAAANCosi+Y3faPhQwEACkgQAAdGVzdGRpclx0ZXN0LnR4dMDMY3faPmN32j50ZXN0IHRleHQgZG9jdW1lbnQNCqHIdOCQMQAAAAAAAAAAAAMAAAAAY3faPhQwBwDtQQAAdGVzdGRpcsDMY3faPmR32j7m53TgkDYAAAAAAAAAAAADAAAAAJ2r1T4UMAwA7UEAAHRlc3RlbXB0eWRpcoDMnavVPsVd2j7EPXsAQAcA";
/** libarchive's test_read_format_rar5_stored.rar: one stored member, helloworld.txt. */
export const RAR5_STORED =
	"UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAA4MAZjLAIDC50ABJ0ApIMCtEOglYAAAQ5oZWxsb3dvcmxkLnR4dAoDE34Oq1tW6Q4aaGVsbG8gbGliYXJjaGl2ZSB0ZXN0IHN1aXRlIQodd1ZRAwUEAA==";
/** libarchive's test_read_format_rar5_encrypted.rar: four members behind a password. */
export const RAR5_ENCRYPTED =
	"UmFyIRoHAQAzkrXlCgEFBgAFAQGAgAA1/zIeHwIDCxIEEiBVblrugAAABWEudHh0CgMCfCGEo4J82gFUaGlzIGlzIGZyb20gYS50eHR6QXGzUAIDPDAEEiAYRaMCgAMABWIudHh0MAEAAw/HRF7hgPi1n9YrQzcIvFfN+jTfBqtdBdSTB3cPHY6AU+o1Zx1w8S1La5wanAoDAnJlmKaCfNoBY7pUstAQpUlftLrTwGmoOxu8uzgn14eTeHMvfJPi0ijEAN7+psA7fmxn1AVQANz4jXzxZh8CAwsSBBIgNT2alIAAAAVjLnR4dAoDAj5I6a6CfNoBVGhpcyBpcyBmcm9tIGMudHh07P3wXVICAzygAASSACDD32MSgAMABWQudHh0MAEAAw/HRF7hgPi1n9YrQzcIvFfN883Wsxy0W6d8rDZYjrMOaYNM1EjpFevWrHe3owoDAnvFKfSPfNoB22ly9PZWjqb9GWXplbM2hTQ39Sqg0yeHsvXBAjLYql4dd1ZRAwUEAA==";


/** The fixture tree as a plain tar. */
export function fixtureTar(): Buffer {
	return Buffer.from(gunzipSync(Buffer.from(FIXTURE_TAR_GZ, "base64")));
}

/** The fixture tree as an ISO 9660 image. */
export function fixtureIso(): Buffer {
	return Buffer.from(gunzipSync(Buffer.from(FIXTURE_ISO_GZ, "base64")));
}

/** A GNU-style `ar` archive: what a `.deb` is. Member names end in `/` the way dpkg writes them. */
export function arArchive(members: readonly { readonly name: string; readonly data: Uint8Array }[]): Buffer {
	const parts: Buffer[] = [Buffer.from("!<arch>\n")];
	for (const { name, data } of members) {
		const header = `${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
		parts.push(Buffer.from(header, "latin1"), Buffer.from(data));
		if (data.length % 2 === 1) parts.push(Buffer.from("\n"));
	}
	return Buffer.concat(parts);
}

/** A `.deb`: `debian-binary`, an (unrelated) control archive, then the payload under `dataName`. */
export function debPackage(dataName: string, data: Uint8Array): Buffer {
	return arArchive([
		{ name: "debian-binary", data: Buffer.from("2.0\n") },
		{ name: "control.tar.gz", data: gzipSync(Buffer.from("not the payload")) },
		{ name: dataName, data },
	]);
}

/** An RPM header section: the 16-byte intro, `indexCount` 16-byte index entries, then `dataLength` bytes of tag data. */
function rpmHeader(indexCount: number, dataLength: number): Buffer {
	const intro = Buffer.alloc(16);
	intro.writeUInt32BE(0x8eade801, 0);
	intro.writeUInt32BE(indexCount, 8);
	intro.writeUInt32BE(dataLength, 12);
	return Buffer.concat([intro, Buffer.alloc(indexCount * 16 + dataLength)]);
}

/**
 * An `.rpm`: the 96-byte lead, a signature header padded to 8 bytes, the main
 * header, then `payload`. The headers carry index entries and data so the
 * reader has to honour their sizes and the signature padding to find the payload.
 */
export function rpmPackage(payload: Uint8Array): Buffer {
	const lead = Buffer.alloc(96);
	lead.writeUInt32BE(0xedabeedb, 0);
	lead.writeUInt8(3, 4);
	lead.writeUInt16BE(5, 78);
	const signature = rpmHeader(1, 3);
	const padded = Buffer.concat([signature, Buffer.alloc((8 - (signature.length % 8)) % 8)]);
	return Buffer.concat([lead, padded, rpmHeader(2, 7), Buffer.from(payload)]);
}

/** A `.cab` with one uncompressed folder holding `files` (all in one data block). */
export function cabArchive(files: readonly { readonly name: string; readonly data: string; readonly date: Date }[]): Buffer {
	const bodies = files.map((file) => Buffer.from(file.data));
	const total = bodies.reduce((sum, body) => sum + body.length, 0);
	const entries = files.map((file, index) => {
		const entry = Buffer.alloc(16);
		entry.writeUInt32LE(bodies[index]?.length ?? 0, 0);
		entry.writeUInt32LE(bodies.slice(0, index).reduce((sum, body) => sum + body.length, 0), 4);
		entry.writeUInt16LE(0, 8);
		entry.writeUInt16LE(((file.date.getUTCFullYear() - 1980) << 9) | ((file.date.getUTCMonth() + 1) << 5) | file.date.getUTCDate(), 10);
		entry.writeUInt16LE((file.date.getUTCHours() << 11) | (file.date.getUTCMinutes() << 5) | (file.date.getUTCSeconds() >> 1), 12);
		entry.writeUInt16LE(0x20, 14);
		return Buffer.concat([entry, Buffer.from(`${file.name}\0`)]);
	});
	const filesLength = entries.reduce((sum, entry) => sum + entry.length, 0);
	const dataOffset = 36 + 8 + filesLength;
	const header = Buffer.alloc(36);
	header.write("MSCF", 0, "latin1");
	header.writeUInt32LE(dataOffset + 8 + total, 8);
	header.writeUInt32LE(36 + 8, 16);
	header.writeUInt8(3, 24);
	header.writeUInt8(1, 25);
	header.writeUInt16LE(1, 26);
	header.writeUInt16LE(files.length, 28);
	const folder = Buffer.alloc(8);
	folder.writeUInt32LE(dataOffset, 0);
	folder.writeUInt16LE(1, 4);
	const block = Buffer.alloc(8);
	block.writeUInt16LE(total, 4);
	block.writeUInt16LE(total, 6);
	return Buffer.concat([header, folder, ...entries, block, ...bodies]);
}
