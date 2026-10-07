/**
 * Manual QA — memory soak and per-interaction cost (FS layer roadmap #104).
 *
 * Drives the built app through repeated browse cycles against a fixture tree
 * and measures what a long session accumulates:
 *
 *   - renderer JS heap after a forced GC (CDP `HeapProfiler.collectGarbage`),
 *     sampled after a warm-up and after the soak, so the delta is retained
 *     memory, not garbage waiting for collection;
 *   - main-process RSS (Electron's own `process.memoryUsage().rss`);
 *   - main event-loop delay p99 (`perf_hooks.monitorEventLoopDelay`) over the soak;
 *   - how many `index:status` IPC calls one selection change triggers (wrapped
 *     inside main through `ipcMain`'s invoke handler, so nothing in the app
 *     changes for the measurement);
 *   - renderer script time over the soak (CDP `Performance.getMetrics`);
 *   - what the renderer still holds at the end, from a heap snapshot: every
 *     row object (`FinderEntry`: has `path`, `fileKind`, `dateLabel`) and every
 *     array of them. A path with more than one row object alive is an older
 *     listing that something still retains (FS roadmap #99 acceptance: 0).
 *
 * A cycle: open each fixture folder through its row, click rows down the list,
 * toggle Quick Look on some, switch view modes list → icons → columns → list,
 * open/close a tab, and come back up. Fixture folders hold files only, so a
 * cycle never touches the user's real folders.
 *
 * Gates (FS roadmap stage 1 acceptance) are enforced only with
 * `SOAK_ENFORCE=1`; without it the lane reports numbers and always passes, so
 * a baseline run on an unfixed tree records its figures instead of failing.
 *
 *   bun run build
 *   bun scripts/manual-qa/run-qa-finder-memory-soak.mjs              # report
 *   SOAK_ENFORCE=1 bun scripts/manual-qa/run-qa-finder-memory-soak.mjs  # gate
 *
 * Knobs: SOAK_CYCLES (default 40), SOAK_WARMUP (default 5), SOAK_SNAPSHOT=0
 * skips the end-of-soak heap snapshot.
 * Evidence: `.omo/evidence/ai-finder-app/qa-memory-soak/result.json`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { finderWindow, launchFinder, ROOT } from "./launch-finder.mjs";
import { chord, sleep } from "./platform.mjs";

const EVIDENCE = join(ROOT, ".omo/evidence/ai-finder-app/qa-memory-soak");
mkdirSync(EVIDENCE, { recursive: true });

const CYCLES = Number(process.env.SOAK_CYCLES ?? 40);
const WARMUP = Number(process.env.SOAK_WARMUP ?? 5);
const ENFORCE = process.env.SOAK_ENFORCE === "1";
/** Stage 1 gates: retained renderer heap per cycle, and index:status calls per click. */
const MAX_HEAP_GROWTH_PER_CYCLE_MB = 0.25;
const MAX_INDEX_STATUS_PER_CLICK = 0;
const MAX_LOOP_P99_MS = 100;
/** FS roadmap #99: only the current listing of a folder is alive, no older one. */
const MAX_LISTING_GENERATIONS = 1;
const SNAPSHOT = process.env.SOAK_SNAPSHOT !== "0";

/**
 * Row objects and row arrays alive in a V8 heap snapshot. A row object is a
 * plain object with `path`, `fileKind`, and `dateLabel` properties; an array
 * counts when at least 50 of its elements are row objects. `maxGenerations`
 * is how many listings of one folder are alive at once (1 = only the current).
 */
