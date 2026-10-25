/**
 * Manual QA — a 10,000-file folder: first paint, listing heap, and sort cost
 * (FS layer roadmap #104, stage 3 / #100).
 *
 * Each run launches the built app on a fresh user-data directory, opens a
 * fixture folder of `LARGE_FILES` files from the QA root, and measures:
 *
 *   - first paint: from just before the double-click to the first animation
 *     frame that shows a row of the folder (`[role="row"]` whose `data-path`
 *     lies inside it), polled on rAF in the page;
 *   - renderer script time from the double-click until the listing settled
 *     (CDP `Performance.getMetrics` ScriptDuration);
 *   - listing heap: renderer heap after a forced GC with the folder shown,
 *     minus the same reading at the QA root just before opening it;
 *   - listing row bytes: from a heap snapshot, the bytes held only by the row
 *     objects of the folder (each row object plus everything reachable only
 *     through rows — its own strings, boxed numbers, property stores);
 *   - sort: click → the frame whose first row is the expected head, for Name
 *     descending and Date Modified descending;
 *   - the `fs:listDir` answer: entries, JSON bytes, and round-trip time;
 *   - heap again once the OS kind / icon pass for the folder has landed.
 *
 * The folder's background enrichment is held inside the filesystem worker
 * (AUTORAG_FS_WORKER_QA=1 registers `fs-worker:qaHoldEnrichment`; nothing else
 * in the app changes), so the listing numbers never race the OS kind pass.
 * The kind/icon pass is released after the listing readings; the Finder
 * metadata pass for 10,000 files would spawn helper processes for minutes and
 * stays held — the run quits first.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-large-folder.mjs
 *
 * Knobs: LARGE_RUNS (default 5 launches), LARGE_FILES (default 10000),
 * LARGE_SNAPSHOT=0 skips the heap snapshot.
 * Evidence: `.omo/evidence/ai-finder-app/qa-large-folder/result.json`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { sleep, cssAttr } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-large-folder");
mkdirSync(EVIDENCE, { recursive: true });

const RUNS = Number(process.env.LARGE_RUNS ?? 5);
const COUNT = Number(process.env.LARGE_FILES ?? 10_000);
const SNAPSHOT = process.env.LARGE_SNAPSHOT !== "0";

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-large-")));
const QA_ROOT = join(WORK, "root");
const FOLDER = "big";
const BIG = join(QA_ROOT, FOLDER);
const EXTENSIONS = ["txt", "md", "csv", "json"];
const fileName = (index) => `${FOLDER}-${String(index).padStart(5, "0")}.${EXTENSIONS[index % EXTENSIONS.length]}`;
// Unique contents (dupey finds no family) and a scrambled mtime order, so the
// newest file is neither the first nor the last by name.
const BASE_MTIME = Date.UTC(2026, 8, 1) / 1000;
const mtimeRank = (index) => (index * 7919) % COUNT;
mkdirSync(BIG, { recursive: true });
let newest = 0;
for (let index = 0; index < COUNT; index += 1) {
	const path = join(BIG, fileName(index));
	writeFileSync(path, `${createHash("sha256").update(String(index)).digest("hex")}\n`);
	const stamp = BASE_MTIME + mtimeRank(index) * 60;
	utimesSync(path, stamp, stamp);
	if (mtimeRank(index) > mtimeRank(newest)) newest = index;
}
const LAST_BY_NAME = join(BIG, fileName(COUNT - 1));
const NEWEST = join(BIG, fileName(newest));

/**
 * Bytes held only by the folder's row objects. A row object is a plain object
 * with `name`, `kind`, and a `path` inside the folder. Starting from the rows,
 * a node joins the owned set once every one of its retainers is owned, so a
 * string or boxed number one row alone points at counts, while the shared
 * folder path, interned constants, and paths other structures also hold do not.
 */
