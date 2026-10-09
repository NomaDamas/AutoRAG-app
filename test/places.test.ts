import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlaces, type PlaceCommandRunner, type PlacesDeps } from "../src/main/places";
import { readRecycleBinName, readRecycleBinRecord } from "../src/main/recycle-bin";
import type { FsLocation } from "../src/shared/fs-contract";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-places-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Call {
	readonly command: string;
	readonly args: readonly string[];
}

/** A command runner answering from a table keyed by command name; every call is recorded. */
function runner(outputs: Readonly<Record<string, string | Error>>): { run: PlaceCommandRunner; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		run: async (command, args) => {
			calls.push({ command, args });
			const output = outputs[command];
			if (output instanceof Error) throw output;
			if (output === undefined) throw new Error(`unexpected command ${command}`);
			return output;
		},
	};
}

function bySection(locations: readonly FsLocation[], section: FsLocation["section"]): readonly FsLocation[] {
	return locations.filter((location) => location.section === section);
}

describe("macOS places", () => {
	async function macHome(): Promise<string> {
		const home = join(root, "jeffrey");
		for (const dir of ["Desktop", "Documents", "Downloads", "Music", "Movies", "Pictures", ".Trash"]) {
			await mkdir(join(home, dir), { recursive: true });
		}
		return home;
	}

	it("lists the Finder favorites in Finder order, named after the user and the OS folders", async () => {
		// Given a macOS home with every standard folder
		const home = await macHome();
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});
		await mkdir(join(root, "Applications"));

		// When listing places
		const favorites = bySection(await places.list(), "favorites");

		// Then home, Applications, the standard folders, and the Trash appear in that order
		expect(favorites.map((location) => [location.name, location.icon])).toEqual([
			["jeffrey", "home"],
			["Applications", "applications"],
			["Desktop", "desktop"],
			["Documents", "documents"],
			["Downloads", "downloads"],
			["Music", "music"],
			["Movies", "movies"],
			["Pictures", "pictures"],
			["Trash", "trash"],
		]);
		expect(favorites.find((location) => location.name === "Trash")?.path).toBe(join(home, ".Trash"));
		// And only the content folders join search and the version-family scan
		expect(favorites.filter((location) => location.scanned).map((location) => location.name)).toEqual([
			"Desktop",
			"Documents",
			"Downloads",
		]);
		expect(favorites.every((location) => !location.ejectable)).toBe(true);
	});

	it("answers ~/.Trash as the Trash location", async () => {
		// Given a macOS home with the standard folders
		const home = await macHome();
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});

		// When asking for the Trash, Then it is the home's .Trash
		await expect(places.trashDir()).resolves.toBe(join(home, ".Trash"));
	});

	it("marks a missing favorite folder unavailable instead of dropping its slot", async () => {
		// Given a home without Music
		const home = join(root, "bare");
		await mkdir(join(home, "Desktop"), { recursive: true });
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});

		// When listing places, Then Music is reported but unavailable and Desktop is available
		const byName = new Map((await places.list()).map((location) => [location.name, location]));
		expect(byName.get("Music")?.available).toBe(false);
		expect(byName.get("Desktop")?.available).toBe(true);
	});

	it("shows every connected cloud domain, one row per account", async () => {
		// Given iCloud Drive plus several File Provider domains in ~/Library/CloudStorage
		const home = await macHome();
		await mkdir(join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), { recursive: true });
		const storage = join(home, "Library", "CloudStorage");
		for (const domain of [
			"GoogleDrive-jeffrey@markr.ai",
			"GoogleDrive-vkehfdl1@gmail.com",
			"OneDrive-Personal",
			"OneDrive-경희대학교",
			"Dropbox",
			"MacDroid-samsungSM-F711N",
		]) {
			await mkdir(join(storage, domain), { recursive: true });
		}
		await writeFile(join(storage, ".DS_Store"), "");
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});

		// When listing places
		const cloud = bySection(await places.list(), "cloud");

		// Then iCloud leads and every account is its own row with the provider glyph
		expect(cloud.map((location) => [location.name, location.icon])).toEqual([
			["iCloud Drive", "icloud"],
			["Dropbox", "dropbox"],
			["Google Drive - jeffrey@markr.ai", "google-drive"],
			["Google Drive - vkehfdl1@gmail.com", "google-drive"],
			["MacDroid - samsungSM-F711N", "cloud"],
			["OneDrive - Personal", "onedrive"],
			["OneDrive - 경희대학교", "onedrive"],
		]);
		expect(cloud.find((location) => location.name === "OneDrive - Personal")?.path).toBe(
			join(storage, "OneDrive-Personal"),
		);
		expect(cloud.every((location) => location.available && !location.ejectable)).toBe(true);
	});

	it("shows no cloud row for a provider that is not connected", async () => {
		// Given a home with no iCloud container and no CloudStorage domains
		const home = await macHome();
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});

		// When listing places, Then the cloud section is empty
		expect(bySection(await places.list(), "cloud")).toEqual([]);
	});

	it("keeps a legacy ~/Dropbox folder when the provider has no CloudStorage domain", async () => {
		// Given the pre-File-Provider Dropbox folder
		const home = await macHome();
		await mkdir(join(home, "Dropbox"));
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: join(root, "Volumes"),
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});

		// When listing places, Then it is the Dropbox cloud row
		expect(bySection(await places.list(), "cloud")).toMatchObject([
			{ name: "Dropbox", path: join(home, "Dropbox"), icon: "dropbox" },
		]);
	});

	it("lists the boot disk and every browsable mounted volume, ejectable except the boot disk", async () => {
		// Given /Volumes with the boot symlink, two mounted disks, a network share,
		// a hidden nobrowse mount, a stale folder, and a dot entry
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(volumes);
		await symlink("/", join(volumes, "Macintosh HD"));
		for (const name of ["SSD1", "HDD 2", "share", "com.apple.TimeMachine.localsnapshots", "Stale", ".hidden"]) {
			await mkdir(join(volumes, name));
		}
		const mount = [
			"/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
			"devfs on /dev (devfs, local, nobrowse)",
			`/dev/disk7s1 on ${join(volumes, "SSD1")} (apfs, local, nodev, nosuid, journaled, noowners)`,
			`/dev/disk9s2 on ${join(volumes, "HDD 2")} (hfs, local, nodev, nosuid, journaled, noowners)`,
			`//jeffrey@nas._smb._tcp.local/share on ${join(volumes, "share")} (smbfs, nodev, nosuid, mounted by jeffrey)`,
			`/dev/disk3s7 on ${join(volumes, "com.apple.TimeMachine.localsnapshots")} (apfs, local, read-only, nobrowse)`,
			`/dev/disk11s1 on ${join(volumes, ".hidden")} (apfs, local)`,
		].join("\n");
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: runner({ mount }).run,
		});

		// When listing places
		const locations = bySection(await places.list(), "locations");

		// Then the boot disk leads at "/", and the mounted volumes follow by name, case-insensitively like Finder
		expect(locations.map((location) => [location.name, location.path, location.icon, location.ejectable])).toEqual([
			["Macintosh HD", "/", "disk", false],
			["HDD 2", join(volumes, "HDD 2"), "disk", true],
			["share", join(volumes, "share"), "network", true],
			["SSD1", join(volumes, "SSD1"), "disk", true],
		]);
		expect(locations.every((location) => location.available && !location.scanned)).toBe(true);
	});

	it("unmounts an ejectable volume with diskutil", async () => {
		// Given a mounted volume
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(join(volumes, "USB"), { recursive: true });
		const fake = runner({
			mount: `/dev/disk12s1 on ${join(volumes, "USB")} (msdos, local, nodev, nosuid, noowners)`,
			diskutil: "Volume USB on disk12s1 unmounted\n",
		});
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: fake.run,
		});

		// When ejecting it
		await places.eject(join(volumes, "USB"));

		// Then exactly that mount point was unmounted
		expect(fake.calls.filter((call) => call.command === "diskutil")).toEqual([
			{ command: "diskutil", args: ["unmount", join(volumes, "USB")] },
		]);
	});

	it("surfaces diskutil's refusal verbatim", async () => {
		// Given a volume another process holds open
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(join(volumes, "Busy"), { recursive: true });
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: runner({
				mount: `/dev/disk12s1 on ${join(volumes, "Busy")} (apfs, local)`,
				diskutil: new Error("Volume Busy on disk12s1 failed to unmount: dissented by PID 42 (/usr/bin/vim)"),
			}).run,
		});

		// When ejecting it, Then the OS reason reaches the caller
		await expect(places.eject(join(volumes, "Busy"))).rejects.toThrow("dissented by PID 42");
	});

	it("refuses to eject the boot disk or a path that is not a mounted volume", async () => {
		// Given only the boot volume
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(volumes);
		await symlink("/", join(volumes, "Macintosh HD"));
		const fake = runner({ mount: "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)" });
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: fake.run,
		});

		// When ejecting the boot disk or a home folder, Then nothing is unmounted
		await expect(places.eject("/")).rejects.toThrow("not an ejectable volume");
		await expect(places.eject(join(home, "Documents"))).rejects.toThrow("not an ejectable volume");
		expect(fake.calls.some((call) => call.command === "diskutil")).toBe(false);
	});

	it("changes its signature when a volume mounts or a cloud domain connects", async () => {
		// Given a steady machine
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(volumes);
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});
		const steady = await places.signature();
		expect(await places.signature()).toBe(steady);

		// When a volume appears, Then the signature moves
		await mkdir(join(volumes, "USB"));
		const mounted = await places.signature();
		expect(mounted).not.toBe(steady);

		// And again when a cloud account connects
		await mkdir(join(home, "Library", "CloudStorage", "OneDrive-Personal"), { recursive: true });
		expect(await places.signature()).not.toBe(mounted);
	});

	it("notifies for a volume that mounts before the first poll", async () => {
		// Given a watch started on a steady machine
		const home = await macHome();
		const volumes = join(root, "Volumes");
		await mkdir(volumes);
		const places = createPlaces({
			homeDir: home,
			platform: "darwin",
			volumesRoot: volumes,
			applicationsDir: join(root, "Applications"),
			run: runner({ mount: "" }).run,
		});
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let fired = 0;
		const changed = Promise.withResolvers<void>();
		const stop = places.watch(() => {
			fired += 1;
			changed.resolve();
		}, 1000);
		// Let the baseline signature (real fs I/O) settle before anything changes.
		await places.signature();

		// When a volume mounts before the first interval elapsed
		await mkdir(join(volumes, "USB"));
		await vi.advanceTimersByTimeAsync(1000);
		await changed.promise;
		stop();
		vi.useRealTimers();

		// Then the listener fired exactly once
		expect(fired).toBe(1);
	});
});

