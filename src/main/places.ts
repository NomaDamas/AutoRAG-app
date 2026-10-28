/**
 * Sidebar places the OS itself knows about: the Finder/Explorer favorites, the
 * cloud drives connected to the OS (one row per account), and the mounted
 * disks. Nothing here is a fixed list of providers or drives — every cloud row
 * comes from a File Provider domain (macOS) or a registered sync root
 * (Windows), and every disk row from the live mount table.
 *
 * macOS
 * - Cloud: iCloud Drive's container plus each `~/Library/CloudStorage/<Provider>-<account>`
 *   domain, i.e. exactly what Finder lists under Locations › Cloud. Legacy
 *   `~/Dropbox` / `~/Google Drive` folders count when the provider has no domain.
 * - Disks: the boot volume at `/`, then every `/Volumes/*` entry that is a
 *   mount point in `mount` output without `nobrowse` (Finder hides those too).
 * - Eject: `diskutil unmount <mount point>`.
 *
 * Windows
 * - Favorites: the known-folder paths Electron resolves (so OneDrive folder
 *   redirection is honored), Program Files, and the user's Recycle Bin folder.
 * - Cloud: `HKLM\…\Explorer\SyncRootManager` roots registered for this user's SID.
 * - Disks: every `Win32_LogicalDisk`; a Google Drive virtual drive joins Cloud.
 * - Eject: `net use X: /delete` for network drives, the shell "Eject" verb otherwise.
 *
 * Both platforms
 * - Discord: one Cloud row per enabled Discord datasource of the AutoRAG config whose attachments folder
 *   (`<AUTORAG_HOME>/attachments/discord/<connection>`, see `discord-attachments.ts`) holds a file of the
 *   user's. The row opens that folder; a sync that saved nothing (only `download-status.json`, `.discrawl/`,
 *   `.lock/`) shows none.
 */

import { execFile } from "node:child_process";
import { readdir, readlink, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { basename, join, win32 } from "node:path";
import type { FsLocation, FsLocationIcon } from "../shared/fs-contract";
import type { KnownFolders } from "../shared/fs-worker-contract";
import { discordAttachmentFolders } from "./discord-attachments";
import { errorMessage, hasErrorCode, isAvailable, pathExists } from "./fs-entry";
import { POWERSHELL_UTF8_OUTPUT } from "./powershell-output";

/** Runs one OS command and resolves its stdout; rejects with stderr (or the spawn error) verbatim. */
export type PlaceCommandRunner = (command: string, args: readonly string[]) => Promise<string>;

export interface PlacesDeps {
	/** Defaults to os.homedir(). */
	readonly homeDir?: string;
	/** Defaults to process.platform. */
	readonly platform?: NodeJS.Platform;
	/** Defaults to execFile. */
	readonly run?: PlaceCommandRunner;
	/** macOS mount directory; defaults to /Volumes. */
	readonly volumesRoot?: string;
	/** macOS Applications folder; defaults to /Applications. */
	readonly applicationsDir?: string;
	/** Windows (SystemDrive, ProgramFiles) and the AutoRAG home and config (AUTORAG_HOME, AUTORAG_CONFIG); defaults to process.env. */
	readonly env?: Readonly<Record<string, string | undefined>>;
	/** Defaults to `<home>/<Folder>`; production passes Electron's resolved paths. */
	readonly knownFolders?: KnownFolders;
	/** Windows: resolves true once the drive letter no longer answers; defaults to a bounded poll. */
	readonly driveGone?: (letter: string) => Promise<boolean>;
}

export interface Places {
	/** Favorites, then cloud, then disks — each in sidebar order. */
	list(): Promise<readonly FsLocation[]>;
	/** Unmount the ejectable location at `path`; rejects with the OS reason. */
	eject(path: string): Promise<void>;
	/** Cheap fingerprint of what is mounted/connected; changes when a volume, cloud account or Discord attachments folder comes or goes. */
	signature(): Promise<string>;
	/** Poll `signature` and call `listener` whenever it moves. Returns the stop function. */
	watch(listener: () => void, intervalMs?: number): () => void;

	/**
	 * The user's Trash folder: `~/.Trash` on macOS/Linux, the boot drive's
	 * `<systemDrive>\$Recycle.Bin\<SID>` on Windows. Null when the SID is
	 * unknown. Restoring and emptying act on this folder.
	 */
	trashDir(): Promise<string | null>;
}

const COMMAND_TIMEOUT_MS = 15_000;
const DRIVE_GONE_TIMEOUT_MS = 5_000;
const DRIVE_GONE_POLL_MS = 250;
const WATCH_INTERVAL_MS = 2_000;
/** Mount types that reach a server, shown with the network glyph. */
const NETWORK_FS = ["smbfs", "nfs", "afpfs", "webdav", "cifs", "ftp"];
/** Win32_LogicalDisk.DriveType values. */
const DRIVE_REMOVABLE = 2;
const DRIVE_NETWORK = 4;
const DRIVE_CDROM = 5;
const SYNC_ROOT_KEY = "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager";

/** Display name and glyph per cloud provider id (CloudStorage prefix or SyncRootManager provider). */
const CLOUD_PROVIDERS: Readonly<Record<string, { readonly name: string; readonly icon: FsLocationIcon }>> = {
	GoogleDrive: { name: "Google Drive", icon: "google-drive" },
	GoogleDriveFS: { name: "Google Drive", icon: "google-drive" },
	OneDrive: { name: "OneDrive", icon: "onedrive" },
	Dropbox: { name: "Dropbox", icon: "dropbox" },
	Box: { name: "Box", icon: "box" },
	iCloudDrive: { name: "iCloud Drive", icon: "icloud" },
};

function defaultRun(command: string, args: readonly string[]): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(command, [...args], { timeout: COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
		if (error !== null) {
			const detail = stderr.trim();
			reject(new Error(detail.length > 0 ? detail : errorMessage(error)));
			return;
		}
		resolve(stdout);
	});
	return promise;
}

