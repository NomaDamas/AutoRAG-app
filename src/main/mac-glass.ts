import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { GlassAddon } from "./quick-search-material";

/**
 * Loads the optional macOS N-API addon (`vendor/mac-glass.node`) that puts macOS 26's Liquid Glass (or, before 26, a
 * rounded blur) behind the quick-search window's page. Same search order as the reveal hook: unpacked from the asar in
 * a packaged app, beside the bundle in dev and tests. `null` when it is absent or cannot load; the launcher then falls
 * back to Electron's plain vibrancy.
 */

function resolveAddonPath(): string | null {
	const baseDir = import.meta.dirname;
	const unpackedBase = baseDir.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
	const candidates = [
		join(unpackedBase, "vendor", "mac-glass.node"),
		join(baseDir, "vendor", "mac-glass.node"),
		join(dirname(unpackedBase), "main", "vendor", "mac-glass.node"),
		join(dirname(baseDir), "main", "vendor", "mac-glass.node"),
		join(process.resourcesPath ?? "", "app.asar.unpacked", "out", "main", "vendor", "mac-glass.node"),
		join(process.resourcesPath ?? "", "app", "out", "main", "vendor", "mac-glass.node"),
	];
	for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
	return null;
}

export function loadGlassAddon(): GlassAddon | null {
	if (process.platform !== "darwin") return null;
	const path = resolveAddonPath();
	if (path === null) return null;
	try {
		return createRequire(import.meta.url)(path) as GlassAddon;
	} catch (error) {
		console.warn("[mac-glass] could not load the native glass addon:", error instanceof Error ? error.message : error);
		return null;
	}
}
