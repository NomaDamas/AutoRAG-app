import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { autoragConfigPath, autoragHome } from "./autorag-home";

/**
 * Where the librarian saves a Discord connection's attachments, and which of the entries there are the
 * sync's own bookkeeping. The librarian writes `<AUTORAG_HOME>/attachments/discord/<connection>/<server>/<channel>/<file>`
 * right after a refresh, next to `download-status.json`, `.discrawl/` (discrawl's private config, logs and
 * download cache) and `.lock/`, and creates those three even when nothing was downloaded.
 *
 * Nothing here imports `@autorag/librarian`: the fs worker serves the sidebar from this and must not load it
 * (test/fs-worker-no-librarian.test.ts). `sanitizeIdSegment` is a copy that test/discord-attachments.test.ts
 * checks against the librarian's own.
 */

type HomeEnv = Readonly<Record<string, string | undefined>>;

/** The status file the librarian keeps at the top of every connection folder. */
const STATUS_FILENAME = "download-status.json";
/** What the librarian writes into a connection folder besides attachments: the status file, discrawl's private folder, the lock. */
const INTERNAL_ENTRIES: ReadonlySet<string> = new Set([STATUS_FILENAME, ".discrawl", ".lock"]);

export interface DiscordAttachmentFolder {
	/** The datasource's name in the AutoRAG config. */
	readonly connection: string;
	/** Its attachments folder. */
	readonly path: string;
}

/** The librarian's `sanitizeIdSegment`: how a datasource name becomes a folder name. */
export function sanitizeIdSegment(value: string): string {
	const normalized = value.replace(/[^\p{L}\p{N}._-]+/gu, "-");
	let start = 0;
	while (start < normalized.length && (normalized[start] === "-" || normalized[start] === ".")) start += 1;
	let end = normalized.length;
	while (end > start && (normalized[end - 1] === "-" || normalized[end - 1] === ".")) end -= 1;
	const cleaned = normalized.slice(start, end);
	if (cleaned === value && cleaned.length > 0 && cleaned.length <= 80) return cleaned;
	const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
	const stem = cleaned.slice(0, 60);
	return stem.length > 0 ? `${stem}-${hash}` : hash;
}

/** The folder that holds one folder per Discord connection. */
function attachmentsParent(env: HomeEnv, homeDir: string): string {
	return join(autoragHome(env, homeDir), "attachments", "discord");
}

/** One connection's attachments folder. */
export function discordAttachmentsRoot(connection: string, env: HomeEnv, homeDir: string): string {
	return join(attachmentsParent(env, homeDir), sanitizeIdSegment(connection));
}

/**
 * The enabled Discord datasources of a raw config, in config order: `datasources.<name>` is `true` or an
 * object that is not `enabled: false`, whose `type` (else its name) is `discord`.
 */
export function configuredDiscordConnections(config: unknown): string[] {
	if (typeof config !== "object" || config === null) return [];
	const datasources: unknown = (config as { readonly datasources?: unknown }).datasources;
	if (typeof datasources !== "object" || datasources === null || Array.isArray(datasources)) return [];
	const names: string[] = [];
	for (const [name, entry] of Object.entries(datasources)) {
		if (entry === true) {
			if (name === "discord") names.push(name);
			continue;
		}
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
		const { enabled, type } = entry as { readonly enabled?: unknown; readonly type?: unknown };
		if (enabled === false) continue;
		if ((typeof type === "string" ? type : name) === "discord") names.push(name);
	}
	return names;
}

/** What the sync keeps at the top of a connection folder: the status file and every dot entry. */
export function isDiscordAttachmentMeta(name: string): boolean {
	return name === STATUS_FILENAME || name.startsWith(".");
}

/** Whether `dir` holds a file (or link) of the user's, at any depth; folders count only for what they hold. */
async function holdsUserFile(dir: string, top: boolean): Promise<boolean> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	const folders: string[] = [];
	for (const entry of entries) {
		if (top ? isDiscordAttachmentMeta(entry.name) : entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) folders.push(entry.name);
		else return true;
	}
	for (const name of folders) {
		if (await holdsUserFile(join(dir, name), false)) return true;
	}
	return false;
}

/** The raw config, or null when it is missing or not JSON (a connection that cannot be read is not shown). */
async function readRawConfig(path: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/**
 * The attachments folders to show in the sidebar: one per enabled Discord datasource whose folder holds
 * something of the user's. A connection that was disabled or removed is not listed, whatever is still on disk.
 */
export async function discordAttachmentFolders(env: HomeEnv, homeDir: string): Promise<readonly DiscordAttachmentFolder[]> {
	const connections = configuredDiscordConnections(await readRawConfig(autoragConfigPath(env, homeDir)));
	const folders = await Promise.all(
		connections.map(async (connection): Promise<DiscordAttachmentFolder | null> => {
			const path = discordAttachmentsRoot(connection, env, homeDir);
			return (await holdsUserFile(path, true)) ? { connection, path } : null;
		}),
	);
	return folders.filter((folder): folder is DiscordAttachmentFolder => folder !== null);
}

export interface DiscordAttachmentPaths {
	/** `name` sits directly in a connection folder `dir` and is one of the sync's own entries. */
	isInternalEntry(dir: string, name: string): boolean;
	/** `path` is, or lies inside, one of the sync's own entries of a connection folder. */
	isInternalPath(path: string): boolean;
}

/**
 * Pure path rules for the folder layout, so listings and searches can hide the bookkeeping without any I/O.
 * Only the three entries the librarian writes are hidden: any other dot entry (a Finder `.DS_Store`) is the
 * user's and follows the "show hidden files" setting like everywhere else.
 */
export function discordAttachmentPaths(env: HomeEnv, homeDir: string): DiscordAttachmentPaths {
	const parent = attachmentsParent(env, homeDir);
	/** The path segments of `path` below the attachments folder; null when it is not below it. */
	const below = (path: string): string[] | null => {
		const rel = relative(parent, path);
		if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
		return rel.split(sep);
	};
	return {
		isInternalEntry: (dir, name) => INTERNAL_ENTRIES.has(name) && below(dir)?.length === 1,
		isInternalPath: (path) => {
			const segments = below(path);
			return segments !== null && segments.length >= 2 && INTERNAL_ENTRIES.has(segments[1] ?? "");
		},
	};
}
