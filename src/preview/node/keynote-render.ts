import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

/** Keynote's bundle ids, the one that ships with macOS-era iWork first, then the Creator Studio one. */
const KEYNOTE_BUNDLE_IDS = ["com.apple.iWork.Keynote", "com.apple.Keynote"] as const;
/** A deck opens, draws every slide, and closes in seconds; this bounds a hung dialog (a password, a missing-font sheet). */
const EXPORT_TIMEOUT_MS = 180_000;
/** Every slide of a deck together may not exceed this, so a huge deck degrades instead of filling memory. */
const DECK_BYTE_CAP = 256 * 1024 * 1024;
/** Disk the exported slides may use; the least recently shown decks go first. */
const CACHE_BYTES = 1024 * 1024 * 1024;
/** A scratch folder this old belongs to a run that died. */
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000;
/** Keynote writes `<folder>.001.jpeg`, `<folder>.002.jpeg`, ... into the folder it is given. */
const SLIDE_FILE = /\.(\d+)\.jpe?g$/i;

/** What identifies one version of a deck: a changed deck must never be served stale slides. */
export interface KeynoteFileIdentity {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

/** One Keynote run: open `path`, write every slide as a JPEG into the existing folder `outDir`, leave Keynote as it was. */
export interface KeynoteExport {
	(job: { readonly path: string; readonly outDir: string; readonly bundleId: string }): Promise<void>;
}

/** Spotlight's answer for one bundle id: the matching apps, one path per line. */
export type FindApps = (bundleId: string) => Promise<string>;

const defaultFindApps: FindApps = (bundleId) =>
	new Promise((resolve, reject) => {
		execFile("mdfind", [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 10_000 }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
	});

/**
 * The bundle id of an installed Keynote, or null. Only macOS has Keynote, and
 * only Spotlight is asked: addressing an app that is not installed would make
 * AppleScript show a "Where is Keynote?" dialog.
 */
export async function findInstalledKeynote(platform: NodeJS.Platform, findApps: FindApps = defaultFindApps): Promise<string | null> {
	if (platform !== "darwin") return null;
	for (const bundleId of KEYNOTE_BUNDLE_IDS) {
		const found = await findApps(bundleId).catch(() => "");
		if (found.trim().length > 0) return bundleId;
	}
	return null;
}

/**
 * The AppleScript behind {@link exportWithKeynote}. A deck the user already has
 * open is exported as it is and stays open; a deck this run opened is closed
 * without saving. The failure is raised only after that cleanup.
 */
function exportScript(bundleId: string): string[] {
	const app = `application id "${bundleId}"`;
	return [
		"on run argv",
		"set thePath to item 1 of argv",
		"set theFile to POSIX file thePath",
		"set outDir to POSIX file (item 2 of argv)",
		`set wasRunning to ${app} is running`,
		`tell ${app}`,
		"set theDoc to missing value",
		"set weOpened to false",
		"set failure to missing value",
		"try",
		"if wasRunning then",
		"repeat with candidate in documents",
		"try",
		"if (POSIX path of (file of candidate as alias)) is thePath then",
		"set theDoc to contents of candidate",
		"exit repeat",
		"end if",
		"end try",
		"end repeat",
		"end if",
		"if theDoc is missing value then",
		"set theDoc to open theFile",
		"set weOpened to true",
		"end if",
		"export theDoc to outDir as slide images with properties {image format:JPEG, skipped slides:true, compression factor:0.85}",
		"on error errMsg number errNum",
		"set failure to {errMsg, errNum}",
		"end try",
		"if weOpened then",
		"try",
		"close theDoc saving no",
		"end try",
		"end if",
		"end tell",
		"if failure is not missing value then error (item 1 of failure) number (item 2 of failure)",
		"end run",
	];
}

/** Quits Keynote only while it has no document: never takes down a deck the user opened meanwhile. */
function quitIfIdleScript(bundleId: string): string[] {
	const app = `application id "${bundleId}"`;
	return [`if ${app} is running then`, `tell ${app}`, "if (count of documents) is 0 then quit", "end tell", "end if"];
}

function osascript(lines: readonly string[], args: readonly string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("osascript", [...lines.flatMap((line) => ["-e", line]), ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
			if (error === null) return resolve(stdout.trim());
			reject(new Error(stderr.trim().length > 0 ? stderr.trim() : error.message));
		});
	});
}

const isRunning = async (bundleId: string): Promise<boolean> =>
	(await osascript([`application id "${bundleId}" is running`], [], 10_000).catch(() => "false")) === "true";

const QUIT_ATTEMPTS = 3;
const QUIT_RETRY_MS = 1000;

function lsappinfo(args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("lsappinfo", args, { timeout: 10_000 }, (error, stdout) => (error === null ? resolve(stdout) : reject(error)));
	});
}

