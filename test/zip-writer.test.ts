import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeZip, type ZipMember } from "../src/main/zip-writer";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-zip-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

function hasBin(name: string): boolean {
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [name], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** Files by entry name under `root/src`, written and returned as members (directories for names ending "/"). */
async function members(files: Readonly<Record<string, Buffer | null>>): Promise<ZipMember[]> {
	const src = join(root, "src");
	const list: ZipMember[] = [];
	for (const [entry, body] of Object.entries(files)) {
		const source = join(src, entry);
		if (body === null) {
			await mkdir(source, { recursive: true });
			list.push({ source, entry, directory: true });
		} else {
			await mkdir(join(source, ".."), { recursive: true });
			await writeFile(source, body);
			list.push({ source, entry, directory: false });
		}
	}
	return list;
}

/** Entry name -> bytes, read through the central directory. */
async function readBack(archive: string): Promise<Record<string, Buffer>> {
	const entries = unzipSync(new Uint8Array(await readFile(archive)));
	return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, Buffer.from(data)]));
}

/** Info-ZIP's own check: every entry's CRC, size, and the directory agree. */
function unzipTest(archive: string): void {
	execFileSync("unzip", ["-tqq", archive], { stdio: "pipe" });
}

const TEXT = Buffer.from("본문과 english text mixed 0123456789\n".repeat(2000));
const FILES = {
	"docs/": null,
	"docs/empty/": null,
	"docs/한글 보고서.txt": TEXT,
	"docs/zero.txt": Buffer.alloc(0),
	"docs/noise.bin": randomBytes(64 * 1024),
	"docs/tiny.txt": Buffer.from("x"),
} as const;
const EXPECTED = Object.fromEntries(Object.entries(FILES).map(([name, body]) => [name, body ?? Buffer.alloc(0)]));

describe("writeZip", () => {
	it("round-trips directories, empty, compressible, and incompressible files", async () => {
		const archive = join(root, "plain.zip");
		await writeZip(archive, await members(FILES));
		expect(await readBack(archive)).toEqual(EXPECTED);
		// Deflated text, stored noise: never meaningfully larger than the input.
		const raw = Object.values(EXPECTED).reduce((sum, body) => sum + body.length, 0);
		expect((await readFile(archive)).length).toBeLessThan(raw);
		if (hasBin("unzip")) unzipTest(archive);
	});

	it("writes Zip64 sizes and offsets that every reader resolves", async () => {
		const archive = join(root, "zip64.zip");
		// Every size and offset at or past 1 KiB goes through the Zip64 records, as past 4 GiB in a real archive.
		await writeZip(archive, await members(FILES), { zip64Threshold: 1024 });
		expect(await readBack(archive)).toEqual(EXPECTED);
		if (hasBin("unzip")) unzipTest(archive);
		if (hasBin("bsdtar")) {
			const out = join(root, "bsdtar-out");
			await mkdir(out);
			execFileSync("bsdtar", ["-xf", archive, "-C", out]);
			expect(await readFile(join(out, "docs", "한글 보고서.txt"))).toEqual(TEXT);
		}
	});

	it("records every entry when there are more than 65,535", { timeout: 120_000 }, async () => {
		const [file] = await members({ "one.txt": Buffer.from("1") });
		const count = 70_000;
		const list: ZipMember[] = Array.from({ length: count }, (_, index) => ({ source: file?.source ?? "", entry: `many/${index}.txt`, directory: false }));
		const archive = join(root, "many.zip");
		await writeZip(archive, list);
		const entries = await readBack(archive);
		expect(Object.keys(entries)).toHaveLength(count);
		expect(entries["many/69999.txt"]?.toString()).toBe("1");
		if (hasBin("zipinfo")) {
			const listed = execFileSync("zipinfo", ["-1", archive], { maxBuffer: 64 * 1024 ** 2 }).toString().trim().split("\n");
			expect(listed).toHaveLength(count);
		}
	});

	it("leaves no partial archive behind when a source disappears", async () => {
		const list = await members({ "a.txt": TEXT, "b.txt": TEXT });
		await rm(list[1]?.source ?? "");
		await expect(writeZip(join(root, "gone.zip"), list)).rejects.toThrow();
		expect(await readdir(root)).not.toContain("gone.zip");
	});
});
