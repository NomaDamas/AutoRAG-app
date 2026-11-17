import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { datasourceSupported, kakaoSupported } from "../shared/messenger-platform";
import type { DetectedSource, SourceDetection, SourceId } from "../shared/onboarding-contract";
import { isJsonObject } from "../shared/settings-contract";
import { ensureMessengerConfig } from "./messenger-config";

/**
 * The sources step lists only connectors that are already installed, signed in,
 * and have data. Detection is read-only and best-effort: every probe is bounded
 * and any failure simply means "not detected", never an error the user has to
 * clear.
 *
 * Each CLI-backed source (the `*crawl` family, `lazykatok`, `himalaya`) owns its
 * archive and credentials, so "usable" means the CLI's own health probe says its
 * source data is reachable. Local files are covered by the folders step; Spotlight
 * and Apple Mail are intentionally not offered here.
 */

export interface SourceDetectionDeps {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	/** Runs one OS command; the caller bounds it with a deadline (rejects on timeout). */
	readonly run: (command: string, args: readonly string[]) => Promise<string>;
	readonly pathExists: (path: string) => Promise<boolean>;
	/** Entry names of one directory, or none when it is missing. */
	readonly readDirNames: (path: string) => Promise<readonly string[]>;
	readonly readFileText: (path: string) => Promise<string>;
}

/** Every connector the step can find on this host, in display order; KakaoTalk and WhatsApp are Mac-only apps. */
function sourceOrder(platform: NodeJS.Platform): readonly SourceId[] {
	const all: readonly SourceId[] = ["kakao", "slack", "discord", "telegram", "whatsapp", "mailcrawl", "github", "notion", "obsidian", "wombat"];
	return all.filter((id) => datasourceSupported(id, platform));
}
const GITHUB_REPO_LIMIT = 5;
const MAILCRAWL_ACCOUNT_LIMIT = 5;
/** mailcrawl's own instance-id rule; an account outside it cannot be registered. */
const MAILCRAWL_ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

async function hasCommand(deps: SourceDetectionDeps, name: string): Promise<boolean> {
	try {
		await deps.run(deps.platform === "win32" ? "where" : "which", [name]);
		return true;
	} catch {
		return false;
	}
}

