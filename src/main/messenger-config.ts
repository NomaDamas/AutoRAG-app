import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";


/**
 * Settings files `discrawl` and `slacrawl` need at their own default location before the app can use them, because
 * on Windows neither finds Discord Desktop's / Slack Desktop's data without one. Both read the messenger's local data
 * (Discord's cache, Slack's Chromium profile) and need no token for that.
 *
 * Measured on the Windows QA PC with discrawl 0.16.0 and slacrawl built from `e0150e0`:
 *  - `discrawl wiretap` finds `%APPDATA%\discord` by itself, but `discrawl doctor` stops at "config file not found"
 *    and never reports the database, and the librarian refuses to index until `doctor` says `config: ok` and
 *    `database: ok`. A config file that exists, even an empty one, is all it takes; `discrawl init` would need a bot token.
 *  - `slacrawl` has no Windows case in `desktopPathCandidates()` (openclaw/slacrawl#299), so without Slack's folder in its
 *    config it reports `available: false` with Slack running. With it, `sync --source wiretap` imported 2 workspaces,
 *    85 channels and 750 messages.
 *
 * The files go to the CLIs' default paths (not behind a forced `--config`), so every caller finds them: detection,
 * refresh, the datasource probe, the agent's search, and the librarian's own managed embedding config. A file that
 * already exists is the user's and is left alone, except for the one blank value Windows cannot fill itself.
 * macOS and Linux find their data on their own and are never touched.
 */

export interface MessengerHost {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
}

/** The alias a datasource entry runs as: its `type`, else the alias itself. */
function entryType(alias: string, entry: unknown): string {
	return typeof entry === "object" && entry !== null && "type" in entry && typeof entry.type === "string" ? entry.type : alias;
}

function explicit(env: NodeJS.ProcessEnv, name: string): boolean {
	return (env[name]?.trim() ?? "").length > 0;
}

/** discrawl's default config file on Windows: `%LOCALAPPDATA%\discrawl\config.toml`. */
export function discrawlConfigPath(host: MessengerHost): string {
	return join(host.env.LOCALAPPDATA?.trim() || join(host.home, "AppData", "Local"), "discrawl", "config.toml");
}

/** slacrawl's default config file: `<home>\.slacrawl\config.toml`. */
export function slacrawlConfigPath(host: MessengerHost): string {
	return join(host.home, ".slacrawl", "config.toml");
}

/** Slack Desktop's Chromium user-data folder on Windows: `%APPDATA%\Slack`. */
export function slackDesktopDir(host: MessengerHost): string {
	return join(host.env.APPDATA?.trim() || join(host.home, "AppData", "Roaming"), "Slack");
}

/** TOML basic strings treat `\` as an escape, so a Windows path has to double them. */
function tomlString(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const DISCRAWL_CONFIG = "# Written by Dazzi so `discrawl doctor` can see the local archive that `discrawl wiretap` fills (no bot token needed).\n";

/** A new slacrawl config: Slack Desktop's folder and nothing else; every other key takes its default. */
export function slacrawlConfigText(slackDir: string): string {
	return [
		"# Written by Dazzi: slacrawl cannot locate Slack Desktop's data folder on Windows by itself.",
		"version = 1",
		"",
		"[slack.desktop]",
		"enabled = true",
		`path = ${tomlString(slackDir)}`,
		"",
	].join("\n");
}

/**
 * An existing slacrawl config with a blank `[slack.desktop] path` (what `slacrawl init` writes on Windows) filled in.
 * Null when there is nothing to fill: no such table, a path already set, or the desktop source turned off.
 */
export function fillSlackDesktopPath(text: string, slackDir: string): string | null {
	const table = /^\[slack\.desktop\][^\S\r\n]*\r?\n(?<body>(?:(?!\[)[^\r\n]*\r?\n?)*)/mu.exec(text);
	if (table?.groups?.body === undefined) return null;
	const body = table.groups.body;
	if (/^\s*enabled\s*=\s*false\b/mu.test(body)) return null;
	const blank = /^(?<head>\s*path\s*=\s*)(?:''|"")[^\S\r\n]*$/mu;
	if (!blank.test(body)) return null;
	const filled = body.replace(blank, (_match, head: string) => `${head}${tomlString(slackDir)}`);
	return text.slice(0, table.index + table[0].length - body.length) + filled + text.slice(table.index + table[0].length);
}

async function ensureFile(path: string, create: string, patch?: (current: string) => string | null): Promise<void> {
	const current = await readFile(path, "utf8").catch(() => null);
	if (current === null) {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, create, "utf8");
		return;
	}
	const next = patch?.(current) ?? null;
	if (next !== null && next !== current) await writeFile(path, next, "utf8");
}

/** Makes `discrawl doctor` answer on Windows. A `DISCRAWL_CONFIG` the user set is theirs. */
export async function ensureDiscrawlConfig(host: MessengerHost): Promise<void> {
	if (host.platform !== "win32" || explicit(host.env, "DISCRAWL_CONFIG")) return;
	await ensureFile(discrawlConfigPath(host), DISCRAWL_CONFIG);
}

/** Points `slacrawl` at Slack Desktop on Windows. A `SLACRAWL_CONFIG` the user set is theirs. */
export async function ensureSlacrawlConfig(host: MessengerHost): Promise<void> {
	if (host.platform !== "win32" || explicit(host.env, "SLACRAWL_CONFIG")) return;
	const slackDir = slackDesktopDir(host);
	await ensureFile(slacrawlConfigPath(host), slacrawlConfigText(slackDir), (current) => fillSlackDesktopPath(current, slackDir));
}

/** Both are best effort: a failure here leaves the CLI to report what it cannot do, as it always did. */
export async function ensureMessengerConfig(cli: "discrawl" | "slacrawl", host: MessengerHost): Promise<void> {
	await (cli === "discrawl" ? ensureDiscrawlConfig(host) : ensureSlacrawlConfig(host)).catch(() => undefined);
}

/** The configs the datasources in `datasources` need, for a caller about to run them. */
export async function ensureMessengerConfigsFor(datasources: unknown, host: MessengerHost): Promise<void> {
	if (host.platform !== "win32" || typeof datasources !== "object" || datasources === null) return;
	const entries = Object.entries(datasources);
	const has = (type: string): boolean => entries.some(([alias, entry]) => entryType(alias, entry) === type);
	await Promise.all([has("discord") ? ensureMessengerConfig("discrawl", host) : undefined, has("slack") ? ensureMessengerConfig("slacrawl", host) : undefined]);
}
