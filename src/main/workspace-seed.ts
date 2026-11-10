import { join, posix } from "node:path";
import { autoragHome } from "./autorag-home";

type HomeEnv = Readonly<Record<string, string | undefined>>;

/** Where the index and its state live unless the user chose a folder: `<AutoRAG home>/workspace`. */
export function defaultWorkspacePath(env: HomeEnv, homeDir: string): string {
	return join(autoragHome(env, homeDir), "workspace");
}

/**
 * The POSIX root `/`. The librarian keeps its state in `<workspace>/.autorag`, which cannot be created there
 * (macOS: the read-only system volume, `ENOENT`). A Windows drive root is not matched: `C:\.autorag` can exist.
 */
export function isFilesystemRoot(path: string): boolean {
	return posix.normalize(path) === "/";
}

/**
 * A packaged app started from Finder has `/` as its working directory, and the app used to seed a fresh
 * config with it twice: `workspacePath` and `searchPaths`. Every refresh before onboarding replaced them then
 * failed with `ENOENT: mkdir '/.autorag'`, which was also the only thing stopping it from walking the whole disk.
 * The config object with that seed replaced by the default workspace and no search folder, or `null` when the
 * config does not carry it (a workspace that is not a root, or search folders the user chose).
 */
export function withoutRootWorkspace(raw: Record<string, unknown>, env: HomeEnv, homeDir: string): Record<string, unknown> | null {
	if (typeof raw.workspacePath !== "string" || !isFilesystemRoot(raw.workspacePath)) return null;
	const seededSearch = Array.isArray(raw.searchPaths) && raw.searchPaths.every((path) => typeof path === "string" && isFilesystemRoot(path));
	return { ...raw, workspacePath: defaultWorkspacePath(env, homeDir), ...(seededSearch ? { searchPaths: [] } : {}) };
}

/** The `searchPaths`/`workspacePath` a fresh config starts with: the launch folder, unless that is a filesystem root. */
export function seedFromLaunchFolder(cwd: string, env: HomeEnv, homeDir: string): { readonly searchPaths: string[]; readonly workspacePath: string } {
	return isFilesystemRoot(cwd) ? { searchPaths: [], workspacePath: defaultWorkspacePath(env, homeDir) } : { searchPaths: [cwd], workspacePath: cwd };
}
