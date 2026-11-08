import type { WindowPhase } from "./window-chrome";

export interface WindowWorkArea {
	readonly width: number;
	readonly height: number;
}

export interface AppWindowSize {
	readonly width: number;
	readonly height: number;
	readonly minWidth: number;
	readonly minHeight: number;
	readonly center?: true;
}

const WINDOW_SIZES: Readonly<Record<WindowPhase, AppWindowSize>> = {
	finder: { width: 1440, height: 900, minWidth: 1360, minHeight: 820 },
};

/** Keep both the default and minimum window inside the display work area. */
export function appWindowSize(workArea: WindowWorkArea, phase: WindowPhase): AppWindowSize {
	const preferred = WINDOW_SIZES[phase];
	const minimumHeight = phase === "finder" && workArea.height < preferred.minHeight ? Math.min(420, workArea.height) : Math.min(preferred.minHeight, workArea.height);
	return {
		...preferred,
		width: Math.min(preferred.width, workArea.width),
		height: Math.min(preferred.height, workArea.height),
		minWidth: Math.min(preferred.minWidth, workArea.width),
		minHeight: minimumHeight,
	};
}
