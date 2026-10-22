/**
 * Apple Calendar & Reminders are read through EventKit, which only macOS has
 * (`mcp-server-apple-events` is a macOS program). One rule for both processes:
 * the main process refuses to start the MCP server elsewhere, and Settings
 * disables the connection and says why.
 */
export function calendarSupported(platform: string): boolean {
	return platform === "darwin";
}

/** The datasource template names that mean Apple Calendar & Reminders. */
export function isCalendarDatasourceType(type: string): boolean {
	return type === "calendar" || type === "apple-events";
}
