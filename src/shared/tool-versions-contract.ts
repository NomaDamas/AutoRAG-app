/**
 * Resolved versions of the app, `@autorag/librarian`, pinned dependency tools,
 * and the shared local embedding daemon (`minsync serve` / `inl`).
 *
 * Read by Settings → About and the outdated-daemon launch notice.
 */

export const TOOL_VERSIONS_CHANNELS = {
	get: "toolVersions:get",
	restartDaemon: "toolVersions:restartDaemon",
} as const;

export type ToolComponentId = "app" | "librarian" | "minsync" | "inl" | "mailcrawl" | "lazykatok";

export interface ToolComponentVersion {
	readonly id: ToolComponentId;
	readonly name: string;
	readonly pinned: string;
	/** Version recorded in `tools/manifest.json` (or running app/librarian version); null in dev runs without bundled tools. */
	readonly bundled: string | null;
	/** Version found on the user's PATH outside `<resources>/tools/bin`, if any. */
	readonly pathVersion: string | null;
	/** Absolute path of the external PATH binary, if found. */
	readonly pathLocation: string | null;
	/** True when a PATH copy exists and its version differs from the bundled (or pinned) version. */
	readonly pathMismatch: boolean;
	/** True when `tools/manifest.json` disagrees with `src/shared/tool-pins.json`. */
	readonly manifestMismatch: boolean;
}

export interface EmbeddingDaemonVersionInfo {
	readonly owner: string;
	readonly engine: string;
	readonly pinnedVersion: string;
	readonly running: boolean;
	readonly version: string | null;
	readonly instance: string | null;
	readonly port: number | null;
	readonly pid: number | null;
	readonly owned: boolean;
	readonly outdated: boolean;
	/** True only when `outdated` and Dazzi owns the daemon; never true for a user-started server. */
	readonly canRestart: boolean;
}

export interface ManifestDriftEntry {
	readonly name: string;
	readonly pinned: string;
	readonly manifest: string | null;
}

export interface ToolVersionsSnapshot {
	readonly appVersion: string;
	readonly librarianRef: string;
	readonly manifestPresent: boolean;
	readonly manifestDrift: readonly ManifestDriftEntry[];
	readonly daemon: EmbeddingDaemonVersionInfo;
	readonly components: readonly ToolComponentVersion[];
}

export interface RestartDaemonResponse {
	readonly ok: boolean;
	readonly reason?: "not-owned" | "unavailable";
	readonly message?: string;
	readonly snapshot: ToolVersionsSnapshot;
}

export interface ToolVersionsBridge {
	get(): Promise<ToolVersionsSnapshot>;
	/** Restarts an outdated app-owned embedding daemon on the same port; never stops a user-started server. */
	restartDaemon(): Promise<RestartDaemonResponse>;
}

/** Compare dotted numeric versions: `a > b` -> positive, `a < b` -> negative, equal -> 0. */
export function compareSemver(a: string, b: string): number {
	const left = a.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.replace(/^v/u, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}
