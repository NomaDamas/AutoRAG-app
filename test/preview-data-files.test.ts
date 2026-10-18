import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewData } from "../src/preview/node/data";
import { prettyJsonLines } from "../src/preview/shared/jsonl";
import { bplistToXml } from "../src/preview/shared/plist";
import { byteNeed, viewerForExtension } from "../src/preview/shared/registry";

let dir = "";
beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "autorag-data-"));
});
afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("registry", () => {
	it("routes data files to their viewers", () => {
		for (const ext of ["sqlite", "sqlite3", "db", "parquet"]) expect(viewerForExtension(ext)).toBe("data");
		for (const ext of ["jsonl", "ndjson"]) expect(viewerForExtension(ext)).toBe("jsonl");
		expect(viewerForExtension("plist")).toBe("plist");
		expect(byteNeed("data")).toBe("query");
		expect(byteNeed("plist")).toBe("whole");
		expect(byteNeed("jsonl")).toBe("prefix");
	});
});

describe("sqlite preview", () => {
	it("lists tables with counts and the first rows of the selected one, without touching the file", async () => {
		const path = join(dir, "a b#c.sqlite");
		const db = new DatabaseSync(path);
		db.exec(`create table "we""ird" (id integer primary key, name text, score real, blob_col blob, big integer);
			create table empty (x);
			create view v as select id from "we""ird";
			create table docs (body text);`);
		const insert = db.prepare(`insert into "we""ird" (name, score, blob_col, big) values (?, ?, ?, ?)`);
		insert.run("한글", 1.5, new Uint8Array(5000), 9007199254740993n);
		insert.run(null, null, null, null);
		db.prepare("insert into docs values (?)").run("x".repeat(5000));
		db.close();
		const before = await readdir(dir);
		const mtime = (await stat(path)).mtimeMs;
		const preview = await previewData(path, null);
		expect(await readdir(dir)).toEqual(before);
		expect((await stat(path)).mtimeMs).toBe(mtime);
		if (preview.kind !== "database") throw new Error("expected database");
		expect(preview.tables.map((table) => [table.name, table.view, table.rowCount, table.exact])).toEqual([
			["docs", false, 1, true],
			["empty", false, 0, true],
			["we\"ird", false, 2, true],
			["v", true, null, true],
		]);
		expect(preview.selected?.name).toBe("docs");
		const weird = await previewData(path, 'we"ird');
		if (weird.kind !== "database" || weird.selected === null) throw new Error("expected rows");
		expect(weird.selected.columns.map((c) => [c.name, c.type])).toEqual([["id", "INTEGER"], ["name", "TEXT"], ["score", "REAL"], ["blob_col", "BLOB"], ["big", "INTEGER"]]);
		expect(weird.selected.rows).toEqual([
			["1", "한글", "1.5", { blob: 5000 }, "9007199254740993"],
			["2", null, null, null, null],
		]);
		expect(weird.selected.more).toBe(false);
		const docs = await previewData(path, "docs");
		if (docs.kind !== "database" || docs.selected === null) throw new Error("expected rows");
		expect(docs.selected.rows[0]?.[0]).toBe(`${"x".repeat(200)}…`);
	});

	it("caps rows and counts, and reports an unknown table as a failure", async () => {
		const path = join(dir, "big.db");
		const db = new DatabaseSync(path);
		db.exec("create table t (n integer); with recursive c(n) as (select 1 union all select n+1 from c where n < 100500) insert into t select n from c;");
		db.close();
		const preview = await previewData(path, "t");
		if (preview.kind !== "database" || preview.selected === null) throw new Error("expected rows");
		expect(preview.tables[0]).toMatchObject({ rowCount: 100000, exact: false });
		expect(preview.selected.rows).toHaveLength(100);
		expect(preview.selected.more).toBe(true);
		const view = await previewData(join(dir, "a b#c.sqlite"), "v");
		if (view.kind !== "database") throw new Error("expected database");
		expect(view.selected?.failure).toBe("view");
		const missing = await previewData(path, "nope");
		if (missing.kind !== "database") throw new Error("expected database");
		expect(missing.selected?.failure).toBe("table");
	});

	it("leaves a WAL database and its sidecar files untouched and flags pending commits", async () => {
		const path = join(dir, "wal.sqlite3");
		const db = new DatabaseSync(path);
		db.exec("pragma journal_mode=wal; create table t (a); insert into t values (1);");
		db.exec("pragma wal_checkpoint(truncate); insert into t values (2);");
		const names = (await readdir(dir)).sort();
		const sizes = await Promise.all([path, `${path}-wal`, `${path}-shm`].map(async (p) => (await stat(p)).size));
		const preview = await previewData(path, null);
		db.close();
		if (preview.kind !== "database") throw new Error("expected database");
		expect(preview.walPending).toBe(true);
		expect(preview.tables[0]?.rowCount).toBe(1);
		expect(names).toContain("wal.sqlite3-wal");
		expect(sizes[1]).toBeGreaterThan(0);
	});

	it("says clearly when the file is not a database or is damaged", async () => {
		const text = join(dir, "notes.db");
		await writeFile(text, "just text, not a database at all ".repeat(40));
		expect(await previewData(text, null)).toEqual({ kind: "unreadable", reason: "not-sqlite" });
		const random = join(dir, "cipher.sqlite");
		await writeFile(random, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7919 + 13) % 256)));
		expect(await previewData(random, null)).toEqual({ kind: "unreadable", reason: "not-sqlite" });
		const good = join(dir, "good.sqlite");
		const db = new DatabaseSync(good);
		db.exec("create table t (a); insert into t values (1)");
		db.close();
		const bytes = new Uint8Array(await readFile(good));
		const damaged = join(dir, "damaged.sqlite");
		await writeFile(damaged, bytes.subarray(0, 100));
		expect(await previewData(damaged, null)).toEqual({ kind: "unreadable", reason: "corrupt" });
	});
});

