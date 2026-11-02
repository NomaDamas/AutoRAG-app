import { createContext, useContext } from "react";
import { DEFAULT_CONTEXT_MENU_SETTINGS, type ContextMenuSettings } from "../../../shared/context-menu-contract";

export const ContextMenuSettingsContext = createContext<ContextMenuSettings>(DEFAULT_CONTEXT_MENU_SETTINGS);

export function useContextMenuSettings(): ContextMenuSettings {
	return useContext(ContextMenuSettingsContext);
}
