import { describe, expect, it } from "vitest";
import { createPriorityGate, type PriorityGate } from "../src/main/priority-gate";

/** Queue `label` behind the gate and record when it is let through. */
function enqueue(gate: PriorityGate, priority: number, label: string, order: string[]): Promise<void> {
	return gate.acquire(priority).then(() => {
		order.push(label);
	});
}

describe("createPriorityGate", () => {
	it("lets the newest batch through before older waiters, FIFO within a batch", async () => {
		// Given a single permit held while an old folder's batch and then a new one queue up
		const gate = createPriorityGate(1);
		await gate.acquire(1);
		const order: string[] = [];
		const waiting = [
			enqueue(gate, 1, "old-a", order),
			enqueue(gate, 1, "old-b", order),
			enqueue(gate, 2, "new-a", order),
			enqueue(gate, 2, "new-b", order),
		];

		// When each holder releases in turn
		for (let released = 0; released < waiting.length; released += 1) {
			gate.release();
			await Promise.resolve();
		}
		await Promise.all(waiting);

		// Then the newer batch ran first, each batch in arrival order
		expect(order).toEqual(["new-a", "new-b", "old-a", "old-b"]);
	});

	it("places a late lower-priority waiter behind higher ones already queued", async () => {
		const gate = createPriorityGate(1);
		await gate.acquire(0);
		const order: string[] = [];
		const waiting = [enqueue(gate, 3, "three", order), enqueue(gate, 1, "one", order), enqueue(gate, 2, "two", order)];
		for (let released = 0; released < waiting.length; released += 1) {
			gate.release();
			await Promise.resolve();
		}
		await Promise.all(waiting);
		expect(order).toEqual(["three", "two", "one"]);
	});

	it("never admits more holders than permits, and returns permits once drained", async () => {
		// Given two permits and five waiters
		const gate = createPriorityGate(2);
		let admitted = 0;
		const waiting = Array.from({ length: 5 }, (_value, index) =>
			gate.acquire(index).then(() => {
				admitted += 1;
			}),
		);
		await Promise.resolve();
		expect(admitted).toBe(2);

		// When every holder releases
		for (let released = 0; released < 5; released += 1) {
			gate.release();
			await Promise.resolve();
		}
		await Promise.all(waiting);
		expect(admitted).toBe(5);

		// Then both permits are free again: two immediate acquires succeed, a third waits
		let third = false;
		await gate.acquire(0);
		await gate.acquire(0);
		void gate.acquire(0).then(() => {
			third = true;
		});
		await Promise.resolve();
		expect(third).toBe(false);
	});
});