/** Entry names of `dir`, or none when it does not exist. */
async function namesIn(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch (error) {
		if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return [];
		throw error;
	}
}

function location(
	section: FsLocation["section"],
	name: string,
	path: string,
	icon: FsLocationIcon,
	flags: { readonly available: boolean; readonly scanned?: boolean; readonly ejectable?: boolean },
): FsLocation {
	return {
		name,
		path,
		section,
		icon,
		available: flags.available,
		scanned: flags.scanned ?? false,
		ejectable: flags.ejectable ?? false,
	};
}

/** A cloud provider's display entry: known providers get their product name and glyph. */
function cloudProvider(id: string): { readonly name: string; readonly icon: FsLocationIcon; readonly known: boolean } {
	const known = CLOUD_PROVIDERS[id];
	return known === undefined ? { name: id, icon: "cloud", known: false } : { ...known, known: true };
}

/** One `mount` output line: `<device> on <mount point> (<type>, <flags…>)`. */
interface MountRow {
	readonly device: string;
	readonly type: string;
	readonly flags: readonly string[];
}

function parseMount(output: string): Map<string, MountRow> {
	const rows = new Map<string, MountRow>();
	for (const line of output.split("\n")) {
		const match = /^(.+?) on (.+) \(([^)]*)\)$/.exec(line.trim());
		if (match === null) continue;
		const [, device = "", mountPoint = "", options = ""] = match;
		const [type = "", ...flags] = options.split(",").map((part) => part.trim());
		rows.set(mountPoint, { device, type, flags });
	}
	return rows;
}

/** Win32_LogicalDisk row as ConvertTo-Json prints it. */
interface LogicalDisk {
	readonly DeviceID: string;
	readonly VolumeName: string | null;
	readonly DriveType: number;
	readonly ProviderName: string | null;
}

const LOGICAL_DISKS_SCRIPT =
	`${POWERSHELL_UTF8_OUTPUT}; ` +
	"Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,ProviderName | ConvertTo-Json -Compress";

/** powershell.exe flags ahead of the `-Command` script. */
const POWERSHELL = ["-NoProfile", "-NonInteractive", "-Command"] as const;

/**
 * Sync roots from `reg query … /s`: each `<Provider>!<SID>!<account>` key, its
 * DisplayNameResource, and the folder its `UserSyncRoots` value maps for `sid`.
 */