function analyzeSnapshot(snapshot) {
	const { meta } = snapshot.snapshot;
	const nodeFields = meta.node_fields.length;
	const edgeFields = meta.edge_fields.length;
	const nodeTypes = meta.node_types[0];
	const edgeTypes = meta.edge_types[0];
	const typeOf = meta.node_fields.indexOf("type");
	const nameOf = meta.node_fields.indexOf("name");
	const edgeCountOf = meta.node_fields.indexOf("edge_count");
	const edgeTypeOf = meta.edge_fields.indexOf("type");
	const edgeNameOf = meta.edge_fields.indexOf("name_or_index");
	const edgeToOf = meta.edge_fields.indexOf("to_node");
	const { nodes, edges, strings } = snapshot;
	const firstEdge = new Uint32Array(nodes.length / nodeFields + 1);
	for (let node = 0, edge = 0; node < nodes.length / nodeFields; node += 1) {
		firstEdge[node] = edge;
		edge += nodes[node * nodeFields + edgeCountOf] * edgeFields;
	}
	firstEdge[nodes.length / nodeFields] = edges.length;
	const property = edgeTypes.indexOf("property");
	const element = edgeTypes.indexOf("element");
	const objectType = nodeTypes.indexOf("object");
	const plainString = nodeTypes.indexOf("string");
	const concatenated = nodeTypes.indexOf("concatenated string");
	const sliced = nodeTypes.indexOf("sliced string");
	/** A string node's value; V8 keeps `a + b` as a rope of two child strings. */
	const stringValue = (node, depth = 0) => {
		const type = nodes[node * nodeFields + typeOf];
		if (type === plainString) return strings[nodes[node * nodeFields + nameOf]];
		if ((type !== concatenated && type !== sliced) || depth > 32) return null;
		const parts = [];
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			const label = strings[edges[edge + edgeNameOf]];
			if (label !== "first" && label !== "second" && label !== "parent") continue;
			const part = stringValue(edges[edge + edgeToOf] / nodeFields, depth + 1);
			if (part === null) return null;
			parts.push(part);
		}
		return type === sliced ? null : parts.join("");
	};
	const rows = new Map();
	const count = nodes.length / nodeFields;
	for (let node = 0; node < count; node += 1) {
		if (nodes[node * nodeFields + typeOf] !== objectType) continue;
		let path = null;
		let location = null;
		let marks = 0;
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			if (edges[edge + edgeTypeOf] !== property) continue;
			const name = strings[edges[edge + edgeNameOf]];
			if (name === "fileKind" || name === "dateLabel") marks += 1;
			else if (name === "path" || name === "location") {
				const value = stringValue(edges[edge + edgeToOf] / nodeFields);
				if (name === "path") path = value;
				else location = value;
			}
		}
		if (marks === 2 && path !== null) rows.set(node, { path, location });
	}
	// Row arrays: listings and every array derived from one (sorted, stacked,
	// grouped). A derived array reuses its listing's row objects.
	const listed = new Set();
	const arraysByFolder = {};
	let rowArrays = 0;
	for (let node = 0; node < count; node += 1) {
		if (nodes[node * nodeFields + typeOf] !== objectType || strings[nodes[node * nodeFields + nameOf]] !== "Array") continue;
		const members = [];
		for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += edgeFields) {
			if (edges[edge + edgeTypeOf] !== element) continue;
			const to = edges[edge + edgeToOf] / nodeFields;
			if (rows.has(to)) members.push(to);
		}
		if (members.length < 50) continue;
		rowArrays += 1;
		for (const member of members) listed.add(member);
		const key = (rows.get(members[0]).location ?? "?").split(/[\\/]/).pop();
		arraysByFolder[key] = (arraysByFolder[key] ?? 0) + 1;
	}
	// A folder's listing generations: how many listed row objects one of its
	// paths has alive, as the most common count over the folder's paths. An
	// older listing still retained (a rewritten array, a closure holding the
	// previous render's rows) shows up as every path having one more copy.
	// Rows outside any listing array (the sidecar's resolved copy of a row,
	// the Inspector's selection) are not listings and do not count.
	const copies = new Map();
	const folderOf = new Map();
	for (const node of listed) {
		const { path, location } = rows.get(node);
		copies.set(path, (copies.get(path) ?? 0) + 1);
		folderOf.set(path, location);
	}
	let staleEntryCopies = 0;
	const histogram = new Map();
	for (const [path, total] of copies) {
		staleEntryCopies += total - 1;
		const key = (folderOf.get(path) ?? "?").split(/[\\/]/).pop();
		const counts = histogram.get(key) ?? new Map();
		counts.set(total, (counts.get(total) ?? 0) + 1);
		histogram.set(key, counts);
	}
	const generationsByFolder = {};
	for (const [folder, counts] of histogram) {
		let best = 0;
		let bestPaths = -1;
		for (const [total, paths] of counts) {
			if (paths > bestPaths) [best, bestPaths] = [total, paths];
		}
		generationsByFolder[folder] = best;
	}
	const maxGenerations = Math.max(0, ...Object.values(generationsByFolder));
	return { rowObjects: rows.size, listedRowObjects: listed.size, staleEntryCopies, maxGenerations, generationsByFolder, rowArrays, arraysByFolder };
}

