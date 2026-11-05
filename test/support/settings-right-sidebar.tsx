import { useState, type ReactElement } from "react";
import { SettingsView, type SettingsCategory } from "../../src/renderer/src/components/SettingsView";
import { SettingsAssistantContext, SettingsAssistantSlot, useSettingsAssistantHost } from "../../src/renderer/src/components/settings/SettingsAssistantDock";

/**
 * Settings as the window shows it: the focused tab beside the window's right sidebar, which hosts the section's AI
 * assistant (App does the same with the Inspector's column), and the toolbar button that shows or hides that sidebar.
 * The right sidebar starts shown, like a fresh profile.
 */
export function SettingsWithRightSidebar({ initialCategory }: { readonly initialCategory?: SettingsCategory }): ReactElement {
	const [rightSidebarVisible, setRightSidebarVisible] = useState(true);
	const { host, dock } = useSettingsAssistantHost({ rightSidebarVisible, setRightSidebarVisible, settingsFocused: true });
	return (
		<SettingsAssistantContext value={host}>
			<button type="button" data-testid="toggle-right-sidebar" aria-pressed={rightSidebarVisible} onClick={() => setRightSidebarVisible((visible) => !visible)} />
			<SettingsView {...(initialCategory === undefined ? {} : { initialCategory })} />
			{rightSidebarVisible && dock !== null ? <SettingsAssistantSlot dock={dock} /> : null}
		</SettingsAssistantContext>
	);
}