describe("parquet preview", () => {
	it("reads the schema and first rows only", async () => {
		const path = join(dir, "x.parquet");
		const buffer = parquetWriteBuffer({
			columnData: [
				{ name: "id", data: Array.from({ length: 300 }, (_, i) => i), type: "INT32" },
				{ name: "name", data: Array.from({ length: 300 }, (_, i) => `n${i}`), type: "STRING" },
				{ name: "big", data: Array.from({ length: 300 }, (_, i) => BigInt(i) + 9007199254740993n), type: "INT64" },
				{ name: "ts", data: Array.from({ length: 300 }, () => new Date(Date.UTC(2024, 0, 2, 3, 4, 5))), type: "TIMESTAMP" },
			],
		});
		await writeFile(path, new Uint8Array(buffer));
		const preview = await previewData(path, null);
		if (preview.kind !== "parquet") throw new Error("expected parquet");
		expect(preview.rowCount).toBe(300);
		expect(preview.selected.columns.map((c) => c.name)).toEqual(["id", "name", "big", "ts"]);
		expect(preview.selected.columns[1]?.type).toBe("UTF8");
		expect(preview.selected.rows).toHaveLength(100);
		expect(preview.selected.more).toBe(true);
		expect(preview.selected.rows[1]).toEqual(["1", "n1", "9007199254740994", "2024-01-02T03:04:05.000Z"]);
	});

	it("names damaged and encrypted files", async () => {
		const bad = join(dir, "bad.parquet");
		await writeFile(bad, "not parquet at all, only text");
		expect(await previewData(bad, null)).toEqual({ kind: "unreadable", reason: "not-parquet" });
		const encrypted = join(dir, "enc.parquet");
		await writeFile(encrypted, Buffer.concat([Buffer.from("PARE"), Buffer.alloc(100), Buffer.from("PARE")]));
		expect(await previewData(encrypted, null)).toEqual({ kind: "unreadable", reason: "encrypted" });
		const truncated = join(dir, "cut.parquet");
		const full = new Uint8Array(parquetWriteBuffer({ columnData: [{ name: "a", data: [1, 2, 3], type: "INT32" }] }));
		await writeFile(truncated, Buffer.concat([full.subarray(0, full.length - 20), Buffer.from("PAR1")]));
		expect(await previewData(truncated, null)).toEqual({ kind: "unreadable", reason: "corrupt" });
	});
});