describe("Windows places", () => {
	const SID = "S-1-5-21-1000";
	const whoami = `"desktop\\me","${SID}"\r\n`;

	function winDeps(overrides: Partial<PlacesDeps>, outputs: Readonly<Record<string, string | Error>>) {
		const fake = runner({ whoami, ...outputs });
		const deps: PlacesDeps = {
			homeDir: "C:\\Users\\me",
			platform: "win32",
			env: { SystemDrive: "C:", ProgramFiles: "C:\\Program Files" },
			knownFolders: {
				desktop: "C:\\Users\\me\\OneDrive\\Desktop",
				documents: "C:\\Users\\me\\OneDrive\\Documents",
				downloads: "C:\\Users\\me\\Downloads",
				music: "C:\\Users\\me\\Music",
				videos: "C:\\Users\\me\\Videos",
				pictures: "C:\\Users\\me\\Pictures",
			},
			run: fake.run,
			...overrides,
		};
		return { deps, calls: fake.calls };
	}

	const NO_SYNC_ROOTS = new Error("ERROR: The system was unable to find the specified registry key or value.");
	const C_ONLY = JSON.stringify({ DeviceID: "C:", VolumeName: "", DriveType: 3, ProviderName: null });

	it("uses the Explorer names and the OS known-folder paths for the favorites", async () => {
		// Given a Windows profile whose Desktop and Documents are redirected into OneDrive
		const { deps } = winDeps({}, { reg: NO_SYNC_ROOTS, "powershell.exe": C_ONLY });

		// When listing places
		const favorites = bySection(await createPlaces(deps).list(), "favorites");

		// Then each favorite carries the Explorer name and the real known-folder path
		expect(favorites.map((location) => [location.name, location.path])).toEqual([
			["me", "C:\\Users\\me"],
			["Program Files", "C:\\Program Files"],
			["Desktop", "C:\\Users\\me\\OneDrive\\Desktop"],
			["Documents", "C:\\Users\\me\\OneDrive\\Documents"],
			["Downloads", "C:\\Users\\me\\Downloads"],
			["Music", "C:\\Users\\me\\Music"],
			["Videos", "C:\\Users\\me\\Videos"],
			["Pictures", "C:\\Users\\me\\Pictures"],
			["Recycle Bin", `C:\\$Recycle.Bin\\${SID}`],
		]);
	});

	it("still lists every place when the user SID cannot be read", async () => {
		// Given a machine where whoami is unavailable (e.g. a stripped PATH)
		const { deps } = winDeps({}, { whoami: new Error("spawn whoami ENOENT"), reg: NO_SYNC_ROOTS, "powershell.exe": C_ONLY });

		// When listing places
		const locations = await createPlaces(deps).list();

		// Then the favorites and the system drive still appear; only the per-user Recycle Bin is missing
		expect(bySection(locations, "favorites").map((location) => location.name)).toEqual([
			"me",
			"Program Files",
			"Desktop",
			"Documents",
			"Downloads",
			"Music",
			"Videos",
			"Pictures",
		]);
		expect(bySection(locations, "locations").map((location) => location.name)).toEqual(["Local Disk (C:)"]);
	});

	it("answers the boot drive's Recycle Bin folder for the user SID", async () => {
		// Given a Windows profile with a readable SID
		const { deps } = winDeps({}, { reg: NO_SYNC_ROOTS, "powershell.exe": C_ONLY });

		// When asking for the Trash, Then it is the per-user SID folder on the system drive
		await expect(createPlaces(deps).trashDir()).resolves.toBe(`C:\\$Recycle.Bin\\${SID}`);
	});

	it("answers null for the Trash when the user SID cannot be read", async () => {
		// Given a machine where whoami is unavailable
		const { deps } = winDeps({}, { whoami: new Error("spawn whoami ENOENT"), reg: NO_SYNC_ROOTS, "powershell.exe": C_ONLY });

		// When asking for the Trash, Then there is no Recycle Bin folder to answer
		await expect(createPlaces(deps).trashDir()).resolves.toBeNull();
	});

	it("lists the cloud sync roots registered with the OS, one per account", async () => {
		// Given two OneDrive accounts and Google Drive registered as sync roots
		const base = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\SyncRootManager";
		const reg = [
			"",
			`${base}\\OneDrive!${SID}!Personal`,
			"    DisplayNameResource    REG_EXPAND_SZ    OneDrive - Personal",
			"",
			`${base}\\OneDrive!${SID}!Personal\\UserSyncRoots`,
			`    ${SID}    REG_SZ    C:\\Users\\me\\OneDrive`,
			"",
			`${base}\\OneDrive!${SID}!Business1`,
			"    DisplayNameResource    REG_EXPAND_SZ    @C:\\Program Files\\OneDrive\\FileSyncShell64.dll,-1",
			"",
			`${base}\\OneDrive!${SID}!Business1\\UserSyncRoots`,
			`    ${SID}    REG_SZ    C:\\Users\\me\\OneDrive - Contoso`,
			"",
			`${base}\\GoogleDriveFS!${SID}!jeffrey@markr.ai`,
			"",
			`${base}\\GoogleDriveFS!${SID}!jeffrey@markr.ai\\UserSyncRoots`,
			`    ${SID}    REG_SZ    C:\\Users\\me\\My Drive`,
			"",
			`${base}\\OneDrive!S-1-5-21-2000!Personal\\UserSyncRoots`,
			"    S-1-5-21-2000    REG_SZ    C:\\Users\\other\\OneDrive",
			"",
		].join("\r\n");
		const { deps } = winDeps({}, { reg, "powershell.exe": C_ONLY });

		// When listing places
		const cloud = bySection(await createPlaces(deps).list(), "cloud");

		// Then only this user's roots appear, named by the OS or by provider and account
		expect(cloud.map((location) => [location.name, location.path, location.icon])).toEqual([
			["OneDrive - Personal", "C:\\Users\\me\\OneDrive", "onedrive"],
			["OneDrive - Business1", "C:\\Users\\me\\OneDrive - Contoso", "onedrive"],
			["Google Drive - jeffrey@markr.ai", "C:\\Users\\me\\My Drive", "google-drive"],
		]);
	});

	it("lists every drive letter, with the system drive fixed and the Google Drive letter under cloud", async () => {
		// Given a system disk, a data disk, a USB stick, a network share, and the Google Drive virtual drive
		const disks = JSON.stringify([
			{ DeviceID: "C:", VolumeName: "", DriveType: 3, ProviderName: null },
			{ DeviceID: "D:", VolumeName: "Data", DriveType: 3, ProviderName: null },
			{ DeviceID: "E:", VolumeName: "USB", DriveType: 2, ProviderName: null },
			{ DeviceID: "G:", VolumeName: "Google Drive", DriveType: 3, ProviderName: null },
			{ DeviceID: "Z:", VolumeName: "share", DriveType: 4, ProviderName: "\\\\nas\\share" },
		]);
		const { deps } = winDeps({}, { reg: NO_SYNC_ROOTS, "powershell.exe": disks });

		// When listing places
		const locations = await createPlaces(deps).list();

		// Then the drives read like Explorer, ejectable except the system drive
		expect(bySection(locations, "locations").map((location) => [location.name, location.path, location.icon, location.ejectable])).toEqual([
			["Local Disk (C:)", "C:\\", "disk", false],
			["Data (D:)", "D:\\", "disk", true],
			["USB (E:)", "E:\\", "disk", true],
			["share (Z:)", "Z:\\", "network", true],
		]);
		expect(bySection(locations, "cloud")).toMatchObject([{ name: "Google Drive (G:)", path: "G:\\", icon: "google-drive" }]);
	});

	it("disconnects a network drive with net use and ejects a disk through the shell verb", async () => {
		// Given a USB stick and a network share
		const disks = JSON.stringify([
			{ DeviceID: "C:", VolumeName: "", DriveType: 3, ProviderName: null },
			{ DeviceID: "E:", VolumeName: "USB", DriveType: 2, ProviderName: null },
			{ DeviceID: "Z:", VolumeName: "share", DriveType: 4, ProviderName: "\\\\nas\\share" },
		]);
		const { deps, calls } = winDeps({ driveGone: async () => true }, { reg: NO_SYNC_ROOTS, "powershell.exe": disks, net: "" });
		const places = createPlaces(deps);

		// When ejecting both
		await places.eject("Z:\\");
		await places.eject("E:\\");

		// Then the share was disconnected and the stick ejected by drive letter
		expect(calls.filter((call) => call.command === "net")).toEqual([
			{ command: "net", args: ["use", "Z:", "/delete", "/y"] },
		]);
		const eject = calls.filter((call) => call.command === "powershell.exe").at(-1);
		expect(eject?.args.join(" ")).toContain("ParseName('E:').InvokeVerb('Eject')");
	});

	it("reports a drive that is still mounted after the eject verb", async () => {
		// Given a disk Windows refuses to release
		const disks = JSON.stringify([
			{ DeviceID: "C:", VolumeName: "", DriveType: 3, ProviderName: null },
			{ DeviceID: "E:", VolumeName: "USB", DriveType: 2, ProviderName: null },
		]);
		const { deps } = winDeps({ driveGone: async () => false }, { reg: NO_SYNC_ROOTS, "powershell.exe": disks });

		// When ejecting it, Then the failure is not reported as success
		await expect(createPlaces(deps).eject("E:\\")).rejects.toThrow("E: is still mounted");
	});
});

