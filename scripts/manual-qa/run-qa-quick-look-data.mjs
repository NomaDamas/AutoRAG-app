/**
 * Manual QA — Quick Look for databases and data files.
 *
 * Builds a fixture folder (SQLite with a live WAL, a corrupt .db, Parquet,
 * JSON Lines, binary and XML plists), drives the production build
 * (`bun run build` first), opens each file with Space from the Finder list, and
 * checks the panel in the DOM. The SQLite file and its `-wal`/`-shm` sidecars
 * must be byte-identical before and after the preview.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? "/tmp/autorag-quicklook-data";
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-data-"));

const dbPath = join(root, "shop.sqlite");
const db = new DatabaseSync(dbPath);
db.exec("pragma journal_mode=wal");
db.exec("create table customers (id integer primary key, name text, balance real, avatar blob)");
db.exec("create table orders (id integer primary key, customer_id integer, note text)");
db.exec("create view big as select * from customers");
const insert = db.prepare("insert into customers (name, balance, avatar) values (?, ?, ?)");
for (let index = 1; index <= 250; index += 1) insert.run(index === 1 ? "김민수" : `고객 ${index}`, index * 1.5, index === 1 ? new Uint8Array(2048) : null);
db.prepare("insert into orders (customer_id, note) values (1, ?)").run("first order");
// Checkpoint what exists, then leave one commit only in the WAL and keep `db` open: the
// -shm is live, as with a running app. `immutable=1` cannot see that last commit.
db.exec("pragma wal_checkpoint(truncate)");
db.prepare("insert into orders (customer_id, note) values (1, ?)").run("only in the wal");

writeFileSync(join(root, "broken.db"), "this is not a database ".repeat(100));
const bytes = new Uint8Array(parquetWriteBuffer({
	columnData: [
		{ name: "id", data: Array.from({ length: 500 }, (_, i) => i), type: "INT32" },
		{ name: "title", data: Array.from({ length: 500 }, (_, i) => `행 ${i}`), type: "STRING" },
	],
}));
writeFileSync(join(root, "events.parquet"), bytes);
writeFileSync(join(root, "bad.parquet"), "nope");
const records = Array.from({ length: 30 }, (_, i) => JSON.stringify({ id: i, tags: ["a", "b"], text: "x".repeat(i === 0 ? 120 : 5), nested: { ok: true } }));
writeFileSync(join(root, "log.jsonl"), `${records.join("\n")}\n`);
writeFileSync(join(root, "feed.ndjson"), '{"a":1}\n{"a":2}\n');
// A real `bplist00` of {CFBundleName: "Demo", LSUIElement: true, Sizes: [16, 32], When: "x"}, checked with
// `plutil -convert xml1`. Written as bytes rather than made by `plutil`, which does not exist on Windows.
writeFileSync(
	join(root, "Prefs.plist"),
	Buffer.from("YnBsaXN0MDBcQ0ZCdW5kbGVOYW1lW0xTVUlFbGVtZW50VVNpemVzVFdoZW5URGVtbwkQEBAgogYHUXjUAAECAwQFCAkIFSEnLDEyNDY5OwAAAAAAAAEBAAAAAAAAAAsAAAAAAAAACgAAAAAAAABE", "base64"),
);
writeFileSync(join(root, "Plain.plist"), '<?xml version="1.0"?>\n<plist version="1.0"><dict><key>k</key><string>v</string></dict></plist>\n');

const digest = (path) => (existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent");
const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const before = sidecars.map(digest);

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

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: process.env.QA_LANGUAGE ?? "en" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
	const visible = () =>
		app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false);

	async function open(name, ready) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(() => preview.evaluate(ready).catch(() => false), Boolean, 10_000);
		await poll(visible, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => (await visible()) === false, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const text = async () => (await preview.locator("body").innerText()) ?? "";

	// SQLite. The clock starts once the listing shows the file: the first listing after launch is the app's startup, not the preview.
	await main.getByRole("row", { name: /shop\.sqlite/ }).first().waitFor({ timeout: 30_000 });
	const started = Date.now();
	await open("shop.sqlite", () => document.querySelectorAll(".ql-data__grid tbody tr").length > 0);
	await preview.screenshot({ path: join(EVIDENCE, "sqlite-first.png") });
	const elapsed = Date.now() - started;
	check("sqlite grid appears quickly", elapsed < 3000, `${elapsed} ms incl. window animation`);
	const shown = await text();
	check("sqlite lists tables with row counts", shown.includes("customers") && shown.includes("250") && shown.includes("orders") && /big\s*view/.test(shown));
	check("sqlite shows the first 100 rows and says so", (await preview.locator(".ql-data__grid tbody tr").count()) === 100 && shown.includes("first 100 rows"));
	check("sqlite shows column names and types", shown.includes("balance") && shown.includes("REAL"));
	check("sqlite shows Korean text and blob size", shown.includes("김민수") && /2\.0 KB binary/.test(shown), "");
	await preview.screenshot({ path: join(EVIDENCE, "sqlite.png") });
	await preview.getByRole("button", { name: /orders/ }).click();
	await poll(() => preview.evaluate(() => document.body.innerText.includes("first order")), Boolean);
	check("selecting another table loads its rows", (await text()).includes("first order"));
	await preview.getByRole("button", { name: /big/ }).click();
	await poll(() => preview.evaluate(() => document.body.innerText.includes("Views are not run")), Boolean);
	check("a view is listed but never run", (await text()).includes("Views are not run"));
	check("sqlite footer flags the pending WAL", (await text()).includes("-wal"));
	await preview.getByRole("button", { name: /orders/ }).click();
	await poll(() => preview.evaluate(() => document.body.innerText.includes("first order")), Boolean);
	check("a commit that exists only in the WAL is not shown", !(await text()).includes("only in the wal"));
	await close();
	const after = sidecars.map(digest);
	check("database, -wal and -shm are byte-identical after the preview", JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before: before.map((d) => d.slice(0, 8)), after: after.map((d) => d.slice(0, 8)) }));
	db.exec("insert into orders (customer_id, note) values (1, 'still writable')");
	check("a writer is not blocked afterwards", true);

	await open("broken.db", () => document.querySelector(".ql__note") !== null);
	check("corrupt database shows a clear note", (await text()).includes("Not a readable SQLite database"));
	await close();

	// Parquet
	await open("events.parquet", () => document.querySelectorAll(".ql-data__grid tbody tr").length > 0);
	const parquet = await text();
	check("parquet shows schema and first rows", parquet.includes("title") && parquet.includes("행 0") && parquet.includes("500 rows") && (await preview.locator(".ql-data__grid tbody tr").count()) === 100);
	await preview.screenshot({ path: join(EVIDENCE, "parquet.png") });
	await close();
	await open("bad.parquet", () => document.querySelector(".ql__note") !== null);
	check("bad parquet shows a clear note", (await text()).includes("Not a Parquet file"));
	await close();

	// JSON Lines
	await open("log.jsonl", () => document.querySelectorAll(".ql-line").length > 0);
	const lines = await preview.locator(".ql-lc").count();
	check("jsonl pretty-prints long records and highlights JSON", lines > 30 && (await preview.locator(".hljs-attr").count()) > 0, `${lines} lines`);
	check("jsonl footer names the format", (await text()).includes("JSON Lines"));
	await preview.screenshot({ path: join(EVIDENCE, "jsonl.png") });
	await close();
	await open("feed.ndjson", () => document.querySelectorAll(".ql-line").length > 0);
	check("ndjson opens as text", (await preview.locator(".ql-lc").count()) === 2);
	await close();

	// plist
	await open("Prefs.plist", () => document.querySelectorAll(".ql-line").length > 0);
	const plist = (await preview.locator(".ql-lc").allTextContents()).join("\n");
	check("binary plist is shown as XML", plist.includes("<key>CFBundleName</key>") && plist.includes("<string>Demo</string>") && plist.includes("<true/>"), "");
	check("binary plist footer says it was converted", (await text()).includes("Binary plist shown as XML"));
	await preview.screenshot({ path: join(EVIDENCE, "plist.png") });
	await close();
	await open("Plain.plist", () => document.querySelectorAll(".ql-line").length > 0);
	check("XML plist is shown as written", (await preview.locator(".ql-lc").allTextContents()).join("\n").includes("<key>k</key>"));
	await close();
} finally {
	await app.close();
	db.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
