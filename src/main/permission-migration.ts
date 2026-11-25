import type { MigrationResult } from "./embedding-migration";

/**
 * Librarian v2.15 replaced the 3-mode Jev approval gate (`ask` | `auto` | `full`) with two deterministic
 * disk permission modes (`readonly` | `full`) and rejects the retired `ask` / `auto` values in `config.json`.
 * An earlier Dazzi or CLI could have written `"permissionMode": "ask"` or `"auto"`, which would cause every
 * later config edit or search to fail validation. Rewrite them to `"readonly"` (the safe restricted mode).
 */
const RETIRED_PERMISSION_MODES = new Set(["ask", "auto"]);

export function migrateLegacyPermissionMode(raw: Record<string, unknown>): MigrationResult {
	const value = raw.permissionMode;
	if (typeof value !== "string") return { raw, changed: false };
	const normalized = value.trim().toLowerCase();
	if (!RETIRED_PERMISSION_MODES.has(normalized)) return { raw, changed: false };
	return { raw: { ...raw, permissionMode: "readonly" }, changed: true };
}
