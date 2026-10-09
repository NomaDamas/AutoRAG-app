import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RefreshScheduleStatus } from "../shared/settings-contract";
import { readSchedulePlan, readScheduleState, schedulePaths, wakeIntervalMs } from "./refresh-schedule";

export const LAUNCHD_LABEL = "com.autorag.app.refresh";
export const WINDOWS_TASK_NAME = "AutoRAGAppRefresh";
/** Marks the crontab line this app owns, so it can be replaced or removed without touching the user's own lines. */
export const CRON_MARKER = "# autorag-app-refresh";

export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type CommandRunner = (command: string, args: readonly string[], input?: string) => Promise<CommandResult>;

export function runCommand(command: string, args: readonly string[], input?: string): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = execFile(command, [...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") });
		});
		if (input !== undefined) child.stdin?.end(input);
	});
}

export interface RefreshSchedulerDeps {
	readonly platform: NodeJS.Platform;
	readonly home?: string;
	readonly uid?: number;
	/** The runtime that runs the job: the app's own Electron binary, started in plain-Node mode. */
	readonly execPath: string;
	/** The built `refresh-job.js`. */
	readonly jobPath: string;
	readonly configPath: () => string;
	readonly env?: NodeJS.ProcessEnv;
	readonly run?: CommandRunner;
}

export interface RefreshScheduler {
	status(): Promise<RefreshScheduleStatus>;
	/** Make the OS job match the config: install/update it when something is wanted, remove it when nothing is. */
	reconcile(): Promise<RefreshScheduleStatus>;
	/** Remove the OS job regardless of config. */
	remove(): Promise<RefreshScheduleStatus>;
}

function mechanismFor(platform: NodeJS.Platform): RefreshScheduleStatus["mechanism"] {
	if (platform === "darwin") return "launchd";
	if (platform === "linux") return "cron";
	if (platform === "win32") return "schtasks";
	return null;
}

