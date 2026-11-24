import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import { APP_NAME } from "../shared/app-info";
import toolPins from "../shared/tool-pins.json";
import {
	compareSemver,
	type EmbeddingDaemonVersionInfo,
	type ManifestDriftEntry,
	type RestartDaemonResponse,
	type ToolComponentVersion,
	type ToolVersionsSnapshot,
} from "../shared/tool-versions-contract";
import { bundledToolsRoot, pathKey } from "./bundled-tools";
import {
	DEFAULT_LOCAL_EMBEDDING_MODEL,
	type EmbeddingDaemonRestartResult,
	type EmbeddingDaemonStatus,
} from "./embedding-daemon";

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 2_500;
const SEMVER_PATTERN = /\b(\d+\.\d+\.\d+)\b/u;

export interface BundledManifestTool {
	readonly name: string;
	readonly version: string;
}

export interface BundledManifest {
	readonly schema?: number;
	readonly platform?: string;
	readonly librarianRef?: string;
	readonly daemon?: {
		readonly owner?: string;
		readonly engine?: string;
		readonly engineVersion?: string;
	};
	readonly tools?: readonly BundledManifestTool[];
}

export interface ExternalToolProbe {
	readonly pathLocation: string | null;
	readonly pathVersion: string | null;
}

export interface ToolVersionsServiceDeps {
	readonly appVersion: string;
	readonly librarianVersion: string;
	readonly resourcesPath: string;
	readonly env: NodeJS.ProcessEnv;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	readonly getModel?: () => Promise<string>;
	readonly daemonStatus: (model: string) => Promise<EmbeddingDaemonStatus>;
	readonly restartDaemon: (model: string) => Promise<EmbeddingDaemonRestartResult>;
	/** Injectable PATH binary prober for deterministic unit tests. */
	readonly probeExternal?: (binary: string, excludeDir: string | null) => Promise<ExternalToolProbe>;
}

export interface ToolVersionsService {
	get(): Promise<ToolVersionsSnapshot>;
	restartDaemon(): Promise<RestartDaemonResponse>;
}

/** Read `tools/manifest.json` from `<resources>/tools` (or `AUTORAG_TOOLS_DIR`), if present. */
export function readBundledManifest(toolsRoot: string | null): BundledManifest | null {
	if (toolsRoot === null) return null;
	const manifestPath = join(toolsRoot, "manifest.json");
	if (!existsSync(manifestPath)) return null;
	try {
		return JSON.parse(readFileSync(manifestPath, "utf8")) as BundledManifest;
	} catch {
		return null;
	}
}

/** Compare `tools/manifest.json` against `src/shared/tool-pins.json` for the manifest's platform. */
export function findManifestDrift(manifest: BundledManifest | null, platformId: string): readonly ManifestDriftEntry[] {
	if (manifest === null || !Array.isArray(manifest.tools)) return [];
	const byName = new Map(manifest.tools.map((entry) => [entry.name, entry.version]));
	const drift: ManifestDriftEntry[] = [];
	const check = (name: string, pinned: string): void => {
		const actual = byName.get(name) ?? null;
		if (actual !== pinned) drift.push({ name, pinned, manifest: actual });
	};
	check("node", toolPins.node.version);
	check("autorag", toolPins.librarian.version);
	for (const [name, entry] of Object.entries(toolPins.tools)) {
		const platforms = "platforms" in entry ? (entry.platforms as readonly string[] | undefined) : undefined;
		if (platforms !== undefined && !platforms.includes(platformId)) continue;
		check(name, entry.version);
	}
	return drift;
}

/** Find a binary on `env.PATH` outside `excludeDir` (so we detect user-installed copies, never the bundled one). */
export function findBinaryOnPath(
	binary: string,
	env: NodeJS.ProcessEnv,
	excludeDir: string | null,
	platform: NodeJS.Platform = process.platform,
): string | null {
	const key = pathKey(env, platform);
	const raw = env[key] ?? "";
	const delimiter = platform === "win32" ? win32.delimiter : posix.delimiter;
	const normalize = (dir: string): string => {
		const resolved = resolve(dir);
		return platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const excluded = excludeDir !== null ? normalize(excludeDir) : null;
	const candidates = platform === "win32" ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];

	for (const entry of raw.split(delimiter)) {
		if (entry.length === 0) continue;
		if (excluded !== null && normalize(entry) === excluded) continue;
		for (const candidate of candidates) {
			const full = join(entry, candidate);
			try {
				if (statSync(full).isFile()) return full;
			} catch {
				// not present here
			}
		}
	}
	return null;
}

