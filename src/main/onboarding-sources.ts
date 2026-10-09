import { join } from "node:path";
import type { DetectedSource, SourceDetection, SourceId } from "../shared/onboarding-contract";
import { isJsonObject } from "../shared/settings-contract";

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

const SOURCE_ORDER: readonly SourceId[] = ["kakao", "slack", "discord", "telegram", "whatsapp", "mailcrawl", "github", "obsidian"];
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

/** KakaoTalk for Mac: the app, its container, a cached login, and readable db files. */
async function detectKakao(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (deps.platform !== "darwin") return null;
	const doctor = await runJsonObject(deps, "lazykatok", ["doctor", "--macos-probe", "--json"]);
	const adapter = isJsonObject(doctor?.source_adapter) ? doctor.source_adapter : null;
	const macos = isJsonObject(adapter?.macos) ? adapter.macos : null;
	if (macos === null || macos.status !== "checked") return null;
	if (macos.app_installed !== true || macos.container_present !== true || macos.auth_cached !== true) return null;
	if (positiveInt(macos.db_file_count) === 0) return null;
	return { id: "kakao", facts: {} };
}

async function detectSlack(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (!(await hasCommand(deps, "slacrawl"))) return null;
	const query = async (sql: string): Promise<number> => {
		try {
			return parseCount(await deps.run("slacrawl", ["--format", "json", "sql", sql]));
		} catch {
			return 0;
		}
	};
	const workspaces = await query("select count(*) as n from workspaces");
	if (workspaces <= 0) return null;
	const channels = await query("select count(*) as n from channels");
	const messages = await query("select count(*) as n from messages");
	return { id: "slack", facts: { workspaces, channels, messages } };
}

/**
 * Discord Desktop's cache, imported by `discrawl wiretap` (no bot token). The
 * skill refuses to index until `doctor` reports a ready config and database, so
 * both are required here too, plus a dry run that finds messages to import.
 */
async function detectDiscord(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
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
	if (!(await hasCommand(deps, "qmd"))) return null;
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
 * resolved value is the full list in `SOURCE_ORDER`, for callers that need all
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
		obsidian: detectObsidian,
	};
	const results = await Promise.all(
		SOURCE_ORDER.map(async (id) => {
			const source = await detectors[id](deps).catch(() => null);
			if (source !== null) onFound?.(source);
			return source;
		}),
	);
	return { sources: results.filter((source): source is DetectedSource => source !== null) };
}
