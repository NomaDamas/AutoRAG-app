import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isJsonObject } from "../shared/settings-contract";

/**
 * The local embedding model's life cycle: `minsync serve` is MinSync's own loopback embedding server, and
 * it is the only thing in the app that holds the model weights. Everything that embeds (MinSync's own sync,
 * the librarian's memory, the chat sidecars, gist, discrawl, mailcrawl, lazykatok) finds it through the
 * discovery files it publishes under `<home>/.cache/minsync/serve/<instance>/`.
 *
 * The app starts it when the local model is in use and stops it when the app quits. It only ever stops a
 * server it started itself: either in this process, or in an earlier run that crashed and left its pid in
 * the owner file. A server somebody else runs (launchd, a terminal) is used but never stopped.
 */

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const HEALTH_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 150;
const STDERR_LIMIT = 4_000;
/** Loading ~1.2 GB of weights into memory takes a while on a cold disk. */
const DEFAULT_READY_TIMEOUT_MS = 10 * 60_000;
const STOP_TIMEOUT_MS = 15_000;

/** Pids of servers this process owns. The stall watchdog must not mistake their idling for a hang. */
const ownedPids: Record<number, true> = {};

export function isEmbeddingDaemonPid(pid: number): boolean {
	return ownedPids[pid] === true;
}

/**
 * The model the app must serve for this config, or null when nothing local is needed: keyword-only mode, or
 * an embedder that names an endpoint (a remote API, or a server the user runs such as Ollama), which is
 * theirs to run. A legacy `profile` field is ignored, as the librarian ignores it.
 */
export function localEmbeddingModel(raw: Record<string, unknown>): string | null {
	if (isJsonObject(raw.appIndexing) && raw.appIndexing.semanticSearch === false) return null;
	const embedder = isJsonObject(raw.minSync) ? raw.minSync.embedder : undefined;
	if (!isJsonObject(embedder)) return DEFAULT_LOCAL_EMBEDDING_MODEL;
	if (typeof embedder.baseUrl === "string" && embedder.baseUrl.length > 0) return null;
	const id = typeof embedder.id === "string" ? embedder.id : undefined;
	if (id === undefined) return DEFAULT_LOCAL_EMBEDDING_MODEL;
	if (id.startsWith("native:")) return id.slice("native:".length);
	return id.startsWith("openai:") || id.startsWith("tei:") ? null : DEFAULT_LOCAL_EMBEDDING_MODEL;
}

/** Where `minsync serve` publishes its `host`/`port`/`pid` per model instance. */
export function minSyncServeStateRoot(options: { readonly home: string; readonly platform: NodeJS.Platform; readonly env: NodeJS.ProcessEnv }): string {
	if (options.platform === "win32") return join(options.env.LOCALAPPDATA ?? join(options.home, "AppData", "Local"), "minsync", "serve");
	return join(options.home, ".cache", "minsync", "serve");
}

interface Served {
	readonly baseUrl: string;
	readonly dimension: number;
	readonly pid: number;
}

export type EmbeddingDaemonState =
	| { readonly state: "running"; readonly baseUrl: string; readonly dimension: number; readonly pid: number; readonly started: boolean }
	| { readonly state: "unavailable"; readonly reason: string };

export interface EmbeddingDaemon {
	/** The server for `model`, started when none answers. Never throws: a failure is a state. */
	ensure(model: string): Promise<EmbeddingDaemonState>;
	/** Stops the server this daemon owns, if any; a server someone else runs is left alone. */
	stop(): Promise<void>;
}

export interface EmbeddingDaemonOptions {
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
	/**
	 * Remembers the pid of the server this app started, so a later launch can stop it after a crash. Left out
	 * by a short-lived process (the scheduled refresh): it then owns only what it started itself.
	 */
	readonly ownerFile?: string;
	readonly readyTimeoutMs?: number;
	/**
	 * Whether the weights of `model` are on this computer. `minsync serve` downloads a missing model by itself
	 * with no way to report progress, so the app never starts it before the model is there: it is downloaded
	 * first, with progress (`model-download.ts`). Left out, every model counts as present.
	 */
	readonly modelPresent?: (model: string) => boolean;
}

