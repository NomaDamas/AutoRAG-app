import { createContext, useContext, type ReactElement } from "react";
import type { AutomationsShell } from "../hooks/useAutomationsShell";
import { AutomationsView } from "./AutomationsView";

/**
 * The window's automation rules and what the person is doing with them. `FinderPane`
 * is memoized and re-renders only for its own props, so the tab reads the shell
 * through context, the way the directory data and the tag catalog reach a pane.
 */
export const AutomationsContext = createContext<AutomationsShell | null>(null);

/** The body of a 자동화 tab. */
export function AutomationsTab(): ReactElement | null {
	const shell = useContext(AutomationsContext);
	return shell === null ? null : <AutomationsView {...shell.props} />;
}
