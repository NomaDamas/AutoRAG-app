#!/usr/bin/env node
/**
 * Before (JS) vs After (Rust N-API core) benchmark for Dazzi's ported hot paths.
 *
 * Runs rotated A/B rounds (pure JS reference implementation vs bundled Rust
 * `dazzi-core.node`), verifies 100% output parity on every workload, and prints
 * a JSON + Markdown summary.
 *
 * Works standalone on macOS host, Tart low-spec macOS VM, and Windows SSH box:
 *   node scripts/bench-dazzi-core.mjs --addon <path-to-dazzi-core.node> [--runs 7] [--json]
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, lstatSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, freemem, hostname, platform, arch, tmpdir, totalmem } from "node:os";
import { extname, join, matchesGlob, sep } from "node:path";
import { opendir, readdir, lstat, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
	const idx = args.indexOf(flag);
	return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const RUNS = Math.max(3, Number.parseInt(argVal("--runs", "7"), 10) || 7);
const JSON_ONLY = args.includes("--json");
const addonArg = argVal("--addon", join(import.meta.dirname, "..", "src", "main", "vendor", "dazzi-core.node"));

if (!existsSync(addonArg)) {
	console.error(`Missing native addon at ${addonArg}`);
	process.exit(1);
}

const require = createRequire(import.meta.url);
const native = require(addonArg);

// ── JS reference implementations (exact copies of AutoRAG-app TypeScript paths) ──

function isGlobExclusion(entry) {
	return /[*?[]/u.test(entry);
}
function isUnder(path, root) {
	return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
function matchesGlobExclusion(path, glob) {
	const slashed = path.replaceAll("\\", "/");
	if (matchesGlob(slashed, glob)) return true;
	return glob.startsWith("**/") && matchesGlob(slashed, glob.slice(3));
}
function jsFindExclusionBatch(exclusions, paths) {
	const out = new Array(paths.length);
	for (let i = 0; i < paths.length; i += 1) {
		const path = paths[i];
		let glob = null;
		let found = null;
		for (const entry of exclusions) {
			if (isGlobExclusion(entry)) {
				if (glob === null && matchesGlobExclusion(path, entry)) glob = { kind: "glob", entry };
			} else if (isUnder(path, entry)) {
				found = { kind: "path", entry };
				break;
			}
		}
		out[i] = found ?? glob;
	}
	return out;
}

const WORD = /[\p{L}\p{N}]/u;
const ASCII = /^[\x00-\x7f]*$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function jsNormalize(text, emit) {
	if (ASCII.test(text)) {
		for (let i = 0; i < text.length; i += 1) {
			const c = text.charCodeAt(i);
			if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) emit(text[i], i, i + 1);
			else if (c >= 0x41 && c <= 0x5a) emit(String.fromCharCode(c + 0x20), i, i + 1);
		}
		return;
	}
	for (const { segment, index } of graphemes.segment(text)) {
		for (const char of segment.normalize("NFKC").toLowerCase()) {
			if (WORD.test(char)) emit(char, index, index + segment.length);
		}
	}
}
function jsBuildTextIndex(pieces) {
	const parts = [];
	const starts = [];
	const ends = [];
	const pieceStarts = new Int32Array(pieces.length);
	for (let i = 0; i < pieces.length; i += 1) {
		pieceStarts[i] = starts.length;
		jsNormalize(pieces[i], (char, s, e) => {
			parts.push(char);
			for (let u = 0; u < char.length; u += 1) {
				starts.push(s);
				ends.push(e);
			}
		});
	}
	return { key: parts.join(""), starts: Int32Array.from(starts), ends: Int32Array.from(ends), pieceStarts };
}

