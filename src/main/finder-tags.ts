/**
 * macOS Finder tags: the tag registry Finder shows in its sidebar, the tags a
 * file carries, and the files that carry one tag.
 *
 * Where macOS keeps each piece (all verified on a live machine):
 *
 * - A file's tags are the extended attribute
 *   `com.apple.metadata:_kMDItemUserTags`: a binary property list array of
 *   strings, `"<name>"` or `"<name>\n<N>"` where N (1 gray, 2 green, 3 purple,
 *   4 blue, 5 yellow, 6 red, 7 orange) is the colour at assignment time.
 * - The colour Finder draws is the registry's, not the file's: a tag recoloured
 *   later keeps its old suffix on files that already carry it. The registry is
 *   the `FinderTagDict` key (`FinderTags: [{ n: name, l: colour, p: sidebar }]`)
 *   of the iCloud key-value store, a SQLite file under `~/Library/Daemon
 *   Containers`.
 * - Spotlight indexes the names as `kMDItemUserTags`, which is how Finder's
 *   tag view lists a tag. Only Finder can add, rename, recolour, or delete a
 *   registry entry, so this module never writes the registry; it assigns and
 *   removes tags on files.
 * - The tag-write APIs are not faithful (`NSURLTagNamesKey` stores `Red\n0`
 *   for the standard colour tags), and Spotlight ignores an XML-plist value,
 *   so a write is a binary plist `xattr` written exactly the way Finder does.
 *
 * Every helper runs with an argv array, never a shell.
 */

import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FsBatchResult, FsOpError, FsTag, FsTagCatalog, FsTagChange, FsTagColor } from "../shared/fs-contract";
import { t } from "../shared/i18n/core";
import { errorMessage } from "./fs-entry";

/** Runs one OS helper with optional stdin and resolves its raw stdout; rejects with stderr (or the spawn error) verbatim. */
export type TagCommandRunner = (command: string, args: readonly string[], input?: string | Uint8Array) => Promise<Buffer>;

export interface FinderTagsDeps {
	/** Defaults to process.platform; every other platform answers "unsupported". */
	readonly platform?: NodeJS.Platform;
	readonly homeDir?: string;
	/** Defaults to `execFile`; tests inject a table-driven stub. */
	readonly run?: TagCommandRunner;
	/** The registry database candidates, newest convention first; defaults to the iCloud KVS files under `homeDir`. */
	readonly registryFiles?: () => Promise<readonly string[]>;
	/** Defaults to console.warn. */
	readonly warn?: (message: string) => void;
	/** Defaults to Date.now. */
	readonly now?: () => number;
}

export interface FinderTags {
	catalog(): Promise<FsTagCatalog>;
	/** Add and remove tags on each path independently; a path that cannot be changed fails alone. */
	set(paths: readonly string[], change: FsTagChange): Promise<FsBatchResult>;
	/** Every indexed path carrying `name` (case-insensitive), unsorted. */
	search(name: string): Promise<readonly string[]>;
}

const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";
const XATTR = "/usr/bin/xattr";
const PLUTIL = "/usr/bin/plutil";
const MDFIND = "/usr/bin/mdfind";
const SQLITE3 = "/usr/bin/sqlite3";
const OSASCRIPT = "/usr/bin/osascript";
const DEFAULTS = "/usr/bin/defaults";
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_MAX_BUFFER = 64 << 20;
const WRITE_CONCURRENCY = 4;
/** How long Spotlight may trail an `xattr` write (measured ~2s); the overlay outlives it. */
const INDEX_LAG_MS = 15_000;
const MAX_TAG_NAME_LENGTH = 255;
const REGISTRY_KEY = "FinderTagDict";
const KVS_DATABASE = "com.apple.KeyValueService-Production.sqlite";
const NO_XATTR = "No such xattr";

/** `NSWorkspace.fileLabels` for an English system: index = colour. */
const ENGLISH_COLOR_NAMES: readonly string[] = ["None", "Gray", "Green", "Purple", "Blue", "Yellow", "Red", "Orange"];
/** Finder's standard tag order in its menus and sidebar: red, orange, yellow, green, blue, purple, gray. */
const STANDARD_ORDER: readonly FsTagColor[] = [6, 7, 5, 2, 4, 3, 1];

