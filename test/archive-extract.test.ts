import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createActionService, type ActionService } from "../src/main/action-service";
import { type ArchiveLimits } from "../src/main/archive-common";
import { extractWithLibarchive } from "../src/main/libarchive-reader";

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
	it("writes a single compressed file as its name without .gz", async () => {
		await writeFile(join(root, "notes.txt"), "compressed body");
		execFileSync("gzip", ["-f", join(root, "notes.txt")]);
		const out = await service().run([join(root, "notes.txt.gz")], { kind: "extract" }, null);
		expect(out.output).toBe(join(root, "notes.txt"));
		expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("compressed body");
	});

	it("treats a .gz wrapping a tar as a tar folder", async () => {
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
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/손상/);
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
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/손상|비어/);
		expect(await readdir(root)).toEqual(["broken.7z"]);
	});

	it("refuses an archive larger than the wasm engine cap", async () => {
		const archive = join(root, "big.7z");
		await writeFile(archive, Buffer.alloc(4096));
		const tiny = { ...LIMITS, maxEngineBytes: 1024 };
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(/너무 커서/);
		expect(await readdir(root)).toEqual(["big.7z"]);
	});
});

describe("encrypted archives", () => {
	it.skipIf(!hasBin("zip"))("refuses an encrypted zip without prompting", async () => {
		await writeFile(join(root, "secret.txt"), "secret");
		const archive = join(root, "enc.zip");
		execFileSync("zip", ["-j", "-P", "pw", archive, join(root, "secret.txt")]);
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/암호/);
		expect(await stat(join(root, "enc")).catch(() => null)).toBeNull();
	});

	it.skipIf(!hasBin("zip"))("the wasm engine refuses an encrypted archive too", async () => {
		await writeFile(join(root, "secret.txt"), "secret");
		const archive = join(root, "enc.zip");
		execFileSync("zip", ["-j", "-P", "pw", archive, join(root, "secret.txt")]);
		await expect(extractWithLibarchive(archive, join(root, "out"), LIMITS)).rejects.toThrow(/암호/);
	});
});

describe("hostile archives", () => {
	it("refuses a tar entry escaping the destination and cleans up staging", async () => {
		const archive = join(root, "hostile.tar");
		await writeFile(archive, buildTar([{ name: "../escape.txt", data: Buffer.from("pwned") }]));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/벗어납니다/);
		await expect(readFile(join(root, "escape.txt"))).rejects.toThrow();
		expect(await readdir(root)).toEqual(["hostile.tar"]);
	});

	it("refuses an absolute tar entry", async () => {
		const archive = join(root, "absolute.tar");
		await writeFile(archive, buildTar([{ name: "/etc/evil.txt", data: Buffer.from("pwned") }]));
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/절대 경로/);
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
		await expect(service().run([archive], { kind: "extract" }, null)).rejects.toThrow(/벗어납니다/);
		expect(await readdir(root)).toEqual(["slip.zip"]);
	});

	it("aborts when the extracted bytes exceed the bomb cap", async () => {
		const archive = join(root, "big.tar");
		await writeFile(archive, buildTar([{ name: "big.txt", data: Buffer.alloc(4096, 0x61) }]));
		const tiny = { ...LIMITS, maxTotalBytes: 1024 };
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(/너무 큽니다/);
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
		await expect(service(tiny).run([archive], { kind: "extract" }, null)).rejects.toThrow(/항목 수/);
		expect(await readdir(root)).toEqual(["many.tar"]);
	});
});

describe("non-archives", () => {
	it("refuses a file whose name is not an offered archive", async () => {
		const path = join(root, "notes.txt");
		await writeFile(path, "plain");
		await expect(service().run([path], { kind: "extract" }, null)).rejects.toThrow(/압축을 풀 수 없는/);
	});

	it("refuses a dotfile whose whole name is a suffix", async () => {
		const path = join(root, ".zip");
		await writeFile(path, "zipSync({})");
		await expect(service().run([path], { kind: "extract" }, null)).rejects.toThrow(/압축을 풀 수 없는/);
	});
});
