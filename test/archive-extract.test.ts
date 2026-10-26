import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActionService, type ActionService } from "../src/main/action-service";
import { type ArchiveLimits } from "../src/main/archive-common";
import { extractWithLibarchive } from "../src/main/libarchive-reader";
import { ArchiveError } from "../src/main/archive-guard.mjs";
import { t } from "../src/shared/i18n/core";
import { RAR4_TREE, RAR5_ENCRYPTED, RAR5_STORED } from "./archive-fixtures";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-extract-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Whether a fixture tool is on PATH; the archive lanes skip when it is absent. */
function hasBin(name: string): boolean {
	const finder = process.platform === "win32" ? "where" : "which";
	try {
		execFileSync(finder, [name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function service(archiveLimits?: ArchiveLimits): ActionService {
	return createActionService({
		platform: "darwin",
		applications: { pick: async () => null },
		run: async () => ({ stdout: "", stderr: "" }),
		...(archiveLimits === undefined ? {} : { archiveLimits }),
	});
}

const LIMITS: ArchiveLimits = { maxTotalBytes: 20 * 1024 ** 3, maxEntries: 100_000, maxEngineBytes: 1024 ** 3 };

/** A source tree with a wrapper folder, a nested file, and an empty directory. */
async function docsSource(): Promise<string> {
	const src = join(root, "src");
	await mkdir(join(src, "docs", "empty"), { recursive: true });
	await writeFile(join(src, "docs", "readme.md"), "hello");
	await writeFile(join(src, "docs", "empty", "keep.txt"), "keep");
	return src;
}

/** A minimal, checksum-valid tar — enough to exercise names, types, and bytes. */
interface TarFixtureEntry {
	readonly name: string;
	readonly type?: string;
	readonly data?: Buffer;
	readonly linkname?: string;
}

function buildTar(entries: readonly TarFixtureEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const data = entry.data ?? Buffer.alloc(0);
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		header.write("0000644\0", 100, 8, "ascii");
		header.write("0000000\0", 108, 8, "ascii");
		header.write("0000000\0", 116, 8, "ascii");
		header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
		header.write("00000000000\0", 136, 12, "ascii");
		header.write("        ", 148, 8, "ascii");
		header.write(entry.type ?? "0", 156, 1, "ascii");
		if (entry.linkname !== undefined) header.write(entry.linkname, 157, 100, "utf8");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let sum = 0;
		for (const byte of header) sum += byte;
		header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header);
		if (data.length > 0) {
			blocks.push(data);
			const padding = (512 - (data.length % 512)) % 512;
			if (padding > 0) blocks.push(Buffer.alloc(padding));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

describe("tar family extraction", () => {
	it("extracts a .tar and strips the matching wrapper folder", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tar");
		execFileSync("tar", ["-cf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
		expect(await readFile(join(root, "docs", "empty", "keep.txt"), "utf8")).toBe("keep");
	});

	it("keeps several top-level folders intact", async () => {
		const src = join(root, "multi");
		await mkdir(join(src, "alpha"), { recursive: true });
		await mkdir(join(src, "beta"), { recursive: true });
		await writeFile(join(src, "alpha", "a.txt"), "a");
		await writeFile(join(src, "beta", "b.txt"), "b");
		const archive = join(root, "bundle.tar");
		execFileSync("tar", ["-cf", archive, "-C", src, "alpha", "beta"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readFile(join(out.output ?? "", "alpha", "a.txt"), "utf8")).toBe("a");
		expect(await readFile(join(out.output ?? "", "beta", "b.txt"), "utf8")).toBe("b");
	});

	it("walks pax headers for long names", async () => {
		const longName = `${"long".repeat(30)}.txt`;
		await writeFile(join(root, longName), "long body");
		const archive = join(root, "paxish.tar");
		execFileSync("tar", ["-cf", archive, "-C", root, longName]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readFile(join(out.output ?? "", longName), "utf8")).toBe("long body");
	});

	it("walks GNU long-name (L) headers", async () => {
		const longName = `${"seg".repeat(40)}.txt`;
		const archive = join(root, "gnu-long.tar");
		await writeFile(
			archive,
			buildTar([
				{ name: "././@LongLink", type: "L", data: Buffer.from(`${longName}\0`) },
				{ name: longName.slice(0, 100), data: Buffer.from("gnu long body") },
			]),
		);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readFile(join(out.output ?? "", longName), "utf8")).toBe("gnu long body");
	});

	it("numbers the output folder when the name is taken", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tar");
		execFileSync("tar", ["-cf", archive, "-C", src, "docs"]);
		await mkdir(join(root, "docs"), { recursive: true });
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs 2"));
		expect(await readFile(join(root, "docs 2", "readme.md"), "utf8")).toBe("hello");
	});
});

describe("gzip family extraction", () => {
	it.skipIf(!hasBin("gzip"))("writes a single compressed file as its name without .gz", async () => {
		await writeFile(join(root, "notes.txt"), "compressed body");
		execFileSync("gzip", ["-f", join(root, "notes.txt")]);
		const out = await service().run([join(root, "notes.txt.gz")], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "notes.txt"));
		expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("compressed body");
	});

	it.skipIf(!hasBin("gzip"))("treats a .gz wrapping a tar as a tar folder", async () => {
		const src = await docsSource();
		const tar = join(root, "payload.tar");
		execFileSync("tar", ["-cf", tar, "-C", src, "docs"]);
		execFileSync("gzip", ["-f", tar]);
		await rename(join(root, "payload.tar.gz"), join(root, "payload.gz"));
		const out = await service().run([join(root, "payload.gz")], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "payload"));
		expect(await readFile(join(root, "payload", "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it("extracts a .tar.gz and strips the wrapper folder", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tar.gz");
		execFileSync("tar", ["-czf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it("extracts a .tgz the same way", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tgz");
		execFileSync("tar", ["-czf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it("reports a corrupt .gz with Korean copy and leaves nothing behind", async () => {
		const archive = join(root, "bad.gz");
		await writeFile(archive, Buffer.from("this is not a gzip stream"));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["bad.gz"]);
	});
});

describe("libarchive-backed extraction", () => {
	it.skipIf(!hasBin("bsdtar"))("extracts a .7z and strips the wrapper folder", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.7z");
		execFileSync("bsdtar", ["-a", "-cf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
		expect(await readFile(join(root, "docs", "empty", "keep.txt"), "utf8")).toBe("keep");
	});

	it.skipIf(!hasBin("bsdtar"))("skips 7z symlinks and never creates a link", async () => {
		const src = join(root, "symsrc");
		await mkdir(src, { recursive: true });
		await writeFile(join(src, "real.txt"), "body");
		await symlink("real.txt", join(src, "link.txt"));
		const archive = join(root, "sym.7z");
		execFileSync("bsdtar", ["-a", "-cf", archive, "-C", src, "."]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await lstat(join(out.output ?? "", "link.txt")).catch(() => null)).toBeNull();
		expect(await readFile(join(out.output ?? "", "real.txt"), "utf8")).toBe("body");
	});

	it.skipIf(!hasBin("bzip2"))("extracts a .tar.bz2", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tar.bz2");
		execFileSync("tar", ["-cjf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it.skipIf(!hasBin("xz"))("extracts a .tar.xz", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tar.xz");
		execFileSync("tar", ["-cJf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it.skipIf(!hasBin("bzip2"))("extracts a .tbz2 shorthand", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.tbz2");
		execFileSync("tar", ["-cjf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it.skipIf(!hasBin("xz"))("extracts a .txz shorthand", async () => {
		const src = await docsSource();
		const archive = join(root, "docs.txz");
		execFileSync("tar", ["-cJf", archive, "-C", src, "docs"]);
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "docs"));
		expect(await readFile(join(root, "docs", "readme.md"), "utf8")).toBe("hello");
	});

	it("reports a corrupt 7z with Korean copy and no output", async () => {
		const archive = join(root, "broken.7z");
		await writeFile(archive, Buffer.from("definitely not a 7z archive, but long enough to read"));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["broken.7z"]);
	});

	it("refuses an archive larger than the wasm engine cap", async () => {
		const archive = join(root, "big.7z");
		await writeFile(archive, Buffer.alloc(4096));
		const tiny = { ...LIMITS, maxEngineBytes: 1024 };
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["big.7z"]);
	});

	// Fixtures are libarchive's own RAR test archives (BSD-2-Clause), embedded
	// because no RAR writer exists to build them here.
	it("extracts a RAR4 archive, skipping its symlink and keeping its empty directory", async () => {
		const archive = join(root, "legacy.rar");
		await writeFile(archive, Buffer.from(RAR4_TREE, "base64"));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "legacy"));
		expect(await readFile(join(root, "legacy", "test.txt"), "utf8")).toBe("test text document\r\n");
		expect(await readFile(join(root, "legacy", "testdir", "test.txt"), "utf8")).toBe("test text document\r\n");
		expect((await stat(join(root, "legacy", "testemptydir"))).isDirectory()).toBe(true);
		expect(await lstat(join(root, "legacy", "testlink")).catch(() => null)).toBeNull();
	});

	it("extracts a RAR5 archive", async () => {
		const archive = join(root, "modern.rar");
		await writeFile(archive, Buffer.from(RAR5_STORED, "base64"));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "modern"));
		expect(await readFile(join(root, "modern", "helloworld.txt"), "utf8")).toBe("hello libarchive test suite!\n");
	});

	it("refuses an encrypted RAR with Korean copy and leaves nothing behind", async () => {
		const archive = join(root, "secret.rar");
		await writeFile(archive, Buffer.from(RAR5_ENCRYPTED, "base64"));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["secret.rar"]);
	});
});

/** One zip entry with its name as raw bytes and the general-purpose flags chosen by the caller. */
function rawZip(entries: readonly { readonly name: Buffer; readonly flags: number; readonly body: Buffer }[]): Buffer {
	const locals: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const crc = crc32(entry.body);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(entry.flags, 6);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(entry.body.length, 18);
		local.writeUInt32LE(entry.body.length, 22);
		local.writeUInt16LE(entry.name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(entry.flags, 8);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(entry.body.length, 20);
		central.writeUInt32LE(entry.body.length, 24);
		central.writeUInt16LE(entry.name.length, 28);
		central.writeUInt32LE(offset, 42);
		const piece = Buffer.concat([local, entry.name, entry.body]);
		locals.push(piece);
		directory.push(Buffer.concat([central, entry.name]));
		offset += piece.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, central, end]);
}

describe("Korean file names", () => {
	const NFC = "한글 보고서.txt";
	/** The CP949 bytes Korean Windows Explorer writes into a zip, with no UTF-8 flag. */
	const CP949_NAME = Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xba, 0xb8, 0xb0, 0xed, 0xbc, 0xad, 0x2e, 0x74, 0x78, 0x74]);

	it("restores a CP949 zip name from Windows Explorer", async () => {
		const archive = join(root, "win.zip");
		await writeFile(archive, rawZip([{ name: CP949_NAME, flags: 0, body: Buffer.from("본문") }]));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual([NFC]);
		expect(await readFile(join(out.output ?? "", NFC), "utf8")).toBe("본문");
	});

	it("restores a UTF-8 zip name written without the UTF-8 flag", async () => {
		const archive = join(root, "unflagged.zip");
		await writeFile(archive, rawZip([{ name: Buffer.from(NFC, "utf8"), flags: 0, body: Buffer.from("x") }]));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual([NFC]);
	});

	it("keeps a flagged UTF-8 zip name that happens to look like Latin-1 mojibake", async () => {
		const archive = join(root, "flagged.zip");
		await writeFile(archive, rawZip([{ name: Buffer.from("Ç.txt", "utf8"), flags: 0x0800, body: Buffer.from("x") }]));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual(["Ç.txt"]);
	});

	it("composes a Mac-style decomposed (NFD) name so Windows sees the same file", async () => {
		const archive = join(root, "mac.zip");
		await writeFile(archive, zipSync({ [NFC.normalize("NFD")]: Buffer.from("x") }));
		const out = await service().run([archive], { kind: "extract" }, null);
		const [name] = await readdir(out.output ?? "");
		expect(name).toBe(NFC);
	});

	it("flattens the wrapper folder even when the archive stem is NFD and the entries are NFC", async () => {
		const archive = join(root, "자료.zip".normalize("NFD"));
		await writeFile(archive, zipSync({ [`${"자료".normalize("NFC")}/a.txt`]: Buffer.from("a") }));
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual(["a.txt"]);
	});

	it.skipIf(!hasBin("bsdtar"))("extracts a Korean file name from a .7z", async () => {
		const src = join(root, "src");
		await mkdir(join(src, "자료"), { recursive: true });
		await writeFile(join(src, "자료", NFC), "본문");
		const archive = join(root, "자료.7z");
		execFileSync("bsdtar", ["-a", "-cf", archive, "-C", src, "자료"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual([NFC]);
		expect(await readFile(join(out.output ?? "", NFC), "utf8")).toBe("본문");
	});

	it.skipIf(!hasBin("xz"))("extracts a Korean file name from a .tar.xz", async () => {
		const src = join(root, "src");
		await mkdir(join(src, "자료"), { recursive: true });
		await writeFile(join(src, "자료", NFC), "본문");
		const archive = join(root, "자료.tar.xz");
		execFileSync("tar", ["-cJf", archive, "-C", src, "자료"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
		const out = await service().run([archive], { kind: "extract" }, null);
		expect(await readdir(out.output ?? "")).toEqual([NFC]);
	});
});

describe("encrypted archives", () => {
	it.skipIf(!hasBin("zip"))("refuses an encrypted zip without prompting", async () => {
		await writeFile(join(root, "secret.txt"), "secret");
		const archive = join(root, "enc.zip");
		execFileSync("zip", ["-j", "-P", "pw", archive, join(root, "secret.txt")]);
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(t("main.archive.encrypted"));
		expect(await stat(join(root, "enc")).catch(() => null)).toBeNull();
	});

	it.skipIf(!hasBin("zip"))("the wasm engine refuses an encrypted archive too", async () => {
		await writeFile(join(root, "secret.txt"), "secret");
		const archive = join(root, "enc.zip");
		execFileSync("zip", ["-j", "-P", "pw", archive, join(root, "secret.txt")]);
		await expect(extractWithLibarchive(archive, join(root, "out"), LIMITS)).rejects.toThrow(ArchiveError);
	});
});

describe("hostile archives", () => {
	it("refuses a tar entry escaping the destination and cleans up staging", async () => {
		const archive = join(root, "hostile.tar");
		await writeFile(archive, buildTar([{ name: "../escape.txt", data: Buffer.from("pwned") }]));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
		expect(await readdir(root)).toEqual(["hostile.tar"]);
	});

	it("refuses an absolute tar entry", async () => {
		const archive = join(root, "absolute.tar");
		await writeFile(archive, buildTar([{ name: "/etc/evil.txt", data: Buffer.from("pwned") }]));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["absolute.tar"]);
	});

	it("skips tar links and devices, keeping a later path inside the destination", async () => {
		const archive = join(root, "hostile-links.tar");
		await writeFile(
			archive,
			buildTar([
				{ name: "link", type: "2", linkname: "../../etc/passwd" },
				{ name: "link/evil", data: Buffer.from("pwned") },
				{ name: "dev", type: "3" },
				{ name: "pipe", type: "6" },
			]),
		);
		const out = await service().run([archive], { kind: "extract" }, null);
		const dir = out.output ?? "";
		const link = await lstat(join(dir, "link"));
		expect(link.isDirectory()).toBe(true);
		expect(link.isSymbolicLink()).toBe(false);
		expect(await readFile(join(dir, "link", "evil"), "utf8")).toBe("pwned");
		expect(await lstat(join(dir, "dev")).catch(() => null)).toBeNull();
		expect(await lstat(join(dir, "pipe")).catch(() => null)).toBeNull();
	});

	it("refuses a zip-slip entry and leaves no output", async () => {
		const archive = join(root, "slip.zip");
		await writeFile(archive, zipSync({ "../escape.txt": new Uint8Array(Buffer.from("pwned")) }));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["slip.zip"]);
	});

	it("aborts when the extracted bytes exceed the bomb cap", async () => {
		const archive = join(root, "big.tar");
		await writeFile(archive, buildTar([{ name: "big.txt", data: Buffer.alloc(4096, 0x61) }]));
		const tiny = { ...LIMITS, maxTotalBytes: 1024 };
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["big.tar"]);
	});

	it("aborts when there are too many entries", async () => {
		const archive = join(root, "many.tar");
		await writeFile(
			archive,
			buildTar([
				{ name: "one.txt", data: Buffer.from("1") },
				{ name: "two.txt", data: Buffer.from("2") },
			]),
		);
		const tiny = { ...LIMITS, maxEntries: 1 };
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(ArchiveError);
		expect(await readdir(root)).toEqual(["many.tar"]);
	});
});

describe("non-archives", () => {
	it("refuses a file whose name is not an offered archive", async () => {
		const path = join(root, "notes.txt");
		await writeFile(path, "plain");
		await expect(service().run([path], { kind: "extract" }, null)).rejects.toThrow(t("main.action.unsupportedExtract"));
	});

	it("refuses a dotfile whose whole name is a suffix", async () => {
		const path = join(root, ".zip");
		await writeFile(path, "zipSync({})");
		await expect(service().run([path], { kind: "extract" }, null)).rejects.toThrow(t("main.action.unsupportedExtract"));
	});
});
