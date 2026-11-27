/**
 * Default file manager contract shared by the main process, preload bridge,
 * and renderer (Settings → 일반 and the Notification Center).
 *
 * When enabled:
 * - macOS: sets global `NSFileViewer` to Dazzi's bundle ID (`com.autorag.app`),
 *   registers Dazzi as the LaunchServices default role handler for
 *   `public.folder`, handles both AppleEvent `misc`/`mvis`
 *   (`kAERevealSelection`, "Reveal in Finder" from other apps) and
 *   `open-file` / `odoc` ("Open folder") inside Dazzi, and optionally runs a
 *   lightweight Finder-window watcher (`mac-finder-watcher.ts`) so folders
 *   double-clicked on the Desktop or opened in Finder also hand over to Dazzi.
 * - Windows: registers per-user `HKCU\Software\Classes\Folder\shell\open\command`
 *   and `Directory\shell\open\command` (forwarding virtual `::{CLSID}` paths
 *   safely back to `explorer.exe`), registers the Win+E CLSID
 *   (`{52205fd8-5dfb-447d-801a-d0b52f2e83e1}\shell\opennewwindow\command`), and
 *   optionally runs a lightweight Explorer-window watcher that intercepts
 *   `SHOpenFolderAndSelectItems` calls (e.g. Chrome/VS Code "Show in folder")
 *   and hands them over to Dazzi.
 *
 * All changes are per-user (no elevation required) and cleanly restored to the
 * OS defaults (Finder / File Explorer) when toggled off or uninstalled.
 */

export const DEFAULT_FILE_MANAGER_CHANNELS = {
	/** invoke: current OS registration and capability status. */
	status: "defaultFileManager:status",
	/** invoke: enable or disable default file manager integration (optional windows watcher flag). */
	apply: "defaultFileManager:apply",
	/** main → renderer: emitted when status changes. */
	changed: "defaultFileManager:changed",
} as const;

export type DefaultFileManagerPlatform = "darwin" | "win32" | "unsupported";

export interface DefaultFileManagerStatus {
	/** Whether this OS supports setting Dazzi as the default file manager. */
	readonly supported: boolean;
	readonly platform: DefaultFileManagerPlatform;
	/** Whether Dazzi is currently enabled as the default file manager in settings. */
	readonly enabled: boolean;
	/** Whether the OS itself currently points at Dazzi (verified against defaults / registry). */
	readonly osRegistered: boolean;
	/** Whether the background OS file-manager window interceptor (Finder on macOS / Explorer on Windows) is enabled. */
	readonly interceptReveal: boolean;
	/** Whether the background OS file-manager window interceptor is currently running. */
	readonly interceptRevealActive: boolean;
	/** macOS only: whether the native AppleEvent `misc`/`mvis` handler is loaded in this build. */
	readonly macRevealHookLoaded: boolean;
	/** True when running unpackaged (`electron .`) on macOS where LaunchServices cannot bind `com.autorag.app`. */
	readonly requiresPackagedApp: boolean;
	/** Non-null when the last probe or apply encountered an error. */
	readonly error: string | null;
}

export interface DefaultFileManagerApplyRequest {
	readonly enabled: boolean;
	/** Also intercept newly opened OS file-manager windows (Desktop folders/Finder on macOS; Explorer `SHOpenFolderAndSelectItems` on Windows). */
	readonly interceptReveal?: boolean;
}

export interface DefaultFileManagerBridge {
	status(): Promise<DefaultFileManagerStatus>;
	apply(request: DefaultFileManagerApplyRequest): Promise<DefaultFileManagerStatus>;
	onChange(listener: (status: DefaultFileManagerStatus) => void): () => void;
}

/**
 * Pure check for whether a Windows target path is a real filesystem path Dazzi
 * should open, versus a Windows shell virtual namespace (`::{CLSID}`, `shell:`,
 * Control Panel, Network, etc.) that must be handed back to `explorer.exe`.
 */
export function isWindowsVirtualShellPath(raw: string): boolean {
	const trimmed = raw.trim().replace(/^"+|"+$/gu, "");
	if (trimmed === "") return true;
	if (trimmed.startsWith("::") || trimmed.startsWith("shell:") || trimmed.startsWith("search-ms:")) return true;
	// Standard drive-letter (`C:\...`, `C:/...`, `C:`) or UNC (`\\server\share`) paths are real filesystem targets.
	if (/^[A-Za-z]:(?:[\\/]|$)/u.test(trimmed)) return false;
	if (/^\\\\[^\\]+\\[^\\]+/u.test(trimmed)) return false;
	return true;
}

export function isDefaultFileManagerApplyRequest(value: unknown): value is DefaultFileManagerApplyRequest {
	if (typeof value !== "object" || value === null) return false;
	const { enabled, interceptReveal } = value as { enabled?: unknown; interceptReveal?: unknown };
	if (typeof enabled !== "boolean") return false;
	if (interceptReveal !== undefined && typeof interceptReveal !== "boolean") return false;
	return true;
}
