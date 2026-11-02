/**
 * Path helpers shared by the sidebar, breadcrumbs, and list rows.
 *
 * Paths are plain strings and every convention round-trips: OS-absolute posix
 * ("/Users/x/Documents"), Windows drive and UNC ("C:\Users\x",
 * "\\server\share\x") from the fs bridge, and prototype-style relative roots
 * ("Documents/Finance") from the fixtures.
 */

import { isTagPath, tagNameOf } from "../../../shared/fs-contract";

interface PathRoot {
	readonly prefix: string;
	readonly separator: "/" | "\\";
	/** Leading segments owned by the root; never rendered as crumb labels. */
	readonly skip: number;
}

const DRIVE_ROOT = /^([A-Za-z]:)[\\/]/;
const UNC_ROOT = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/;

function pathRoot(path: string): PathRoot | null {
	const drive = DRIVE_ROOT.exec(path);
	if (drive !== null) {
		return { prefix: `${drive[1]}\\`, separator: "\\", skip: 1 };
	}
	const unc = UNC_ROOT.exec(path);
	if (unc !== null) {
		return { prefix: `\\\\${unc[1]}\\${unc[2]}\\`, separator: "\\", skip: 2 };
	}
	if (path.startsWith("/")) {
		return { prefix: "/", separator: "/", skip: 0 };
	}
	return null;
}

/**
 * Volume label for the decorative root crumb a "Users"-rooted path sits on.
 * The breadcrumb trail never renders the root, so the bar reconstructs it:
 * a Windows drive shows as "C:", a UNC share as its `\\server\share` prefix,
 * and a POSIX boot volume keeps the macOS Finder label.
 */
export function volumeLabel(path: string): string {
	const drive = DRIVE_ROOT.exec(path);
	if (drive !== null) return drive[1]!.toUpperCase();
	const unc = UNC_ROOT.exec(path);
	if (unc !== null) return `\\\\${unc[1]}\\${unc[2]}`;
	return "Macintosh HD";
}

/**
 * The drive (`C:\`) or share (`\\server\share\`) a Windows path sits on, or null for any other path. The path bar
 * shows it as the top folder of every Windows location, not only of the ones under `Users`.
 */
export function windowsRootPath(path: string): string | null {
	const root = pathRoot(path);
	return root !== null && root.separator === "\\" ? root.prefix : null;
}

function separatorOf(path: string): "/" | "\\" {
	const root = pathRoot(path);
	if (root !== null) {
		return root.separator;
	}
	return path.lastIndexOf("\\") > path.lastIndexOf("/") ? "\\" : "/";
}

export function isAbsolutePath(path: string): boolean {
	return pathRoot(path) !== null;
}

export function pathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

export function basename(path: string): string {
	const segments = pathSegments(path);
	return segments[segments.length - 1] ?? "";
}

export function dirname(path: string): string {
	const segments = pathSegments(path);
	const root = pathRoot(path);
	if (root === null) {
		if (segments.length <= 1) {
			return "";
		}
		return segments.slice(0, -1).join("/");
	}
	const rest = segments.slice(root.skip);
	if (rest.length <= 1) {
		return root.prefix;
	}
	return root.prefix + rest.slice(0, -1).join(root.separator);
}

export function joinPath(dir: string, name: string): string {
	if (dir === "") {
		return name;
	}
	if (dir.endsWith("/") || dir.endsWith("\\")) {
		return dir + name;
	}
	return `${dir}${separatorOf(dir)}${name}`;
}

/** Location rendered with the reference separator, e.g. "Documents › Finance". */
export function whereSegments(path: string): string {
	return pathSegments(path).join(" › ");
}

/** Where a typed or pasted location is resolved from. */
export interface PathInputContext {
	/** The folder in view; a relative entry is resolved against it when it is absolute. */
	readonly current: string;
	/** The user's home folder, for `~`; null when unknown. */
	readonly home: string | null;
}

