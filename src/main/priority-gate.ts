/**
 * Counting semaphore that serves the highest-priority waiter first, FIFO
 * within one priority. Callers stamp each batch with a rising number, so
 * the batch the user asked for last — the folder they just opened, the rows
 * they just scrolled to — takes the next free permit instead of queuing
 * behind thousands of requests from a folder they already left. Superseded
 * work still runs, but only once nothing newer is waiting.
 */
export interface PriorityGate {
	acquire(priority: number): Promise<void>;
	release(): void;
}

interface Bucket {
	readonly priority: number;
	readonly waiters: Array<() => void>;
	/** Index of the next waiter to wake; avoids O(n) `shift` on long queues. */
	head: number;
}

export function createPriorityGate(permits: number): PriorityGate {
	let available = permits;
	/** Ascending by priority; the last non-empty bucket is served next. */
	const buckets: Bucket[] = [];
	return {
		async acquire(priority) {
			if (available > 0) {
				available -= 1;
				return;
			}
			const { promise, resolve } = Promise.withResolvers<void>();
			// Batches almost always arrive in rising order, so scan from the end.
			let index = buckets.length;
			while (index > 0 && (buckets[index - 1]?.priority ?? 0) > priority) index -= 1;
			const existing = buckets[index - 1];
			if (existing !== undefined && existing.priority === priority) existing.waiters.push(resolve);
			else buckets.splice(index, 0, { priority, waiters: [resolve], head: 0 });
			await promise;
		},
		release() {
			// Drained buckets are popped eagerly, so the top bucket always holds a waiter.
			const bucket = buckets.at(-1);
			const next = bucket?.waiters[bucket.head];
			if (bucket === undefined || next === undefined) {
				available += 1;
				return;
			}
			bucket.head += 1;
			if (bucket.head === bucket.waiters.length) buckets.pop();
			// The permit passes straight to the woken waiter.
			next();
		},
	};
}