function xmlEscape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** PATH the job needs to find the datasource CLIs (discrawl, rclone, ...) that launchd's minimal PATH would hide. */
export function jobPath(home: string, current: string | undefined): string {
	const base = [join(home, ".cargo", "bin"), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	const extra = (current ?? "").split(":").filter((entry) => entry.length > 0 && !base.includes(entry));
	return [...base, ...extra].join(":");
}

export function buildLaunchdPlist(input: {
	readonly execPath: string;
	readonly jobPath: string;
	readonly intervalSeconds: number;
	readonly logPath: string;
	readonly home: string;
	readonly path: string;
	readonly configPath: string | undefined;
}): string {
	const environment = [
		["ELECTRON_RUN_AS_NODE", "1"],
		["HOME", input.home],
		["PATH", input.path],
		...(input.configPath === undefined ? [] : [["AUTORAG_CONFIG", input.configPath]]),
	]
		.map(([key, value]) => `\t\t<key>${xmlEscape(key as string)}</key>\n\t\t<string>${xmlEscape(value as string)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xmlEscape(input.execPath)}</string>
		<string>${xmlEscape(input.jobPath)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${environment}
	</dict>
	<key>StartInterval</key>
	<integer>${input.intervalSeconds}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${xmlEscape(input.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

export function buildCronLine(input: { readonly execPath: string; readonly jobPath: string; readonly intervalMinutes: number; readonly logPath: string; readonly path: string; readonly configPath: string | undefined }): string {
	const minutes = Math.max(1, Math.min(30, Math.floor(input.intervalMinutes)));
	const config = input.configPath === undefined ? "" : ` AUTORAG_CONFIG=${shellQuote(input.configPath)}`;
	return `*/${minutes} * * * * PATH=${shellQuote(input.path)} ELECTRON_RUN_AS_NODE=1${config} ${shellQuote(input.execPath)} ${shellQuote(input.jobPath)} >> ${shellQuote(input.logPath)} 2>&1 ${CRON_MARKER}`;
}

/** Drop every line this app owns from a crontab, keeping the rest byte-for-byte. */
export function stripOwnedCronLines(crontab: string): string {
	return crontab
		.split("\n")
		.filter((line) => !line.includes(CRON_MARKER))
		.join("\n");
}

/** Lines of a crontab that refresh AutoRAG by other means (not ours). */
export function foreignCronLines(crontab: string): string[] {
	return crontab
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#") && !line.includes(CRON_MARKER) && /autorag/i.test(line))
		.map((line) => (line.length > 160 ? `${line.slice(0, 157)}...` : line));
}

export function createRefreshScheduler(deps: RefreshSchedulerDeps): RefreshScheduler {
	const run = deps.run ?? runCommand;
	const home = deps.home ?? homedir();
	const env = deps.env ?? process.env;
	const mechanism = mechanismFor(deps.platform);
	const plistPath = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
	const uid = deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0);
	const domain = `gui/${uid}`;

	const explicitConfig = (): string | undefined => (typeof env.AUTORAG_CONFIG === "string" && env.AUTORAG_CONFIG.length > 0 ? env.AUTORAG_CONFIG : undefined);

	const readCrontab = async (): Promise<string> => {
		const result = await run("crontab", ["-l"]);
		// "no crontab for user" exits non-zero and means an empty table, not a failure.
		return result.code === 0 ? result.stdout : "";
	};

	const isInstalled = async (): Promise<boolean> => {
		if (mechanism === "launchd") {
			if (!existsSync(plistPath)) return false;
			return (await run("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`])).code === 0;
		}
		if (mechanism === "cron") return (await readCrontab()).includes(CRON_MARKER);
		if (mechanism === "schtasks") return (await run("schtasks", ["/Query", "/TN", WINDOWS_TASK_NAME])).code === 0;
		return false;
	};

	const conflicts = async (): Promise<string[]> => {
		const found: string[] = [];
		if (mechanism === "launchd") {
			const directory = join(home, "Library", "LaunchAgents");
			try {
				for (const name of readdirSync(directory)) {
					if (!name.endsWith(".plist") || name === `${LAUNCHD_LABEL}.plist` || !/autorag/i.test(name)) continue;
					found.push(`launchd: ${name}`);
				}
			} catch {
				// no LaunchAgents directory
			}
		}
		if (mechanism === "launchd" || mechanism === "cron") {
			for (const line of foreignCronLines(await readCrontab())) found.push(`cron: ${line}`);
		}
		return found;
	};

	const install = async (intervalMs: number): Promise<void> => {
		const paths = schedulePaths(deps.configPath());
		mkdirSync(paths.dir, { recursive: true });
		const path = jobPath(home, env.PATH);
		if (mechanism === "launchd") {
			mkdirSync(dirname(plistPath), { recursive: true });
			writeFileSync(
				plistPath,
				buildLaunchdPlist({
					execPath: deps.execPath,
					jobPath: deps.jobPath,
					intervalSeconds: Math.max(60, Math.round(intervalMs / 1000)),
					logPath: paths.log,
					home,
					path,
					configPath: explicitConfig(),
				}),
			);
			// bootout first so a changed interval takes effect; "not loaded" on a first install is expected.
			await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
			const result = await run("launchctl", ["bootstrap", domain, plistPath]);
			if (result.code !== 0) throw new Error(`launchctl bootstrap failed: ${result.stderr.trim() || `exit ${result.code}`}`);
			return;
		}
		if (mechanism === "cron") {
			const line = buildCronLine({
				execPath: deps.execPath,
				jobPath: deps.jobPath,
				intervalMinutes: Math.round(intervalMs / 60_000),
				logPath: paths.log,
				path,
				configPath: explicitConfig(),
			});
			const kept = stripOwnedCronLines(await readCrontab()).replace(/\n+$/, "");
			const result = await run("crontab", ["-"], `${kept.length > 0 ? `${kept}\n` : ""}${line}\n`);
			if (result.code !== 0) throw new Error(`crontab failed: ${result.stderr.trim() || `exit ${result.code}`}`);
			return;
		}
		if (mechanism === "schtasks") {
			const minutes = Math.max(1, Math.min(30, Math.round(intervalMs / 60_000)));
			const command = `cmd /c "set ELECTRON_RUN_AS_NODE=1&& "${deps.execPath}" "${deps.jobPath}" >> "${paths.log}" 2>&1"`;
			const result = await run("schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", String(minutes), "/TN", WINDOWS_TASK_NAME, "/TR", command]);
			if (result.code !== 0) throw new Error(`schtasks failed: ${result.stderr.trim() || `exit ${result.code}`}`);
			return;
		}
		throw new Error("This platform has no supported scheduler");
	};

	const uninstall = async (): Promise<void> => {
		if (mechanism === "launchd") {
			await run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
			rmSync(plistPath, { force: true });
			return;
		}
		if (mechanism === "cron") {
			const current = await readCrontab();
			if (!current.includes(CRON_MARKER)) return;
			const kept = stripOwnedCronLines(current).replace(/\n+$/, "");
			const result = kept.trim().length === 0 ? await run("crontab", ["-r"]) : await run("crontab", ["-"], `${kept}\n`);
			if (result.code !== 0) throw new Error(`crontab failed: ${result.stderr.trim() || `exit ${result.code}`}`);
			return;
		}
		if (mechanism === "schtasks") {
			const result = await run("schtasks", ["/Delete", "/F", "/TN", WINDOWS_TASK_NAME]);
			if (result.code !== 0 && (await isInstalled())) throw new Error(`schtasks failed: ${result.stderr.trim() || `exit ${result.code}`}`);
		}
	};

	const readRaw = (): Record<string, unknown> => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(deps.configPath(), "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};

	const status = async (error: string | null = null): Promise<RefreshScheduleStatus> => {
		const plan = readSchedulePlan(readRaw());
		const interval = wakeIntervalMs(plan);
		const state = readScheduleState(schedulePaths(deps.configPath()).state);
		let installed = false;
		let queryError = error;
		try {
			installed = await isInstalled();
		} catch (cause) {
			queryError ??= cause instanceof Error ? cause.message : String(cause);
		}
		let otherJobs: string[] = [];
		try {
			otherJobs = await conflicts();
		} catch {
			// a missing crontab binary is not a scheduling failure
		}
		return {
			supported: mechanism !== null,
			mechanism,
			installed,
			wanted: interval !== null,
			intervalMs: interval,
			lastTickAt: state.lastTickAt,
			local: state.local,
			sources: state.sources,
			conflicts: otherJobs,
			error: queryError,
		};
	};

	return {
		status: () => status(),
		reconcile: async () => {
			if (mechanism === null) return status();
			const interval = wakeIntervalMs(readSchedulePlan(readRaw()));
			try {
				if (interval === null) await uninstall();
				else await install(interval);
			} catch (cause) {
				return status(cause instanceof Error ? cause.message : String(cause));
			}
			return status();
		},
		remove: async () => {
			try {
				await uninstall();
			} catch (cause) {
				return status(cause instanceof Error ? cause.message : String(cause));
			}
			return status();
		},
	};
}