const WORK = realpathSync(mkdtempSync(join(tmpdir(), "autorag-qa-soak-")));
const USER_DATA = join(WORK, "user-data");
const QA_ROOT = join(WORK, "root");
const FOLDERS = ["alpha", "beta", "gamma"];
const FILES_PER_FOLDER = 400;
for (const folder of FOLDERS) {
	const dir = join(QA_ROOT, folder);
	mkdirSync(dir, { recursive: true });
	for (let index = 0; index < FILES_PER_FOLDER; index += 1) {
		const ext = ["txt", "md", "csv", "json"][index % 4];
		writeFileSync(join(dir, `${folder}-${String(index).padStart(4, "0")}.${ext}`), `${folder} ${index}\n`);
	}
}
// A folder of real images: every row gets an OS thumbnail and Finder
// metadata, so the fill phase measures what enrichment costs the renderer.
const IMAGES = "images";
const IMAGE_COUNT = 600;
{
	const dir = join(QA_ROOT, IMAGES);
	mkdirSync(dir, { recursive: true });
	for (let index = 0; index < IMAGE_COUNT; index += 1) {
		writeFileSync(join(dir, `img-${String(index).padStart(4, "0")}.png`), solidPng(32, 32, [(index * 7) % 255, 90, 200]));
	}
}

function crc32(buf) {
	let crc = 0xffffffff;
	for (const byte of buf) {
		crc ^= byte;
		for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
	}
	return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}
function solidPng(width, height, [r, g, b]) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	const raw = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y += 1) {
		const offset = y * (1 + width * 3);
		for (let x = 0; x < width; x += 1) raw.set([r, g, b], offset + 1 + x * 3);
	}
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

const results = [];
const check = (label, ok, detail) => {
	results.push({ label, ok, detail });
	console.log(`${ok ? "PASS" : ENFORCE ? "FAIL" : "INFO"}  ${label}${detail === undefined ? "" : ` :: ${detail}`}`);
};

