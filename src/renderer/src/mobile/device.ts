/**
 * Reads the browser's device signals for `wantsMobileShell` and follows them:
 * a desktop browser narrowed to phone width, or a phone rotated past the
 * breakpoint, switches shells without a reload. The desktop Electron window is
 * never remote, so it always reads false here.
 */

import { useSyncExternalStore } from "react";
import { isPhoneUserAgent, wantsMobileShell, type DeviceSignals } from "./model";

function isRemoteSession(): boolean {
	return typeof window !== "undefined" && Reflect.get(window, "autoragIsRemote") === true;
}

function readSignals(): DeviceSignals {
	const uaData: unknown = Reflect.get(navigator, "userAgentData");
	const uaMobile = typeof uaData === "object" && uaData !== null && typeof Reflect.get(uaData, "mobile") === "boolean" ? (Reflect.get(uaData, "mobile") as boolean) : undefined;
	return {
		remote: isRemoteSession(),
		width: window.innerWidth,
		height: window.innerHeight,
		coarse: window.matchMedia?.("(pointer: coarse)").matches ?? false,
		phoneAgent: isPhoneUserAgent(navigator.userAgent, uaMobile),
	};
}

/** The decision as the first frame sees it, before React mounts. */
export function initialMobileShell(): boolean {
	return isRemoteSession() && wantsMobileShell(readSignals());
}

function subscribe(listener: () => void): () => void {
	if (!isRemoteSession()) return () => {};
	window.addEventListener("resize", listener);
	window.addEventListener("orientationchange", listener);
	return () => {
		window.removeEventListener("resize", listener);
		window.removeEventListener("orientationchange", listener);
	};
}

export function useMobileShell(): boolean {
	return useSyncExternalStore(subscribe, initialMobileShell, () => false);
}