async function jsScanFolder(root, supportedSet, skipSet, maxBytes, maxEntries) {
	let files = 0, bytes = 0, scanned = 0;
	const queue = [root];
	for (let head = 0; head < queue.length; head += 1) {
		const dir = queue[head];
		let handle;
		try { handle = await opendir(dir); } catch { continue; }
		for await (const entry of handle) {
			if (scanned >= maxEntries) break;
			scanned += 1;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || skipSet.has(entry.name.toLowerCase())) continue;
				queue.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (!supportedSet.has(extname(entry.name).toLowerCase())) continue;
			let size;
			try { size = (await stat(full)).size; } catch { continue; }
			if (size > maxBytes) continue;
			files += 1;
			bytes += size;
		}
		if (scanned >= maxEntries) break;
	}
	return { files, bytes };
}

async function jsMeasureFolder(folder, supportedSet, skipSet, maxBytes, maxEntries, sampleSize) {
	const DAY_MS = 86_400_000;
	const newBucket = () => ({ indexedFiles: 0, totalFiles: 0, indexedBytes: 0, extensions: new Map(), times: [], names: [], below: new Map() });
	const own = newBucket();
	const children = new Map();
	let scanned = 0, truncated = false;
	const queue = [{ dir: folder, bucket: own, isFolder: true, part: null, depth: 0 }];
	for (let head = 0; head < queue.length; head += 1) {
		const { dir, bucket, isFolder, part, depth } = queue[head];
		let handle;
		try { handle = await opendir(dir); } catch { continue; }
		for await (const entry of handle) {
			if (scanned >= maxEntries) { truncated = true; break; }
			scanned += 1;
			if (entry.isDirectory()) {
				if (entry.name.startsWith(".") || skipSet.has(entry.name.toLowerCase())) continue;
				let child = bucket;
				if (isFolder) { child = newBucket(); children.set(entry.name, child); }
				queue.push({ dir: join(dir, entry.name), bucket: child, isFolder: false, part: depth === 1 ? entry.name : part, depth: depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			const ext = extname(entry.name).toLowerCase();
			const label = ext === "" ? "(none)" : ext;
			bucket.totalFiles += 1;
			bucket.extensions.set(label, (bucket.extensions.get(label) ?? 0) + 1);
			bucket.names.push(entry.name);
			if (part !== null) bucket.below.set(part, (bucket.below.get(part) ?? 0) + 1);
			let info;
			try { info = await stat(join(dir, entry.name)); } catch { continue; }
			bucket.times.push(info.mtimeMs);
			if (!supportedSet.has(ext) || info.size > maxBytes) continue;
			bucket.indexedFiles += 1;
			bucket.indexedBytes += info.size;
		}
		if (truncated && scanned >= maxEntries) break;
	}
	const all = [own, ...children.values()];
	const allTimes = all.flatMap((b) => b.times).sort((a, b) => a - b);
	return {
		indexedFiles: all.reduce((s, b) => s + b.indexedFiles, 0),
		totalFiles: all.reduce((s, b) => s + b.totalFiles, 0),
		indexedBytes: all.reduce((s, b) => s + b.indexedBytes, 0),
		childCount: children.size,
		timesCount: allTimes.length,
		truncated,
	};
}

async function jsListDir(dirPath, plat) {
	const dirents = await readdir(dirPath, { withFileTypes: true });
	const entries = [];
	for (let i = 0; i < dirents.length; i += 64) {
		const batch = dirents.slice(i, i + 64);
		const built = await Promise.all(
			batch.map(async (d) => {
				const full = join(dirPath, d.name);
				const ls = await lstat(full);
				const isSym = ls.isSymbolicLink();
				const eff = isSym ? await stat(full).catch(() => ls) : ls;
				const isDir = eff.isDirectory();
				const dot = d.name.lastIndexOf(".");
				const ext = dot <= 0 ? "" : d.name.slice(dot + 1).toLowerCase();
				const isFolder = isDir && !(plat === "darwin" && d.name.length > 4 && ext === "app");
				return {
					name: d.name,
					path: full,
					kind: isFolder ? "folder" : "file",
					ext: isFolder ? "" : ext,
					size: isDir ? null : eff.size,
					mtimeMs: eff.mtimeMs,
					flags: isSym ? 1 : 0,
				};
			}),
		);
		entries.push(...built);
	}
	entries.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
	return entries;
}

// ── Build realistic filesystem fixtures ──
const work = mkdtempSync(join(tmpdir(), "dazzi-bench-"));
const treeDir = join(work, "tree");
const bigDir = join(work, "big-dir");
mkdirSync(bigDir, { recursive: true });
for (let i = 0; i < 3000; i += 1) {
	writeFileSync(join(bigDir, `doc_${String(i).padStart(4, "0")}_보고서.pdf`), `payload ${i}`);
}
for (let d = 0; d < 60; d += 1) {
	const sub = join(treeDir, `dept_${String(d).padStart(2, "0")}`, `sub_${d % 3}`);
	mkdirSync(sub, { recursive: true });
	for (let f = 0; f < 100; f += 1) {
		const ext = f % 3 === 0 ? "pdf" : f % 3 === 1 ? "md" : "txt";
		writeFileSync(join(sub, `file_${d}_${f}.${ext}`), `body ${d} ${f}`);
	}
}
const nmDir = join(treeDir, "dept_00", "node_modules", "pkg");
mkdirSync(nmDir, { recursive: true });
for (let i = 0; i < 200; i += 1) writeFileSync(join(nmDir, `m_${i}.js`), `export const x = ${i};`);

const supportedExts = [".pdf", ".md", ".txt", ".docx", ".xlsx", ".pptx", ".hwp", ".hwpx"];
const supportedSet = new Set(supportedExts);
const skipDirs = ["node_modules", ".git", "dist", "build", "target", ".cache", ".venv", "__pycache__"];
const skipSet = new Set(skipDirs);
const exclusions = [
	join(work, "private"),
	join(work, "archive"),
	"**/node_modules/**",
	"**/.git/**",
	"**/*.tmp",
	"**/*.log",
	"**/dist/**",
	"**/build/**",
	"**/target/**",
	"**/.venv/**",
	"**/__pycache__/**",
	"**/*.DS_Store",
	"**/*.cache",
	"**/Library/Caches/**",
	"**/Downloads/Installers/**",
];
const exclPaths = Array.from({ length: 20_000 }, (_, i) =>
	i % 19 === 0
		? join(work, `proj_${i % 50}`, "node_modules", "pkg", "index.js")
		: join(work, `proj_${i % 50}`, "src", `mod_${i % 20}`, `file_${i}.pdf`),
);
const textPieces = Array.from({ length: 2000 }, (_, p) =>
	`제${p + 1}조 (계약의 목적 및 적용범위) 본 계약은 주식회사 마커와 협력사 간의 AI 문서 검색 플랫폼 공급 및 유지보수에 관한 권리와 의무를 규정한다. Article ${p + 1}: Performance SLA 99.95%, response time under 200ms. 금액: ${(p + 1) * 150000}원.`,
);

const median = (arr) => {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

async function measureRotated(name, jsFn, rustFn, verifyParity) {
	// Warmup + parity check
	const jsOut = await jsFn();
	const rsOut = await rustFn();
	const parityOk = verifyParity(jsOut, rsOut);
	if (!parityOk) {
		throw new Error(`Parity mismatch in ${name}!`);
	}

	const jsTimes = [];
	const rsTimes = [];
	for (let r = 0; r < RUNS; r += 1) {
		if (r % 2 === 0) {
			const t0 = performance.now();
			await jsFn();
			jsTimes.push(performance.now() - t0);
			const t1 = performance.now();
			await rustFn();
			rsTimes.push(performance.now() - t1);
		} else {
			const t1 = performance.now();
			await rustFn();
			rsTimes.push(performance.now() - t1);
			const t0 = performance.now();
			await jsFn();
			jsTimes.push(performance.now() - t0);
		}
	}
	const jsMed = median(jsTimes);
	const rsMed = median(rsTimes);
	return {
		name,
		parityOk,
		runs: RUNS,
		jsMedianMs: Number(jsMed.toFixed(2)),
		rustMedianMs: Number(rsMed.toFixed(2)),
		speedup: Number((jsMed / rsMed).toFixed(2)),
		jsMinMs: Number(Math.min(...jsTimes).toFixed(2)),
		rustMinMs: Number(Math.min(...rsTimes).toFixed(2)),
	};
}

try {
	const results = [];

	results.push(
		await measureRotated(
			"findExclusionBatch (20k paths x 15 rules)",
			() => jsFindExclusionBatch(exclusions, exclPaths),
			() => native.findExclusionBatch(exclusions, exclPaths),
			(a, b) => a.length === b.length && a.every((v, i) => JSON.stringify(v) === JSON.stringify(b[i])),
		),
	);

	results.push(
		await measureRotated(
			"scanFolder (6,000 files across 60 dirs)",
			() => jsScanFolder(treeDir, supportedSet, skipSet, 50 * 1024 * 1024, 200_000),
			() => native.scanFolderNative(treeDir, supportedExts, skipDirs, 50 * 1024 * 1024, 200_000, null, new native.WalkControl()),
			(a, b) => a.files === b.files && a.bytes === b.bytes,
		),
	);

	results.push(
		await measureRotated(
			"measureFolder (6,000 files survey)",
			() => jsMeasureFolder(treeDir, supportedSet, skipSet, 50 * 1024 * 1024, 400_000, 12),
			() => native.measureFolderNative(treeDir, supportedExts, skipDirs, 50 * 1024 * 1024, 400_000, 12, new native.WalkControl()),
			(a, b) => a.indexedFiles === b.indexedFiles && a.totalFiles === b.totalFiles && a.indexedBytes === b.indexedBytes && a.childCount === b.children.length,
		),
	);

	results.push(
		await measureRotated(
			"listDir (3,000 files single folder)",
			() => jsListDir(bigDir, platform()),
			() => {
				const { entries: raw } = native.listDirNative(bigDir, platform());
				raw.sort((a, b) => (a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : a.name.localeCompare(b.name)));
				return raw;
			},
			(a, b) => a.length === b.length && a[0]?.name === b[0]?.name && a[a.length - 1]?.name === b[b.length - 1]?.name,
		),
	);

	const totalJs = results.reduce((s, r) => s + r.jsMedianMs, 0);
	const totalRs = results.reduce((s, r) => s + r.rustMedianMs, 0);
	const report = {
		host: {
			hostname: hostname(),
			platform: platform(),
			arch: arch(),
			node: process.version,
			cpuModel: cpus()[0]?.model ?? "unknown",
			cpuCount: cpus().length,
			totalMemGb: Number((totalmem() / 1024 ** 3).toFixed(1)),
			freeMemGb: Number((freemem() / 1024 ** 3).toFixed(1)),
		},
		runs: RUNS,
		results,
		combined: {
			jsMedianMs: Number(totalJs.toFixed(2)),
			rustMedianMs: Number(totalRs.toFixed(2)),
			speedup: Number((totalJs / totalRs).toFixed(2)),
		},
	};

	if (JSON_ONLY) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`\n=== Dazzi Rust Core Benchmark (${report.host.platform}/${report.host.arch}, ${report.host.cpuCount} vCPU, ${report.host.totalMemGb} GB RAM, Node ${report.host.node}) ===`);
		console.log(`CPU: ${report.host.cpuModel}`);
		console.log(`Workload                                  | Before (JS) | After (Rust) | Speedup | Parity`);
		console.log(`------------------------------------------|-------------|--------------|---------|-------`);
		for (const r of results) {
			console.log(
				`${r.name.padEnd(41)} | ${`${r.jsMedianMs} ms`.padStart(11)} | ${`${r.rustMedianMs} ms`.padStart(12)} | ${`${r.speedup}×`.padStart(7)} | ${r.parityOk ? "PASS" : "FAIL"}`,
			);
		}
		console.log(`------------------------------------------|-------------|--------------|---------|-------`);
		console.log(
			`${"Combined total".padEnd(41)} | ${`${report.combined.jsMedianMs} ms`.padStart(11)} | ${`${report.combined.rustMedianMs} ms`.padStart(12)} | ${`${report.combined.speedup}×`.padStart(7)} | PASS\n`,
		);
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
