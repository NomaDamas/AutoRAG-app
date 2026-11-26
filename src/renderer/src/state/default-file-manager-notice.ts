import type { DefaultFileManagerStatus } from "../../../shared/default-file-manager-contract";

/**
 * Decides whether the Notification Center should invite the user to set Dazzi
 * as the OS default file manager (Finder on macOS / File Explorer on Windows).
 *
 * Shown only once onboarding has finished AND the user has signed in, when the
 * OS supports default file manager registration and Dazzi is not yet enabled.
 */
export function shouldPromptDefaultFileManager(input: {
	readonly onboardingPending: boolean;
	readonly signedIn: boolean;
	readonly status: DefaultFileManagerStatus | null;
}): boolean {
	if (input.onboardingPending || !input.signedIn) return false;
	if (input.status === null || !input.status.supported) return false;
	if (input.status.enabled || input.status.osRegistered) return false;
	return true;
}

export const DEFAULT_FILE_MANAGER_NOTICE_ID = "default-file-manager";
export const DEFAULT_FILE_MANAGER_NOTICE_SIGNATURE = "v1";
