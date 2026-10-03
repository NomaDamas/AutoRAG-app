import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { measureFolder, summarizeFolder } from "../src/preview/node/folder";
import { describeBinary } from "../src/preview/shared/binary-kind";
import { isQuickLookReady } from "../src/preview/shared/contract";
import { fitQuickLook, QUICK_LOOK_TOOLBAR } from "../src/preview/shared/fit";
import { formatClock, formatFinderDate, formatFinderSize, formatItemCount } from "../src/preview/shared/format";
import { locationCrumbs } from "../src/preview/shared/location";

const SCREEN = { width: 1440, height: 900 };

describe("quick look fit modes", () => {
	it("keeps a document's preferred width while clamping a tall body to the screen", () => {
		const size = fitQuickLook({ width: 840, height: 5000 }, SCREEN, "clamp");
		expect(size.width).toBe(840);
		expect(size.height).toBe(Math.round(900 * 0.86));
	});

	it("adds the toolbar to a fixed-size panel body", () => {
		expect(QUICK_LOOK_TOOLBAR).toBe(46);
		expect(fitQuickLook({ width: 620, height: 244 }, SCREEN, "clamp")).toEqual({ width: 620, height: 290 });
	});

	it("only accepts ready reports that name a fit mode", () => {
		expect(isQuickLookReady({ seq: 1, width: 10, height: 10, fit: "clamp" })).toBe(true);
		expect(isQuickLookReady({ seq: 1, width: 10, height: 10, fit: "aspect" })).toBe(true);
		expect(isQuickLookReady({ seq: 1, width: 10, height: 10, fit: "stretch" })).toBe(false);
		expect(isQuickLookReady({ seq: 1, width: 10, height: 10 })).toBe(false);
	});
});

describe("finder formatting", () => {
	it("prints sizes the way Finder does", () => {
		expect(formatFinderSize(0)).toBe("Zero bytes");
		expect(formatFinderSize(1)).toBe("1 byte");
		expect(formatFinderSize(512)).toBe("512 bytes");
		expect(formatFinderSize(12_345)).toBe("12 KB");
		expect(formatFinderSize(6_800_000)).toBe("6.8 MB");
		expect(formatFinderSize(214_600_000)).toBe("214.6 MB");
		expect(formatFinderSize(1_240_000_000)).toBe("1.24 GB");
		expect(formatFinderSize(3_500_000_000_000)).toBe("3.5 TB");
	});

	it("prints Finder dates with and without seconds", () => {
		const iso = new Date(2026, 7, 28, 22, 58, 21).toISOString();
		expect(formatFinderDate(iso, true)).toBe("Aug 28, 2026 at 10:58:21 PM");
		expect(formatFinderDate(new Date(2026, 8, 30, 16, 12, 5).toISOString(), false)).toBe("Sep 30, 2026 at 4:12 PM");
		expect(formatFinderDate("not a date", false)).toBe("not a date");
	});

	it("prints media clocks with hours only when needed", () => {
		expect(formatClock(4.9)).toBe("0:04");
		expect(formatClock(157)).toBe("2:37");
		expect(formatClock(3725)).toBe("1:02:05");
		expect(formatClock(-3)).toBe("0:00");
		expect(formatClock(Number.NaN)).toBe("0:00");
	});

	it("counts items in English like the Finder header", () => {
		expect(formatItemCount(0)).toBe("Zero items");
		expect(formatItemCount(1)).toBe("1 item");
		expect(formatItemCount(24)).toBe("24 items");
		expect(formatItemCount(12_400)).toBe("12,400 items");
	});
});

describe("file location crumbs", () => {
	it("names the boot volume for paths on the startup disk", () => {
		expect(locationCrumbs("/Users/jeffrey/Downloads/SecuKitNXS.exe", "darwin", "Macintosh HD")).toEqual(["Macintosh HD", "Users", "jeffrey", "Downloads"]);
	});

	it("names a mounted volume instead of /Volumes", () => {
		expect(locationCrumbs("/Volumes/SSD1/3/report.pdf", "darwin", "Macintosh HD")).toEqual(["SSD1", "3"]);
	});

	it("starts Windows paths at the drive", () => {
		expect(locationCrumbs("C:\\Users\\me\\Downloads\\setup.exe", "win32", null)).toEqual(["C:", "Users", "me", "Downloads"]);
		expect(locationCrumbs("\\\\server\\share\\docs\\a.txt", "win32", null)).toEqual(["\\\\server\\share", "docs"]);
	});

	it("falls back to the root when the boot volume is unknown", () => {
		expect(locationCrumbs("/tmp/a.txt", "linux", null)).toEqual(["/", "tmp"]);
	});
});

function bytes(length: number, writes: readonly (readonly [number, readonly number[]])[]): Uint8Array {
	const out = new Uint8Array(length);
	for (const [offset, values] of writes) out.set(values, offset);
	return out;
}