function parseSyncRoots(output: string, sid: string): FsLocation[] {
	interface Root {
		provider: string;
		account: string;
		display: string | null;
		path: string | null;
	}
	const roots = new Map<string, Root>();
	let current: { readonly id: string; readonly userRoots: boolean } | null = null;
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line.startsWith("HKEY_")) {
			const marker = "\\SyncRootManager\\";
			const at = line.indexOf(marker);
			const rest = at < 0 ? "" : line.slice(at + marker.length);
			const [id = "", sub = ""] = rest.split("\\");
			const [provider = "", owner = "", ...account] = id.split("!");
			current = owner === sid ? { id, userRoots: sub === "UserSyncRoots" } : null;
			if (current !== null && !roots.has(id)) {
				roots.set(id, { provider, account: account.join("!"), display: null, path: null });
			}
			continue;
		}
		const value = /^\s+(\S.*?)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
		if (current === null || value === null) continue;
		const [, name = "", , data = ""] = value;
		const root = roots.get(current.id);
		if (root === undefined) continue;
		if (current.userRoots && name === sid) root.path = data;
		else if (!current.userRoots && name === "DisplayNameResource" && !data.startsWith("@")) root.display = data;
	}
	const result: FsLocation[] = [];
	for (const root of roots.values()) {
		if (root.path === null) continue;
		const provider = cloudProvider(root.provider);
		const name = root.display ?? (root.account === "" ? provider.name : `${provider.name} - ${root.account}`);
		result.push(location("cloud", name, root.path, provider.icon, { available: true, scanned: provider.known }));
	}
	return result;
}

async function defaultDriveGone(letter: string): Promise<boolean> {
	const deadline = Date.now() + DRIVE_GONE_TIMEOUT_MS;
	for (;;) {
		if (!(await pathExists(`${letter}\\`))) return true;
		if (Date.now() >= deadline) return false;
		await sleep(DRIVE_GONE_POLL_MS);
	}
}