/** The process id of the running Keynote with this bundle id, or null. */
async function keynotePid(bundleId: string): Promise<number | null> {
	const asn = (await lsappinfo(["find", `bundleid=${bundleId}`]).catch(() => "")).trim();
	if (asn.length === 0) return null;
	const pid = /"pid"=(\d+)/.exec(await lsappinfo(["info", "-only", "pid", asn]).catch(() => ""))?.[1];
	return pid === undefined ? null : Number(pid);
}

/**
 * Leaves Keynote as this run found it. A Keynote this run launched is quit once
 * it holds no document. A deck it cannot open makes Keynote raise an alert a
 * moment after the failed `open`, and a Keynote showing its document picker or
 * such an alert ignores `quit` for good; one that is still running after a few
 * tries with no document open holds nothing to lose and is terminated, so the
 * user is never left with an invisible Keynote that will not launch again.
 */
async function quitLaunchedKeynote(bundleId: string): Promise<void> {
	for (let attempt = 0; attempt < QUIT_ATTEMPTS; attempt += 1) {
		await osascript(quitIfIdleScript(bundleId), [], 15_000).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, QUIT_RETRY_MS));
		if (!(await isRunning(bundleId))) return;
	}
	const count = await osascript([`tell application id "${bundleId}" to count documents`], [], 15_000).catch(() => "unknown");
	const pid = count === "0" ? await keynotePid(bundleId) : null;
	if (pid !== null) process.kill(pid, "SIGTERM");
}

/** Draws every slide of a deck through the Keynote app (a GUI launch: seconds per deck). */
export const exportWithKeynote: KeynoteExport = async ({ path, outDir, bundleId }) => {
	const real = await realpath(path);
	const wasRunning = await isRunning(bundleId);
	try {
		await osascript(exportScript(bundleId), [real, outDir], EXPORT_TIMEOUT_MS);
	} finally {
		if (!wasRunning) await quitLaunchedKeynote(bundleId);
	}
};

/** The slide JPEGs in `folder` in show order (numeric, not lexical), or null when they exceed the byte cap. */
async function readSlides(folder: string): Promise<Uint8Array[] | null> {
	const numbered = (await readdir(folder))
		.map((name) => ({ name, index: SLIDE_FILE.exec(name)?.[1] }))
		.filter((entry): entry is { name: string; index: string } => entry.index !== undefined)
		.sort((a, b) => Number(a.index) - Number(b.index));
	const slides: Uint8Array[] = [];
	let total = 0;
	for (const { name } of numbered) {
		const bytes = await readFile(join(folder, name));
		total += bytes.byteLength;
		if (total > DECK_BYTE_CAP) return null;
		slides.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
	}
	return slides;
}

async function folderBytes(folder: string): Promise<number> {
	let total = 0;
	for (const name of await readdir(folder)) total += (await stat(join(folder, name))).size;
	return total;
}

export interface KeynoteSlideCacheDeps {
	/** Where the rendered decks live; created on first use. */
	readonly dir: string;
	/** The bundle id of the installed Keynote, or null. Defaults to asking Spotlight once. */
	readonly installed?: () => Promise<string | null>;
	readonly export?: KeynoteExport;
	/** Bytes of slides kept on disk. Defaults to 1GB. */
	readonly maxBytes?: number;
	readonly warn?: (message: string) => void;
}