/** One command's stdout parsed as a JSON object; null when it fails or prints anything else. */
async function runJsonObject(
	deps: SourceDetectionDeps,
	command: string,
	args: readonly string[],
): Promise<Record<string, unknown> | null> {
	try {
		const parsed: unknown = JSON.parse(await deps.run(command, args));
		return isJsonObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function positiveInt(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Parse `gh ... --json` output into a string array; empty on any malformed value. */
function parseRepoList(output: string): string[] {
	try {
		const parsed: unknown = JSON.parse(output);
		if (!Array.isArray(parsed)) return [];
		const repos: string[] = [];
		for (const item of parsed) {
			if (isJsonObject(item) && typeof item.nameWithOwner === "string") repos.push(item.nameWithOwner);
		}
		return repos.slice(0, GITHUB_REPO_LIMIT);
	} catch {
		return [];
	}
}

/** First integer in a sqlite count result, whatever row shape `slacrawl` prints. */
function parseCount(output: string): number {
	try {
		const parsed: unknown = JSON.parse(output);
		const rows = Array.isArray(parsed) ? parsed : [parsed];
		for (const row of rows) {
			if (!isJsonObject(row)) continue;
			for (const value of Object.values(row)) {
				if (typeof value === "number" && Number.isFinite(value)) return value;
				if (typeof value === "string") {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue)) return parsedValue;
				}
			}
		}
	} catch {
		const match = /(\d+)/u.exec(output);
		if (match?.[1] !== undefined) return Number.parseInt(match[1], 10);
	}
	return 0;
}

/** KakaoTalk for Mac: the app, its container, a cached or verifiable login, and readable db files. */
async function detectKakao(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (!kakaoSupported(deps.platform)) return null;
	const doctor = await runJsonObject(deps, "lazykatok", ["doctor", "--macos-probe", "--json"]);
	const adapter = isJsonObject(doctor?.source_adapter) ? doctor.source_adapter : null;
	const macos = isJsonObject(adapter?.macos) ? adapter.macos : null;
	if (macos === null || macos.status !== "checked") return null;
	if (macos.app_installed !== true || macos.container_present !== true) return null;
	if (positiveInt(macos.db_file_count) === 0) return null;
	let chats: number | undefined;
	try {
		const parsed: unknown = JSON.parse(await deps.run("lazykatok", ["source", "chats", "--source", "macos", "--json"]));
		if (Array.isArray(parsed)) chats = parsed.length;
	} catch {
		// Live chat probe failed; if no cached auth exists either, the databases cannot be opened.
	}
	if (macos.auth_cached !== true && chats === undefined) return null;
	return { id: "kakao", facts: chats !== undefined ? { chats } : {} };
}

async function detectSlack(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (!(await hasCommand(deps, "slacrawl"))) return null;
	// Windows: slacrawl cannot find Slack Desktop by itself; its default config is pointed at it first.
	await ensureMessengerConfig("slacrawl", deps);
	const query = async (sql: string): Promise<number> => {
		try {
			return parseCount(await deps.run("slacrawl", ["--format", "json", "sql", sql]));
		} catch {
			return 0;
		}
	};
	const workspaces = await query("select count(*) as n from workspaces");
	if (workspaces > 0) {
		const channels = await query("select count(*) as n from channels");
		const messages = await query("select count(*) as n from messages");
		return { id: "slack", facts: { workspaces, channels, messages } };
	}
	// Nothing archived yet. On macOS and Windows the desktop app itself is the source: `doctor` reports how many
	// workspaces it has signed in, and the first index imports them with `sync --source wiretap`.
	if (deps.platform !== "win32" && deps.platform !== "darwin") return null;
	const doctor = await runJsonObject(deps, "slacrawl", ["--json", "doctor"]);
	const desktop = isJsonObject(doctor?.desktop_source) ? doctor.desktop_source : null;
	const summary = isJsonObject(desktop?.summary) ? desktop.summary : null;
	if (desktop === null || desktop.available !== true) return null;
	const signedIn = positiveInt(summary?.workspace_count);
	return signedIn > 0 ? { id: "slack", facts: { workspaces: signedIn } } : null;
}

/**
 * Discord Desktop's cache, imported by `discrawl wiretap` (no bot token). The
 * skill refuses to index until `doctor` reports a ready config and database, so
 * both are required here too, plus a dry run that finds messages to import.
 */
async function detectDiscord(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	// Windows: `doctor` stops at "config file not found" and never reports the database; an existing config fixes that.
	await ensureMessengerConfig("discrawl", deps);
	const doctor = await runJsonObject(deps, "discrawl", ["--json", "doctor"]);
	if (doctor === null || doctor.config !== "ok" || doctor.database !== "ok") return null;
	const tap = await runJsonObject(deps, "discrawl", ["--json", "wiretap", "--dry-run"]);
	const messages = positiveInt(tap?.messages);
	return messages > 0 ? { id: "discord", facts: { messages } } : null;
}

async function detectTelegram(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	const doctor = await runJsonObject(deps, "telecrawl", ["--json", "doctor"]);
	if (doctor === null || doctor.exists !== true || doctor.accessible !== true) return null;
	if (typeof doctor.store !== "string" || doctor.store === "missing") return null;
	return { id: "telegram", facts: {} };
}

async function detectWhatsapp(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	// `--sync never`: detection must not import anything.
	const doctor = await runJsonObject(deps, "wacrawl", ["--sync", "never", "--json", "doctor"]);
	const desktop = isJsonObject(doctor?.desktop) ? doctor.desktop : null;
	if (desktop === null || desktop.available !== true) return null;
	const messages = positiveInt(desktop.message_rows);
	if (messages === 0) return null;
	return { id: "whatsapp", facts: { chats: positiveInt(desktop.chat_rows), messages } };
}

/**
 * Notion Desktop's local cache, which `notcrawl sync` (the skill's only sync command) reads with no token. `doctor`
 * calls the cache available as soon as the app has run once: a fresh Notion.app writes a ~480 KB `notion.db` with no
 * workspace in it, and a source that holds nothing would fail its first index. So `doctor` only gates the real probe,
 * which imports the cache into a throwaway archive (its own config, never `~/.notcrawl`, deleted afterwards) and
 * offers Notion when that archive holds pages. An API token alone does not count: that needs a Notion integration
 * rather than the signed-in app.
 */
async function detectNotion(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	const doctor = await runJsonObject(deps, "notcrawl", ["doctor", "--json"]);
	if (doctor === null || doctor.desktop_available !== true || positiveInt(doctor.desktop_size) === 0) return null;
	const probeDir = await mkdtemp(join(tmpdir(), "dazzi-notion-probe-"));
	try {
		const config = join(probeDir, "config.toml");
		await writeFile(
			config,
			[
				`db_path = ${JSON.stringify(join(probeDir, "notcrawl.db"))}`,
				`cache_dir = ${JSON.stringify(join(probeDir, "cache"))}`,
				`markdown_dir = ${JSON.stringify(join(probeDir, "pages"))}`,
				"[notion.desktop]",
				"enabled = true",
				"[notion.api]",
				"enabled = false",
				"",
			].join("\n"),
		);
		await deps.run("notcrawl", ["--config", config, "sync", "--source", "desktop"]);
		const status = await runJsonObject(deps, "notcrawl", ["--config", config, "status"]);
		return positiveInt(status?.pages) > 0 ? { id: "notion", facts: {} } : null;
	} finally {
		await rm(probeDir, { recursive: true, force: true });
	}
}

/**
 * mailcrawl reads mail through himalaya, which owns the account logins. An account
 * counts only when himalaya can actually list its mailboxes (a real IMAP login),
 * so a configured-but-signed-out account never becomes a source that fails its
 * first sync.
 */
async function detectMailcrawl(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (!(await hasCommand(deps, "mailcrawl"))) return null;
	const listed = await runJsonObject(deps, "himalaya", ["account", "list", "--json"]);
	const rows = Array.isArray(listed?.accounts) ? listed.accounts : [];
	const names: string[] = [];
	for (const row of rows) {
		if (isJsonObject(row) && typeof row.name === "string" && MAILCRAWL_ACCOUNT_NAME.test(row.name)) names.push(row.name);
	}
	const verified = await Promise.all(
		names.slice(0, MAILCRAWL_ACCOUNT_LIMIT).map(async (account) => {
			try {
				await deps.run("himalaya", ["mailbox", "list", "--account", account, "--json"]);
				return account;
			} catch {
				return null;
			}
		}),
	);
	const accounts = verified.filter((account): account is string => account !== null);
	return accounts.length > 0 ? { id: "mailcrawl", facts: { accounts } } : null;
}

/**
 * Where each coding agent keeps its sessions, in wombat's agent names (`wombat sync --agent <name>`). `path` is the
 * folder wombat reads by default (`SourceRoots::default_from_env`) relative to the agent's root: the home directory,
 * or the agent's own `env` variable when the user moved it. The order is the order the step names them in.
 */
interface AiSessionFolder {
	readonly agent: string;
	readonly env?: string;
	/** Folder under the home directory. */
	readonly home: readonly string[];
	/** Folder under the `env` override, which replaces `home`. */
	readonly underEnv: readonly string[];
}

const AI_SESSION_FOLDERS: readonly AiSessionFolder[] = [
	{ agent: "codex", env: "CODEX_HOME", home: [".codex", "sessions"], underEnv: ["sessions"] },
	{ agent: "claude-code", env: "CLAUDE_CONFIG_DIR", home: [".claude", "projects"], underEnv: ["projects"] },
	{ agent: "omp", home: [".omp", "agent", "sessions"], underEnv: [] },
	{ agent: "pi", home: [".pi", "agent", "sessions"], underEnv: [] },
	{ agent: "opencode", home: [".local", "share", "opencode"], underEnv: [] },
	{ agent: "hermes", env: "HERMES_HOME", home: [".hermes"], underEnv: [] },
	{ agent: "gemini", env: "GEMINI_CLI_HOME", home: [".gemini"], underEnv: [".gemini"] },
	{ agent: "qwen", env: "QWEN_HOME", home: [".qwen"], underEnv: [] },
	{ agent: "copilot", env: "COPILOT_HOME", home: [".copilot"], underEnv: [] },
	{ agent: "continue", env: "CONTINUE_GLOBAL_DIR", home: [".continue"], underEnv: [] },
	{ agent: "codebuddy", env: "CODEBUDDY_CONFIG_DIR", home: [".codebuddy"], underEnv: [] },
	{ agent: "vibe", env: "VIBE_HOME", home: [".vibe"], underEnv: [] },
	{ agent: "droid", env: "FACTORY_HOME", home: [".factory"], underEnv: [] },
	{ agent: "kiro", env: "KIRO_HOME", home: [".kiro"], underEnv: [] },
	{ agent: "iflow", home: [".iflow", "projects"], underEnv: [] },
	{ agent: "aside", home: [".aside"], underEnv: [] },
];

/** The folder one agent's sessions live in on this computer; a relative or empty override is ignored, as wombat ignores it. */
function aiSessionFolder(deps: SourceDetectionDeps, entry: AiSessionFolder): string {
	const joinPath = deps.platform === "win32" ? win32.join : posix.join;
	const override = entry.env === undefined ? undefined : deps.env[entry.env];
	if (override !== undefined && (posix.isAbsolute(override) || win32.isAbsolute(override))) return joinPath(override, ...entry.underEnv);
	return joinPath(deps.home, ...entry.home);
}

/**
 * AI Sessions: the past conversations coding agents (Claude Code, Codex, ...) left on this computer, searched through
 * the `wombat` CLI. It is offered only when the CLI is installed and at least one agent's own session folder holds
 * something, so a first index never starts a source that has nothing to read.
 */
async function detectWombat(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (!(await hasCommand(deps, "wombat"))) return null;
	const found = await Promise.all(
		AI_SESSION_FOLDERS.map(async (entry) => {
			const folder = aiSessionFolder(deps, entry);
			if (!(await deps.pathExists(folder))) return null;
			return (await deps.readDirNames(folder)).length > 0 ? entry.agent : null;
		}),
	);
	const agents = found.filter((agent): agent is string => agent !== null);
	return agents.length > 0 ? { id: "wombat", facts: { agents } } : null;
}

async function detectGithub(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	const envToken = deps.env.GITHUB_TOKEN;
	let authenticated = typeof envToken === "string" && envToken.length > 0;
	if (!authenticated) {
		try {
			authenticated = (await deps.run("gh", ["auth", "token"])).trim().length > 0;
		} catch {
			authenticated = false;
		}
	}
	if (!authenticated) return null;
	let repos: string[] = [];
	try {
		repos = parseRepoList(await deps.run("gh", ["repo", "list", "--limit", String(GITHUB_REPO_LIMIT), "--json", "nameWithOwner"]));
	} catch {
		repos = [];
	}
	// The GitHub skill cannot index without a repository target, even when
	// authentication succeeds. Do not offer a source that fails its first sync.
	if (repos.length === 0) return null;
	return { id: "github", facts: { repos } };
}

async function detectObsidian(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	const configPath =
		deps.platform === "win32"
			? join(deps.env.APPDATA ?? join(deps.home, "AppData", "Roaming"), "obsidian", "obsidian.json")
			: join(deps.home, "Library", "Application Support", "obsidian", "obsidian.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(await deps.readFileText(configPath));
	} catch {
		return null;
	}
	if (!isJsonObject(parsed) || !isJsonObject(parsed.vaults)) return null;
	const vaults: string[] = [];
	for (const vault of Object.values(parsed.vaults)) {
		if (isJsonObject(vault) && typeof vault.path === "string" && (await deps.pathExists(vault.path))) vaults.push(vault.path);
	}
	return vaults.length > 0 ? { id: "obsidian", facts: { vaults } } : null;
}

/**
 * Probes every connector concurrently and reports each usable one through
 * `onFound` the moment its own probe finishes, so a fast probe (KakaoTalk,
 * WhatsApp: ~0.2s) is never held back by a slow one (IMAP login: seconds). The
 * resolved value is the full list in `sourceOrder`, for callers that need all
 * the facts at once (the indexing handoff).
 */
export async function detectSources(
	deps: SourceDetectionDeps,
	onFound?: (source: DetectedSource) => void,
): Promise<SourceDetection> {
	const detectors: Record<SourceId, (deps: SourceDetectionDeps) => Promise<DetectedSource | null>> = {
		kakao: detectKakao,
		slack: detectSlack,
		discord: detectDiscord,
		telegram: detectTelegram,
		whatsapp: detectWhatsapp,
		mailcrawl: detectMailcrawl,
		github: detectGithub,
		notion: detectNotion,
		obsidian: detectObsidian,
		wombat: detectWombat,
	};
	const results = await Promise.all(
		sourceOrder(deps.platform).map(async (id) => {
			const source = await detectors[id](deps).catch(() => null);
			if (source !== null) onFound?.(source);
			return source;
		}),
	);
	return { sources: results.filter((source): source is DetectedSource => source !== null) };
}