const UNSUPPORTED: FsTagCatalog = { supported: false, tags: [], colorNames: [] };

function defaultRun(command: string, args: readonly string[], input?: string | Uint8Array): Promise<Buffer> {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
	const child = execFile(
		command,
		[...args],
		{ timeout: COMMAND_TIMEOUT_MS, maxBuffer: COMMAND_MAX_BUFFER, encoding: "buffer" },
		(error, stdout, stderr) => {
			if (error !== null) {
				const detail = stderr.toString("utf8").trim();
				reject(new Error(detail === "" ? error.message : detail));
				return;
			}
			resolve(stdout);
		},
	);
	if (child.stdin !== null) {
		// A helper that fails before reading its input leaves nothing to write to.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	}
	return promise;
}

async function defaultRegistryFiles(home: string): Promise<readonly string[]> {
	const root = join(home, "Library", "Daemon Containers");
	let containers: string[];
	try {
		containers = await readdir(root);
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const container of containers) {
		const file = join(root, container, "Data", "com.apple.kvs", KVS_DATABASE);
		try {
			await access(file);
			found.push(file);
		} catch {
			// Not this container.
		}
	}
	return found;
}

function isColor(value: unknown): value is FsTagColor {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 7;
}

/** The tag name inside one stored entry: the colour suffix (`"Urgent\n6"`) is not part of the name. */
export function tagNameOfStored(stored: string): string {
	return stored.replace(/\n\d+(?:\n\d+)*$/, "");
}

/** The suffix colour a stored entry carries; 0 when it has none. */
export function storedColor(stored: string): FsTagColor {
	const match = /\n(\d+)(?:\n\d+)*$/.exec(stored);
	const color = match === null ? 0 : Number(match[1]);
	return isColor(color) ? color : 0;
}

/** A Spotlight string literal: backslash, quote, and the wildcard are escaped. */
export function spotlightLiteral(name: string): string {
	return name.replace(/[\\"*]/g, "\\$&");
}

/** Throws the reason a tag name cannot be stored, or returns the trimmed name. */
export function validTagName(name: string): string {
	const trimmed = name.trim();
	if (trimmed === "") throw new Error(t("main.tags.nameEmpty"));
	if (/[\n\r\u0000]/.test(trimmed)) throw new Error(t("main.tags.nameNewline"));
	if (trimmed.length > MAX_TAG_NAME_LENGTH) throw new Error(t("main.tags.nameTooLong"));
	return trimmed;
}

interface RegistryTag {
	readonly name: string;
	readonly color: FsTagColor;
	readonly sidebar: boolean;
}

function parseRegistry(value: unknown): readonly RegistryTag[] | null {
	if (typeof value !== "object" || value === null || !("FinderTags" in value) || !Array.isArray(value.FinderTags)) return null;
	const tags: RegistryTag[] = [];
	for (const item of value.FinderTags) {
		if (typeof item !== "object" || item === null || !("n" in item) || typeof item.n !== "string" || item.n === "") continue;
		tags.push({
			name: item.n,
			color: "l" in item && isColor(item.l) ? item.l : 0,
			sidebar: "p" in item && item.p === true,
		});
	}
	return tags;
}

function mapWithLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	};
	return Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane)).then(() => results);
}

