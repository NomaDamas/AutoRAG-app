import { describe, expect, it, vi } from "vitest";
import {
	BACKDROP_MAX_OPACITY,
	BACKDROP_SAFETY_TIMEOUT_MS,
	createRevealBackdropController,
	type BackdropDisplay,
	type BackdropWindowLike,
	type TargetWindowLike,
} from "../src/main/reveal-backdrop";

function makeDisplay(id: number, x: number, y: number, width: number, height: number): BackdropDisplay {
	return { id, bounds: { x, y, width, height }, workArea: { x, y, width, height } };
}
interface FakeBackdropWindow extends BackdropWindowLike {
	bounds: { x: number; y: number; width: number; height: number };
	opacity: number;
	level: string | null;
	destroyed: boolean;
	shown: boolean;
	ignoredMouse: boolean;
}

function makeFakeBackdrop(bounds: { x: number; y: number; width: number; height: number }): FakeBackdropWindow {
	const win = {
		bounds,
		opacity: 0,
		level: null as string | null,
		destroyed: false,
		shown: false,
		ignoredMouse: false,
		isDestroyed: () => win.destroyed,
		setOpacity: vi.fn((value: number) => {
			win.opacity = value;
		}),
		setAlwaysOnTop: vi.fn((flag: boolean, level?: string) => {
			win.level = flag ? (level ?? "floating") : null;
		}),
		setIgnoreMouseEvents: vi.fn((ignore: boolean) => {
			win.ignoredMouse = ignore;
		}),
		setVisibleOnAllWorkspaces: vi.fn(),
		showInactive: vi.fn(() => {
			win.shown = true;
		}),
		destroy: vi.fn(() => {
			win.destroyed = true;
		}),
	};
	return win;
}

function makeTargetWindow(opts: { fullScreen?: boolean; minimized?: boolean } = {}): TargetWindowLike & {
	level: string | null;
	movedTop: number;
	closedListeners: (() => void)[];
} {
	const closedListeners: (() => void)[] = [];
	const target = {
		level: null as string | null,
		movedTop: 0,
		closedListeners,
		isDestroyed: () => false,
		isFullScreen: () => opts.fullScreen ?? false,
		isMinimized: () => opts.minimized ?? false,
		setAlwaysOnTop: vi.fn((flag: boolean, level?: string) => {
			target.level = flag ? (level ?? "floating") : null;
		}),
		moveTop: vi.fn(() => {
			target.movedTop += 1;
		}),
		once: vi.fn((event: string, listener: () => void) => {
			if (event === "closed") closedListeners.push(listener);
		}),
	};
	return target;
}

describe("Arc/Dia desktop spotlight backdrop controller", () => {
	it("creates click-through dimmer windows across all displays and elevates the main window above them", () => {
		const created: FakeBackdropWindow[] = [];
		const target = makeTargetWindow();
		const displays = [makeDisplay(1, 0, 0, 1728, 1117), makeDisplay(2, 1728, 0, 2560, 1440)];

		const controller = createRevealBackdropController({
			platform: "darwin",
			getDisplays: () => displays,
			getTargetWindow: () => target,
			createBackdropWindow: (bounds) => {
				const w = makeFakeBackdrop(bounds);
				created.push(w);
				return w;
			},
		});

		controller.setOpacity(0.82);

		expect(created).toHaveLength(2);
		for (const w of created) {
			expect(w.ignoredMouse).toBe(true);
			expect(w.shown).toBe(true);
			expect(w.level).toBe("floating");
			expect(w.opacity).toBeCloseTo(0.82, 4);
		}
		expect(target.level).toBe("floating");
		expect(target.movedTop).toBeGreaterThanOrEqual(1);
		expect(controller.activeCount()).toBe(2);

		// Clamps opacity to BACKDROP_MAX_OPACITY
		controller.setOpacity(1.5);
		expect(created[0]!.opacity).toBeCloseTo(BACKDROP_MAX_OPACITY, 4);

		// Dropping opacity to 0 destroys every backdrop and restores normal z-order
		controller.setOpacity(0);
		expect(controller.activeCount()).toBe(0);
		for (const w of created) expect(w.destroyed).toBe(true);
		expect(target.level).toBeNull();
	});

	it("skips spawning backdrops when the main window is fullscreen or minimized", () => {
		const createSpy = vi.fn();
		const fsTarget = makeTargetWindow({ fullScreen: true });
		const controller = createRevealBackdropController({
			platform: "darwin",
			getDisplays: () => [makeDisplay(1, 0, 0, 1440, 900)],
			getTargetWindow: () => fsTarget,
			createBackdropWindow: createSpy,
		});

		controller.setOpacity(0.8);
		expect(createSpy).not.toHaveBeenCalled();
		expect(controller.activeCount()).toBe(0);
	});

	it("cleans up automatically when the main window closes or when the safety timeout elapses", () => {
		vi.useFakeTimers();
		try {
			const created: FakeBackdropWindow[] = [];
			const target = makeTargetWindow();
			const controller = createRevealBackdropController({
				platform: "darwin",
				getDisplays: () => [makeDisplay(1, 0, 0, 1440, 900)],
				getTargetWindow: () => target,
				createBackdropWindow: (bounds) => {
					const w = makeFakeBackdrop(bounds);
					created.push(w);
					return w;
				},
			});

			controller.setOpacity(0.75);
			expect(controller.activeCount()).toBe(1);

			// Safety timeout guarantees no stuck black overlay if renderer crashes mid-reveal
			vi.advanceTimersByTime(BACKDROP_SAFETY_TIMEOUT_MS + 100);
			expect(controller.activeCount()).toBe(0);
			expect(created[0]!.destroyed).toBe(true);
			expect(target.level).toBeNull();

			// Re-open then trigger target window close
			controller.setOpacity(0.6);
			expect(controller.activeCount()).toBe(1);
			for (const fn of target.closedListeners) fn();
			expect(controller.activeCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