/** Walk up from a resolved npm binary to read its package.json version (used for CLIs without `--version`, like `mailcrawl`). */
function readPackageVersionNear(binaryPath: string, packageName: string): string | null {
	let current: string;
	try {
		current = dirname(realpathSync(binaryPath));
	} catch {
		current = dirname(binaryPath);
	}
	for (let depth = 0; depth < 5; depth += 1) {
		const pkgPath = join(current, "package.json");
		if (existsSync(pkgPath)) {
			try {
				const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; version?: string };
				if (parsed.name === packageName && typeof parsed.version === "string") return parsed.version;
			} catch {
				// keep walking
			}
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

async function defaultProbeExternal(
	binary: string,
	excludeDir: string | null,
	env: NodeJS.ProcessEnv,
	platform: NodeJS.Platform,
): Promise<ExternalToolProbe> {
	const pathLocation = findBinaryOnPath(binary, env, excludeDir, platform);
	if (pathLocation === null) return { pathLocation: null, pathVersion: null };

	if (binary === "mailcrawl") {
		const fromPkg = readPackageVersionNear(pathLocation, "@nomadamas/mailcrawl");
		if (fromPkg !== null) return { pathLocation, pathVersion: fromPkg };
	}

	try {
		const { stdout, stderr } = await execFileAsync(pathLocation, ["--version"], {
			timeout: PROBE_TIMEOUT_MS,
			windowsHide: true,
			env,
		});
		const match = SEMVER_PATTERN.exec(`${stdout}\n${stderr}`);
		return { pathLocation, pathVersion: match?.[1] ?? null };
	} catch {
		return { pathLocation, pathVersion: null };
	}
}

export function createToolVersionsService(deps: ToolVersionsServiceDeps): ToolVersionsService {
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const platformId = `${platform}-${arch}`;

	const probeExternal = (binary: string, excludeDir: string | null): Promise<ExternalToolProbe> =>
		deps.probeExternal ? deps.probeExternal(binary, excludeDir) : defaultProbeExternal(binary, excludeDir, deps.env, platform);

	const activeModel = async (): Promise<string> => (deps.getModel ? deps.getModel() : DEFAULT_LOCAL_EMBEDDING_MODEL);

	const get = async (): Promise<ToolVersionsSnapshot> => {
		const toolsRoot = bundledToolsRoot({ resourcesPath: deps.resourcesPath, env: deps.env });
		const bundledBinDir = toolsRoot !== null ? join(toolsRoot, "bin") : null;
		const manifest = readBundledManifest(toolsRoot);
		const manifestByName = new Map((manifest?.tools ?? []).map((entry) => [entry.name, entry.version]));
		const manifestDrift = findManifestDrift(manifest, platformId);
		const driftSet = new Set(manifestDrift.map((entry) => entry.name));

		const model = await activeModel();
		const [daemonState, minsyncExt, inlExt, mailcrawlExt, lazykatokExt] = await Promise.all([
			deps.daemonStatus(model),
			probeExternal("minsync", bundledBinDir),
			probeExternal("inl", bundledBinDir),
			probeExternal("mailcrawl", bundledBinDir),
			platform === "darwin" ? probeExternal("lazykatok", bundledBinDir) : Promise.resolve({ pathLocation: null, pathVersion: null }),
		]);

		const pinnedEngine = toolPins.daemon.engineVersion;
		const running = daemonState.state === "running";
		const daemonVersion = running ? daemonState.version : null;
		const outdated = running && daemonVersion !== null && compareSemver(daemonVersion, pinnedEngine) < 0;
		const daemon: EmbeddingDaemonVersionInfo = {
			owner: manifest?.daemon?.owner ?? toolPins.daemon.owner,
			engine: manifest?.daemon?.engine ?? toolPins.daemon.engine,
			pinnedVersion: pinnedEngine,
			running,
			version: daemonVersion,
			instance: running ? daemonState.instance : null,
			port: running ? daemonState.port : null,
			pid: running ? daemonState.pid : null,
			owned: running ? daemonState.owned : false,
			outdated,
			canRestart: outdated && running && daemonState.owned,
		};

		const bundledMinsync = manifestByName.get("minsync") ?? null;
		const bundledMailcrawl = manifestByName.get("@nomadamas/mailcrawl") ?? null;
		const bundledLazykatok = manifestByName.get("lazykatok") ?? null;
		const bundledLibrarian = manifestByName.get("autorag") ?? deps.librarianVersion;

		const hasPathMismatch = (pathVersion: string | null, expected: string): boolean =>
			pathVersion !== null && compareSemver(pathVersion, expected) !== 0;

		const components: ToolComponentVersion[] = [
			{
				id: "app",
				name: APP_NAME,
				pinned: deps.appVersion,
				bundled: deps.appVersion,
				pathVersion: null,
				pathLocation: null,
				pathMismatch: false,
				manifestMismatch: false,
			},
			{
				id: "librarian",
				name: "@autorag/librarian",
				pinned: toolPins.librarian.version,
				bundled: bundledLibrarian,
				pathVersion: null,
				pathLocation: null,
				pathMismatch: false,
				manifestMismatch: driftSet.has("autorag"),
			},
			{
				id: "minsync",
				name: "minsync",
				pinned: toolPins.tools.minsync.version,
				bundled: bundledMinsync,
				pathVersion: minsyncExt.pathVersion,
				pathLocation: minsyncExt.pathLocation,
				pathMismatch: hasPathMismatch(minsyncExt.pathVersion, bundledMinsync ?? toolPins.tools.minsync.version),
				manifestMismatch: driftSet.has("minsync"),
			},
			{
				id: "inl",
				name: "inl",
				pinned: pinnedEngine,
				bundled: manifest?.daemon?.engineVersion ?? (manifest !== null ? pinnedEngine : null),
				pathVersion: inlExt.pathVersion,
				pathLocation: inlExt.pathLocation,
				pathMismatch: hasPathMismatch(inlExt.pathVersion, pinnedEngine),
				manifestMismatch: false,
			},
			{
				id: "mailcrawl",
				name: "mailcrawl",
				pinned: toolPins.tools["@nomadamas/mailcrawl"].version,
				bundled: bundledMailcrawl,
				pathVersion: mailcrawlExt.pathVersion,
				pathLocation: mailcrawlExt.pathLocation,
				pathMismatch: hasPathMismatch(mailcrawlExt.pathVersion, bundledMailcrawl ?? toolPins.tools["@nomadamas/mailcrawl"].version),
				manifestMismatch: driftSet.has("@nomadamas/mailcrawl"),
			},
		];

		if (platform === "darwin") {
			components.push({
				id: "lazykatok",
				name: "lazykatok",
				pinned: toolPins.tools.lazykatok.version,
				bundled: bundledLazykatok,
				pathVersion: lazykatokExt.pathVersion,
				pathLocation: lazykatokExt.pathLocation,
				pathMismatch: hasPathMismatch(lazykatokExt.pathVersion, bundledLazykatok ?? toolPins.tools.lazykatok.version),
				manifestMismatch: driftSet.has("lazykatok"),
			});
		}

		return {
			appVersion: deps.appVersion,
			librarianRef: toolPins.librarian.ref,
			manifestPresent: manifest !== null,
			manifestDrift,
			daemon,
			components,
		};
	};

	const restartDaemon = async (): Promise<RestartDaemonResponse> => {
		const model = await activeModel();
		const result = await deps.restartDaemon(model);
		const snapshot = await get();
		if (!result.ok) {
			return { ok: false, reason: result.reason, message: result.message, snapshot };
		}
		return { ok: true, snapshot };
	};

	return { get, restartDaemon };
}