export function createFinderTags(deps: FinderTagsDeps = {}): FinderTags {
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const home = deps.homeDir ?? process.env.HOME ?? "";
	const registryFiles = deps.registryFiles ?? (() => defaultRegistryFiles(home));
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const warned = new Set<string>();
	const warnOnce = (message: string): void => {
		if (warned.has(message)) return;
		warned.add(message);
		warn(message);
	};
	let colorNames: Promise<readonly string[]> | null = null;
	let registryFile: string | null = null;
	/** Paths this app tagged or untagged lately: name (lower-case) → carries it now. */
	const recentChanges = new Map<string, { readonly names: ReadonlyMap<string, boolean>; readonly expiresAt: number }>();
	const now = deps.now ?? (() => Date.now());

	/** The OS's localized colour names, which are also what the standard colour tags are called. */
	function loadColorNames(): Promise<readonly string[]> {
		colorNames ??= (async () => {
			try {
				const script = 'ObjC.import("AppKit"); JSON.stringify(ObjC.deepUnwrap($.NSWorkspace.sharedWorkspace.fileLabels))';
				const parsed: unknown = JSON.parse((await run(OSASCRIPT, ["-l", "JavaScript", "-e", script])).toString("utf8"));
				if (Array.isArray(parsed) && parsed.length === 8 && parsed.every((name) => typeof name === "string")) {
					return parsed as string[];
				}
			} catch (error) {
				warnOnce(`finder-tags: colour names unavailable: ${errorMessage(error)}`);
			}
			return ENGLISH_COLOR_NAMES;
		})();
		return colorNames;
	}

	async function plistToJson(bytes: Uint8Array): Promise<unknown> {
		return JSON.parse((await run(PLUTIL, ["-convert", "json", "-o", "-", "--", "-"], bytes)).toString("utf8"));
	}

	async function queryRegistry(file: string): Promise<readonly RegistryTag[] | null> {
		const sql = `SELECT hex(ZPLISTDATAVALUE) FROM ZSYDMANAGEDKEYVALUE WHERE ZKEY='${REGISTRY_KEY}' LIMIT 1`;
		const hex = (await run(SQLITE3, ["-readonly", "-noheader", file, sql])).toString("utf8").trim();
		if (hex === "") return null;
		return parseRegistry(await plistToJson(Buffer.from(hex, "hex")));
	}

	/** Finder's registry, or null when this machine's store cannot be read. */
	async function readRegistry(): Promise<readonly RegistryTag[] | null> {
		const candidates = registryFile === null ? await registryFiles() : [registryFile];
		for (const file of candidates) {
			try {
				const tags = await queryRegistry(file);
				if (tags !== null) {
					registryFile = file;
					return tags;
				}
			} catch (error) {
				warnOnce(`finder-tags: registry ${file} unreadable: ${errorMessage(error)}`);
			}
		}
		registryFile = null;
		return null;
	}

	/** The sidebar tags Finder remembers when the registry is unreadable: names only, no colours. */
	async function readFavoriteNames(): Promise<readonly string[]> {
		try {
			const exported = await run(DEFAULTS, ["export", "com.apple.finder", "-"]);
			const json = (await run(PLUTIL, ["-extract", "FavoriteTagNames", "json", "-o", "-", "--", "-"], exported)).toString("utf8");
			const parsed: unknown = JSON.parse(json);
			return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string" && name !== "") : [];
		} catch (error) {
			warnOnce(`finder-tags: Finder preferences unreadable: ${errorMessage(error)}`);
			return [];
		}
	}

	async function catalog(): Promise<FsTagCatalog> {
		if (platform !== "darwin") return UNSUPPORTED;
		const names = await loadColorNames();
		const standard: FsTag[] = STANDARD_ORDER.map((color) => ({ name: names[color] ?? ENGLISH_COLOR_NAMES[color] ?? "", color, sidebar: false }));
		const standardColor = new Map(standard.map((tag) => [tag.name.toLowerCase(), tag.color]));
		const registry = await readRegistry();
		let tags: FsTag[];
		if (registry !== null && registry.length > 0) {
			tags = registry.map((tag) => ({ ...tag }));
		} else if (registry === null) {
			// No registry: Finder's favourites by name; a standard colour name still has its colour.
			const favorites = await readFavoriteNames();
			tags = favorites.map((name) => ({ name, color: standardColor.get(name.toLowerCase()) ?? 0, sidebar: true }));
		} else {
			tags = [];
		}
		if (tags.length === 0) {
			// A Mac that never customized Finder's tags: the seven colour tags are the sidebar.
			return { supported: true, tags: standard.map((tag) => ({ ...tag, sidebar: true })), colorNames: names };
		}
		const known = new Set(tags.map((tag) => tag.name.toLowerCase()));
		for (const tag of standard) if (!known.has(tag.name.toLowerCase())) tags.push(tag);
		return { supported: true, tags, colorNames: names };
	}

	async function readStored(path: string): Promise<readonly string[]> {
		let hex: string;
		try {
			hex = (await run(XATTR, ["-p", "-x", TAGS_XATTR, path])).toString("utf8");
		} catch (error) {
			if (errorMessage(error).includes(NO_XATTR)) return [];
			throw error;
		}
		const bytes = Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex");
		if (bytes.length === 0) return [];
		const parsed = await plistToJson(bytes);
		// A value that is not a list of strings is not ours to overwrite.
		if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
			throw new Error(t("main.tags.unreadable"));
		}
		return parsed as string[];
	}

	async function writeStored(path: string, stored: readonly string[]): Promise<void> {
		if (stored.length === 0) {
			try {
				await run(XATTR, ["-d", TAGS_XATTR, path]);
			} catch (error) {
				if (!errorMessage(error).includes(NO_XATTR)) throw error;
			}
			return;
		}
		const binary = await run(PLUTIL, ["-convert", "binary1", "-o", "-", "--", "-"], JSON.stringify(stored));
		await run(XATTR, ["-w", "-x", TAGS_XATTR, binary.toString("hex"), path]);
	}

	async function set(paths: readonly string[], change: FsTagChange): Promise<FsBatchResult> {
		if (platform !== "darwin") throw new Error(t("main.tags.macosOnly"));
		const add = [...new Set(change.add.map(validTagName))];
		const remove = new Set(change.remove.map((name) => name.trim().toLowerCase()).filter((name) => name !== ""));
		const colors = new Map<string, FsTagColor>();
		if (add.length > 0) for (const tag of (await catalog()).tags) colors.set(tag.name.toLowerCase(), tag.color);
		const ok: string[] = [];
		const failed: FsOpError[] = [];
		await mapWithLimit(paths, WRITE_CONCURRENCY, async (path) => {
			try {
				const current = await readStored(path);
				// Entries the change does not name stay byte for byte, suffix included.
				const next = current.filter((stored) => !remove.has(tagNameOfStored(stored).toLowerCase()));
				for (const name of add) {
					if (next.some((stored) => tagNameOfStored(stored).toLowerCase() === name.toLowerCase())) continue;
					const color = colors.get(name.toLowerCase()) ?? 0;
					next.push(color === 0 ? name : `${name}\n${color}`);
				}
				if (next.length !== current.length || next.some((stored, index) => stored !== current[index])) await writeStored(path, next);
				ok.push(path);
				const names = new Map<string, boolean>();
				for (const name of remove) names.set(name, false);
				for (const name of add) names.set(name.toLowerCase(), true);
				const earlier = recentChanges.get(path)?.names;
				recentChanges.set(path, { names: new Map([...(earlier ?? []), ...names]), expiresAt: now() + INDEX_LAG_MS });
			} catch (error) {
				failed.push({ path, message: errorMessage(error) });
			}
		});
		return { ok, failed };
	}

	async function search(name: string): Promise<readonly string[]> {
		if (platform !== "darwin") return [];
		const query = `kMDItemUserTags == "${spotlightLiteral(name)}"cd`;
		const output = (await run(MDFIND, ["-0", query])).toString("utf8");
		const hits = new Set(output.split("\u0000").filter((path) => path !== ""));
		// Spotlight trails a write by a couple of seconds: this app's own recent
		// writes decide until the index has caught up.
		const wanted = name.trim().toLowerCase();
		const time = now();
		for (const [path, change] of recentChanges) {
			if (change.expiresAt <= time) {
				recentChanges.delete(path);
				continue;
			}
			const present = change.names.get(wanted);
			if (present === true) hits.add(path);
			else if (present === false) hits.delete(path);
		}
		return [...hits];
	}

	return { catalog, set, search };
}
