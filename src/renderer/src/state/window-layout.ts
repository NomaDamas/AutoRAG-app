/**
 * The window grid's columns: left sidebar, content, right sidebar. A hidden sidebar slides to zero.
 * While Settings is open its own sidebar fills the left column, so that column stays even when the
 * Finder sidebar is hidden (the Finder sidebar's visibility is remembered for when Settings closes).
 */
export function windowColumns({
	sidebarVisible,
	sidebarWidth,
	inspectorVisible,
	inspectorWidth,
	settingsOpen,
}: {
	readonly sidebarVisible: boolean;
	readonly sidebarWidth: number;
	readonly inspectorVisible: boolean;
	readonly inspectorWidth: number;
	readonly settingsOpen: boolean;
}): string {
	return `${sidebarVisible || settingsOpen ? sidebarWidth : 0}px minmax(0,1fr) ${inspectorVisible ? inspectorWidth : 0}px`;
}