export function createPlaces(deps: PlacesDeps = {}): Places {
	const home = deps.homeDir ?? homedir();
	const platform = deps.platform ?? process.platform;
	const run = deps.run ?? defaultRun;
	const env = deps.env ?? process.env;
	const volumesRoot = deps.volumesRoot ?? "/Volumes";
	const windows = platform === "win32";
	const known: KnownFolders = deps.knownFolders ?? {
		desktop: join(home, "Desktop"),
		documents: join(home, "Documents"),
		downloads: join(home, "Downloads"),
		music: join(home, "Music"),
		videos: join(home, windows ? "Videos" : "Movies"),
		pictures: join(home, "Pictures"),
	};
	const systemDrive = (env.SystemDrive ?? "C:").toUpperCase();
	const cloudStorage = join(home, "Library", "CloudStorage");
	const iCloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
	let userSid: Promise<string | null> | null = null;
	/** Cloud + disk rows cost subprocesses; they are reused until the signature moves. */
	let cached: { readonly signature: string; readonly rows: Promise<readonly FsLocation[]> } | null = null;

	/** The user's SID, or null when `whoami` cannot answer; only the per-user rows depend on it. */
	function sid(): Promise<string | null> {
		userSid ??= run("whoami", ["/user", "/fo", "csv", "/nh"])
			.then((output) => {
				const match = /"(S-[\d-]+)"/.exec(output);
				if (match?.[1] === undefined) throw new Error(`whoami printed no SID: ${output.trim()}`);
				return match[1];
			})
			.catch((error: unknown) => {
				console.warn(`places: no user SID, skipping the Recycle Bin and sync roots: ${errorMessage(error)}`);
				return null;
			});
		return userSid;
	}

	async function favorites(): Promise<FsLocation[]> {
		const userSid = windows ? await sid() : null;
		const specs: [string, string, FsLocationIcon, boolean][] = windows
			? [
					[win32.basename(home), home, "home", false],
					["Program Files", env.ProgramFiles ?? `${systemDrive}\\Program Files`, "applications", false],
					["Desktop", known.desktop, "desktop", true],
					["Documents", known.documents, "documents", true],
					["Downloads", known.downloads, "downloads", true],
					["Music", known.music, "music", false],
					["Videos", known.videos, "movies", false],
					["Pictures", known.pictures, "pictures", false],
					...(userSid === null
						? []
						: [["Recycle Bin", `${systemDrive}\\$Recycle.Bin\\${userSid}`, "trash", false] as [string, string, FsLocationIcon, boolean]]),
				]
			: [
					[basename(home), home, "home", false],
					["Applications", deps.applicationsDir ?? "/Applications", "applications", false],
					["Desktop", known.desktop, "desktop", true],
					["Documents", known.documents, "documents", true],
					["Downloads", known.downloads, "downloads", true],
					["Music", known.music, "music", false],
					["Movies", known.videos, "movies", false],
					["Pictures", known.pictures, "pictures", false],
					["Trash", join(home, ".Trash"), "trash", false],
				];
		return Promise.all(
			specs.map(async ([name, path, icon, scanned]) =>
				location("favorites", name, path, icon, { available: await isAvailable(path), scanned }),
			),
		);
	}

	async function macCloud(): Promise<FsLocation[]> {
		const rows: FsLocation[] = [];
		if (await pathExists(iCloud)) {
			rows.push(location("cloud", "iCloud Drive", iCloud, "icloud", { available: true, scanned: true }));
		}
		const domains: FsLocation[] = [];
		const providers = new Set<string>();
		for (const entry of await namesIn(cloudStorage)) {
			if (entry.startsWith(".")) continue;
			const dash = entry.indexOf("-");
			const id = dash < 0 ? entry : entry.slice(0, dash);
			const provider = cloudProvider(id);
			providers.add(id);
			const name = dash < 0 ? provider.name : `${provider.name} - ${entry.slice(dash + 1)}`;
			domains.push(
				location("cloud", name, join(cloudStorage, entry), provider.icon, { available: true, scanned: provider.known }),
			);
		}
		// Pre-File-Provider installs keep a plain folder in the home directory.
		for (const [id, folder] of [["Dropbox", "Dropbox"], ["GoogleDrive", "Google Drive"]] as const) {
			const legacy = join(home, folder);
			if (!providers.has(id) && (await pathExists(legacy))) {
				const provider = cloudProvider(id);
				domains.push(location("cloud", provider.name, legacy, provider.icon, { available: true, scanned: true }));
			}
		}
		domains.sort((a, b) => a.name.localeCompare(b.name));
		return [...rows, ...domains];
	}

	async function macDisks(): Promise<FsLocation[]> {
		let mounts = new Map<string, MountRow>();
		try {
			mounts = parseMount(await run("mount", []));
		} catch (error) {
			console.warn(`places: mount failed, listing the boot disk only: ${errorMessage(error)}`);
		}
		let bootName = "Macintosh HD";
		const volumes: FsLocation[] = [];
		for (const entry of await namesIn(volumesRoot)) {
			if (entry.startsWith(".")) continue;
			const path = join(volumesRoot, entry);
			const target = await readlink(path).catch(() => null);
			if (target === "/") {
				bootName = entry;
				continue;
			}
			const mount = mounts.get(path);
			if (mount === undefined || mount.flags.includes("nobrowse")) continue;
			const network = NETWORK_FS.includes(mount.type) || mount.device.startsWith("//");
			volumes.push(location("locations", entry, path, network ? "network" : "disk", { available: true, ejectable: true }));
		}
		volumes.sort((a, b) => a.name.localeCompare(b.name));
		return [location("locations", bootName, "/", "disk", { available: true }), ...volumes];
	}

	async function logicalDisks(): Promise<readonly LogicalDisk[]> {
		try {
			const parsed: unknown = JSON.parse(await run("powershell.exe", [...POWERSHELL, LOGICAL_DISKS_SCRIPT]));
			return (Array.isArray(parsed) ? parsed : [parsed]) as LogicalDisk[];
		} catch (error) {
			console.warn(`places: Win32_LogicalDisk failed, listing the system drive only: ${errorMessage(error)}`);
			return [{ DeviceID: systemDrive, VolumeName: null, DriveType: 3, ProviderName: null }];
		}
	}

	async function windowsRows(): Promise<FsLocation[]> {
		let cloud: FsLocation[] = [];
		const userSid = await sid();
		if (userSid !== null) {
			try {
				cloud = parseSyncRoots(await run("reg", ["query", SYNC_ROOT_KEY, "/s"]), userSid);
			} catch (error) {
				// No SyncRootManager key means no cloud provider is registered.
				console.warn(`places: no sync roots: ${errorMessage(error)}`);
			}
		}
		const disks: FsLocation[] = [];
		for (const disk of await logicalDisks()) {
			const letter = disk.DeviceID.toUpperCase();
			const path = `${letter}\\`;
			const label = disk.VolumeName?.trim() ?? "";
			if (label === "Google Drive") {
				cloud.push(location("cloud", `Google Drive (${letter})`, path, "google-drive", { available: true, scanned: true }));
				continue;
			}
			const network = disk.DriveType === DRIVE_NETWORK;
			const fallback = network
				? win32.basename(disk.ProviderName ?? letter)
				: disk.DriveType === DRIVE_CDROM
					? "CD Drive"
					: disk.DriveType === DRIVE_REMOVABLE
						? "USB Drive"
						: "Local Disk";
			disks.push(
				location("locations", `${label === "" ? fallback : label} (${letter})`, path, network ? "network" : "disk", {
					available: true,
					ejectable: letter !== systemDrive,
				}),
			);
		}
		return [...cloud, ...disks];
	}

	/** What is mounted or connected at the OS level; the cached cloud and disk rows are valid while it holds. */
	async function mountSignature(): Promise<string> {
		if (windows) {
			const letters: string[] = [];
			for (let code = 65; code <= 90; code += 1) {
				const letter = String.fromCharCode(code);
				if (await pathExists(`${letter}:\\`)) letters.push(letter);
			}
			return letters.join("");
		}
		const [volumes, domains, hasICloud] = await Promise.all([
			namesIn(volumesRoot),
			namesIn(cloudStorage),
			pathExists(iCloud),
		]);
		// The mount point directory appears before the mount completes; its device id
		// changing is what marks the volume as actually mounted.
		const devices = await Promise.all(
			volumes.sort().map(async (name) => {
				const info = await stat(join(volumesRoot, name)).catch(() => null);
				return `${name}:${info?.dev ?? "-"}`;
			}),
		);
		return JSON.stringify([devices, domains.sort(), hasICloud]);
	}

	/**
	 * One row per connected Discord source whose attachments folder holds something of the user's. Read on
	 * every call, not cached with the mounts: it depends on the config and on what the last refresh saved.
	 */
	async function discordRows(): Promise<FsLocation[]> {
		const folders = await discordAttachmentFolders(env, home);
		return folders.map(({ connection, path }) =>
			location("cloud", folders.length === 1 ? "Discord" : `Discord - ${connection}`, path, "discord", { available: true, scanned: true }),
		);
	}

	async function signature(): Promise<string> {
		const [mounted, discord] = await Promise.all([mountSignature(), discordAttachmentFolders(env, home)]);
		// Which folders are shown, not how many files they hold: the first attachment and a connection
		// being switched on or off move it, the thousandth download does not.
		return JSON.stringify([mounted, discord.map((folder) => folder.path)]);
	}

	async function mountedRows(): Promise<readonly FsLocation[]> {
		const current = await mountSignature();
		if (cached === null || cached.signature !== current) {
			const rows = windows ? windowsRows() : Promise.all([macCloud(), macDisks()]).then((parts) => parts.flat());
			cached = { signature: current, rows };
			// A failed detection must not stick.
			rows.catch(() => {
				if (cached?.rows === rows) cached = null;
			});
		}
		return cached.rows;
	}

	async function list(): Promise<readonly FsLocation[]> {
		const [favoriteRows, rows, discord] = await Promise.all([favorites(), mountedRows(), discordRows()]);
		return [...favoriteRows, ...rows, ...discord];
	}

	async function eject(path: string): Promise<void> {
		// Re-detect: the row the user clicked must still be mounted right now.
		cached = null;
		const target = (await mountedRows()).find((row) => row.ejectable && row.path === path);
		if (target === undefined) {
			throw new Error(`"${path}" is not an ejectable volume`);
		}
		try {
			if (!windows) {
				await run("diskutil", ["unmount", path]);
				return;
			}
			const letter = path.slice(0, 2).toUpperCase();
			if (target.icon === "network") {
				await run("net", ["use", letter, "/delete", "/y"]);
				return;
			}
			await run(
				"powershell.exe",
				[...POWERSHELL, `(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${letter}').InvokeVerb('Eject')`],
			);
			if (!(await (deps.driveGone ?? defaultDriveGone)(letter))) {
				throw new Error(`${letter} is still mounted — Windows did not release the drive`);
			}
		} finally {
			cached = null;
		}
	}

	/** The Trash folder the sidebar's Trash row shows. */
	async function trashDir(): Promise<string | null> {
		if (!windows) return join(home, ".Trash");
		const userSid = await sid();
		return userSid === null ? null : `${systemDrive}\\$Recycle.Bin\\${userSid}`;
	}

	function watch(listener: () => void, intervalMs = WATCH_INTERVAL_MS): () => void {
		let last: string | null = null;
		let busy = true;
		const tick = (): void => {
			signature()
				.then((next) => {
					if (last !== null && next !== last) listener();
					last = next;
				})
				.catch((error: unknown) => console.warn(`places: signature failed: ${errorMessage(error)}`))
				.finally(() => {
					busy = false;
				});
		};
		// The baseline is taken now, before the window's first `locations()`,
		// so a volume mounted during startup still counts as a change.
		tick();
		const timer = setInterval(() => {
			if (busy) return;
			busy = true;
			tick();
		}, intervalMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	return { list, eject, signature, watch, trashDir };
}
