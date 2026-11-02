import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parsedMirrorRoot, parsedOutputPath } from "@autorag/librarian";

const stageKey = (virtualPath) => createHash("sha256").update(virtualPath).digest("hex");

export function seedMirrorStage(workspacePath, index) {
	const mirrorRoot = parsedMirrorRoot(workspacePath);
	const stateDir = join(mirrorRoot, "stage");
	const outputRoot = join(mirrorRoot, "files");
	rmSync(stateDir, { recursive: true, force: true });
	mkdirSync(outputRoot, { recursive: true });
	mkdirSync(workspacePath, { recursive: true });

	const items = [];
	const commits = [];
	const skips = [];

	for (const entry of Object.values(index.entries ?? {})) {
		const key = stageKey(entry.virtualPath);
		const version = JSON.stringify({
			virtualPath: entry.virtualPath,
			sourcePath: entry.sourcePath,
			parserName: entry.parserName,
			sourceMtimeNs: entry.sourceMtimeNs,
			sourceSizeBytes: entry.sourceSizeBytes,
			...(entry.parserVersion === undefined ? {} : { parserVersion: entry.parserVersion }),
			...(entry.sourceVersion === undefined ? {} : { sourceVersion: entry.sourceVersion }),
		});
		const outFile = parsedOutputPath(workspacePath, entry.virtualPath);
		mkdirSync(dirname(outFile), { recursive: true });
		if (!existsSync(outFile)) writeFileSync(outFile, "# seeded\n", "utf8");
		items.push({ key, version });
		commits.push({ key, version, outputPath: basename(outFile) });
	}

	for (const skip of Object.values(index.skipped ?? {})) {
		const key = stageKey(skip.virtualPath);
		const version = JSON.stringify({
			virtualPath: skip.virtualPath,
			sourcePath: skip.sourcePath,
			parserName: skip.parserName ?? "plain-text",
			sourceMtimeNs: skip.sourceMtimeNs,
			sourceSizeBytes: skip.sourceSizeBytes,
			...(skip.parserVersion === undefined ? {} : { parserVersion: skip.parserVersion }),
		});
		items.push({ key, version });
		skips.push({ key, version, reason: skip.reason });
	}

	const requests = [
		{ op: "capabilities" },
		{
			op: "open",
			stage: "parse",
			source_id: "autorag-parsed-mirror",
			fingerprint: "fixture",
			output_root: outputRoot,
			items,
		},
		...commits.map((item) => ({ op: "commit", key: item.key, version: item.version, output: { path: item.outputPath } })),
		...skips.map((item) => ({ op: "skip", key: item.key, version: item.version, reason: item.reason })),
		{ op: "finish" },
	];

	const result = spawnSync("minsync", ["stage", "--state-dir", stateDir], {
		cwd: workspacePath,
		input: `${requests.map((req) => JSON.stringify(req)).join("\n")}\n`,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(`seedMirrorStage failed (exit ${result.status}): ${result.stderr || result.stdout}`);
	}
}
