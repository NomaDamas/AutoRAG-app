import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where each messenger's desktop app lives, so Settings can say "install Discord" only when it truly is not there.
 * The datasource CLIs (`discrawl`, `slacrawl`) read the app's own data, which exists only once the app has run.
 *
 * macOS: a `.app` bundle. Windows: Squirrel installs per user under `%LOCALAPPDATA%\<name>` (`app-<version>\` folders
 * next to `Update.exe`), a machine-wide install goes to Program Files, and the Microsoft Store variant is a package
 * under `%LOCALAPPDATA%\Packages`. Linux has no common location, so it reports "unknown" (`null`), never a wrong "missing".
 */

export interface DesktopAppEnv {
	readonly platform: NodeJS.Platform;
	readonly env: NodeJS.ProcessEnv;
	readonly home: string;
}

/** The app's folder name on disk, which differs from its label (`Slack` ships as `slack` on Windows). */
const WINDOWS_APPS: Readonly<Record<string, { readonly folders: readonly string[]; readonly executable: string; readonly packagePrefixes: readonly string[] }>> = {
	Discord: { folders: ["Discord"], executable: "Discord.exe", packagePrefixes: [] },
	Slack: { folders: ["slack", "Slack"], executable: "slack.exe", packagePrefixes: ["com.tinyspeck.slackdesktop", "91750D7E.Slack"] },
};

async function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false);
}

async function windowsInstalled(name: string, env: NodeJS.ProcessEnv, home: string): Promise<boolean | null> {
	const spec = WINDOWS_APPS[name];
	if (spec === undefined) return null;
	const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
	const roots = [local, env.ProgramFiles, env["ProgramFiles(x86)"]].filter((root): root is string => typeof root === "string" && root.length > 0);
	for (const root of roots) {
		for (const folder of spec.folders) {
			const base = join(root, folder);
			if (!(await exists(base))) continue;
			// Squirrel keeps the launcher next to versioned `app-*` folders; a plain install has the executable in place.
			if ((await exists(join(base, spec.executable))) || (await exists(join(base, "Update.exe")))) return true;
			const versions = await readdir(base).catch(() => [] as string[]);
			if (versions.some((entry) => entry.startsWith("app-"))) return true;
		}
	}
	const packages = await readdir(join(local, "Packages")).catch(() => [] as string[]);
	return packages.some((entry) => spec.packagePrefixes.some((prefix) => entry.startsWith(prefix)));
}

/** True / false when the platform has a known location for this app, null when it does not. */
export async function desktopAppInstalled(name: string, host: DesktopAppEnv): Promise<boolean | null> {
	if (host.platform === "darwin") {
		const candidates = [`/Applications/${name}.app`, host.home.length === 0 ? "" : join(host.home, "Applications", `${name}.app`)];
		const present = await Promise.all(candidates.map((candidate) => (candidate.length > 0 ? exists(candidate) : false)));
		return present.some(Boolean);
	}
	if (host.platform === "win32") return windowsInstalled(name, host.env, host.home);
	return null;
}