function u16(value: number): readonly number[] {
	return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): readonly number[] {
	return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function portableExecutable(machine: number, magic: number): Uint8Array {
	const pe = 0x80;
	return bytes(512, [
		[0, [0x4d, 0x5a]],
		[0x3c, u32(pe)],
		[pe, [0x50, 0x45, 0, 0]],
		[pe + 4, u16(machine)],
		[pe + 24, u16(magic)],
	]);
}

describe("binary sniffing", () => {
	it("names the platform of Windows executables", () => {
		expect(describeBinary(portableExecutable(0x8664, 0x20b), null)).toEqual({ label: "플랫폼", value: "Windows (PE32+, x86-64)" });
		expect(describeBinary(portableExecutable(0x14c, 0x10b), null)).toEqual({ label: "플랫폼", value: "Windows (PE32, x86)" });
		expect(describeBinary(portableExecutable(0xaa64, 0x20b), null)).toEqual({ label: "플랫폼", value: "Windows (PE32+, ARM64)" });
	});

	it("names Mach-O and ELF binaries", () => {
		const machO = bytes(64, [
			[0, [0xcf, 0xfa, 0xed, 0xfe]],
			[4, u32(0x0100000c)],
		]);
		expect(describeBinary(machO, null)).toEqual({ label: "플랫폼", value: "macOS (Mach-O, arm64)" });
		const universal = bytes(64, [[0, [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]]]);
		expect(describeBinary(universal, null)).toEqual({ label: "플랫폼", value: "macOS (Universal)" });
		const elf = bytes(64, [
			[0, [0x7f, 0x45, 0x4c, 0x46, 2, 1]],
			[18, u16(0x3e)],
		]);
		expect(describeBinary(elf, null)).toEqual({ label: "플랫폼", value: "Linux (ELF 64-bit, x86-64)" });
	});

	it("recognizes an Apple disk image from its trailer", () => {
		const tail = bytes(512, [[0, [0x6b, 0x6f, 0x6c, 0x79]]]);
		expect(describeBinary(new Uint8Array(64), tail)).toEqual({ label: "포맷", value: "Apple 디스크 이미지 (UDIF)" });
	});

	it("stays quiet about anything else", () => {
		expect(describeBinary(new TextEncoder().encode("hello world"), null)).toBeNull();
		expect(describeBinary(new Uint8Array(0), null)).toBeNull();
		expect(describeBinary(bytes(8, [[0, [0x4d, 0x5a]]]), null)).toBeNull();
	});
});

describe("folder summary", () => {
	async function fixture(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "autorag-ql-folder-"));
		const at = (minutes: number): Date => new Date(Date.UTC(2026, 8, 30, 12, minutes));
		const files: readonly (readonly [string, number, number])[] = [
			["old.txt", 10, 0],
			["build_eval.py", 2000, 9],
			["README.md", 300, 8],
			["demo.mp4", 50_000, 6],
			["report.pdf", 4000, 5],
			["notes.txt", 20, 1],
		];
		for (const [name, size, minute] of files) {
			const path = join(dir, name);
			await writeFile(path, new Uint8Array(size));
			await utimes(path, at(minute), at(minute));
		}
		await mkdir(join(dir, "assets", "deep"), { recursive: true });
		await writeFile(join(dir, "assets", "deep", "logo.png"), new Uint8Array(700));
		await utimes(join(dir, "assets"), at(7), at(7));
		await writeFile(join(dir, ".DS_Store"), new Uint8Array(6000));
		return dir;
	}

	it("counts visible items and lists the most recently modified first", async () => {
		const dir = await fixture();
		try {
			const summary = await summarizeFolder(dir, 6);
			expect(summary.itemCount).toBe(7);
			expect(summary.recent.map((item) => item.name)).toEqual(["build_eval.py", "README.md", "assets", "demo.mp4", "report.pdf", "notes.txt"]);
			expect(summary.recent.find((item) => item.name === "assets")?.folder).toBe(true);
			expect(summary.recent.find((item) => item.name === "build_eval.py")?.ext).toBe("py");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("adds up every file below the folder, hidden ones included", async () => {
		const dir = await fixture();
		try {
			const total = 10 + 2000 + 300 + 50_000 + 4000 + 20 + 700 + 6000;
			expect(await measureFolder(dir, { maxEntries: 1000, maxMs: 5000 })).toEqual({ bytes: total, complete: true });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("reports a partial total when the walk runs out of budget", async () => {
		const dir = await fixture();
		try {
			const partial = await measureFolder(dir, { maxEntries: 3, maxMs: 5000 });
			expect(partial.complete).toBe(false);
			expect(partial.bytes).toBeLessThan(63_030);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
