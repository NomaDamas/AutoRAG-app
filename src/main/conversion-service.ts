import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
	convertWithFilee,
	resolveFileeOptions,
	type FileeCliOptions,
	type FileeConvertRequest,
	type FileeConvertResult,
} from "@autorag/librarian";
import { readRawConfigObject } from "@autorag/librarian/core";
import type { ConversionOutcome, ConversionPlan, ConversionRequest } from "../shared/conversion-contract";
import { t } from "../shared/i18n/core";
import { canonicalFormat, planConversion } from "./conversion-plan";

/**
 * The `filee` block of the shared AutoRAG config — the same switches the agent's
 * `convert_files` tool honours, so one config governs both. `enabled: false`
 * turns conversion off everywhere.
 */
export interface FileeSettings {
	readonly enabled?: boolean;
	readonly binaryPath?: string;
	/** Download the pinned filee-cli on first use. Default true. */
	readonly autoInstall?: boolean;
	readonly timeoutMs?: number;
	/** Folder for Filee's own settings and engines (`FILEE_DATA_DIR`). */
	readonly dataDir?: string;
}

export interface ConversionServiceDeps {
	/** Read on every call, so a config edit applies to the next rename. */
	readonly settings: () => FileeSettings;
	/** Finds (or installs) the filee-cli binary and returns options that can spawn it. */
	readonly resolveOptions: (options: FileeCliOptions) => Promise<FileeCliOptions>;
	readonly convert: (request: FileeConvertRequest, options: FileeCliOptions) => Promise<FileeConvertResult>;
}

export interface ConversionService {
	plan(oldName: string, newName: string): Promise<ConversionPlan>;
	run(request: ConversionRequest): Promise<ConversionOutcome>;
	cancel(id: string): Promise<void>;
}

/** Prefix of the hidden folder a conversion writes into before the result takes its final name. */
const STAGING_PREFIX = ".dazzi-convert-";

/** The `filee` block of the AutoRAG config at `configPath`; an absent or unreadable file means the defaults. */
export function readFileeSettings(configPath: string): FileeSettings {
	let block: unknown;
	try {
		block = existsSync(configPath) ? readRawConfigObject(configPath).filee : undefined;
	} catch {
		return {};
	}
	if (typeof block !== "object" || block === null || Array.isArray(block)) return {};
	const record = block as Record<string, unknown>;
	return {
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(typeof record.binaryPath === "string" && record.binaryPath.length > 0 ? { binaryPath: record.binaryPath } : {}),
		...(typeof record.autoInstall === "boolean" ? { autoInstall: record.autoInstall } : {}),
		...(typeof record.timeoutMs === "number" && record.timeoutMs > 0 ? { timeoutMs: record.timeoutMs } : {}),
		...(typeof record.dataDir === "string" && record.dataDir.length > 0 ? { dataDir: record.dataDir } : {}),
	};
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export function createConversionService(deps: ConversionServiceDeps): ConversionService {
	const running = new Map<string, AbortController>();

	async function run(request: ConversionRequest): Promise<ConversionOutcome> {
		const { path, newName } = request;
		const name = basename(path);
		const plan = planConversion(name, newName);
		if (plan.kind !== "convert") throw new Error(t("main.convert.notConvertible", { name, extension: extname(newName) }));
		if (basename(newName) !== newName || newName === "." || newName === "..") {
			throw new Error(t("main.convert.invalidName", { name: newName }));
		}
		const info = await lstat(path).catch(() => null);
		if (info === null || !info.isFile()) throw new Error(t("main.convert.sourceMissing", { name }));

		const directory = dirname(path);
		const target = join(directory, newName);
		if (await exists(target)) throw new Error(t("main.convert.nameTaken", { name: newName }));
		// A hidden folder beside the source: the result is renamed out of it, which
		// never crosses a device, and a failed or cancelled run removes it whole.
		const staging = await mkdtemp(join(directory, STAGING_PREFIX));
		const controller = new AbortController();
		running.set(request.id, controller);
		try {
			const outputs = await convertInto(path, plan.to, staging, controller.signal, name);
			return await place(outputs, directory, newName);
		} finally {
			running.delete(request.id);
			await rm(staging, { recursive: true, force: true });
		}
	}

	async function convertInto(path: string, extension: string, staging: string, signal: AbortSignal, name: string): Promise<readonly string[]> {
		const settings = deps.settings();
		let result: FileeConvertResult;
		try {
			const options = await deps.resolveOptions({
				signal,
				...(settings.binaryPath === undefined ? {} : { executable: settings.binaryPath }),
				...(settings.autoInstall === false ? { autoInstall: false } : {}),
				...(settings.timeoutMs === undefined ? {} : { timeoutMs: settings.timeoutMs }),
				...(settings.dataDir === undefined ? {} : { dataDir: settings.dataDir }),
			});
			result = await deps.convert({ inputs: [path], to: canonicalFormat(extension), outputDir: staging }, options);
		} catch (error) {
			if (signal.aborted) throw new Error(t("main.convert.cancelled", { name }));
			throw new Error(t("main.convert.failed", { name, reason: error instanceof Error ? error.message : String(error) }));
		}
		const file = result.files[0];
		if (file === undefined || file.state !== "done") {
			throw new Error(t("main.convert.failed", { name, reason: file?.error ?? t("main.convert.unknownReason") }));
		}
		return file.outputs;
	}

	/** One file takes the new name; several (a page per image) go into a folder that takes it, without its extension. */
	async function place(outputs: readonly string[], directory: string, newName: string): Promise<ConversionOutcome> {
		const [only, ...rest] = outputs;
		if (only === undefined || !(await exists(only))) throw new Error(t("main.convert.noOutput", { name: newName }));
		if (rest.length === 0) {
			const target = join(directory, newName);
			if (await exists(target)) throw new Error(t("main.convert.nameTaken", { name: newName }));
			await rename(only, target);
			return { output: target, note: t("main.convert.done", { name: newName }) };
		}
		const folderName = basename(newName, extname(newName));
		const folder = join(directory, folderName);
		if (await exists(folder)) throw new Error(t("main.convert.nameTaken", { name: folderName }));
		await mkdir(folder);
		try {
			for (const output of outputs) await rename(output, join(folder, basename(output)));
		} catch (error) {
			await rm(folder, { recursive: true, force: true });
			throw error;
		}
		return { output: folder, note: t("main.convert.doneFolder", { name: folderName, count: outputs.length }) };
	}

	return {
		plan: async (oldName, newName) => (deps.settings().enabled === false ? { kind: "rename" } : planConversion(oldName, newName)),
		run,
		cancel: async (id) => {
			running.get(id)?.abort();
		},
	};
}

/** The service the app runs: the librarian's own Filee resolver and converter. */
export function createFileeConversionService(settings: () => FileeSettings): ConversionService {
	return createConversionService({
		settings,
		resolveOptions: (options) => resolveFileeOptions(options),
		convert: convertWithFilee,
	});
}
