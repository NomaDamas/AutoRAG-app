import { describe, expect, it } from "vitest";
import { createClientWatchSets } from "../src/fs-worker/client-watch";

describe("filesystem client watch sets", () => {
	it("keeps desktop and remote folders watched when either client navigates", async () => {
		// Given two independent pages sharing the worker's native watcher.
		const applied: unknown[] = [];
		const watches = createClientWatchSets((args) => applied.push(args[0]));
		const desktop = watches.connect();
		const remote = watches.connect();
		const signal = new AbortController().signal;
		await desktop.setWatchSet([["/desktop", "/shared"]], signal);
		await remote.setWatchSet([["/remote", "/shared"]], signal);

		// When only the browser navigates to another directory.
		await remote.setWatchSet([["/other"]], signal);

		// Then the desktop's watches remain, and only the browser's old directory leaves.
		expect(applied).toEqual([
			["/desktop", "/shared"],
			["/desktop", "/shared", "/remote"],
			["/desktop", "/shared", "/other"],
		]);
	});

	it("releases only the disconnected client's folders", async () => {
		// Given overlapping desktop and browser subscriptions.
		let current: unknown;
		const watches = createClientWatchSets((args) => { current = args[0]; });
		const desktop = watches.connect();
		const remote = watches.connect();
		const signal = new AbortController().signal;
		await desktop.setWatchSet([["/desktop", "/shared"]], signal);
		await remote.setWatchSet([["/remote", "/shared"]], signal);

		// When the browser disconnects, including repeated cleanup.
		await remote.close();
		await remote.close();
		await remote.setWatchSet([["/stale"]], signal);

		// Then the desktop still receives its directories.
		expect(current).toEqual(["/desktop", "/shared"]);
	});

	it("rejects invalid subscriptions without replacing another client's watches", async () => {
		// Given a valid existing subscription.
		let current: unknown;
		const watches = createClientWatchSets((args) => { current = args[0]; });
		const desktop = watches.connect();
		const remote = watches.connect();
		const signal = new AbortController().signal;
		await desktop.setWatchSet([["/desktop"]], signal);

		// When an untrusted client passes malformed folders.
		expect(() => remote.setWatchSet([["/remote", 42]], signal)).toThrow(TypeError);

		// Then the valid subscription is retained.
		expect(current).toEqual(["/desktop"]);
	});
});
