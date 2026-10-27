import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ErrorFixChange } from "../../../shared/error-fix-contract";
import type { AutoRagConfigUpdate, JsonValue } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { isSecretKey, type AutoRagConfigService } from "../../autorag-config-service";

/**
 * The error-fix agent's hands: pi's own `read`, `ls`, `find`, `grep`, `edit`, `write` and `bash`,
 * with the few rules that keep a repair from becoming damage.
 *
 * What the agent may see: any file, except the AI's own sign-in and key files (the agent dir) and
 * files named like a key or a credential. The config file is shown with its secrets hidden.
 *
 * What the agent may change with `edit`/`write`: the shared AutoRAG config (through the same
 * validating service the Settings pages use, after a dated copy, never the model, a secret or the
 * folders AutoRAG manages), the files the config's data sources name, and the app's workspace folder.
 * Anything else, such as the person's own documents, is refused.
 *
 * `bash` is pi's shell as it is. It cannot be fenced to those places: the rules above bind the file
 * tools, and the shell only gets an environment without keys and tokens and a refusal to name the
 * AI's own credential files. Every tool refuses once the run was stopped.
 */

/** What the agent sees in place of a secret, and may write back to leave it as it is. */
const REDACTED = "__AUTORAG_SECRET_REDACTED__";
const MAX_VALUE_CHARS = 300;
const LOOKS_LIKE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])[^\n]{0,1000}$/u;
/** Files that are keys or credentials by their name, wherever they lie. */
const CREDENTIAL_NAME = /^(?:\.env(?:\..*)?|id_[a-z0-9]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain-db)|auth\.json|credentials(?:\..*)?|\.netrc|\.npmrc|\.pypirc)$/iu;
/** How many looks (read, ls, find, grep, a shell command) the agent gets in one run: enough to follow a moved folder and to read a log or two, not to comb the machine for one that is gone. */
const MAX_LOOKS = 12;

export interface FixToolsDeps {
	readonly cwd: string;
	/** pi's agent dir: the AI's own sign-in and key files. Never opened. */
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** The shared AutoRAG config as the Settings pages edit it: redacted reads, validated writes. */
	readonly config: Pick<AutoRagConfigService, "get" | "patch">;
	readonly now?: () => Date;
	/** True once the run was stopped; every tool then refuses. */
	readonly cancelled: () => boolean;
	/** Called for each thing a write changed. */
	readonly onChange: (change: ErrorFixChange) => void;
	/** Called with each shell command, as the agent wrote it, just before it runs. */
	readonly onCommand: (command: string) => void;
}

export interface FixTools {
	readonly tools: readonly ToolDefinition[];
	/** The copy of the config taken before the first change, or null. */
	backupPath(): string | null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Compact JSON for the change log; long values are cut. */
function show(value: unknown): string | null {
	if (value === undefined) return null;
	const json = JSON.stringify(value);
	return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : json;
}

/** Stamp for the backup name: `20261026101112`, the shape the person's own `config.json.bak-…` files carry. */
function stamp(date: Date): string {
	return date.toISOString().replace(/\.\d+Z$/u, "").replace(/[-:T]/gu, "");
}

function expand(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** The real place a path leads to; for a path that does not exist yet, its closest existing folder's real place plus the rest. */
async function realish(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(await realish(parent), basename(path));
	}
}

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function valueAt(root: unknown, path: readonly string[]): unknown {
	return path.reduce<unknown>((current, segment) => (isJsonObject(current) ? current[segment] : undefined), root);
}

/** The leaf changes that turn `before` into `after`: objects are walked, anything else (a list too) is set whole. */
function diff(before: unknown, after: unknown, path: readonly string[], out: AutoRagConfigUpdate[]): void {
	if (isJsonObject(before) && isJsonObject(after)) {
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (!(key in after)) out.push({ path: [...path, key], remove: true });
			else if (!(key in before)) out.push({ path: [...path, key], value: after[key] as JsonValue });
			else diff(before[key], after[key], [...path, key], out);
		}
		return;
	}
	if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, value: after as JsonValue });
}

/** Why an update may not be made, or null. The validating service still checks the value itself. */
function refusal(update: AutoRagConfigUpdate): string | null {
	if (update.path[0] === "model") return "the AI model is the person's choice (Settings > AI); do not change it";
	const secret = update.path.find((segment) => isSecretKey(segment));
	if (secret !== undefined) return `"${secret}" holds a secret; keys and tokens are never edited here`;
	return null;
}

/** A config file that is not valid JSON, seen with the values of its secret keys hidden. */
function maskedText(raw: string): string {
	return raw.replace(/("(?:[^"\\]|\\.)*")(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/gu, (whole, key: string, colon: string) => {
		const name = key.slice(1, -1);
		return isSecretKey(name) ? `${key}${colon}"${REDACTED}"` : whole;
	});
}

