import { createContext, useContext } from "react";
import {
	DEFAULT_SHORTCUT_SETTINGS,
	formatShortcutChord,
	resolveEffectiveShortcuts,
	type ShortcutId,
	type ShortcutSettings,
} from "../../../shared/shortcuts-contract";
import { hostPlatform } from "../lib/shortcuts";

export const ShortcutSettingsContext = createContext<ShortcutSettings>(DEFAULT_SHORTCUT_SETTINGS);

export function useShortcutSettings(): ShortcutSettings {
	return useContext(ShortcutSettingsContext);
}

/** Formats the active shortcut for `id` on the current platform (`⌘F`, `Ctrl+F`, `F2`, …). */
export function useFormattedShortcut(id: ShortcutId, platform: string = hostPlatform()): string {
	const shortcuts = useShortcutSettings();
	const effective = resolveEffectiveShortcuts(shortcuts);
	return formatShortcutChord(effective[id], platform);
}