describe("json lines", () => {
	it("pretty-prints long records, keeps short ones on one line, and keeps bad lines verbatim", () => {
		const long = JSON.stringify({ a: "x".repeat(60), b: [1, 2, 3], c: { d: "y".repeat(60) } });
		const out = prettyJsonLines(`{"k":1}\n\nnot json\n${long}\n`, 100);
		expect(out.cut).toBe(false);
		expect(out.text.split("\n")[0]).toBe('{"k":1}');
		expect(out.text).toContain("not json");
		expect(out.text).toContain(`  "a": "${"x".repeat(60)}"`);
	});

	it("stops after the record limit and leaves unsafe big integers untouched", () => {
		const out = prettyJsonLines('{"n":12345678901234567890}\n{"n":2}\n{"n":3}\n', 2);
		expect(out.cut).toBe(true);
		expect(out.text).toBe('{"n":12345678901234567890}\n{"n":2}');
	});
});

describe("binary plist", () => {
	const available = process.platform === "darwin";
	it.skipIf(!available)("renders the same XML as plutil", async () => {
		const sources = [
			'{"s":"héllo <&>","i":-5,"big":18446744073709551615,"r":1.5,"t":true,"f":false,"arr":[1,"x",[]],"d":{},"u":"한글😀","z":0,"n":300,"h":70000}',
			"[]",
			'{"nested":{"a":[{"b":[true,false]},{}]}}',
		];
		for (const [index, source] of sources.entries()) {
			const json = join(dir, `p${index}.json`);
			const bin = join(dir, `p${index}.plist`);
			await writeFile(json, source);
			execFileSync("plutil", ["-convert", "binary1", "-o", bin, json]);
			const expected = execFileSync("plutil", ["-convert", "xml1", "-o", "-", bin]).toString();
			expect(bplistToXml(new Uint8Array(await readFile(bin)))).toBe(expected);
		}
	});

	it("renders dates, data, and reals from a known binary plist", () => {
		const bytes = Buffer.from(
			"YnBsaXN0MDDTAQIDBAUGUmR0UmRhUnJlM0HFodpSgAAATxBkAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZCNACgAAAAAAAAgPEhUYIYgAAAAAAAABAQAAAAAAAAAHAAAAAAAAAAAAAAAAAAAAkQ==",
			"base64",
		);
		const xml = bplistToXml(new Uint8Array(bytes));
		expect(xml).toContain("<key>dt</key>\n\t<date>2024-01-02T03:04:05Z</date>");
		expect(xml).toContain("<real>3.25</real>");
		expect(xml).toContain("<data>\n\tAQIDBAUGBwgJCgsMDQ4P");
	});

	it("rejects truncated and malicious files instead of looping or throwing past the caller", () => {
		const bytes = Buffer.from("YnBsaXN0MDDZAQIDBAUGBwgJCgsMDRESExQVUXRRdVFkU2FyclFpUXJTYmlnUXNRZglk1VyuANg9", "base64");
		expect(() => bplistToXml(new Uint8Array(bytes))).toThrow();
		expect(() => bplistToXml(new TextEncoder().encode("bplist00"))).toThrow();
		// A one-object file whose array refers to itself.
		const loop = Buffer.concat([Buffer.from("bplist00"), Buffer.from([0xa1, 0x00]), Buffer.alloc(6), Buffer.from([0, 0, 0, 0, 0, 0, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8])]);
		expect(() => bplistToXml(new Uint8Array(loop))).toThrow();
	});
});
