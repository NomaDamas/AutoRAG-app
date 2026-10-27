import { basename } from "node:path";
import { resolveFileeOptions, type FileeCliOptions } from "@autorag/librarian";
import type { FileeSettings } from "./conversion-service";
import { runFileeProcess } from "./filee-process";

/**
 * Shrinks a PDF without changing its format. Filee's own `compress-pdf` preset
 * does the work (it needs no extra engine: the Compress PDF preset ran in under a
 * second on a 8.6 MB scan with Ghostscript not installed), so the app adds no PDF
 * library of its own.
 */
export interface PdfReducer {
	/** Whether a reduction can be attempted now: Filee is enabled and present, or may be downloaded on first use. */
	available(): Promise<boolean>;
	/** Writes the reduced copy into `outputDir` and returns its path. Rejects with Filee's own reason. */
	reduce(source: string, outputDir: string, signal?: AbortSignal): Promise<string>;
}

/** The Filee preset that compresses a PDF. */
export const PDF_PRESET = "compress-pdf";

/** Exit 0: all converted, 1: some failed; both carry the JSON report. */
export function parseReduceResult(stdout: string, stderr: string, exitCode: number, source: string): string {
	if (exitCode !== 0 && exitCode !== 1) {
		const detail = stderr
			.split(/\r?\n/)
			.map((line) => line.replace(/^filee:\s*/, "").trim())
			.filter((line) => line.length > 0 && !line.startsWith("Run 'filee help'"))
			.join(" ");
		throw new Error(detail.length > 0 ? detail : `filee exited with code ${exitCode}`);
	}
	let report: unknown;
	try {
		report = JSON.parse(stdout);
	} catch {
		throw new Error("filee returned invalid JSON");
	}
	const files = typeof report === "object" && report !== null && "files" in report && Array.isArray(report.files) ? (report.files as unknown[]) : [];
	const file = files[0];
	if (typeof file !== "object" || file === null) throw new Error(`filee reported nothing for ${basename(source)}`);
	const { state, outputs, error } = file as { state?: unknown; outputs?: unknown; error?: unknown };
	if (state !== "done") throw new Error(typeof error === "string" && error.length > 0 ? error : `filee did not finish ${basename(source)}`);
	const output = Array.isArray(outputs) ? outputs.find((entry): entry is string => typeof entry === "string") : undefined;
	if (output === undefined) throw new Error(`filee wrote no file for ${basename(source)}`);
	return output;
}

export function createFileePdfReducer(settings: () => FileeSettings): PdfReducer {
	/** Executables already asked whether they know the preset (an older filee-cli may not). */
	const presetKnown = new Map<string, Promise<boolean>>();

	function baseOptions(autoInstall?: boolean): FileeCliOptions {
		const current = settings();
		return {
			...(current.binaryPath === undefined ? {} : { executable: current.binaryPath }),
			...((autoInstall ?? current.autoInstall) === false ? { autoInstall: false } : {}),
			...(current.timeoutMs === undefined ? {} : { timeoutMs: current.timeoutMs }),
			...(current.dataDir === undefined ? {} : { dataDir: current.dataDir }),
		};
	}

	function knowsPreset(executable: string, options: FileeCliOptions): Promise<boolean> {
		let known = presetKnown.get(executable);
		if (known === undefined) {
			known = runFileeProcess(executable, ["presets"], {
				timeoutMs: 15_000,
				...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			}).then(
				(run) => run.exitCode === 0 && run.stdout.split(/\r?\n/).some((line) => line.startsWith(PDF_PRESET)),
				() => false,
			);
			presetKnown.set(executable, known);
		}
		return known;
	}

	return {
		async available() {
			const current = settings();
			if (current.enabled === false) return false;
			try {
				// Already installed: the preset must exist in this version.
				const found = await resolveFileeOptions({ ...baseOptions(), autoInstall: false });
				return found.executable === undefined ? false : await knowsPreset(found.executable, found);
			} catch {
				// Not installed: the first run may download it, unless that is switched off or a path was pinned.
				return current.binaryPath === undefined && current.autoInstall !== false;
			}
		},

		async reduce(source, outputDir, signal) {
			const options = await resolveFileeOptions({
				...baseOptions(),
				...(signal === undefined ? {} : { signal }),
			});
			const executable = options.executable ?? "filee";
			const run = await runFileeProcess(executable, ["convert", source, "--preset", PDF_PRESET, "-o", outputDir, "--json"], {
				...(signal === undefined ? {} : { signal }),
				...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
				...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			});
			return parseReduceResult(run.stdout, run.stderr, run.exitCode, source);
		},
	};
}