export interface KeynoteSlideCache {
	/** Whether {@link render} can produce slides for this deck: Keynote is installed and has not already failed on this version of it. */
	available(file: KeynoteFileIdentity): Promise<boolean>;
	/** The full-size slides already on disk for this version of the deck; never starts Keynote. */
	lookup(file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null>;
	/** {@link lookup}, else a Keynote export (one at a time; a run for the same deck is joined). Null when Keynote cannot draw all `expected` slides. Never rejects. */
	render(file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null>;
}

function identityKey(file: KeynoteFileIdentity): string {
	return createHash("sha256").update(`${file.path}\u0000${file.mtimeMs}\u0000${file.size}`).digest("hex").slice(0, 32);
}

/**
 * Slides drawn by Keynote itself, kept per deck version under `dir`. Launching
 * Keynote takes seconds, so a deck is exported at most once per version: the
 * folder is named by path + modification time + size and is moved into place
 * only when whole, which makes its presence the proof of a finished export.
 */
export function createKeynoteSlideCache(deps: KeynoteSlideCacheDeps): KeynoteSlideCache {
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const maxBytes = deps.maxBytes ?? CACHE_BYTES;
	const run = deps.export ?? exportWithKeynote;
	let found: Promise<string | null> | null = null;
	const installed = (): Promise<string | null> => {
		found ??= (deps.installed ?? (() => findInstalledKeynote(process.platform)))();
		return found;
	};
	const running = new Map<string, Promise<Uint8Array[] | null>>();
	let queue: Promise<unknown> = Promise.resolve();

	const lookup = async (file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null> => {
		const folder = join(deps.dir, identityKey(file));
		const slides = await readSlides(folder).catch(() => null);
		if (slides === null) return null;
		if (slides.length !== expected) {
			await rm(folder, { recursive: true, force: true });
			return null;
		}
		const now = new Date();
		await utimes(folder, now, now).catch(() => undefined);
		return slides;
	};

	const prune = async (keep: string): Promise<void> => {
		const survivors: Array<{ readonly name: string; readonly bytes: number; readonly usedAt: number }> = [];
		for (const name of await readdir(deps.dir)) {
			const folder = join(deps.dir, name);
			const info = await stat(folder).catch(() => null);
			if (info === null || !info.isDirectory()) continue;
			if (name.startsWith(".tmp-")) {
				if (Date.now() - info.mtimeMs > SCRATCH_MAX_AGE_MS) await rm(folder, { recursive: true, force: true });
				continue;
			}
			survivors.push({ name, bytes: await folderBytes(folder).catch(() => 0), usedAt: info.mtimeMs });
		}
		let total = 0;
		for (const entry of survivors.sort((a, b) => b.usedAt - a.usedAt)) {
			total += entry.bytes;
			if (total > maxBytes && entry.name !== keep) await rm(join(deps.dir, entry.name), { recursive: true, force: true });
		}
	};

	/** Decks Keynote failed on this session: asking again would only launch it for another alert. */
	const failed = new Set<string>();
	const draw = async (file: KeynoteFileIdentity, expected: number): Promise<Uint8Array[] | null> => {
		const cached = await lookup(file, expected);
		if (cached !== null) return cached;
		if (failed.has(identityKey(file))) return null;
		const bundleId = await installed();
		if (bundleId === null) return null;
		const key = identityKey(file);
		await mkdir(deps.dir, { recursive: true });
		const scratch = join(deps.dir, `.tmp-${randomBytes(6).toString("hex")}`);
		const outDir = join(scratch, "slides");
		try {
			await mkdir(outDir, { recursive: true });
			await run({ path: file.path, outDir, bundleId });
			const slides = await readSlides(outDir);
			if (slides === null || slides.length !== expected) {
				warn(`quick-look: Keynote drew ${slides === null ? "too much" : `${slides.length} slide(s)`} for ${file.path}, expected ${expected}; keeping the stored slides`);
				failed.add(key);
				return null;
			}
			const folder = join(deps.dir, key);
			await rm(folder, { recursive: true, force: true });
			await rename(outDir, folder);
			await prune(key).catch(() => undefined);
			return slides;
		} catch (error) {
			warn(`quick-look: Keynote render of ${file.path} failed: ${error instanceof Error ? error.message : String(error)}`);
			failed.add(key);
			return null;
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	};

	return {
		available: async (file) => (await installed()) !== null && !failed.has(identityKey(file)),
		lookup,
		render(file, expected) {
			const key = identityKey(file);
			const known = running.get(key);
			if (known !== undefined) return known;
			const job = queue.then(() => draw(file, expected)).finally(() => running.delete(key));
			queue = job.catch(() => undefined);
			running.set(key, job);
			return job;
		},
	};
}

/** What the panel shows of a Keynote deck: the full-size slides when known, and whether Keynote is still drawing them. */
export interface KeynoteSlidesState {
	readonly pages: readonly Uint8Array[] | null;
	readonly rendering: boolean;
}

export interface OpenKeynoteDeps {
	readonly cache: Pick<KeynoteSlideCache, "available" | "lookup" | "render">;
	/** Sends a later state of this open to the preview window. */
	readonly publish: (update: KeynoteSlidesState) => void;
	/** False once the preview has moved on to another file; nothing more is published then. */
	readonly current: () => boolean;
}

/**
 * The state to open a Keynote deck with. A deck drawn before opens with its
 * full-size slides. Otherwise, when Keynote is installed, the panel opens at
 * once on the stored 356px slides (`rendering`) and `publish` delivers the
 * full-size ones when Keynote is done, or `pages: null` when it could not draw
 * them. Without Keynote nothing changes and nothing is published.
 */
export async function openKeynoteSlides(file: KeynoteFileIdentity, expected: number, deps: OpenKeynoteDeps): Promise<KeynoteSlidesState> {
	const cached = await deps.cache.lookup(file, expected);
	if (cached !== null) return { pages: cached, rendering: false };
	if (!(await deps.cache.available(file))) return { pages: null, rendering: false };
	void deps.cache.render(file, expected).then((pages) => {
		if (deps.current()) deps.publish({ pages, rendering: false });
	});
	return { pages: null, rendering: true };
}
