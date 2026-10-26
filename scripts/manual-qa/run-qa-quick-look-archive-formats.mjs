/**
 * Manual QA — Quick Look lists 7z, RAR, bzip2/xz/zstd tars, ISO, deb, rpm, and CAB.
 *
 * Each of those must open with the same panel as a zip (header, "N items,
 * size", the 포함된 항목 strip newest first), and an archive that cannot be
 * listed — password-protected, damaged, too large — must say so in the panel
 * instead of erroring. Builds the fixtures, drives the production build (`bun
 * run build` first), opens each file with Space from the Finder list, and
 * reads the panel in the DOM. `.dmg` has no reader and must keep the info panel.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.argv[2] ?? fileURLToPath(new URL("../../.omo/evidence/quick-look-archive-formats/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-archive-formats-"));
const tree = join(root, ".tree");
const TAR = process.platform === "linux" ? "bsdtar" : "tar";
const tarEnv = { ...process.env, COPYFILE_DISABLE: "1" };

// The tree every container holds: three top-level children, newest first 한글, docs, readme.md.
const when = (year, month, day) => new Date(Date.UTC(year, month - 1, day, 12));
function plant(path, text, date) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
	utimesSync(path, date, date);
}
plant(join(tree, "readme.md"), "top", when(2022, 5, 6));
plant(join(tree, "docs", "a.txt"), "hello", when(2024, 1, 2));
plant(join(tree, "docs", "sub", "b.txt"), "world", when(2022, 1, 1));
plant(join(tree, "한글", "메모.txt"), "memo", when(2025, 3, 4));
// Creating a file touched its folder; pin the folders' dates too, or they would read "now" and tie.
for (const [folder, date] of [["docs/sub", when(2022, 1, 1)], ["docs", when(2024, 1, 2)], ["한글", when(2025, 3, 4)]]) utimesSync(join(tree, folder), date, date);
const TREE_NAMES = ["readme.md", "docs", "한글"];
const EXPECTED = ["한글", "docs", "readme.md"];

function bsdtar(args, out) {
	execFileSync(TAR, [...args, "-f", join(root, out), ...TREE_NAMES], { cwd: tree, env: tarEnv });
}
bsdtar(["-c", "--format", "7zip"], "sample.7z");
bsdtar(["-cj"], "sample.tar.bz2");
bsdtar(["-cJ"], "sample.tar.xz");
bsdtar(["-c", "--format", "iso9660"], "sample.iso");

// deb: an ar archive whose data.tar.gz member is the payload.
function ar(members) {
	const parts = [Buffer.from("!<arch>\n")];
	for (const { name, data } of members) {
		const header = `${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
		parts.push(Buffer.from(header, "latin1"), data, ...(data.length % 2 === 1 ? [Buffer.from("\n")] : []));
	}
	return Buffer.concat(parts);
}
bsdtar(["-c", "--format", "ustar"], "payload.tar");
const payloadTar = readFileSync(join(root, "payload.tar"));
rmSync(join(root, "payload.tar"));
// The guest has no zstd program for tar to launch; Node's own zstd writes the same stream.
writeFileSync(join(root, "sample.tar.zst"), zstdCompressSync(payloadTar));
writeFileSync(join(root, "sample.deb"), ar([{ name: "debian-binary", data: Buffer.from("2.0\n") }, { name: "control.tar.gz", data: gzipSync(Buffer.from("x")) }, { name: "data.tar.gz", data: gzipSync(payloadTar) }]));

// rpm: lead, signature header (padded to 8), main header, gzip(cpio).
function rpmHeader(indexCount, dataLength) {
	const intro = Buffer.alloc(16);
	intro.writeUInt32BE(0x8eade801, 0);
	intro.writeUInt32BE(indexCount, 8);
	intro.writeUInt32BE(dataLength, 12);
	return Buffer.concat([intro, Buffer.alloc(indexCount * 16 + dataLength)]);
}
bsdtar(["-c", "--format", "newc"], "payload.cpio");
const cpio = readFileSync(join(root, "payload.cpio"));
rmSync(join(root, "payload.cpio"));
const lead = Buffer.alloc(96);
lead.writeUInt32BE(0xedabeedb, 0);
lead.writeUInt8(3, 4);
const signature = rpmHeader(1, 3);
writeFileSync(join(root, "sample.rpm"), Buffer.concat([lead, signature, Buffer.alloc((8 - (signature.length % 8)) % 8), rpmHeader(2, 7), gzipSync(cpio)]));

// cab: one stored folder; names use backslashes the way Windows tools write them.
function cab(files) {
	const bodies = files.map((file) => Buffer.from(file.data));
	const total = bodies.reduce((sum, body) => sum + body.length, 0);
	const entries = files.map((file, index) => {
		const entry = Buffer.alloc(16);
		entry.writeUInt32LE(bodies[index].length, 0);
		entry.writeUInt32LE(bodies.slice(0, index).reduce((sum, body) => sum + body.length, 0), 4);
		entry.writeUInt16LE(((file.date.getUTCFullYear() - 1980) << 9) | ((file.date.getUTCMonth() + 1) << 5) | file.date.getUTCDate(), 10);
		entry.writeUInt16LE(file.date.getUTCHours() << 11, 12);
		entry.writeUInt16LE(0x20, 14);
		return Buffer.concat([entry, Buffer.from(`${file.name}\0`)]);
	});
	const dataOffset = 36 + 8 + entries.reduce((sum, entry) => sum + entry.length, 0);
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
writeFileSync(join(root, "sample.cab"), cab([{ name: "readme.md", data: "top", date: when(2022, 5, 6) }, { name: "docs\\a.txt", data: "hello", date: when(2024, 1, 2) }, { name: "docs\\sub\\b.txt", data: "world", date: when(2022, 1, 1) }]));

// RAR has no writer: libarchive's own test archives, kept with the unit-test fixtures.
const fixtures = readFileSync(join(fileURLToPath(new URL("../../test/archive-fixtures.ts", import.meta.url))), "utf8");
function fixture(name) {
	const found = new RegExp(`export const ${name} =\\s*"([^"]+)"`).exec(fixtures);
	if (found === null) throw new Error(`fixture ${name} missing`);
	return Buffer.from(found[1], "base64");
}
writeFileSync(join(root, "sample.rar"), fixture("RAR5_STORED"));
writeFileSync(join(root, "locked.rar"), fixture("RAR5_ENCRYPTED"));

// Notes: not an archive, and one far over the input cap (sparse, so it costs no disk).
writeFileSync(join(root, "junk.7z"), "this is plain text, not an archive at all ".repeat(20));
writeFileSync(join(root, "huge.7z"), "");
truncateSync(join(root, "huge.7z"), 300 * 1024 ** 2);
// A disk image has no reader here: it keeps the info panel.
writeFileSync(join(root, "disk.dmg"), Buffer.from(Array.from({ length: 4096 }, (_unused, index) => (index * 31) % 251)));
rmSync(tree, { recursive: true, force: true });

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
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
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const visible = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window !== undefined && window.isVisible();
		});

	/** Space on `name`, then wait until the panel stopped loading: either the item count or a note is drawn. */
	async function open(name) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(
			() =>
				preview
					.evaluate((expected) => {
						const archive = document.querySelector(".ql-archive");
						const other = document.querySelector(".ql-other__name");
						if (other?.textContent === expected) return true;
						return archive?.querySelector(".ql-archive__name")?.textContent === expected && /\d+(\s?items|개 항목)/u.test(archive.querySelector(".ql-archive__count")?.textContent ?? "");
					}, name)
					.catch(() => false),
			Boolean,
			15_000,
		);
		await poll(visible, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 1200));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => !(await visible()), Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const texts = (selector) => preview.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.textContent));

	const LISTED = [
		["sample.7z", "7-Zip archive"],
		["sample.tar.bz2", "Bzip2 archive"],
		["sample.tar.xz", "XZ archive"],
		["sample.tar.zst", "Zstandard archive"],
		["sample.iso", "Disc Image"],
		["sample.deb", "Debian package"],
		["sample.rpm", "RPM package"],
		["sample.cab", "Cabinet archive"],
	];
	for (const [name, kind] of LISTED) {
		await open(name);
		const panel = (await preview.locator(".ql-archive").textContent().catch(() => null)) ?? "";
		check(`${name} opens the archive panel as a ${kind}`, panel.includes(kind), panel.slice(0, 80));
		const count = (await preview.locator(".ql-archive__count").textContent().catch(() => null)) ?? "";
		const expectedCount = name === "sample.cab" ? 2 : 3;
		check(`${name} counts its top-level items`, new RegExp(`^${expectedCount}(\\s?items|개 항목),? `, "u").test(count), count);
		const items = await texts(".ql-archive__items > div > span");
		const expectedItems = name === "sample.cab" ? ["docs", "readme.md"] : EXPECTED;
		check(`${name} lists the newest child first`, JSON.stringify(items) === JSON.stringify(expectedItems), JSON.stringify(items));
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		await close();
	}

	await open("sample.rar");
	const rarItems = await texts(".ql-archive__items > div > span");
	check("sample.rar lists helloworld.txt", JSON.stringify(rarItems) === JSON.stringify(["helloworld.txt"]), JSON.stringify(rarItems));
	await preview.screenshot({ path: join(EVIDENCE, "sample.rar.png") });
	await close();

	const NOTES = [
		["locked.rar", "암호로 보호된 압축 파일이라 목록을 볼 수 없습니다"],
		["junk.7z", "목록을 읽지 못했습니다"],
		["huge.7z", "너무 커서"],
	];
	for (const [name, note] of NOTES) {
		await open(name);
		const shown = (await preview.locator(".ql__note").textContent().catch(() => null)) ?? "";
		check(`${name} shows a note instead of an error`, shown.includes(note), shown);
		check(`${name} keeps the info panel`, ((await preview.locator(".ql-other__name").textContent().catch(() => null)) ?? "") === name);
		await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
		await close();
	}

	await open("disk.dmg");
	check("disk.dmg keeps the info panel with no archive listing", (await preview.locator(".ql-archive").count()) === 0 && (await preview.locator(".ql-other__name").textContent()) === "disk.dmg");
	await preview.screenshot({ path: join(EVIDENCE, "disk.dmg.png") });
	await close();
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