/** Every string under `value` that names a place on disk. */
function pathsIn(value: unknown, found: string[]): void {
	if (typeof value === "string") {
		if (LOOKS_LIKE_PATH.test(value)) found.push(expand(value));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) pathsIn(item, found);
		return;
	}
	if (isJsonObject(value)) for (const child of Object.values(value)) pathsIn(child, found);
}

export function createFixTools(deps: FixToolsDeps): FixTools {
	const now = deps.now ?? (() => new Date());
	let configBackup: string | null = null;
	/** Files other than the config that were copied aside in this run, so each is copied once. */
	const copied = new Set<string>();
	/** How many looks (read, ls, find, grep, shell command) the agent has used. */
	let looks = 0;

	function running(): void {
		if (deps.cancelled()) throw new Error("The run was cancelled; nothing more can be read or changed.");
	}

	const agentDirReal = realish(resolve(deps.agentDir));

	async function denyRead(path: string): Promise<void> {
		running();
		const real = await realish(path);
		if (inside(real, await agentDirReal) || CREDENTIAL_NAME.test(basename(real)) || CREDENTIAL_NAME.test(basename(path))) {
			throw new Error(`Refused: ${path} is the AI's own sign-in or a key file; it is never opened.`);
		}
	}

	/** The path as the tools resolve it: relative to the working folder, `~` the home folder. */
	function absolute(path: string): string {
		const expanded = expand(path);
		return isAbsolute(expanded) ? expanded : resolve(deps.cwd, expanded);
	}

	async function configPath(): Promise<string> {
		return (await deps.config.get()).configPath;
	}

	async function isConfig(path: string): Promise<boolean> {
		return (await realish(path)) === (await realish(await configPath()));
	}

	/** The config as the agent sees it: the file with every secret hidden. */
	async function configView(): Promise<string> {
		const path = await configPath();
		const raw = await readFile(path, "utf8");
		try {
			JSON.parse(raw);
		} catch {
			return maskedText(raw);
		}
		return `${JSON.stringify((await deps.config.get()).config, null, 2)}\n`;
	}

	async function readOf(path: string): Promise<Buffer> {
		await denyRead(path);
		return (await isConfig(path)) ? Buffer.from(await configView()) : readFile(path);
	}

	/** Which kind of place a write to `path` is, or why it is refused. */
	async function writeKind(path: string): Promise<"config" | "file" | "workspace"> {
		running();
		if (await isConfig(path)) return "config";
		const snapshot = await deps.config.get();
		const real = await realish(path);
		const named: string[] = [];
		pathsIn(snapshot.config.datasources, named);
		for (const candidate of named) {
			const entry = await lstat(candidate).catch(() => null);
			if (entry !== null && entry.isFile() && !entry.isSymbolicLink() && (await realish(candidate)) === real) return "file";
		}
		const workspace = snapshot.config.workspacePath;
		if (typeof workspace === "string" && inside(real, await realish(expand(workspace)))) return "workspace";
		throw new Error(`Refused: ${path} is not a place you may change. You may change the AutoRAG config, the files its data sources name and the app's workspace folder; the person's own files are theirs.`);
	}

	/** Copies the config aside once per run, before the first write; returns whether this call made the copy. */
	async function backupConfigOnce(path: string): Promise<boolean> {
		if (configBackup !== null) return false;
		const target = `${path}.bak-${stamp(now())}-before-error-fix`;
		try {
			await copyFile(path, target);
		} catch {
			// No config file yet: there is nothing to lose.
			return false;
		}
		configBackup = target;
		return true;
	}

	async function writeConfig(path: string, content: string): Promise<void> {
		let current: unknown;
		try {
			current = JSON.parse(await readFile(path, "utf8"));
		} catch {
			throw new Error("Refused: the config file is not valid JSON, and what you saw of it hides its secrets, so it cannot be rewritten from that. It has to be restored in a shell, for example from a config.json.bak-… copy next to it.");
		}
		let next: unknown;
		try {
			next = JSON.parse(content);
		} catch (error) {
			throw new Error(`Refused: the new config is not valid JSON (${errorText(error)}).`);
		}
		if (!isJsonObject(next) || !isJsonObject(current)) throw new Error("Refused: the config must be one JSON object.");
		const snapshot = await deps.config.get();
		const updates: AutoRagConfigUpdate[] = [];
		diff(snapshot.config, next, [], updates);
		if (updates.length === 0) return;
		for (const update of updates) {
			const why = refusal(update);
			if (why !== null) throw new Error(`Refused ${update.path.join(".")}: ${why}.`);
		}
		const madeCopy = await backupConfigOnce(path);
		try {
			await deps.config.patch(updates);
		} catch (error) {
			// A rejected change leaves nothing behind, the copy made for it included.
			if (madeCopy && configBackup !== null) {
				await rm(configBackup, { force: true });
				configBackup = null;
			}
			throw new Error(`Refused: ${errorText(error)}`);
		}
		for (const update of updates) {
			deps.onChange({ path: update.path.join("."), before: show(valueAt(snapshot.config, update.path)), after: "remove" in update ? null : show(update.value) });
		}
	}

	async function writeOther(path: string, content: string): Promise<void> {
		const before = await stat(path).then((entry) => entry.size, () => null);
		let backup: string | undefined;
		if (before !== null && !copied.has(path)) {
			backup = `${path}.bak-${stamp(now())}-before-error-fix`;
			await copyFile(path, backup);
			copied.add(path);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
		deps.onChange({ path, before: before === null ? null : `${before} bytes`, after: `${Buffer.byteLength(content)} bytes`, ...(backup === undefined ? {} : { backup }) });
	}

	async function writeOf(path: string, content: string): Promise<void> {
		const kind = await writeKind(path);
		if (kind === "config") await writeConfig(await configPath(), content);
		else await writeOther(path, content);
	}

	const readOps = {
		access: async (path: string) => {
			await denyRead(path);
			await access(path, constants.R_OK);
		},
		readFile: readOf,
	};

	const editOps = {
		readFile: readOf,
		writeFile: writeOf,
		access: async (path: string) => {
			await denyRead(path);
			await access(path, constants.R_OK);
			// Refused here, before the edit is worked out, rather than at the write.
			await writeKind(path);
		},
	};

	const writeOps = {
		writeFile: writeOf,
		mkdir: async (dir: string) => {
			if (await stat(dir).then((entry) => entry.isDirectory(), () => false)) return;
			// A folder that does not exist is made only where a file could be written.
			await writeKind(join(dir, "new-file"));
			await mkdir(dir, { recursive: true });
		},
	};

	const lsOps = {
		exists: async (path: string) => {
			await denyRead(path);
			return access(path).then(() => true, () => false);
		},
		stat: async (path: string) => {
			await denyRead(path);
			return stat(path);
		},
		readdir: async (path: string) => {
			await denyRead(path);
			return readdir(path);
		},
	};

	/**
	 * The tool as pi built it, but it refuses when the run was stopped and first looks at what `check` makes of its arguments.
	 * A `look` (read, ls, find, grep, a shell command) is one of a bounded number: past it the agent is told to report. A call the
	 * tools themselves refuse is not a look, and a change (edit, write) never is.
	 */
	// biome-ignore lint/suspicious/noExplicitAny: the wrapper only forwards the tool's own typed arguments.
	function guarded<T extends ToolDefinition<any, any, any>>(tool: T, check: (params: Record<string, unknown>) => Promise<void> | void, look = false): T {
		const inner = tool.execute as (...args: unknown[]) => Promise<unknown>;
		return {
			...tool,
			execute: async (...args: unknown[]) => {
				running();
				await check((args[1] ?? {}) as Record<string, unknown>);
				if (!look) return inner(...args);
				if (looks >= MAX_LOOKS) {
					throw new Error(`Refused: you have looked ${MAX_LOOKS} times already. Do not keep searching for it: report with report_result what you found and, where the person has to act, give them a button. Changing a file is still allowed.`);
				}
				looks += 1;
				try {
					return await inner(...args);
				} catch (error) {
					if (error instanceof Error && error.message.startsWith("Refused:")) looks -= 1;
					throw error;
				}
			},
		} as unknown as T;
	}

	const pathArgument = (params: Record<string, unknown>): string => (typeof params.path === "string" && params.path !== "" ? absolute(params.path) : deps.cwd);

	const secretEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([key]) => !isSecretKey(key)));

	const bash = createBashToolDefinition(deps.cwd, {
		spawnHook: (context) => ({ ...context, env: secretEnv({ ...context.env, ...deps.env }) }),
	});

	const tools = [
		guarded(createReadToolDefinition(deps.cwd, { operations: readOps }), () => undefined, true),
		guarded(createLsToolDefinition(deps.cwd, { operations: lsOps }), () => undefined, true),
		guarded(createFindToolDefinition(deps.cwd), (params) => denyRead(pathArgument(params)), true),
		guarded(createGrepToolDefinition(deps.cwd), (params) => denyRead(pathArgument(params)), true),
		createEditToolDefinition(deps.cwd, { operations: editOps }),
		createWriteToolDefinition(deps.cwd, { operations: writeOps }),
		guarded(
			bash,
			async (params) => {
				const command = typeof params.command === "string" ? params.command : "";
				const real = await agentDirReal;
				if (command.includes(real) || command.includes(resolve(deps.agentDir)) || /\b(?:auth|models)\.json\b/u.test(command)) {
					throw new Error("Refused: the AI's own sign-in and key files are off limits, also in a shell.");
				}
				deps.onCommand(command);
			},
			true,
		),
	] as unknown as ToolDefinition[];

	return { tools, backupPath: () => configBackup };
}