function analyzeRows(snapshot, prefix) {
	const { meta } = snapshot.snapshot;
	const nodeFields = meta.node_fields.length;
	const edgeFields = meta.edge_fields.length;
	const nodeTypes = meta.node_types[0];
	const edgeTypes = meta.edge_types[0];
	const typeOf = meta.node_fields.indexOf("type");
	const nameOf = meta.node_fields.indexOf("name");
	const sizeOf = meta.node_fields.indexOf("self_size");
	const edgeCountOf = meta.node_fields.indexOf("edge_count");
	const edgeTypeOf = meta.edge_fields.indexOf("type");
	const edgeNameOf = meta.edge_fields.indexOf("name_or_index");
	const edgeToOf = meta.edge_fields.indexOf("to_node");
	const { nodes, edges, strings } = snapshot;
	const count = nodes.length / nodeFields;
	const firstEdge = new Uint32Array(count + 1);
	for (let node = 0, edge = 0; node < count; node += 1) {
		firstEdge[node] = edge;
		edge += nodes[node * nodeFields + edgeCountOf] * edgeFields;
	}
	firstEdge[count] = edges.length;
	const property = edgeTypes.indexOf("property");
	const weak = edgeTypes.indexOf("weak");
	const objectType = nodeTypes.indexOf("object");
	const plainString = nodeTypes.indexOf("string");
	const retainers = new Uint32Array(count);
	for (let edge = 0; edge < edges.length; edge += edgeFields) {
		if (edges[edge + edgeTypeOf] === weak) continue;
		retainers[edges[edge + edgeToOf] / nodeFields] += 1;
	}
	const rows = [];
	for (let node = 0; node < count; node += 1) {
		if (nodes[node * nodeFields + typeOf] !== objectType) continue;
		let marks = 0;
		let inside = false;
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			if (edges[edge + edgeTypeOf] !== property) continue;
			const name = strings[edges[edge + edgeNameOf]];
			if (name === "name" || name === "kind") marks += 1;
			else if (name === "path") {
				const to = edges[edge + edgeToOf] / nodeFields;
				inside = nodes[to * nodeFields + typeOf] === plainString && strings[nodes[to * nodeFields + nameOf]].startsWith(prefix);
			}
		}
		if (marks === 2 && inside) rows.push(node);
	}
	const owned = new Uint8Array(count);
	const hits = new Uint32Array(count);
	const queue = [...rows];
	for (const node of rows) owned[node] = 1;
	let bytes = 0;
	while (queue.length > 0) {
		const node = queue.pop();
		bytes += nodes[node * nodeFields + sizeOf];
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			if (edges[edge + edgeTypeOf] === weak) continue;
			const to = edges[edge + edgeToOf] / nodeFields;
			if (owned[to] === 1) continue;
			hits[to] += 1;
			if (hits[to] === retainers[to]) {
				owned[to] = 1;
				queue.push(to);
			}
		}
	}
	const fieldNames = new Set();
	if (rows.length > 0) {
		const node = rows[0];
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			if (edges[edge + edgeTypeOf] === property) fieldNames.add(strings[edges[edge + edgeNameOf]]);
		}
	}
	return { rowObjects: rows.length, rowBytes: bytes, bytesPerRow: rows.length === 0 ? 0 : Math.round(bytes / rows.length), fields: [...fieldNames].sort() };
}

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

/** In-page ms from the mark to the first frame where `predicate(prefix, expected)` holds. */
const sinceMark = (page, kind, expected) =>
	page
		.waitForFunction(
			({ kind, prefix, expected }) => {
				const rows = document.querySelectorAll('[role="row"][data-path]');
				if (kind === "paint") {
					for (const row of rows) {
						if (row.getAttribute("data-path").startsWith(prefix)) return performance.now() - globalThis.__largeMark;
					}
					return null;
				}
				const first = rows[0]?.getAttribute("data-path");
				return first === expected ? performance.now() - globalThis.__largeMark : null;
			},
			{ kind, prefix: `${BIG}${sep}`, expected },
			{ polling: "raf", timeout: 60_000 },
		)
		.then((handle) => handle.jsonValue())
		.then((ms) => Math.round(ms * 10) / 10);

