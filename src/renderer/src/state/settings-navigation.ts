import type { SettingsCategory } from "../components/SettingsView";

/**
 * "Open Settings on this page": the sidebar's indexing block lives outside the
 * Settings view, which may not be mounted yet. A request waits here until the
 * view mounts (or is delivered at once when it already is).
 */
let pending: SettingsCategory | null = null;
let listener: ((category: SettingsCategory) => void) | null = null;

export function requestSettingsCategory(category: SettingsCategory): void {
	if (listener === null) pending = category;
	else listener(category);
}

/** Called by the mounted Settings view: returns any waiting request, then receives later ones. */
export function attachSettingsNavigation(onRequest: (category: SettingsCategory) => void): { readonly initial: SettingsCategory | null; readonly detach: () => void } {
	const initial = pending;
	pending = null;
	listener = onRequest;
	return {
		initial,
		detach: () => {
			if (listener === onRequest) listener = null;
		},
	};
}