const QUOTED = /^(["'])(.*)\1$/s;
const FILE_URL = /^file:\/\/(?:localhost)?(?=\/)/i;
const BARE_DRIVE = /^[A-Za-z]:$/;

/**
 * The folder path a typed or pasted location names (the path bar's editor),
 * or null when it names nothing. Accepts absolute POSIX, drive and UNC paths,
 * `~`, `file://` URLs, quoted paths, and paths relative to the folder in view;
 * the result is normalized (no `.`/`..`, repeated or trailing separators) in
 * the convention of its root.
 */
export function resolvePathInput(input: string, context: PathInputContext): string | null {
	let text = input.trim();
	const quoted = QUOTED.exec(text);
	if (quoted !== null) text = (quoted[2] ?? "").trim();
	if (text === "") return null;
	if (FILE_URL.test(text)) {
		try {
			text = decodeURIComponent(text.replace(FILE_URL, ""));
		} catch {
			return null;
		}
		// "file:///C:/x" carries the drive behind a slash.
		if (/^\/[A-Za-z]:[\\/]/.test(text)) text = text.slice(1);
	}
	if (BARE_DRIVE.test(text)) text += "\\";
	if (text === "~" || text.startsWith("~/") || text.startsWith("~\\")) {
		if (context.home === null) return null;
		text = context.home + text.slice(1);
	} else if (!isAbsolutePath(text) && isAbsolutePath(context.current)) {
		text = joinPath(context.current, text);
	}
	const root = pathRoot(text);
	const parts: string[] = [];
	for (const segment of pathSegments(text).slice(root?.skip ?? 0)) {
		if (segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	if (root === null) return parts.length === 0 ? null : parts.join("/");
	return root.prefix + parts.join(root.separator);
}

export interface PathCompletionEntry {
	readonly name: string;
	readonly path: string;
	readonly kind: "folder" | "file";
}

export interface PathCompletion {
	/** On-disk folder name shown in the candidate row. */
	readonly name: string;
	/** Absolute folder path used for navigation. */
	readonly path: string;
	/** Draft after acceptance; keeps the user's ~, relative, and separator spelling. */
	readonly text: string;
}

/**
 * Complete the last path segment from direct child folders. The parent is
 * resolved with the same rules as Enter, while the accepted draft retains the
 * user's original prefix instead of unexpectedly expanding `~` or a relative
 * path. URLs and quoted paths keep their existing paste-and-Enter behavior.
 */
export async function completePath(
	input: string,
	context: PathInputContext,
	list: (dir: string) => Promise<readonly PathCompletionEntry[]>,
): Promise<readonly PathCompletion[]> {
	if (FILE_URL.test(input) || input.startsWith('"') || input.startsWith("'")) return [];
	const separator = Math.max(input.lastIndexOf("/"), input.lastIndexOf("\\"));
	const prefix = separator < 0 ? "" : input.slice(0, separator + 1);
	const query = input.slice(separator + 1).toLocaleLowerCase();
	const directory = prefix === "" ? context.current : resolvePathInput(prefix, context);
	if (directory === null) return [];
	const entries = await list(directory);
	return entries.flatMap((entry) =>
		entry.kind === "folder" && entry.name.toLocaleLowerCase().startsWith(query)
			? [{ name: entry.name, path: entry.path, text: prefix + entry.name }]
			: [],
	);
}

export interface Crumb {
	readonly label: string;
	readonly path: string;
	/** True when a separator precedes this crumb. */
	readonly separator: boolean;
	readonly isLast: boolean;
}

/**
 * At most the last `maxSegments` segments, prefixed with a "…" crumb that
 * navigates one level above the visible window (handoff README §2 Toolbar).
 */
export function breadcrumbTrail(path: string, maxSegments = 2): Crumb[] {
	// A tag is one place, not a folder path: "tag://Green" must not read as "tag:" › "Green".
	if (isTagPath(path)) return [{ label: tagNameOf(path), path, separator: false, isLast: true }];
	const segments = pathSegments(path);
	if (segments.length === 0) {
		return [];
	}
	const root = pathRoot(path);
	const prefix = root?.prefix ?? "";
	const separator = root?.separator ?? separatorOf(path);
	const parts = segments.slice(root?.skip ?? 0);
	if (parts.length === 0) {
		return [];
	}
	const pathAt = (index: number): string => prefix + parts.slice(0, index + 1).join(separator);
	const start = Math.max(0, parts.length - maxSegments);
	const crumbs: Crumb[] = [];
	if (start > 0) {
		crumbs.push({ label: "…", path: pathAt(start - 1), separator: false, isLast: false });
	}
	for (let i = start; i < parts.length; i++) {
		crumbs.push({
			label: parts[i] ?? "",
			path: pathAt(i),
			separator: i > start || start > 0,
			isLast: i === parts.length - 1,
		});
	}
	return crumbs;
}

export interface NavTarget {
	readonly name: string;
	readonly path: string;
}

/** `path` with a trailing separator, so ownership checks never match a partial segment. */
export function parentPrefix(path: string): string {
	return path.endsWith("/") || path.endsWith("\\") ? path : path + separatorOf(path);
}

/**
 * A path typed or pasted into the path bar, made ready to look up: surrounding
 * quotes (a path copied from a shell) and whitespace go, `~` expands to `home`,
 * and trailing separators drop, except on a root (`/`, `C:\`), which stays
 * itself. Empty when nothing usable remains.
 */
export function normalizeTypedPath(text: string, home: string | null): string {
	let value = text.trim();
	const quoted = /^(["'])(.*)\1$/u.exec(value);
	if (quoted !== null) value = (quoted[2] ?? "").trim();
	if (value === "") return "";
	if (home !== null && (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))) {
		value = home + value.slice(1);
	}
	const floor = Math.max(pathRoot(value)?.prefix.length ?? 0, 1);
	let end = value.length;
	while (end > floor && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
	return value.slice(0, end);
}

/** The sidebar entry that owns `path` — the longest matching nav path. */
export function activeNavPath(path: string, targets: readonly NavTarget[]): string | null {
	let best: string | null = null;
	for (const target of targets) {
		const owns = path === target.path || path.startsWith(parentPrefix(target.path));
		if (owns && (best === null || target.path.length > best.length)) {
			best = target.path;
		}
	}
	return best;
}
