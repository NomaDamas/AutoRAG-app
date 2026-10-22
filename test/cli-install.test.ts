import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addToWinPath, defaultLinkDirs, installCli, parseWinUserPath, type CliInstallDeps, type LinkDir } from "../src/main/cli-install";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cli-install-"));
	dirs.push(dir);
	return dir;
}

/** A fake `Dazzi.app/Contents/Resources/bin` with the launcher in it. */
async function bundle(root: string, name = "Dazzi.app"): Promise<string> {
	const bin = join(root, name, "Contents", "Resources", "bin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "dazzi"), "#!/bin/sh\n");
	await chmod(join(bin, "dazzi"), 0o755);
	return bin;
}

const never = async (): Promise<string> => {
	throw new Error("no process may run on this platform");
};

async function mac(root: string, linkDirs: readonly LinkDir[], extra: Partial<CliInstallDeps> = {}): Promise<CliInstallDeps> {
	return { platform: "darwin", homeDir: join(root, "home"), bundledBinDir: await bundle(root), linkDirs, run: never, ...extra };
}

describe.skipIf(process.platform === "win32")("installCli on macOS", () => {
	it("links dazzi into the first existing directory, pointing at the bundled launcher", async () => {
		const root = await tempDir();
		const brew = join(root, "brew-bin");
		await mkdir(brew);
		const deps = await mac(root, [{ dir: brew, create: false, onPath: true }]);
		const result = await installCli(deps);
		expect(result).toEqual({ kind: "linked", link: join(brew, "dazzi"), changed: true, profile: null });
		expect(await readlink(join(brew, "dazzi"))).toBe(join(deps.bundledBinDir, "dazzi"));
	});

	it("is a no-op the second time", async () => {
		const root = await tempDir();
		const brew = join(root, "brew-bin");
		await mkdir(brew);
		const deps = await mac(root, [{ dir: brew, create: false, onPath: true }]);
		await installCli(deps);
		expect(await installCli(deps)).toMatchObject({ kind: "linked", changed: false });
	});

	it("repoints its own link when the app moved to another folder", async () => {
		const root = await tempDir();
		const brew = join(root, "brew-bin");
		await mkdir(brew);
		const old = await bundle(join(root, "old"));
		await symlink(join(old, "dazzi"), join(brew, "dazzi"));
		const deps = await mac(root, [{ dir: brew, create: false, onPath: true }]);
		expect(await installCli(deps)).toMatchObject({ kind: "linked", changed: true });
		expect(await readlink(join(brew, "dazzi"))).toBe(join(deps.bundledBinDir, "dazzi"));
	});

	it("repoints its own link even when the app it pointed at is gone", async () => {
		const root = await tempDir();
		const brew = join(root, "brew-bin");
		await mkdir(brew);
		await symlink("/Applications/Dazzi.app/Contents/Resources/bin/dazzi", join(brew, "dazzi"));
		const deps = await mac(root, [{ dir: brew, create: false, onPath: true }]);
		await installCli(deps);
		expect(await readlink(join(brew, "dazzi"))).toBe(join(deps.bundledBinDir, "dazzi"));
	});

	it("never overwrites a dazzi that is not ours and moves on to the next directory", async () => {
		const root = await tempDir();
		const first = join(root, "first");
		const second = join(root, "second");
		await mkdir(first);
		await mkdir(second);
		await writeFile(join(first, "dazzi"), "someone else's tool\n");
		const deps = await mac(root, [
			{ dir: first, create: false, onPath: true },
			{ dir: second, create: false, onPath: true },
		]);
		const result = await installCli(deps);
		expect(result).toMatchObject({ kind: "linked", link: join(second, "dazzi") });
		expect(await readFile(join(first, "dazzi"), "utf8")).toBe("someone else's tool\n");
	});

	it("refreshes the link it already made in a later directory instead of adding a second one", async () => {
		const root = await tempDir();
		const first = join(root, "first");
		const second = join(root, "second");
		await mkdir(first);
		await mkdir(second);
		const old = await bundle(join(root, "old"));
		await symlink(join(old, "dazzi"), join(second, "dazzi"));
		const deps = await mac(root, [
			{ dir: first, create: false, onPath: true },
			{ dir: second, create: false, onPath: true },
		]);
		const result = await installCli(deps);
		expect(result).toMatchObject({ kind: "linked", link: join(second, "dazzi") });
		await expect(lstat(join(first, "dazzi"))).rejects.toThrow();
	});

	it("does not create system directories, and falls back to the user directory it may create", async () => {
		const root = await tempDir();
		const system = join(root, "no-such", "bin");
		const local = join(root, "home", ".local", "bin");
		const deps = await mac(root, [
			{ dir: system, create: false, onPath: true },
			{ dir: local, create: true, onPath: false },
		]);
		const result = await installCli(deps);
		expect(result).toMatchObject({ kind: "linked", link: join(local, "dazzi") });
		await expect(lstat(system)).rejects.toThrow();
	});

	it("puts a user directory that is not on PATH there through the zsh profile, once", async () => {
		const root = await tempDir();
		const local = join(root, "home", ".local", "bin");
		const deps = await mac(root, [{ dir: local, create: true, onPath: false }], { shell: "/bin/zsh" });
		const first = await installCli(deps);
		const profile = join(root, "home", ".zprofile");
		expect(first).toMatchObject({ kind: "linked", profile });
		await installCli(deps);
		const text = await readFile(profile, "utf8");
		expect(text.match(/>>> dazzi CLI >>>/gu)).toHaveLength(1);
		expect(text).toContain(`${local}`);
	});

	it("keeps what the profile already holds and uses .bash_profile for bash", async () => {
		const root = await tempDir();
		const local = join(root, "home", ".local", "bin");
		await mkdir(join(root, "home"), { recursive: true });
		await writeFile(join(root, "home", ".bash_profile"), "export FOO=1\n");
		const deps = await mac(root, [{ dir: local, create: true, onPath: false }], { shell: "/usr/local/bin/bash" });
		await installCli(deps);
		const text = await readFile(join(root, "home", ".bash_profile"), "utf8");
		expect(text.startsWith("export FOO=1\n")).toBe(true);
		expect(text).toContain(">>> dazzi CLI >>>");
	});

	it("leaves every profile alone when the directory is already on PATH", async () => {
		const root = await tempDir();
		const brew = join(root, "brew-bin");
		await mkdir(brew);
		await installCli(await mac(root, [{ dir: brew, create: false, onPath: true }], { shell: "/bin/zsh" }));
		await expect(lstat(join(root, "home", ".zprofile"))).rejects.toThrow();
	});

	it("reports unavailable when the bundle ships no launcher or no directory takes it", async () => {
		const root = await tempDir();
		const empty = join(root, "empty-bin");
		await mkdir(empty);
		expect(await installCli({ platform: "darwin", homeDir: root, bundledBinDir: empty, linkDirs: [{ dir: root, create: false, onPath: true }], run: never })).toMatchObject({ kind: "unavailable" });
		const deps = await mac(root, [{ dir: join(root, "missing"), create: false, onPath: true }]);
		expect(await installCli(deps)).toMatchObject({ kind: "unavailable" });
	});

	it("does nothing on Linux", async () => {
		const root = await tempDir();
		expect(await installCli({ ...(await mac(root, [])), platform: "linux" })).toMatchObject({ kind: "unavailable" });
	});
});

describe("defaultLinkDirs", () => {
	it("tries Homebrew, then /usr/local, then a user directory it may create", () => {
		expect(defaultLinkDirs("/Users/me")).toEqual([
			{ dir: "/opt/homebrew/bin", create: false, onPath: true },
			{ dir: "/usr/local/bin", create: false, onPath: true },
			{ dir: "/Users/me/.local/bin", create: true, onPath: false },
		]);
	});
});

describe("Windows user PATH", () => {
	const BIN = "C:\\Users\\me\\AppData\\Local\\Programs\\Dazzi\\resources\\bin";

	it("adds the folder once, ignoring case and a trailing backslash, and keeps %VAR% entries verbatim", () => {
		expect(addToWinPath("%USERPROFILE%\\bin;C:\\tools", BIN)).toBe(`%USERPROFILE%\\bin;C:\\tools;${BIN}`);
		expect(addToWinPath(`C:\\tools;${BIN.toLowerCase()}\\`, BIN)).toBeNull();
		expect(addToWinPath("", BIN)).toBe(BIN);
		expect(addToWinPath("C:\\tools;;", BIN)).toBe(`C:\\tools;${BIN}`);
	});

	it("reads the value out of `reg query`, expandable or not, and tolerates a missing value", () => {
		expect(parseWinUserPath("\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n\r\n")).toBe("%USERPROFILE%\\bin;C:\\x");
		expect(parseWinUserPath("    Path    REG_SZ    C:\\a b;C:\\c\r\n")).toBe("C:\\a b;C:\\c");
		expect(parseWinUserPath("")).toBe("");
	});

	function winDeps(calls: string[][], queryOutput: string | Error): CliInstallDeps {
		return {
			platform: "win32",
			homeDir: "C:\\Users\\me",
			bundledBinDir: BIN,
			exists: async () => true,
			run: async (command, args) => {
				calls.push([command, ...args]);
				if (args[0] === "query") {
					if (queryOutput instanceof Error) throw queryOutput;
					return queryOutput;
				}
				return "";
			},
		};
	}

	it("registers the bundled bin folder in HKCU\\Environment\\Path as an expandable string, then tells Windows", async () => {
		const calls: string[][] = [];
		const result = await installCli(winDeps(calls, "    Path    REG_EXPAND_SZ    C:\\tools\r\n"));
		expect(result).toEqual({ kind: "path-registered", dir: BIN, changed: true });
		expect(calls[1]).toEqual(["reg.exe", "add", "HKCU\\Environment", "/v", "Path", "/t", "REG_EXPAND_SZ", "/d", `C:\\tools;${BIN}`, "/f"]);
		expect(calls[2]?.[0]).toBe("powershell.exe");
	});

	it("writes nothing when the folder is already registered", async () => {
		const calls: string[][] = [];
		const result = await installCli(winDeps(calls, `    Path    REG_SZ    ${BIN}\r\n`));
		expect(result).toEqual({ kind: "path-registered", dir: BIN, changed: false });
		expect(calls).toHaveLength(1);
	});

	it("starts a PATH when the user has none", async () => {
		const calls: string[][] = [];
		await installCli(winDeps(calls, new Error("The system was unable to find the specified registry key or value.")));
		expect(calls[1]).toContain(BIN);
	});

	it("still reports success when only the change broadcast fails", async () => {
		const calls: string[][] = [];
		const deps = winDeps(calls, "");
		const result = await installCli({
			...deps,
			run: async (command, args) => {
				if (command === "powershell.exe") throw new Error("blocked by policy");
				return deps.run(command, args);
			},
		});
		expect(result).toMatchObject({ kind: "path-registered", changed: true });
	});
});
