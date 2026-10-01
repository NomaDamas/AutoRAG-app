import { mkdtemp, readFile, writeFile, rename, rmdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsEntry, FsVersionFamily } from "../src/shared/fs-contract";
import { createFileVersionFamilyStore } from "../src/main/version-family-store";
import {
	DIRTY_STAMP,
	type FileStamp,
	type Probe,
	remapRenames,
	sameContent,
	sameIdentity,
	verifyFamilies,
} from "../src/main/version-family-verify";

const stamp = (overrides: Partial<FileStamp> = {}): FileStamp => ({
	dev: "dev",
	ino: "1",
	size: "10",
	mtimeNs: "100",
	ctimeNs: "100",
	...overrides,
});

function entry(path: string, modifiedAt = "2026-09-29T00:00:00.000Z"): FsEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		kind: "file",
		ext: "txt",
		size: 10,
		modifiedAt,
		isSymlink: false,
		osKind: null,
		iconDataUrl: null,
	};
}

function family(head = "/x/head.txt", member = "/x/member.txt"): FsVersionFamily {
	return {
		head,
		members: [{ path: member, relation: "exact" }],
		entries: [entry(head, "2026-09-29T02:00:00.000Z"), entry(member)],
	};
}

function probeFrom(values: Readonly<Record<string, FileStamp | null>>, calls: string[] = []): Probe {
	return async (path) => {
		calls.push(path);
		return values[path] ?? null;
	};
}

