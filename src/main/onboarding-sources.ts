import { join } from "node:path";
import type { DetectedSource, SourceDetection, SourceId } from "../shared/onboarding-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * The sources step lists only connectors that are already installed,
 * authenticated, and have data. Detection is read-only and best-effort: every
 * probe is bounded and any failure simply means "not detected", never an error
 * the user has to clear.
 */

export interface SourceDetectionDeps {
	readonly platform: NodeJS.Platform;
	readonly home: string;
	readonly env: NodeJS.ProcessEnv;
	/** Runs one OS command with a short timeout; caller bounds it (5s). */
	readonly run: (command: string, args: readonly string[]) => Promise<string>;
	readonly pathExists: (path: string) => Promise<boolean>;
	/** Entry names of one directory, or none when it is missing. */
	readonly readDirNames: (path: string) => Promise<readonly string[]>;
	readonly readFileText: (path: string) => Promise<string>;
}

const SOURCE_ORDER: readonly SourceId[] = ["spotlight", "github", "obsidian", "mail", "slack"];
const GITHUB_REPO_LIMIT = 5;
const MAILBOX_DIR = /^V\d+$/u;

async function hasCommand(deps: SourceDetectionDeps, name: string): Promise<boolean> {
	try {
		await deps.run(deps.platform === "win32" ? "where" : "which", [name]);
		return true;
	} catch {
		return false;
	}
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

async function detectSpotlight(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (deps.platform !== "darwin") return null;
	try {
		// `mdfind -h` exits 5 even when Spotlight works; a scoped count query is
		// the cheapest call that succeeds exactly when the index answers.
		await deps.run("mdfind", ["-onlyin", deps.home, "-count", "kMDItemFSName == '.autorag-probe'"]);
	} catch {
		return null;
	}
	return { id: "spotlight", needsFullDiskAccess: false, facts: {} };
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
	return { id: "github", needsFullDiskAccess: false, facts: { repos } };
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
	return vaults.length > 0 ? { id: "obsidian", needsFullDiskAccess: false, facts: { vaults } } : null;
}

async function detectMail(deps: SourceDetectionDeps): Promise<DetectedSource | null> {
	if (deps.platform !== "darwin") return null;
	const mailDir = join(deps.home, "Library", "Mail");
	if (!(await deps.pathExists(mailDir))) return null;
	const mailboxes = (await deps.readDirNames(mailDir)).filter((name) => MAILBOX_DIR.test(name)).length;
	return { id: "mail", needsFullDiskAccess: true, facts: { mailboxes } };
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
	return { id: "slack", needsFullDiskAccess: false, facts: { workspaces, channels, messages } };
}

export async function detectSources(deps: SourceDetectionDeps): Promise<SourceDetection> {
	const detectors: Record<SourceId, (deps: SourceDetectionDeps) => Promise<DetectedSource | null>> = {
		spotlight: detectSpotlight,
		github: detectGithub,
		obsidian: detectObsidian,
		mail: detectMail,
		slack: detectSlack,
	};
	const detected: DetectedSource[] = [];
	for (const id of SOURCE_ORDER) {
		const source = await detectors[id](deps).catch(() => null);
		if (source !== null) detected.push(source);
	}
	return { sources: detected };
}
