import { spawn, type ChildProcess } from "node:child_process";
import { isWindowsVirtualShellPath } from "../shared/default-file-manager-contract";

/**
 * Windows Explorer window watcher that intercepts `SHOpenFolderAndSelectItems`
 * calls from other apps (Chrome "Show in folder", VS Code "Reveal in File
 * Explorer", Slack, etc.) without requiring administrator rights or DLL
 * injection.
 *
 * How it works:
 * - Runs a single hidden `powershell.exe` child process using `Shell.Application`
 *   COM (`IShellWindows`).
 * - At startup it snapshots existing Explorer window HWNDs so user-opened
 *   Explorer windows that were already open are NEVER touched.
 * - Whenever a brand-new `CabinetWClass` Explorer window appears, it inspects
 *   `Document.FocusedItem` / `Document.SelectedItems` and `LocationURL`:
 *     - If it is a virtual shell folder (Control Panel, This PC, Network,
 *       Recycle Bin, `::{CLSID}`, etc.) it leaves the Explorer window alone.
 *     - If it is a real filesystem folder (with or without a selected item), it
 *       closes that Explorer window via `win.Quit()` and emits a JSON line on
 *       stdout (`{"action":"reveal"|"open","path":"..."}`), which Dazzi hands
 *       straight into `osRequests`.
 *
 * An opt-in escape hatch (`ignoreExplorerUntil`) lets Dazzi itself intentionally
 * open Explorer (e.g., "Reveal in File Explorer" or virtual folder fallback)
 * without the watcher intercepting it.
 */

export interface WindowsExplorerInterceptEvent {
	readonly action: "open" | "reveal";
	readonly path: string;
}

export interface WindowsExplorerWatcher {
	isRunning(): boolean;
	start(): void;
	stop(): void;
	/** Suppress interception briefly when Dazzi intentionally launches Explorer itself. */
	suppressFor(ms: number): void;
}

/**
 * Builds the PowerShell script that watches `Shell.Application` windows.
 * Uses pure UTF-8 JSON lines over stdout. Exits cleanly when stdin closes or
 * the parent process dies.
 */