describe("version-family verification primitives", () => {
	it("compares identity and all content fields, including dirty stamps", () => {
		expect(sameIdentity(stamp(), stamp({ size: "99" }))).toBe(true);
		expect(sameIdentity(stamp(), stamp({ ino: "2" }))).toBe(false);
		expect(sameContent(stamp(), stamp())).toBe(true);
		expect(sameContent(stamp(), stamp({ ctimeNs: "101" }))).toBe(false);
		expect(sameContent(DIRTY_STAMP, DIRTY_STAMP)).toBe(false);
		expect(sameContent({ ...DIRTY_STAMP }, { ...DIRTY_STAMP })).toBe(false);
	});

	it("prunes a vanished member", async () => {
		const result = await verifyFamilies(
			[family()],
			{ "/x/head.txt": stamp(), "/x/member.txt": stamp() },
			probeFrom({ "/x/head.txt": stamp(), "/x/member.txt": null }),
		);
		expect(result.vanished).toEqual(["/x/member.txt"]);
		expect(result.families).toEqual([]);
	});

	it("re-heads to the newest remaining member when the head vanishes", async () => {
		const original = {
			head: "/x/head.txt",
			members: [
				{ path: "/x/older.txt", relation: "exact" as const },
				{ path: "/x/newer.txt", relation: "near" as const },
			],
			entries: [entry("/x/head.txt"), entry("/x/older.txt", "2026-09-29T01:00:00.000Z"), entry("/x/newer.txt", "2026-09-29T03:00:00.000Z")],
		};
		const result = await verifyFamilies(
			[original],
			{ "/x/head.txt": stamp(), "/x/older.txt": stamp({ ino: "2" }), "/x/newer.txt": stamp({ ino: "3" }) },
			probeFrom({ "/x/head.txt": null, "/x/older.txt": stamp({ ino: "2" }), "/x/newer.txt": stamp({ ino: "3" }) }),
		);
		expect(result.families[0]?.head).toBe("/x/newer.txt");
		expect(result.families[0]?.members.map((member) => member.path)).toEqual(["/x/older.txt"]);
	});

	it("detaches a changed member and drops a changed head", async () => {
		const changedMember = await verifyFamilies(
			[family()],
			{ "/x/head.txt": stamp(), "/x/member.txt": stamp() },
			probeFrom({ "/x/head.txt": stamp(), "/x/member.txt": stamp({ size: "11" }) }),
		);
		expect(changedMember.families).toEqual([]);

		const changedHead = await verifyFamilies(
			[family()],
			{ "/x/head.txt": stamp(), "/x/member.txt": stamp() },
			probeFrom({ "/x/head.txt": stamp({ mtimeNs: "101" }), "/x/member.txt": stamp() }),
		);
		expect(changedHead.families).toEqual([]);
	});

	it("detaches a dirty member and keeps an existing path without a stamp", async () => {
		const dirty = await verifyFamilies(
			[family()],
			{ "/x/head.txt": stamp(), "/x/member.txt": DIRTY_STAMP },
			probeFrom({ "/x/head.txt": stamp(), "/x/member.txt": stamp() }),
		);
		expect(dirty.families).toEqual([]);

		const unstamped = await verifyFamilies(
			[family()],
			{},
			probeFrom({ "/x/head.txt": stamp(), "/x/member.txt": stamp() }),
		);
		expect(unstamped.families).toEqual([family()]);
	});

	it("limits probing to only paths in the provided set", async () => {
		const calls: string[] = [];
		const result = await verifyFamilies(
			[family()],
			{ "/x/head.txt": stamp(), "/x/member.txt": stamp() },
			probeFrom({ "/x/head.txt": null, "/x/member.txt": stamp() }, calls),
			new Set(["/x/member.txt"]),
		);
		expect(calls).toEqual(["/x/member.txt"]);
		expect(result.families).toEqual([family()]);
	});

	it("remaps a head and member and moves the stamp key", async () => {
		const original = family();
		const oldStamp = stamp();
		const result = await remapRenames(
			[original],
			{ "/x/head.txt": oldStamp, "/x/member.txt": stamp({ ino: "2" }) },
			["/x/head.txt"],
			["/x/new-head.txt"],
			probeFrom({ "/x/new-head.txt": oldStamp }),
		);
		expect(result.remapped).toEqual(new Map([["/x/head.txt", "/x/new-head.txt"]]));
		expect(result.families[0]?.head).toBe("/x/new-head.txt");
		expect(result.families[0]?.entries.map((item) => item.path)).toContain("/x/new-head.txt");
		expect(result.stamps).toEqual({ "/x/member.txt": stamp({ ino: "2" }), "/x/new-head.txt": oldStamp });

		const both = await remapRenames(
			[original],
			{ "/x/head.txt": oldStamp, "/x/member.txt": stamp({ ino: "2" }) },
			["/x/head.txt", "/x/member.txt"],
			["/x/new-head.txt", "/x/new-member.txt"],
			probeFrom({ "/x/new-head.txt": oldStamp, "/x/new-member.txt": stamp({ ino: "2" }) }),
		);
		expect(both.families[0]?.head).toBe("/x/new-head.txt");
		expect(both.families[0]?.members[0]?.path).toBe("/x/new-member.txt");
		expect(both.stamps).toEqual({ "/x/new-head.txt": oldStamp, "/x/new-member.txt": stamp({ ino: "2" }) });
	});

	it("rejects different dev, ambiguous identity, and defers changed remaps", async () => {
		const original = family();
		const noDevMatch = await remapRenames(
			[original],
			{ "/x/member.txt": stamp() },
			["/x/member.txt"],
			["/x/new-member.txt"],
			probeFrom({ "/x/new-member.txt": stamp({ dev: "other" }) }),
		);
		expect(noDevMatch.remapped.size).toBe(0);

		const ambiguous = await remapRenames(
			[original],
			{ "/x/member.txt": stamp() },
			["/x/member.txt"],
			["/x/a.txt", "/x/b.txt"],
			probeFrom({ "/x/a.txt": stamp(), "/x/b.txt": stamp() }),
		);
		expect(ambiguous.remapped.size).toBe(0);

		const changed = await remapRenames(
			[original],
			{ "/x/member.txt": stamp() },
			["/x/member.txt"],
			["/x/new-member.txt"],
			probeFrom({ "/x/new-member.txt": stamp({ size: "11" }) }),
		);
		expect(changed.remapped).toEqual(new Map([["/x/member.txt", "/x/new-member.txt"]]));
		expect(changed.families[0]?.members[0]?.path).toBe("/x/new-member.txt");
		expect(changed.stamps["/x/new-member.txt"]).toEqual(DIRTY_STAMP);
		const published = await verifyFamilies(
			changed.families,
			changed.stamps,
			probeFrom({
				"/x/head.txt": stamp(),
				"/x/new-member.txt": stamp({ size: "11" }),
			}),
		);
		expect(published.families).toEqual([]);
	});
});

	describe("remapRenames ctime-only rename detection", () => {
		it("remaps when only ctimeNs differs and stores the new probe stamp", async () => {
			const oldStamp = stamp();
			const newStamp = stamp({ ctimeNs: "101" });
			const baseFamily = family();
			const result = await remapRenames(
				[baseFamily],
				{ "/x/member.txt": oldStamp },
				["/x/member.txt"],
				["/x/new-member.txt"],
				probeFrom({ "/x/new-member.txt": newStamp }),
			);
			expect(result.remapped).toEqual(new Map([["/x/member.txt", "/x/new-member.txt"]]));
			expect(result.stamps["/x/new-member.txt"]).toEqual(newStamp);
			expect(result.stamps["/x/new-member.txt"]).not.toBe(DIRTY_STAMP);

			const published = await verifyFamilies(
				result.families,
				result.stamps,
				probeFrom({
					"/x/head.txt": stamp(),
					"/x/new-member.txt": newStamp,
				}),
			);
			expect(published.families.length).toBeGreaterThan(0);
			const publishedMember = published.families[0]?.members.find(
				(m) => m.path === "/x/new-member.txt",
			);
			expect(publishedMember).toBeDefined();
		});

		it("stores DIRTY_STAMP when mtime changes on rename", async () => {
			const oldStamp = stamp();
			const newStamp = stamp({ mtimeNs: "200" });
			const result = await remapRenames(
				[family()],
				{ "/x/member.txt": oldStamp },
				["/x/member.txt"],
				["/x/new-member.txt"],
				probeFrom({ "/x/new-member.txt": newStamp }),
			);
			expect(result.remapped.size).toBe(1);
			expect(result.stamps["/x/new-member.txt"]).toEqual(DIRTY_STAMP);

			const published = await verifyFamilies(
				result.families,
				result.stamps,
				probeFrom({
					"/x/head.txt": stamp(),
					"/x/new-member.txt": newStamp,
				}),
			);
			expect(published.families).toEqual([]);
		});
	});

	describe("version-family store stamp compatibility", () => {
	it("round-trips stamps and still accepts snapshots without stamps", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vf-verify-"));
		const store = createFileVersionFamilyStore(dir);
		const snapshot = {
			version: 1 as const,
			scannedAt: "2026-09-29T10:00:00.000Z",
			locations: ["/x"],
			families: [family()],
			stamps: { "/x/head.txt": stamp() },
		};
		await store.write(snapshot);
		expect(await store.read()).toEqual(snapshot);
		expect(JSON.parse(await readFile(join(dir, "version-families.json"), "utf8"))).toEqual(snapshot);

		const oldSnapshot = { ...snapshot };
		delete (oldSnapshot as { stamps?: unknown }).stamps;
		await store.write(oldSnapshot);
		expect(await store.read()).toEqual(oldSnapshot);
	});
});