const runs = [];
try {
	for (let run = 0; run < RUNS; run += 1) {
		const userData = mkdtempSync(join(WORK, "user-data-"));
		const app = await launchFinder({ userDataDir: userData, env: { AUTORAG_QA_ROOT: QA_ROOT, AUTORAG_FS_WORKER_QA: "1" } });
		try {
			const page = await finderWindow(app, 30_000);
			page.setDefaultTimeout(30_000);
			const pageErrors = [];
			page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
			// Hold the folder's enrichment inside the worker for as long as the
			// listing readings are taken (see the header).
			await app.evaluate(async ({ ipcMain }, prefix) => {
				const hold = ipcMain._invokeHandlers.get("fs-worker:qaHoldEnrichment");
				if (hold === undefined) throw new Error("fs-worker:qaHoldEnrichment is not registered (AUTORAG_FS_WORKER_QA=1)");
				await hold({}, prefix, ["enrichEntries", "finderMetadata"]);
			}, `${BIG}${sep}`);
			const cdp = await page.context().newCDPSession(page);
			await cdp.send("HeapProfiler.enable");
			await cdp.send("Performance.enable");
			const scriptSeconds = async () => {
				const { metrics } = await cdp.send("Performance.getMetrics");
				return metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0;
			};
			const retainedHeap = async () => {
				for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
				const { usedSize } = await cdp.send("Runtime.getHeapUsage");
				return usedSize;
			};
			const viewButton = (mode) => page.locator(".seg__button").nth(["icons", "list", "columns"].indexOf(mode));
			await page.locator(".sidebar__item", { hasText: "QA" }).click();
			const folderRow = page.locator(`[data-path="${cssAttr(BIG)}"]`).first();
			await folderRow.waitFor();
			await viewButton("list").click();
			// Startup work (version-family scan of the QA root, locations) settles first.
			await sleep(3000);

			const heapBefore = await retainedHeap();
			const scriptBefore = await scriptSeconds();
			await page.evaluate(() => {
				globalThis.__largeMark = performance.now();
			});
			await folderRow.dblclick();
			const firstPaintMs = await sinceMark(page, "paint");
			await sleep(500);
			const openScriptMs = Math.round(((await scriptSeconds()) - scriptBefore) * 1000);
			const heapListing = await retainedHeap();
			const mountedRows = await page.locator('[role="row"][data-path]').count();

			let snapshotRows = null;
			if (SNAPSHOT) {
				const chunks = [];
				const onChunk = (event) => chunks.push(event.chunk);
				cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
				await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
				cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
				snapshotRows = analyzeRows(JSON.parse(chunks.join("")), `${BIG}${sep}`);
			}

			const sortButton = (index) => page.locator(".col-header__sort").nth(index);
			const timeSort = async (button, expected) => {
				await page.evaluate(() => {
					globalThis.__largeMark = performance.now();
				});
				await button.click();
				return sinceMark(page, "first", expected);
			};
			// Name: ascending (the listing order already), then descending.
			await sortButton(0).click();
			await sleep(300);
			const nameDescMs = await timeSort(sortButton(0), LAST_BY_NAME);
			await sleep(300);
			// Date Modified: the first click sorts newest first.
			const dateDescMs = await timeSort(sortButton(1), NEWEST);
			await sleep(300);

			const ipc = await page.evaluate(async (dir) => {
				const started = performance.now();
				const listing = await window.autorag.fs.listDir(dir);
				const ms = performance.now() - started;
				return { ms: Math.round(ms * 10) / 10, entries: listing.entries.length, bytes: JSON.stringify(listing).length, fields: Object.keys(listing.entries[0] ?? {}).sort() };
			}, BIG);

			// Release the OS kind / icon pass and read the heap once it has landed.
			// The Finder metadata pass stays held: 10,000 files would keep helper
			// processes busy for minutes, and the run quits before it is needed.
			const held = await app.evaluate(async ({ ipcMain }) => {
				const release = ipcMain._invokeHandlers.get("fs-worker:qaReleaseEnrichment");
				if (release === undefined) throw new Error("fs-worker:qaReleaseEnrichment is not registered (AUTORAG_FS_WORKER_QA=1)");
				return release({}, ["enrichEntries"]);
			});
			await sleep(1500);
			const heapEnriched = await retainedHeap();

			const sample = {
				firstPaintMs,
				openScriptMs,
				listingHeapMB: +((heapListing - heapBefore) / 1e6).toFixed(2),
				enrichedHeapMB: +((heapEnriched - heapBefore) / 1e6).toFixed(2),
				heapBeforeMB: +(heapBefore / 1e6).toFixed(2),
				mountedRows,
				snapshotRows,
				nameDescMs,
				dateDescMs,
				ipc,
				enrichBatchesHeld: held,
				pageErrors,
			};
			runs.push(sample);
			console.log(`INFO  run ${run + 1}/${RUNS} ${JSON.stringify(sample)}`);
			check(`run ${run + 1}: no page errors`, pageErrors.length === 0, pageErrors[0]);
			check(`run ${run + 1}: listDir answers every file`, ipc.entries === COUNT, `${ipc.entries}`);
			if (snapshotRows !== null) {
				check(`run ${run + 1}: one row object per file`, snapshotRows.rowObjects === COUNT, `${snapshotRows.rowObjects}`);
			}
			if (run === 0) await page.screenshot({ path: join(EVIDENCE, "end.png") });
		} finally {
			await app.close().catch(() => undefined);
		}
	}
} finally {
	rmSync(WORK, { recursive: true, force: true });
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : +((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2);
};
const stat = (pick) => {
	const values = runs.map(pick).filter((value) => typeof value === "number");
	return values.length === 0 ? null : { median: median(values), min: Math.min(...values), max: Math.max(...values) };
};
const summary = {
	files: COUNT,
	runs: runs.length,
	firstPaintMs: stat((run) => run.firstPaintMs),
	openScriptMs: stat((run) => run.openScriptMs),
	listingHeapMB: stat((run) => run.listingHeapMB),
	enrichedHeapMB: stat((run) => run.enrichedHeapMB),
	rowBytes: stat((run) => run.snapshotRows?.rowBytes),
	bytesPerRow: stat((run) => run.snapshotRows?.bytesPerRow),
	rowFields: runs[0]?.snapshotRows?.fields ?? null,
	nameDescMs: stat((run) => run.nameDescMs),
	dateDescMs: stat((run) => run.dateDescMs),
	listDirMs: stat((run) => run.ipc.ms),
	listDirBytes: stat((run) => run.ipc.bytes),
	listDirFields: runs[0]?.ipc.fields ?? null,
};
console.log(`INFO  summary ${JSON.stringify(summary)}`);
writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ summary, runs, checks: results }, null, 2)}\n`);
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0 || runs.length < RUNS) process.exitCode = 1;