export function buildWindowsExplorerWatcherScript(pollIntervalMs = 150): string {
	return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$seen = New-Object 'System.Collections.Generic.HashSet[int64]'

function Snapshot-Existing {
	foreach ($w in @($shell.Windows())) {
		try {
			$hwnd = [int64]$w.HWND
			if ($hwnd -ne 0) { [void]$seen.Add($hwnd) }
		} catch {}
	}
}

Snapshot-Existing
Write-Output '{"event":"ready"}'
[Console]::Out.Flush()

while ($true) {
	Start-Sleep -Milliseconds ${Math.max(80, Math.floor(pollIntervalMs))}
	$current = New-Object 'System.Collections.Generic.HashSet[int64]'
	$windows = @()
	try { $windows = @($shell.Windows()) } catch { continue }

	foreach ($w in $windows) {
		$hwnd = [int64]0
		try { $hwnd = [int64]$w.HWND } catch { continue }
		if ($hwnd -eq 0) { continue }
		[void]$current.Add($hwnd)
		if ($seen.Contains($hwnd)) { continue }

		# Wait briefly for Document/SelectedItems to populate on newly created Explorer windows
		$url = ''
		$folderPath = ''
		$selectedPath = ''
		for ($attempt = 0; $attempt -lt 6; $attempt++) {
			try { $url = [string]$w.LocationURL } catch { $url = '' }
			try {
				$doc = $w.Document
				if ($null -ne $doc) {
					if ($null -ne $doc.Folder -and $null -ne $doc.Folder.Self) {
						$folderPath = [string]$doc.Folder.Self.Path
					}
					$sel = $doc.SelectedItems()
					if ($null -ne $sel -and $sel.Count -gt 0) {
						$first = $sel.Item(0)
						if ($null -ne $first -and $null -ne $first.Path) {
							$selectedPath = [string]$first.Path
						}
					}
					if (-not $selectedPath -and $null -ne $doc.FocusedItem -and $null -ne $doc.FocusedItem.Path) {
						$selectedPath = [string]$doc.FocusedItem.Path
					}
				}
			} catch {}
			if ($selectedPath -or $folderPath) { break }
			Start-Sleep -Milliseconds 40
		}

		[void]$seen.Add($hwnd)

		# Only intercept real filesystem windows (file:// URL or drive/UNC path)
		if (-not $url -and -not $folderPath) { continue }
		$isFileUrl = $url -match '^file:///'
		$target = if ($selectedPath) { $selectedPath } else { $folderPath }
		if (-not $target) { continue }
		if ($target.StartsWith('::') -or $target.StartsWith('shell:') -or $target.StartsWith('search-ms:')) { continue }
		if (-not $isFileUrl -and -not ($target -match '^[A-Za-z]:[\\\\/]' -or $target -match '^\\\\\\\\[^\\\\]+\\\\[^\\\\]+')) { continue }

		$action = if ($selectedPath) { 'reveal' } else { 'open' }
		try { $w.Quit() } catch {}
		$payload = @{ event = 'intercept'; action = $action; path = $target } | ConvertTo-Json -Compress
		Write-Output $payload
		[Console]::Out.Flush()
	}

	# Prune closed HWNDs from $seen so handles reused by Windows are tracked cleanly
	$stale = @()
	foreach ($h in $seen) {
		if (-not $current.Contains($h)) { $stale += $h }
	}
	foreach ($h in $stale) { [void]$seen.Remove($h) }
}
`.trim();
}

export function parseWatcherLine(line: string): WindowsExplorerInterceptEvent | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	try {
		const parsed = JSON.parse(trimmed) as { event?: unknown; action?: unknown; path?: unknown };
		if (parsed.event !== "intercept") return null;
		if (parsed.action !== "open" && parsed.action !== "reveal") return null;
		if (typeof parsed.path !== "string" || isWindowsVirtualShellPath(parsed.path)) return null;
		return { action: parsed.action, path: parsed.path };
	} catch {
		return null;
	}
}

export interface WindowsExplorerWatcherDeps {
	readonly platform?: NodeJS.Platform;
	readonly pollIntervalMs?: number;
	readonly onIntercept: (event: WindowsExplorerInterceptEvent) => void;
	readonly onError?: (error: string) => void;
}

export function createWindowsExplorerWatcher(deps: WindowsExplorerWatcherDeps): WindowsExplorerWatcher {
	const platform = deps.platform ?? process.platform;
	let child: ChildProcess | null = null;
	let suppressedUntil = 0;

	const stop = (): void => {
		if (child === null) return;
		const proc = child;
		child = null;
		try {
			proc.kill();
		} catch {
			// Already exited.
		}
	};

	const start = (): void => {
		if (platform !== "win32") return;
		if (child !== null && child.exitCode === null && !child.killed) return;
		const script = buildWindowsExplorerWatcherScript(deps.pollIntervalMs);
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		child = proc;

		let buffer = "";
		proc.stdout?.setEncoding("utf8");
		proc.stdout?.on("data", (chunk: string) => {
			buffer += chunk;
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const event = parseWatcherLine(line);
				if (event === null) continue;
				if (Date.now() < suppressedUntil) continue;
				deps.onIntercept(event);
			}
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			const msg = chunk.trim();
			if (msg !== "") deps.onError?.(msg);
		});
		proc.on("exit", () => {
			if (child === proc) child = null;
		});
		proc.on("error", (error) => {
			deps.onError?.(error.message);
			if (child === proc) child = null;
		});
	};

	return {
		isRunning: () => child !== null && child.exitCode === null && !child.killed,
		start,
		stop,
		suppressFor: (ms) => {
			suppressedUntil = Math.max(suppressedUntil, Date.now() + ms);
		},
	};
}
