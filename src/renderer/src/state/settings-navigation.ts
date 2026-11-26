import type { SettingsCategory } from "../components/SettingsView";

export interface SettingsNavigationOptions {
	/** Optional prompt to pre-fill into the right-sidebar AI assistant of the target Settings page. */
	readonly assistantPrompt?: string;
}

export interface SettingsNavigationRequest extends SettingsNavigationOptions {
	readonly category: SettingsCategory;
}

/**
 * "Open Settings on this page": the sidebar's indexing block and notification
 * center live outside the Settings view, which may not be mounted yet. A
 * request waits here until the view mounts (or is delivered at once when it
 * already is).
 */
let pending: SettingsNavigationRequest | null = null;
let listener: ((request: SettingsNavigationRequest) => void) | null = null;

export function requestSettingsCategory(category: SettingsCategory, options?: SettingsNavigationOptions): void {
	const request: SettingsNavigationRequest =
		options?.assistantPrompt === undefined ? { category } : { category, assistantPrompt: options.assistantPrompt };
	if (listener === null) pending = request;
	else listener(request);
}

/** Called by the mounted Settings view: returns any waiting request, then receives later ones. */
export function attachSettingsNavigation(onRequest: (request: SettingsNavigationRequest) => void): {
	readonly initial: SettingsNavigationRequest | null;
	readonly detach: () => void;
} {
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