let app;
try {
	app = await launchFinder({ userDataDir: USER_DATA, env: { AUTORAG_QA_ROOT: QA_ROOT } });
	const page = await finderWindow(app, 30_000);
	page.setDefaultTimeout(15_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
	let rendererGone = false;
	page.on("crash", () => {
		rendererGone = true;
	});

	// Main-side probes: invoke counters (index:status and the listing/enrichment
	// channels) and an event-loop delay histogram.
	await app.evaluate(({ ipcMain }) => {
		const handlers = ipcMain._invokeHandlers;
		globalThis.__soakCalls = {};
		for (const channel of ["index:status", "fs:listDir", "fs:enrichEntries", "fs:finderMetadata"]) {
			const original = handlers.get(channel);
			if (original === undefined) continue;
			globalThis.__soakCalls[channel] = 0;
			handlers.set(channel, (...args) => {
				globalThis.__soakCalls[channel] += 1;
				return original(...args);
			});
		}
		globalThis.__soakHasIndexProbe = globalThis.__soakCalls["index:status"] !== undefined;
	});
	const mainProbe = () =>
		app.evaluate(() => ({
			indexStatusCalls: globalThis.__soakCalls["index:status"],
			calls: { ...globalThis.__soakCalls },
			hasIndexProbe: globalThis.__soakHasIndexProbe,
			rss: process.memoryUsage().rss,
			loopP99: globalThis.__soakLoop === undefined ? null : globalThis.__soakLoop.percentile(99) / 1e6,
			loopMax: globalThis.__soakLoop === undefined ? null : globalThis.__soakLoop.max / 1e6,
		}));
	const startLoopMonitor = () =>
		app.evaluate(() => {
			const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
			globalThis.__soakLoop?.disable();
			globalThis.__soakLoop = monitorEventLoopDelay({ resolution: 10 });
			globalThis.__soakLoop.enable();
		});

	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.enable");
	await cdp.send("Performance.enable");
	const scriptSeconds = async () => {
		const { metrics } = await cdp.send("Performance.getMetrics");
		return metrics.find((metric) => metric.name === "ScriptDuration")?.value ?? 0;
	};
	const heapSnapshot = async () => {
		const chunks = [];
		const onChunk = (event) => chunks.push(event.chunk);
		cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
		await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
		cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
		return analyzeSnapshot(JSON.parse(chunks.join("")));
	};
	const retainedHeap = async () => {
		for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
		// `performance.memory` is bucketed without --enable-precise-memory-info; CDP is exact.
		const { usedSize } = await cdp.send("Runtime.getHeapUsage");
		return usedSize;
	};
	// The view toggle's labels are localized; its order is fixed (Toolbar VIEW_OPTIONS).
	const viewButton = (mode) => page.locator(".seg__button").nth(["icons", "list", "columns"].indexOf(mode));
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await page.waitForSelector(`[data-path="${join(QA_ROOT, FOLDERS[0])}"]`);
	await viewButton("list").click();

	const rows = page.locator('[role="row"]');
	const openFolder = async (folder) => {
		await page.locator(".sidebar__item", { hasText: "QA" }).click();
		const row = page.locator(`[data-path="${join(QA_ROOT, folder)}"]`).first();
		await row.waitFor();
		await row.dblclick();
		await page.locator(`[data-path="${join(QA_ROOT, folder, `${folder}-0000.txt`)}"]`).first().waitFor();
	};
	const cycle = async () => {
		for (const folder of FOLDERS) {
			await openFolder(folder);
			const count = Math.min(await rows.count(), 16);
			for (let index = 0; index < count; index += 1) {
				await rows.nth(index).click();
				if (index % 5 === 0) {
					await page.keyboard.press("Space");
					await sleep(150);
					await page.keyboard.press("Escape");
				}
			}
			for (let step = 0; step < 6; step += 1) await page.keyboard.press("ArrowDown");
		}
		await viewButton("icons").click();
		await sleep(150);
		await viewButton("columns").click();
		await sleep(150);
		await viewButton("list").click();
		await page.keyboard.press(chord("t"));
		await sleep(150);
		await page.keyboard.press(chord("w"));
		await sleep(150);
	};

	// 1. Per-interaction IPC cost: clicks inside an already-listed folder.
	await openFolder(FOLDERS[0]);
	await sleep(1500);
	const beforeClicks = await mainProbe();
	const CLICKS = 10;
	for (let index = 0; index < CLICKS; index += 1) {
		await rows.nth(index).click();
		await sleep(80);
	}
	await sleep(500);
	const afterClicks = await mainProbe();
	const perClick = (afterClicks.indexStatusCalls - beforeClicks.indexStatusCalls) / CLICKS;
	check("index:status probe installed", afterClicks.hasIndexProbe === true, String(afterClicks.hasIndexProbe));

	// 1b. Thumbnail fill: scroll a cold 600-image folder top to bottom in the
	// list until the last row shows its OS thumbnail. Every batch of icons and
	// Finder metadata lands while the list scrolls; renderer script time and
	// long tasks over the phase are what that costs.
	await page.locator(".sidebar__item", { hasText: "QA" }).click();
	await page.locator(`[data-path="${join(QA_ROOT, IMAGES)}"]`).first().dblclick();
	const lastImage = page.locator(`[data-path="${join(QA_ROOT, IMAGES, `img-${String(IMAGE_COUNT - 1).padStart(4, "0")}.png`)}"]`).first();
	await page.locator(`[data-path="${join(QA_ROOT, IMAGES, "img-0000.png")}"]`).first().waitFor();
	await page.evaluate(() => {
		globalThis.__soakLongTasks = [];
		new PerformanceObserver((list) => {
			for (const task of list.getEntries()) globalThis.__soakLongTasks.push(task.duration);
		}).observe({ type: "longtask" });
	});
	const fillScriptStart = await scriptSeconds();
	const fillStarted = Date.now();
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if ((await lastImage.count()) > 0) break;
		await page.locator(".list").evaluate((node) => {
			node.scrollTop += node.clientHeight * 0.5;
		});
		await sleep(40);
	}
	await lastImage.locator("img.tile--image").waitFor({ timeout: 30_000 });
	await sleep(1000);
	const fill = {
		ms: Date.now() - fillStarted - 1000,
		scriptMs: Math.round(((await scriptSeconds()) - fillScriptStart) * 1000),
		...(await page.evaluate(() => {
			const tasks = globalThis.__soakLongTasks ?? [];
			return { longTasks: tasks.length, longTaskMs: Math.round(tasks.reduce((sum, value) => sum + value, 0)) };
		})),
	};
	console.log(`INFO  thumbnail fill ${JSON.stringify(fill)}`);

	// 2. Warm-up, then the soak.
	for (let index = 0; index < WARMUP; index += 1) await cycle();
	await sleep(1000);
	const heapStart = await retainedHeap();
	const probeStart = await mainProbe();
	const rssStart = probeStart.rss;
	await startLoopMonitor();
	const scriptStart = await scriptSeconds();
	const started = Date.now();
	const samples = [];
	for (let index = 0; index < CYCLES; index += 1) {
		await cycle();
		if ((index + 1) % 10 === 0) {
			const heap = await retainedHeap();
			const probe = await mainProbe();
			samples.push({ cycle: index + 1, heapMB: +(heap / 1e6).toFixed(1), mainRssMB: +(probe.rss / 1e6).toFixed(1) });
			console.log(`INFO  cycle ${index + 1}: heap ${(heap / 1e6).toFixed(1)} MB, main RSS ${(probe.rss / 1e6).toFixed(1)} MB`);
		}
	}
	await sleep(1500);
	const scriptEnd = await scriptSeconds();
	const heapEnd = await retainedHeap();
	const end = await mainProbe();
	const growthPerCycleMB = (heapEnd - heapStart) / 1e6 / CYCLES;
	const retention = SNAPSHOT ? await heapSnapshot() : null;

	const summary = {
		cycles: CYCLES,
		seconds: Math.round((Date.now() - started) / 1000),
		heapStartMB: +(heapStart / 1e6).toFixed(1),
		heapEndMB: +(heapEnd / 1e6).toFixed(1),
		heapGrowthPerCycleMB: +growthPerCycleMB.toFixed(3),
		heapGrowthMB: +((heapEnd - heapStart) / 1e6).toFixed(1),
		rendererScriptMsPerCycle: +(((scriptEnd - scriptStart) * 1000) / CYCLES).toFixed(1),
		retention,
		thumbnailFill: fill,
		mainRssStartMB: +(rssStart / 1e6).toFixed(1),
		mainRssEndMB: +(end.rss / 1e6).toFixed(1),
		mainLoopP99Ms: end.loopP99 === null ? null : +end.loopP99.toFixed(1),
		mainLoopMaxMs: end.loopMax === null ? null : +end.loopMax.toFixed(1),
		indexStatusPerClick: perClick,
		ipcPerCycle: Object.fromEntries(
			Object.entries(end.calls).map(([channel, total]) => [channel, +((total - (probeStart.calls[channel] ?? 0)) / CYCLES).toFixed(1)]),
		),
		samples,
		pageErrors,
	};
	console.log(`INFO  summary ${JSON.stringify(summary)}`);

	check("renderer stayed alive through the soak", !rendererGone);
	check("no page errors during the soak", pageErrors.length === 0, pageErrors[0]);
	check(
		`retained renderer heap grows ≤ ${MAX_HEAP_GROWTH_PER_CYCLE_MB} MB/cycle`,
		growthPerCycleMB <= MAX_HEAP_GROWTH_PER_CYCLE_MB,
		`${growthPerCycleMB.toFixed(3)} MB/cycle (${summary.heapStartMB} → ${summary.heapEndMB} MB over ${CYCLES})`,
	);
	check(
		`a selection click sends ≤ ${MAX_INDEX_STATUS_PER_CLICK} index:status IPC`,
		perClick <= MAX_INDEX_STATUS_PER_CLICK,
		`${perClick} per click`,
	);
	check(
		`main event-loop delay p99 < ${MAX_LOOP_P99_MS} ms`,
		summary.mainLoopP99Ms !== null && summary.mainLoopP99Ms < MAX_LOOP_P99_MS,
		`${summary.mainLoopP99Ms} ms (max ${summary.mainLoopMaxMs} ms)`,
	);
	if (retention !== null) {
		check(
			`no older listing is retained (generations per folder ≤ ${MAX_LISTING_GENERATIONS})`,
			retention.maxGenerations <= MAX_LISTING_GENERATIONS,
			`${retention.maxGenerations} max ${JSON.stringify(retention.generationsByFolder)}; ${retention.staleEntryCopies} duplicate row objects; ${retention.rowArrays} row arrays ${JSON.stringify(retention.arraysByFolder)}`,
		);
	}
	await page.screenshot({ path: join(EVIDENCE, "end.png") });
	writeFileSync(join(EVIDENCE, "result.json"), `${JSON.stringify({ summary, checks: results }, null, 2)}\n`);
} finally {
	if (app !== undefined) await app.close().catch(() => undefined);
	rmSync(WORK, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${ENFORCE ? "" : " (report mode)"}`);
if (ENFORCE && failed.length > 0) process.exitCode = 1;
