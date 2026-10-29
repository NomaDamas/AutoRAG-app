import { createContext, useContext } from "react";
import { DEFAULT_SIDEBAR_SETTINGS, type SidebarSettings } from "../../../shared/sidebar-contract";

export const SidebarSettingsContext = createContext<SidebarSettings>(DEFAULT_SIDEBAR_SETTINGS);

export function useSidebarSettings(): SidebarSettings {
	return useContext(SidebarSettingsContext);
}
