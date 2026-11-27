import { describe, expect, it, vi } from "vitest";
import {
	BACKDROP_DUSK_MAX,
	BACKDROP_SAFETY_TIMEOUT_MS,
	createRevealBackdropController,
	type BackdropDisplay,
	type BackdropWindowLike,
	type TargetWindowLike,
} from "../src/main/reveal-backdrop";
import type { RevealLightFrame, RevealLightScene } from "../src/shared/reveal-light";

function makeDisplay(id: number, x: number, y: number, width: number, height: number): BackdropDisplay {
	return { id, bounds: { x, y, width, height }, workArea: { x, y: y + 25, width, height: height - 25 } };
}

function frame(values: Partial<RevealLightFrame> = {}): RevealLightFrame {
	return { time: 2, dusk: 1, light: 0.9, spread: 0.5, glow: 0.8, rise: 0, open: 0, ...values };
}

interface FakeBackdropWindow extends BackdropWindowLike {
	bounds: { x: number; y: number; width: number; height: number };
	scene: RevealLightScene;
	frames: RevealLightFrame[];
	level: string | null;
	destroyed: boolean;
	shown: boolean;
	ignoredMouse: boolean;
}

function makeFakeBackdrop(bounds: { x: number; y: number; width: number; height: number }, scene: RevealLightScene): FakeBackdropWindow {
	const win: FakeBackdropWindow = {
		bounds,
		scene,
		frames: [],
		level: null,
		destroyed: false,
		shown: false,
		ignoredMouse: false,
		isDestroyed: () => win.destroyed,
		drawFrame: vi.fn((value: RevealLightFrame) => {
			win.frames.push(value);
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
		getContentBounds: () => ({ x: 200, y: 120, width: 1200, height: 760 }),
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

describe("reveal desktop light controller", () => {
	it("covers every display with click-through light windows that share one scene, and keeps the main window above them", () => {
		const created: FakeBackdropWindow[] = [];
		const target = makeTargetWindow();
		const displays = [makeDisplay(1, 0, 0, 1728, 1117), makeDisplay(2, 1728, 0, 2560, 1440)];

		const controller = createRevealBackdropController({
			platform: "darwin",
			getDisplays: () => displays,
			getTargetWindow: () => target,
			createBackdropWindow: (bounds, scene) => {
				const w = makeFakeBackdrop(bounds, scene);
				created.push(w);
				return w;
			},
		});

		controller.setFrame(frame());

		expect(created).toHaveLength(2);
		for (const w of created) {
			expect(w.ignoredMouse).toBe(true);
			expect(w.shown).toBe(true);
			expect(w.level).toBe("floating");
			expect(w.frames).toHaveLength(1);
			// Every surface knows where the Dazzi window is and measures the field by the display it is on.
			expect(w.scene).toMatchObject({ windowX: 200, windowY: 120, windowWidth: 1200, windowHeight: 760, unit: 1117, duskMax: BACKDROP_DUSK_MAX });
		}
		// On macOS the menu bar stays clear.
		expect(created[0]!.scene.originY).toBe(25);
		expect(created[1]!.scene.originX).toBe(1728);
		expect(target.level).toBe("floating");
		expect(target.movedTop).toBeGreaterThanOrEqual(1);
		expect(controller.activeCount()).toBe(2);

		controller.setFrame(frame({ rise: 0.5, open: 1 }));
		expect(created[0]!.frames.at(-1)).toMatchObject({ rise: 0.5, open: 1 });

		// A frame with nothing left to draw tears every window down and restores the normal z-order.
		controller.setFrame(frame({ dusk: 0, light: 0 }));
		expect(controller.activeCount()).toBe(0);
		for (const w of created) expect(w.destroyed).toBe(true);
		expect(target.level).toBeNull();
	});

	it("covers the full display bounds outside macOS", () => {
		const created: FakeBackdropWindow[] = [];
		const controller = createRevealBackdropController({
			platform: "win32",
			getDisplays: () => [makeDisplay(1, 0, 0, 1920, 1080)],
			getTargetWindow: () => makeTargetWindow(),
			createBackdropWindow: (bounds, scene) => {
				const w = makeFakeBackdrop(bounds, scene);
				created.push(w);
				return w;
			},
		});
		controller.setFrame(frame());
		expect(created[0]!.bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
		controller.setFrame(null);
		expect(controller.activeCount()).toBe(0);
	});

	it("skips spawning backdrops when the main window is fullscreen or minimized", () => {
		const createSpy = vi.fn();
		const controller = createRevealBackdropController({
			platform: "darwin",
			getDisplays: () => [makeDisplay(1, 0, 0, 1440, 900)],
			getTargetWindow: () => makeTargetWindow({ fullScreen: true }),
			createBackdropWindow: createSpy,
		});

		controller.setFrame(frame());
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
				createBackdropWindow: (bounds, scene) => {
					const w = makeFakeBackdrop(bounds, scene);
					created.push(w);
					return w;
				},
			});

			controller.setFrame(frame());
			expect(controller.activeCount()).toBe(1);

			// The safety timeout guarantees no stuck overlay if the renderer crashes mid-reveal.
			vi.advanceTimersByTime(BACKDROP_SAFETY_TIMEOUT_MS + 100);
			expect(controller.activeCount()).toBe(0);
			expect(created[0]!.destroyed).toBe(true);
			expect(target.level).toBeNull();

			controller.setFrame(frame());
			expect(controller.activeCount()).toBe(1);
			for (const fn of target.closedListeners) fn();
			expect(controller.activeCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
