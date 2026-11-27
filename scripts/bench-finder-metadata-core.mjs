#!/usr/bin/env node
/**
 * Before (child-process spawns / uncached localeCompare) vs After (Bundled Rust N-API Core)
 * benchmark for Finder metadata, Finder tags, Windows Explorer file-kind registry lookup,
 * and large-directory entry sorting.
 *
 * Works on macOS (host + 2-vCPU/4GB Tart VM) and Windows SSH PC:
 *   node scripts/bench-finder-metadata-core.mjs \
 *     --addon <path-to-dazzi-core.node> \
 *     --app-dir <AutoRAG-app-root>
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const argVal = (flag, fallback) => {
	const idx = args.indexOf(flag);
	return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const appDir = resolve(argVal("--app-dir", join(import.meta.dirname, "..")));
const addonPath = resolve(argVal("--addon", join(appDir, "src", "main", "vendor", "dazzi-core.node")));
if (!existsSync(addonPath)) {
	console.error(`Missing native addon: ${addonPath}`);
	process.exit(1);
}

const req = createRequire(join(appDir, "package.json"));
const native = req(addonPath);
const work = mkdtempSync(join(tmpdir(), "dazzi-meta-bench-"));

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let i = 0;
	const lane = async () => {
		while (i < items.length) {
			const idx = i++;
			out[idx] = await fn(items[idx], idx);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
	return out;
}

function runCmd(command, cmdArgs, input) {
	return new Promise((res, rej) => {
		const child = execFile(command, cmdArgs, { timeout: 10000, maxBuffer: 4 << 20, encoding: "buffer" }, (err, stdout) => {
			if (err) rej(err);
			else res(stdout);
		});
		if (input !== undefined && child.stdin) {
			child.stdin.on("error", () => {});
			child.stdin.end(input);
		}
	});
}

const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];

try {
	console.log(`\n=== Finder Metadata / Tags / Kind Benchmark (${platform()}/${arch()}, ${cpus().length} vCPU, ${(totalmem() / 1024 ** 3).toFixed(1)} GB, Node ${process.version}) ===`);
	console.log(`CPU: ${cpus()[0]?.model}`);
	console.log(`Workload                                           | Before (JS/CLI) | After (Rust) | Speedup | Parity`);
	console.log(`---------------------------------------------------|-----------------|--------------|---------|-------`);

	const rows = [];

	// 1. macOS workloads: 100 tagged/commented files (metadata load + bulk tag edit)
	if (platform() === "darwin") {
		const dir = join(work, "tagged-100");
		mkdirSync(dir, { recursive: true });
		const files = [];
		const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";
		const COMMENT_XATTR = "com.apple.metadata:kMDItemFinderComment";
		const commentXml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><string>리뷰 완료 · Q4 보고서</string></plist>`;
		const commentBin = await runCmd("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], commentXml);

		for (let i = 0; i < 100; i += 1) {
			const p = join(dir, `doc_${String(i).padStart(3, "0")}.txt`);
			writeFileSync(p, `doc ${i}\n`);
			native.writeFinderTagsNative(p, i % 2 === 0 ? ["Urgent\n6", "한글태그\n4"] : ["Review\n2"]);
			if (i % 3 === 0) {
				await execFileAsync("/usr/bin/xattr", ["-w", "-x", COMMENT_XATTR, commentBin.toString("hex"), p]);
			}
			files.push(p);
		}

		const MDLS_ARGS = [
			"-name", "kMDItemFSCreationDate",
			"-name", "kMDItemDateAdded",
			"-name", "kMDItemLastUsedDate",
			"-name", "kMDItemUserTags",
			"-name", "kMDItemFinderComment",
			"-name", "kMDItemPixelWidth",
			"-name", "kMDItemPixelHeight",
			"-name", "kMDItemStarRating",
			"-name", "kMDItemRating",
			"-plist", "-",
		];

		// 2a. Finder metadata read across 100 files (scroll/columns load)
		async function readMetaBefore() {
			return mapLimit(files, 4, async (p) => {
				const [tHex, cHex, mdlsXml] = await Promise.all([
					runCmd("/usr/bin/xattr", ["-p", "-x", TAGS_XATTR, p]).then((b) => b.toString("utf8")).catch(() => null),
					runCmd("/usr/bin/xattr", ["-p", "-x", COMMENT_XATTR, p]).then((b) => b.toString("utf8")).catch(() => null),
					runCmd("/usr/bin/mdls", ["-plist", "-", p]).then((b) => b.toString("utf8")).catch(() => ""),
				]);
				const decode = async (hex) => {
					if (!hex) return null;
					const bytes = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex");
					if (!bytes.length) return null;
					const xml = (await runCmd("/usr/bin/plutil", ["-convert", "xml1", "-o", "-", "--", "-"], bytes)).toString("utf8");
					return [...xml.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
				};
				const tags = await decode(tHex);
				const comment = (await decode(cHex))?.[0] ?? null;
				return { tags, comment, mdlsLen: mdlsXml.length };
			});
		}

		async function readMetaAfter() {
			const xattrs = files.map((p) => native.readFinderXattrsNative(p));
			const batches = [];
			for (let i = 0; i < files.length; i += 32) {
				batches.push(runCmd("/usr/bin/mdls", [...MDLS_ARGS, ...files.slice(i, i + 32)]));
			}
			await Promise.all(batches);
			return xattrs.map((x) => ({ tags: x.tags ?? null, comment: x.comment ?? null }));
		}

		const tB0 = performance.now();
		const resBefore = await readMetaBefore();
		const msBefore = performance.now() - tB0;

		const tA0 = performance.now();
		const resAfter = await readMetaAfter();
		const msAfter = performance.now() - tA0;

		const metaParity = resBefore.every(
			(b, i) => JSON.stringify(b.tags) === JSON.stringify(resAfter[i].tags) && b.comment === resAfter[i].comment,
		);
		if (!metaParity) throw new Error("Finder metadata parity mismatch");
		rows.push({ name: "macOS Finder metadata (100 tagged files)", before: msBefore, after: msAfter, parity: metaParity });

		// 2b. Bulk Finder tag edit across 100 files (add + remove tag)
		async function tagEditBefore() {
			await mapLimit(files, 4, async (p) => {
				const hex = (await runCmd("/usr/bin/xattr", ["-p", "-x", TAGS_XATTR, p])).toString("utf8");
				const cur = JSON.parse((await runCmd("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex"))).toString("utf8"));
				const next = [...cur.filter((t) => !t.startsWith("BenchTag")), "BenchTag\n7"];
				const bin = await runCmd("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"], JSON.stringify(next));
				await runCmd("/usr/bin/xattr", ["-w", "-x", TAGS_XATTR, bin.toString("hex"), p]);
			});
		}

		async function tagEditAfter() {
			for (const p of files) {
				const cur = native.readFinderTagsNative(p);
				const next = [...cur.filter((t) => !t.startsWith("BenchTag")), "BenchTag\n7"];
				native.writeFinderTagsNative(p, next);
			}
		}

		const tTB0 = performance.now();
		await tagEditBefore();
		const msTagBefore = performance.now() - tTB0;
		const snapBefore = files.map((p) => native.readFinderTagsNative(p));

		const tTA0 = performance.now();
		await tagEditAfter();
		const msTagAfter = performance.now() - tTA0;
		const snapAfter = files.map((p) => native.readFinderTagsNative(p));
		const tagParity = JSON.stringify(snapBefore) === JSON.stringify(snapAfter);
		if (!tagParity) throw new Error("Finder tag write parity mismatch");
		rows.push({ name: "macOS Bulk Finder tag write (100 files)", before: msTagBefore, after: msTagAfter, parity: tagParity });
	}

	// 3. Windows workload: 50 distinct extensions Explorer Type registry lookup
	if (platform() === "win32") {
		const exts = [
			".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".json", ".csv", ".tsv", ".xml",
			".html", ".css", ".js", ".ts", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
			".tif", ".tiff", ".svg", ".ico", ".mp4", ".mov", ".avi", ".mkv", ".mp3", ".wav",
			".zip", ".7z", ".rar", ".tar", ".gz", ".exe", ".msi", ".dll", ".bat", ".ps1",
			".py", ".rs", ".go", ".c", ".cpp", ".h", ".log", ".ini", ".cfg", ".nonexistent_dazzi_ext",
		];

		async function winKindsBefore() {
			const list = exts.map((e) => `'${e}'`).join(",");
			const script = [
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
				"$root = [Microsoft.Win32.Registry]::ClassesRoot",
				"function Get-Default([string]$name) { try { $key = $root.OpenSubKey($name); if ($null -eq $key) { return '' }; try { return [string]$key.GetValue('') } finally { $key.Close() } } catch { return '' } }",
				`foreach ($ext in @(${list})) { $line = ''; $progId = Get-Default $ext; if (-not [string]::IsNullOrEmpty($progId)) { $line = (Get-Default $progId) -replace '[\\r\\n]+', ' ' }; [Console]::Out.WriteLine($line) }`,
			].join("; ");
			const out = (await runCmd("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script])).toString("utf8");
			const lines = out.split(/\r?\n/);
			return exts.map((_, i) => {
				const l = (lines[i] ?? "").trim();
				return l === "" ? null : l;
			});
		}

		const bt = [], at = [];
		let bRes = null, aRes = null;
		for (let r = 0; r < 5; r += 1) {
			const t0 = performance.now(); bRes = await winKindsBefore(); bt.push(performance.now() - t0);
			const t1 = performance.now(); aRes = native.lookupWindowsFileKindsNative(exts); at.push(performance.now() - t1);
		}
		const parity = JSON.stringify(bRes) === JSON.stringify(aRes);
		if (!parity) {
			for (let i = 0; i < exts.length; i += 1) {
				if (bRes[i] !== aRes[i]) console.error(`Mismatch ${exts[i]}: PS=${JSON.stringify(bRes[i])} Rust=${JSON.stringify(aRes[i])}`);
			}
			throw new Error("Windows file-kind registry parity mismatch");
		}
		rows.push({ name: "Windows File Kind lookup (50 extensions, HKCR)", before: median(bt), after: median(at), parity });
	}

	for (const r of rows) {
		const bStr = `${r.before.toFixed(1)} ms`.padStart(15);
		const aStr = `${r.after.toFixed(2)} ms`.padStart(12);
		const xStr = `${(r.before / Math.max(0.01, r.after)).toFixed(1)}×`.padStart(7);
		console.log(`${r.name.padEnd(50)} | ${bStr} | ${aStr} | ${xStr} | ${r.parity ? "PASS" : "FAIL"}`);
	}
	console.log("");
} finally {
	rmSync(work, { recursive: true, force: true });
}