export function createEmbeddingDaemon(options: EmbeddingDaemonOptions): EmbeddingDaemon {
	const stateRoot = minSyncServeStateRoot({ home: options.home, platform: process.platform, env: options.env });
	const pending = new Map<string, Promise<EmbeddingDaemonState>>();
	let owned: { readonly pid: number; readonly model: string } | undefined;

	const readText = (path: string): string | undefined => {
		try {
			return readFileSync(path, "utf8").trim();
		} catch {
			return undefined;
		}
	};

	/** A loopback server of exactly this model that answers `GET /health` now. Leftover files from a crashed server answer nothing. */
	const probe = async (model: string): Promise<Served | undefined> => {
		let instances: string[];
		try {
			instances = readdirSync(stateRoot);
		} catch {
			return undefined;
		}
		for (const instance of instances) {
			const port = Number(readText(join(stateRoot, instance, "port")));
			const host = readText(join(stateRoot, instance, "host")) ?? "127.0.0.1";
			if (!Number.isInteger(port) || port <= 0 || !LOOPBACK_HOSTS.has(host)) continue;
			const baseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
			try {
				const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
				if (!response.ok) continue;
				const health = (await response.json()) as { status?: string; model_id?: string; dimension?: number; pid?: number };
				if (health.status !== "ok" || health.model_id?.toLowerCase() !== model.toLowerCase()) continue;
				if (typeof health.dimension !== "number" || typeof health.pid !== "number") continue;
				return { baseUrl, dimension: health.dimension, pid: health.pid };
			} catch {
				// nothing listens there any more
			}
		}
		return undefined;
	};

	const recordOwner = (pid: number, model: string): void => {
		owned = { pid, model };
		ownedPids[pid] = true;
		if (options.ownerFile === undefined) return;
		mkdirSync(dirname(options.ownerFile), { recursive: true });
		writeFileSync(options.ownerFile, `${JSON.stringify({ pid, model })}\n`);
	};

	const forgetOwner = (): void => {
		if (owned !== undefined) delete ownedPids[owned.pid];
		owned = undefined;
		if (options.ownerFile !== undefined) rmSync(options.ownerFile, { force: true });
	};

	/** The server an earlier run of this app started: the owner file's pid must be the pid the live server reports. */
	const recordedOwner = async (): Promise<{ readonly pid: number; readonly model: string } | undefined> => {
		if (options.ownerFile === undefined) return undefined;
		try {
			const recorded: unknown = JSON.parse(readFileSync(options.ownerFile, "utf8"));
			if (!isJsonObject(recorded) || typeof recorded.pid !== "number" || typeof recorded.model !== "string") return undefined;
			const live = await probe(recorded.model);
			return live?.pid === recorded.pid ? { pid: recorded.pid, model: recorded.model } : undefined;
		} catch {
			return undefined;
		}
	};

	const stopOwned = async (): Promise<void> => {
		const target = owned ?? (await recordedOwner());
		if (target === undefined) return;
		try {
			process.kill(target.pid, "SIGTERM");
		} catch {
			// already gone
		}
		const deadline = Date.now() + STOP_TIMEOUT_MS;
		while (Date.now() < deadline && (await probe(target.model))?.pid === target.pid) {
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		if ((await probe(target.model))?.pid === target.pid) {
			try {
				process.kill(target.pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		forgetOwner();
	};

	const start = async (model: string): Promise<EmbeddingDaemonState> => {
		if (owned !== undefined && owned.model !== model) await stopOwned();
		const found = await probe(model);
		if (found !== undefined) {
			if (owned?.pid !== found.pid && (await recordedOwner())?.pid === found.pid) recordOwner(found.pid, model);
			return { state: "running", ...found, started: false };
		}
		// A server of another model from an earlier run is no use now and would hold ~2.8 GB.
		if (owned === undefined) await stopOwned();
		if (options.modelPresent?.(model) === false) return { state: "unavailable", reason: `the weights of ${model} are not downloaded yet` };

		const child = spawn("minsync", ["serve", "--format", "json", "--quiet", "--idle-timeout", "0", "--embedder", `native:${model}`], {
			env: { ...options.env },
			cwd: options.home,
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(-STDERR_LIMIT);
		});
		let spawnError: Error | undefined;
		let exitCode: number | null | undefined;
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("exit", (code) => {
			exitCode = code;
		});
		const detail = (): string => (stderr.trim().length > 0 ? `: ${stderr.trim()}` : "");

		const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (spawnError !== undefined) return { state: "unavailable", reason: `could not start \`minsync serve\`: ${spawnError.message}` };
			const ready = await probe(model);
			if (ready !== undefined) {
				child.stderr?.destroy();
				child.unref();
				// A second `minsync serve` that found a running server exits 0 and the server it found answers.
				if (exitCode === undefined) recordOwner(ready.pid, model);
				return { state: "running", ...ready, started: exitCode === undefined };
			}
			if (exitCode !== undefined) return { state: "unavailable", reason: `\`minsync serve\` exited with code ${exitCode} before it was ready${detail()}` };
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		}
		child.kill("SIGTERM");
		return { state: "unavailable", reason: `\`minsync serve\` was not ready within ${Math.round(timeoutMs / 1000)}s${detail()}` };
	};

	return {
		ensure: (model) => {
			const running = pending.get(model);
			if (running !== undefined) return running;
			const run = start(model).finally(() => pending.delete(model));
			pending.set(model, run);
			return run;
		},
		stop: stopOwned,
	};
}

/**
 * Brings the server in line with the config: started for the local model it names, stopped (when this app
 * started it) once the config no longer wants one, because keyword-only mode or an endpoint took over.
 * Returns the server state, or undefined when no local model is wanted.
 */
export async function followConfig(daemon: EmbeddingDaemon, raw: Record<string, unknown>): Promise<EmbeddingDaemonState | undefined> {
	const model = localEmbeddingModel(raw);
	if (model === null) {
		await daemon.stop();
		return undefined;
	}
	return daemon.ensure(model);
}

let shared: EmbeddingDaemon | undefined;
let modelCheck: EmbeddingDaemonOptions["modelPresent"];
let reportedProblem: string | undefined;

/**
 * Makes this process manage the embedding server.
 * A process that never calls this (a test, a one-shot CLI) manages nothing.
 */
export function configureEmbeddingDaemon(options: EmbeddingDaemonOptions): void {
	shared = createEmbeddingDaemon(options);
	modelCheck = options.modelPresent;
	reportedProblem = undefined;
}

/**
 * True when this process manages the server, the config wants a local model, and that model's weights are not
 * downloaded: nothing can embed until they are. Anything else (a remote embedder, keyword-only mode, a server
 * that failed for another reason) is false, because only a missing download is the user's to fix in the app.
 */
export function localModelMissing(raw: Record<string, unknown>): boolean {
	const model = localEmbeddingModel(raw);
	return shared !== undefined && model !== null && modelCheck?.(model) === false;
}

/**
 * Call before anything that embeds. Makes the server match the raw config (see {@link followConfig}) and
 * never throws: a server that cannot start is logged once and semantic work degrades as it already does.
 */
export async function ensureEmbeddingForConfig(raw: Record<string, unknown>): Promise<void> {
	if (shared === undefined) return;
	const state = await followConfig(shared, raw);
	if (state?.state !== "unavailable") {
		reportedProblem = undefined;
		return;
	}
	if (state.reason !== reportedProblem) console.warn(`[embedding] the local embedding server is unavailable: ${state.reason}`);
	reportedProblem = state.reason;
}

/** Stops the server this process started. Call on quit. */
export async function stopEmbeddingDaemon(): Promise<void> {
	await shared?.stop();
}

/**
 * The local server for `model`, started when it is not running. In a process that never called
 * {@link configureEmbeddingDaemon} nothing may be started, so it is unavailable.
 */
export async function localEmbeddingServer(model: string): Promise<EmbeddingDaemonState> {
	if (shared === undefined) return { state: "unavailable", reason: "this process does not manage the embedding server" };
	return shared.ensure(model);
}
