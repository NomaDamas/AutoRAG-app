import { describe, expect, it, vi } from "vitest";
import {
	ICON_LIMIT,
	type IconTarget,
	SYSTEM_ICON_CONCURRENCY,
	THUMBNAIL_CONCURRENCY,
	createIconProvider,
} from "../src/main/file-icon";
import { iconUrl, handleIconRequest } from "../src/main/icon-protocol";

const BYTES = new Uint8Array([1, 2, 3, 4]);
const MTIME = "2026-09-29T00:00:00.000Z";
const target = (path: string, modifiedAt = MTIME): IconTarget => ({ path, modifiedAt });

describe("createIconProvider", () => {
	it("generates one thumbnail per listed file and returns a URL per produced thumbnail", async () => {
		// Given a macOS provider whose native thumbnail generator records its calls
		const generated: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => {
				generated.push(path);
				return BYTES;
			},
		});

		// When two files are listed together
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/b.mp4")]);

		// Then the OS was asked per file and each URL carries its own cache identity
		expect([...generated].sort()).toEqual(["/docs/a.png", "/docs/b.mp4"]);
		expect(icons.get("/docs/a.png")).toBe(
			"autorag-thumb://local/?path=%2Fdocs%2Fa.png&mtime=2026-09-29T00%3A00%3A00.000Z",
		);
		expect(icons.get("/docs/b.mp4")).toBe(iconUrl("/docs/b.mp4", MTIME));
	});

	it("keeps the produced bytes in the store so the protocol can serve them", async () => {
		// Given a provider that produced one thumbnail
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => BYTES,
		});

		// When it is listed
		await provider.icons([target("/docs/a.png", "t1")]);

		// Then the exact bytes are readable under the same identity, and absent elsewhere
		expect(provider.read("/docs/a.png", "t1")).toEqual(BYTES);
		expect(provider.read("/docs/a.png", "t2")).toBeNull();
		expect(provider.read("/docs/missing.png", "t1")).toBeNull();
	});

	it("serves a produced icon through the protocol handler from the same cache", async () => {
		// Given a provider and the URL it handed to the renderer
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => BYTES,
		});
		const url = (await provider.icons([target("/docs/a.png")])).get("/docs/a.png");
		expect(url).toBeDefined();

		// When the protocol handler answers that URL
		const response = await handleIconRequest(new Request(url ?? ""), provider);

		// Then the lazy image load yields the produced PNG bytes
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it("reuses the cached icon for an unchanged file and regenerates a changed one", async () => {
		// Given a provider whose generator counts runs
		let runs = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				runs += 1;
				return BYTES;
			},
		});

		// When the same file is listed twice unchanged, then changes
		await provider.icons([target("/docs/a.png", "t1")]);
		await provider.icons([target("/docs/a.png", "t1")]);
		expect(runs).toBe(1);
		await provider.icons([target("/docs/a.png", "t2")]);

		// Then only the changed file triggered a new run
		expect(runs).toBe(2);
	});

	it("caps one listing at the icon limit", async () => {
		// Given more files than the limit
		const planned: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => {
				planned.push(path);
				return BYTES;
			},
		});
		const many = Array.from({ length: ICON_LIMIT + 5 }, (_value, index) => target(`/docs/f${index}.png`));

		// When they are listed
		const icons = await provider.icons(many);

		// Then exactly the limit was planned and nothing beyond it got an icon
		expect(planned).toHaveLength(ICON_LIMIT);
		expect(icons.size).toBe(ICON_LIMIT);
	});

	it("applies the cap to the selected slice, so a warm re-list generates nothing more", async () => {
		// Given a small cap and a listing larger than it
		const planned: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			limit: 3,
			thumbnail: async (path) => {
				planned.push(path);
				return BYTES;
			},
		});
		const many = Array.from({ length: 300 }, (_value, index) => target(`/docs/f${index}.png`));

		// When the same listing is enriched cold then warm
		const cold = await provider.icons(many);
		const coldPlanned = [...planned];
		planned.length = 0;
		const warm = await provider.icons(many);

		// Then only the first `limit` targets were ever selected, and the warm pass added nothing
		expect(coldPlanned).toEqual(["/docs/f0.png", "/docs/f1.png", "/docs/f2.png"]);
		expect([...cold.keys()]).toEqual(["/docs/f0.png", "/docs/f1.png", "/docs/f2.png"]);
		expect(planned).toEqual([]);
		expect([...warm.keys()]).toEqual(["/docs/f0.png", "/docs/f1.png", "/docs/f2.png"]);
	});

	it("runs native thumbnail generation within the bounded pool", async () => {
		// Given a generator held open until the pool is saturated
		let active = 0;
		let maximum = 0;
		let started = 0;
		const gate = Promise.withResolvers<void>();
		const saturated = Promise.withResolvers<void>();
		const provider = createIconProvider({
			platform: "darwin",
			thumbnailConcurrency: 2,
			thumbnail: async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				started += 1;
				if (started === 2) saturated.resolve();
				await gate.promise;
				active -= 1;
				return BYTES;
			},
		});
		const many = Array.from({ length: 8 }, (_value, index) => target(`/docs/f${index}.png`));

		// When the pool is saturated
		const pending = provider.icons(many);
		await saturated.promise;

		// Then no more than the configured pool ran at once
		expect(maximum).toBe(2);
		gate.resolve();
		await pending;
	});

	it("shares one thumbnail budget across concurrent listings", async () => {
		// Given two listings together richer than the pool
		let active = 0;
		let maximum = 0;
		let started = 0;
		const gate = Promise.withResolvers<void>();
		const saturated = Promise.withResolvers<void>();
		const provider = createIconProvider({
			platform: "darwin",
			thumbnailConcurrency: 3,
			thumbnail: async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				started += 1;
				if (started === 3) saturated.resolve();
				await gate.promise;
				active -= 1;
				return BYTES;
			},
		});
		const first = Array.from({ length: 10 }, (_value, index) => target(`/a/f${index}.png`));
		const second = Array.from({ length: 10 }, (_value, index) => target(`/b/f${index}.png`));

		// When they enrich at the same time
		const pending = Promise.all([provider.icons(first), provider.icons(second)]);
		await saturated.promise;

		// Then the two calls together still never exceeded one pool
		expect(maximum).toBe(3);
		gate.resolve();
		await pending;
	});

	it("single-flights a target requested by two concurrent listings", async () => {
		// Given a generator that counts every run
		let calls = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				calls += 1;
				return BYTES;
			},
		});

		// When the same file is requested twice before either finishes
		const [first, second] = await Promise.all([
			provider.icons([target("/docs/a.png")]),
			provider.icons([target("/docs/a.png")]),
		]);

		// Then it was generated once and both callers got the same URL
		expect(calls).toBe(1);
		expect(first.get("/docs/a.png")).toBe(iconUrl("/docs/a.png", MTIME));
		expect(second.get("/docs/a.png")).toBe(first.get("/docs/a.png"));
	});

	it("deduplicates a repeated target within one listing", async () => {
		// Given the same identity listed twice in one call
		let calls = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				calls += 1;
				return BYTES;
			},
		});

		// When both copies are enriched
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/a.png")]);

		// Then the OS was asked once and one URL came back
		expect(calls).toBe(1);
		expect([...icons.keys()]).toEqual(["/docs/a.png"]);
	});

	it("keeps the other icons when one native thumbnail fails", async () => {
		// Given a generator that rejects for one file only
		const warnings: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => {
				if (path.endsWith("b.bin")) throw new Error("XPC connection interrupted");
				return BYTES;
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When three files are listed
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/b.bin"), target("/docs/c.png")]);

		// Then only the failing file is missing and the failure surfaced verbatim
		expect([...icons.keys()].sort()).toEqual(["/docs/a.png", "/docs/c.png"]);
		expect(warnings.join("\n")).toContain("XPC connection interrupted");
	});

	it("does not regenerate icons for files that produced none", async () => {
		// Given a file with no native thumbnail (the API yields null)
		let generateCalls = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				generateCalls += 1;
				return null;
			},
		});

		// When the same file is listed twice
		expect((await provider.icons([target("/docs/app.zip")])).size).toBe(0);
		expect((await provider.icons([target("/docs/app.zip")])).size).toBe(0);

		// Then the OS was only asked once — per-file nulls are cached too
		expect(generateCalls).toBe(1);
	});

	it("skips a file the generator produced nothing for", async () => {
		// Given a generator that only produces one of two files
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => (path === "/docs/a.png" ? BYTES : null),
		});

		// When both are listed
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/unsupported.bin")]);

		// Then only the produced one has an icon
		expect([...icons.keys()]).toEqual(["/docs/a.png"]);
	});

	it("logs a generation failure verbatim and returns no icons", async () => {
		// Given a generator that fails every file
		const warnings: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				throw new Error("nativeImage: failed to generate thumbnails");
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When a file is listed
		const icons = await provider.icons([target("/docs/a.png")]);

		// Then the listing survives with no icon and the real message is visible
		expect(icons.size).toBe(0);
		expect(warnings.join("\n")).toContain("nativeImage: failed to generate thumbnails");
	});

	it("times out one native thumbnail without losing the batch", async () => {
		// Real timers here are the behavior under test (the per-file deadline),
		// so drive them with fake timers rather than waiting on the wall clock.
		vi.useFakeTimers();
		try {
			const warnings: string[] = [];
			const provider = createIconProvider({
				platform: "darwin",
				thumbnailTimeoutMs: 5,
				thumbnail: (path) =>
					path.endsWith("slow.bin") ? Promise.withResolvers<Uint8Array | null>().promise : Promise.resolve(BYTES),
				warn: (message) => {
					warnings.push(message);
				},
			});

			// When a stuck file and a fast file are listed
			const pending = provider.icons([target("/docs/slow.bin"), target("/docs/fast.png")]);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(5);

			// Then the fast icon survived and the timeout was logged
			const icons = await pending;
			expect([...icons.keys()]).toEqual(["/docs/fast.png"]);
			expect(warnings.join("\n")).toContain("timed out after 5ms");
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses the native thumbnail API on macOS and Windows but the type icon on Linux", async () => {
		// Given generators that record which path the platform took
		const native: string[] = [];
		const type: string[] = [];
		const thumbnail = async (path: string) => {
			native.push(path);
			return BYTES;
		};
		const systemIcon = async (path: string) => {
			type.push(path);
			return BYTES;
		};

		// When each platform lists a file
		for (const platform of ["darwin", "win32"] as const) {
			await createIconProvider({ platform, thumbnail, systemIcon }).icons([target("/docs/a.png")]);
		}
		await createIconProvider({ platform: "linux", thumbnail, systemIcon }).icons([target("/docs/a.png")]);

		// Then only macOS/Windows took the native path and only Linux the type icon
		expect(native).toEqual(["/docs/a.png", "/docs/a.png"]);
		expect(type).toEqual(["/docs/a.png"]);
	});

	it("evicts the least-recently-used identities when the entry cap is exceeded", async () => {
		// Given a cache that holds only two identities
		const provider = createIconProvider({
			platform: "darwin",
			cacheMaxEntries: 2,
			thumbnail: async () => BYTES,
		});

		// When three are generated
		await provider.icons([target("/docs/a.png"), target("/docs/b.png"), target("/docs/c.png")]);

		// Then the oldest is gone and the newest are still served
		expect(provider.read("/docs/a.png", MTIME)).toBeNull();
		expect(provider.read("/docs/b.png", MTIME)).toEqual(BYTES);
		expect(provider.read("/docs/c.png", MTIME)).toEqual(BYTES);
	});

	it("keeps the cache within its byte budget", async () => {
		// Given a cache whose budget only fits two four-byte icons
		const provider = createIconProvider({
			platform: "darwin",
			cacheMaxEntries: 16,
			cacheMaxBytes: BYTES.byteLength * 2,
			thumbnail: async () => BYTES,
		});

		// When three are generated
		await provider.icons([target("/docs/a.png"), target("/docs/b.png"), target("/docs/c.png")]);

		// Then the byte budget evicted the oldest while the newest stayed
		expect(provider.read("/docs/a.png", MTIME)).toBeNull();
		expect(provider.read("/docs/b.png", MTIME)).toEqual(BYTES);
		expect(provider.read("/docs/c.png", MTIME)).toEqual(BYTES);
	});

	it("uses the OS type icon off macOS and Windows with bounded concurrency", async () => {
		// Given a Linux provider whose lookups hold until the pool saturates
		let active = 0;
		let maximum = 0;
		let started = 0;
		const asked: string[] = [];
		const gate = Promise.withResolvers<void>();
		const saturated = Promise.withResolvers<void>();
		const provider = createIconProvider({
			platform: "linux",
			systemConcurrency: 2,
			systemIcon: async (path) => {
				active += 1;
				maximum = Math.max(maximum, active);
				asked.push(path);
				started += 1;
				if (started === 2) saturated.resolve();
				await gate.promise;
				active -= 1;
				return path.endsWith(".mp4") ? BYTES : null;
			},
		});
		const many = Array.from({ length: SYSTEM_ICON_CONCURRENCY + 3 }, (_value, index) => target(`/docs/f${index}.mp4`));

		// When the pool is saturated
		const pending = provider.icons(many);
		await saturated.promise;

		// Then lookups never exceeded the configured pool
		expect(maximum).toBe(2);
		gate.resolve();
		const icons = await pending;
		expect(icons.size).toBe(many.length);
		expect(asked).toHaveLength(many.length);
	});

	it("keeps the other OS icons when one getFileIcon lookup fails", async () => {
		// Given a lookup that throws for one file only
		const warnings: string[] = [];
		const provider = createIconProvider({
			platform: "linux",
			systemIcon: async (path) => {
				if (path.endsWith("b.bin")) throw new Error("EPERM: cannot read icon");
				return BYTES;
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When three files are listed
		const icons = await provider.icons([target("/docs/a.mp4"), target("/docs/b.bin"), target("/docs/c.png")]);

		// Then only the failing file is missing and the failure surfaced verbatim
		expect([...icons.keys()].sort()).toEqual(["/docs/a.mp4", "/docs/c.png"]);
		expect(warnings.join("\n")).toContain("EPERM: cannot read icon");
	});

	it("times out one getFileIcon lookup without losing the batch", async () => {
		// Real timers here are the behavior under test (the per-file deadline),
		// so drive them with fake timers rather than waiting on the wall clock.
		vi.useFakeTimers();
		try {
			const warnings: string[] = [];
			const provider = createIconProvider({
				platform: "linux",
				systemIconTimeoutMs: 5,
				systemIcon: (path) =>
					path.endsWith("slow.bin") ? Promise.withResolvers<Uint8Array | null>().promise : Promise.resolve(BYTES),
				warn: (message) => {
					warnings.push(message);
				},
			});

			// When a slow file and a fast file are listed
			const pending = provider.icons([target("/docs/slow.bin"), target("/docs/fast.png")]);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(5);

			// Then the fast icon survived and the timeout was logged
			const icons = await pending;
			expect([...icons.keys()]).toEqual(["/docs/fast.png"]);
			expect(warnings.join("\n")).toContain("timed out after 5ms");
		} finally {
			vi.useRealTimers();
		}
	});
});