describe("Recycle Bin $I records", () => {
	function utf16(text: string): Buffer {
		return Buffer.from(`${text}\0`, "utf16le");
	}

	it("reads the original path of a Windows 10+ (version 2) record", async () => {
		// Given a version-2 $I record for C:\Users\me\Documents\보고서.docx
		const original = "C:\\Users\\me\\Documents\\보고서.docx";
		const header = Buffer.alloc(28);
		header.writeBigInt64LE(2n, 0);
		header.writeBigInt64LE(1234n, 8);
		header.writeInt32LE(original.length + 1, 24);
		const path = join(root, "$IABC123.docx");
		await writeFile(path, Buffer.concat([header, utf16(original)]));

		// When reading it, Then the original name comes back
		expect(await readRecycleBinName(path)).toBe("보고서.docx");
	});

	it("reads the original path of a Vista-8 (version 1) record", async () => {
		// Given a version-1 record with its fixed 260-character path field
		const original = "D:\\photos\\cat.jpg";
		const record = Buffer.alloc(24 + 520);
		record.writeBigInt64LE(1n, 0);
		record.write(original, 24, "utf16le");
		const path = join(root, "$IXYZ.jpg");
		await writeFile(path, record);

		// When reading it, Then the original name comes back
		expect(await readRecycleBinName(path)).toBe(win32.basename(original));
	});

	it("returns null for a file that is not a $I record", async () => {
		// Given an unrelated short file
		const path = join(root, "desktop.ini");
		await writeFile(path, "[.ShellClassInfo]");

		// When reading it, Then there is no name
		expect(await readRecycleBinName(path)).toBeNull();
	});

	it("reads the full original path and deleted-at FILETIME a record carries", async () => {
		// Given a version-2 record with a stamped delete time
		const original = "C:\\Users\\me\\Documents\\보고서.docx";
		const header = Buffer.alloc(28);
		header.writeBigInt64LE(2n, 0);
		header.writeBigInt64LE(1234n, 8);
		header.writeBigInt64LE(132_000_000_000_000_000n, 16);
		header.writeInt32LE(original.length + 1, 24);
		const path = join(root, "$IWHEN.docx");
		await writeFile(path, Buffer.concat([header, utf16(original)]));

		// When reading it as a record, Then both fields come back
		expect(await readRecycleBinRecord(path)).toEqual({
			originalPath: original,
			deletedAt: 132_000_000_000_000_000n,
		});
	});

	it("answers no record for a file that is not one", async () => {
		// Given an unrelated short file
		const path = join(root, "notes.txt");
		await writeFile(path, "x");

		// When reading it as a record, Then there is none
		expect(await readRecycleBinRecord(path)).toBeNull();
	});
});
