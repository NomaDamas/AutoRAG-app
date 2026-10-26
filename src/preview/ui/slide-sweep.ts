/** Minimum time between two steps of the sweep. */
const STEP_MS = 60;
/** However many slides arrive, a burst takes at most this many steps. */
const MAX_STEPS = 20;

export interface SweptSlide {
	readonly index: number;
	readonly bytes: Uint8Array;
}

export interface SweepUpdate {
	readonly slides: readonly SweptSlide[];
	readonly rendering: boolean;
}

/**
 * Keynote writes a deck's slides within a few milliseconds of each other.
 * Applying them as they arrive would sharpen every slide at the same instant;
 * the sweep instead applies them top to bottom, at most one step per 60ms and a
 * burst in at most {@link MAX_STEPS} steps, so the eye sees the deck sharpen
 * from the top. `rendering` goes false only after the last slide is applied.
 */
export function createSlideSweep(apply: (update: SweepUpdate) => void): { readonly push: (update: SweepUpdate) => void; readonly clear: () => void } {
	const queue = new Map<number, Uint8Array>();
	let rendering = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastStepAt = Number.NEGATIVE_INFINITY;
	/** Slides applied per step; sized from the largest backlog so a burst takes at most MAX_STEPS steps. */
	let perStep = 1;

	const step = (): void => {
		timer = undefined;
		perStep = Math.max(perStep, Math.ceil(queue.size / MAX_STEPS));
		const batch = [...queue.keys()]
			.sort((a, b) => a - b)
			.slice(0, perStep)
			.map((index) => ({ index, bytes: queue.get(index)! }));
		for (const { index } of batch) queue.delete(index);
		lastStepAt = Date.now();
		apply({ slides: batch, rendering: rendering || queue.size > 0 });
		if (queue.size > 0) schedule();
	};

	const schedule = (): void => {
		if (timer !== undefined) return;
		const wait = lastStepAt + STEP_MS - Date.now();
		if (wait <= 0) step();
		else timer = setTimeout(step, wait);
	};

	return {
		push(update) {
			for (const { index, bytes } of update.slides) queue.set(index, bytes);
			rendering = update.rendering;
			if (queue.size > 0) {
				schedule();
				return;
			}
			if (timer === undefined) apply({ slides: [], rendering });
		},
		clear() {
			queue.clear();
			rendering = true;
			perStep = 1;
			lastStepAt = Number.NEGATIVE_INFINITY;
			clearTimeout(timer);
			timer = undefined;
		},
	};
}
