/**
 * The system-wide shortcut that summons the quick-search launcher. Electron's `globalShortcut` is injected, so the
 * lifecycle (move to a new chord, report one another app holds, let go while Settings records) is testable without it.
 */

import { chordToAccelerator, type QuickSearchSettings, type QuickSearchStatus } from "../shared/quick-search-contract";

export interface QuickSearchShortcutDeps {
	/** `globalShortcut.register`: false when the OS or another app refused the accelerator. */
	readonly register: (accelerator: string, callback: () => void) => boolean;
	readonly unregister: (accelerator: string) => void;
	readonly onPress: () => void;
}

export interface QuickSearchShortcut {
	/** Follow the stored settings; an unchanged chord is left registered. */
	apply(settings: QuickSearchSettings): void;
	/** While Settings records a chord the global one is released, so the keys reach the recorder. */
	setPaused(paused: boolean): void;
	status(): QuickSearchStatus;
	dispose(): void;
}

export function createQuickSearchShortcut(deps: QuickSearchShortcutDeps): QuickSearchShortcut {
	let wanted: string | null = null;
	let paused = false;
	let held: string | null = null;
	let refused = false;

	const sync = (): void => {
		const target = paused ? null : wanted;
		if (target === held) return;
		if (held !== null) deps.unregister(held);
		held = null;
		refused = false;
		if (target === null) return;
		if (deps.register(target, deps.onPress)) held = target;
		else refused = true;
	};

	return {
		apply(settings) {
			// A refused chord is tried again on the next apply: nothing is held, so `sync` registers anew.
			wanted = settings.enabled ? chordToAccelerator(settings.chord) : null;
			sync();
		},
		setPaused(next) {
			paused = next;
			sync();
		},
		status: () => ({ registered: held !== null, error: refused ? "taken" : null }),
		dispose() {
			paused = true;
			sync();
		},
	};
}
