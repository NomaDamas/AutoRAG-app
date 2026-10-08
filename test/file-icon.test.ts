import { describe, expect, it, vi } from "vitest";
import {
	ICON_LIMIT,
	PREVIEW_ICON_SIZE,
	type IconTarget,
	SYSTEM_ICON_CONCURRENCY,
	THUMBNAIL_CONCURRENCY,
	createIconProvider,
} from "../src/main/file-icon";
import { iconUrl, handleIconRequest } from "../src/main/icon-protocol";

const BYTES = new Uint8Array([1, 2, 3, 4]);
const MTIME = Date.parse("2026-09-29T00:00:00.000Z");
const target = (path: string, mtimeMs = MTIME): IconTarget => ({
	path,
	mtimeMs,
	ext: path.slice(path.lastIndexOf(".") + 1).toLowerCase(),
});

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
		expect(icons.get("/docs/a.png")).toBe(iconUrl("/docs/a.png", MTIME));
		expect(icons.get("/docs/b.mp4")).toBe(iconUrl("/docs/b.mp4", MTIME));
	});

	it("skips known non-thumbnail files before native generation", async () => {
		// Given a mixed listing whose text file is not a visual thumbnail candidate
		const generated: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			limit: 1,
			thumbnail: async (path) => {
				generated.push(path);
				return BYTES;
			},
		});

		// When both entries are enriched
		const icons = await provider.icons([target("/docs/readme.txt"), target("/docs/photo.png")]);

		// Then Quick Look was called only for the visual file, despite the cap
		expect(generated).toEqual(["/docs/photo.png"]);
		expect([...icons.keys()]).toEqual(["/docs/photo.png"]);
	});

	it("keeps the produced bytes in the store so the protocol can serve them", async () => {
		// Given a provider that produced one thumbnail
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => BYTES,
		});

		// When it is listed
		await provider.icons([target("/docs/a.png", 1)]);

		// Then the exact bytes are readable under the same identity, and absent elsewhere
		expect(provider.read("/docs/a.png", 1)).toEqual(BYTES);
		expect(provider.read("/docs/a.png", 2)).toBeNull();
		expect(provider.read("/docs/missing.png", 1)).toBeNull();
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
		await provider.icons([target("/docs/a.png", 1)]);
		await provider.icons([target("/docs/a.png", 1)]);
		expect(runs).toBe(1);
		await provider.icons([target("/docs/a.png", 2)]);

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
				if (path.endsWith("b.png")) throw new Error("XPC connection interrupted");
				return BYTES;
			},
			systemIcon: async () => null,
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When three files are listed
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/b.png"), target("/docs/c.png")]);

		// Then only the failing file is missing and the failure surfaced verbatim
		expect([...icons.keys()].sort()).toEqual(["/docs/a.png", "/docs/c.png"]);
		expect(warnings.join("\n")).toContain("XPC connection interrupted");
	});

	it("does not regenerate icons for files that produced none", async () => {
		// Given a file with no native thumbnail and no type icon either (both yield null)
		let generateCalls = 0;
		let iconCalls = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				generateCalls += 1;
				return null;
			},
			systemIcon: async () => {
				iconCalls += 1;
				return null;
			},
		});

		// When the same file is listed twice
		expect((await provider.icons([target("/docs/app.png")])).size).toBe(0);
		expect((await provider.icons([target("/docs/app.png")])).size).toBe(0);

		// Then the OS was only asked once per generator — per-file nulls are cached too
		expect(generateCalls).toBe(1);
		expect(iconCalls).toBe(1);
	});

	it("skips a file the generator produced nothing for", async () => {
		// Given a generator that only produces one of two files, with no type icon either
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => (path === "/docs/a.png" ? BYTES : null),
			systemIcon: async () => null,
		});

		// When both are listed
		const icons = await provider.icons([target("/docs/a.png"), target("/docs/unsupported.png")]);

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
			systemIcon: async () => null,
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
					path.endsWith("slow.png") ? Promise.withResolvers<Uint8Array | null>().promise : Promise.resolve(BYTES),
				systemIcon: async () => null,
				warn: (message) => {
					warnings.push(message);
				},
			});

			// When a stuck file and a fast file are listed
			const pending = provider.icons([target("/docs/slow.png"), target("/docs/fast.png")]);
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

	it("falls back to getFileIcon for a file the native thumbnail API produced nothing for", async () => {
		// Given a Windows provider whose thumbnail API renders only the image
		const SYSTEM_BYTES = new Uint8Array([9, 8, 7]);
		const thumbnailPaths: string[] = [];
		const iconPaths: string[] = [];
		const provider = createIconProvider({
			platform: "win32",
			thumbnail: async (path) => {
				thumbnailPaths.push(path);
				return path.endsWith(".png") ? BYTES : null;
			},
			systemIcon: async (path) => {
				iconPaths.push(path);
				return SYSTEM_BYTES;
			},
		});

		// When an image and a document are listed
		const icons = await provider.icons([target("/docs/pic.png"), target("/docs/report.pdf")]);

		// Then the document got the OS type icon and the fallback only ran for it
		expect(thumbnailPaths.sort()).toEqual(["/docs/pic.png", "/docs/report.pdf"]);
		expect(iconPaths).toEqual(["/docs/report.pdf"]);
		expect(provider.read("/docs/report.pdf", MTIME)).toEqual(SYSTEM_BYTES);
		expect(icons.get("/docs/pic.png")).toBe(iconUrl("/docs/pic.png", MTIME));
		expect(icons.get("/docs/report.pdf")).toBe(iconUrl("/docs/report.pdf", MTIME));
	});

	it("degrades to no icon when the getFileIcon fallback also fails", async () => {
		// Given a thumbnail API that yields nothing and a type-icon lookup that fails
		const warnings: string[] = [];
		const provider = createIconProvider({
			platform: "win32",
			thumbnail: async () => null,
			systemIcon: async () => {
				throw new Error("getFileIcon: unsupported type");
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When the document is listed (a visual extension: the win32 pipeline only
		// requests native thumbnails for visual types)
		const icons = await provider.icons([target("/docs/report.png")]);

		// Then the row keeps its letter tile and the fallback failure is logged
		expect(icons.size).toBe(0);
		expect(warnings.join("\n")).toContain("getFileIcon: unsupported type");
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

describe("preview tier", () => {
	it("generates the preview at the large size and returns a size-carrying URL", async () => {
		// Given a macOS provider whose generator records the requested sizes
		const sizes: number[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (_path, size) => {
				sizes.push(size);
				return BYTES;
			},
		});

		// When the inspector asks for one file's preview
		const url = await provider.preview(target("/docs/a.pdf"));

		// Then the OS rendered the large tier and the URL carries it
		expect(sizes).toEqual([PREVIEW_ICON_SIZE]);
		expect(url).toBe(iconUrl("/docs/a.pdf", MTIME, PREVIEW_ICON_SIZE));
	});

	it("keeps preview bytes separate from the tile-icon tier in the same store", async () => {
		// Given a generator whose bytes depend on the requested tier
		const small = new Uint8Array([1]);
		const big = new Uint8Array([2]);
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (_path, size) => (size === PREVIEW_ICON_SIZE ? big : small),
		});

		// When the listing tier and the preview tier both render the same file
		await provider.icons([target("/docs/a.pdf")]);
		await provider.preview(target("/docs/a.pdf"));

		// Then each tier reads back its own bytes
		expect(provider.read("/docs/a.pdf", MTIME)).toEqual(small);
		expect(provider.read("/docs/a.pdf", MTIME, PREVIEW_ICON_SIZE)).toEqual(big);
	});

	it("serves the produced preview through the protocol handler", async () => {
		// Given a provider that rendered one preview
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => BYTES,
		});
		const url = await provider.preview(target("/docs/a.pdf"));
		expect(url).not.toBeNull();

		// When the protocol handler answers that URL
		const response = await handleIconRequest(new Request(url ?? ""), provider);

		// Then the inspector's <img> receives the large-tier bytes
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
	});

	it("returns null when the OS produced no preview, so the inspector keeps its letter tile", async () => {
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => null,
		});

		expect(await provider.preview(target("/docs/a.pdf"))).toBeNull();
	});

	it("skips non-visual extensions without ever entering Quick Look", async () => {
		// Given a macOS provider whose generator must stay untouched
		let runs = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				runs += 1;
				return BYTES;
			},
		});

		// When the inspector asks for a spreadsheet and a source file
		// Then both answers are null at once — Quick Look is never entered
		expect(await provider.preview(target("/docs/books.xlsx"))).toBeNull();
		expect(await provider.preview(target("/src/main.swift"))).toBeNull();
		expect(runs).toBe(0);
	});

	it("caches the preview so re-inspecting an unchanged file never regenerates it", async () => {
		let runs = 0;
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				runs += 1;
				return BYTES;
			},
		});

		await provider.preview(target("/docs/a.pdf"));
		await provider.preview(target("/docs/a.pdf"));

		expect(runs).toBe(1);
	});

	it("single-flights concurrent previews of the same identity", async () => {
		let runs = 0;
		const gate = Promise.withResolvers<void>();
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async () => {
				runs += 1;
				await gate.promise;
				return BYTES;
			},
		});

		const first = provider.preview(target("/docs/a.pdf"));
		const second = provider.preview(target("/docs/a.pdf"));
		gate.resolve();

		expect(await first).toBe(await second);
		expect(runs).toBe(1);
	});

	it("survives a failed preview without poisoning the icon tier", async () => {
		// Given a generator that fails the preview tier only
		const warnings: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (_path, size) => {
				if (size === PREVIEW_ICON_SIZE) throw new Error("QLThumbnailGenerationError: cancelled");
				return BYTES;
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When the preview fails
		const url = await provider.preview(target("/docs/a.pdf"));

		// Then the failure is verbatim in the log and the tile tier still works
		expect(url).toBeNull();
		expect(warnings.join("\n")).toContain("QLThumbnailGenerationError: cancelled");
		const icons = await provider.icons([target("/docs/a.pdf")]);
		expect(icons.get("/docs/a.pdf")).toBe(iconUrl("/docs/a.pdf", MTIME));
	});
});

describe("macOS application bundles", () => {
	it("renders the bundle's own icon through the native thumbnail path, not a letter tile", async () => {
		// Given a macOS provider whose thumbnail generator records its calls
		const generated: string[] = [];
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (path) => {
				generated.push(path);
				return BYTES;
			},
		});

		// When the Applications folder is listed
		const icons = await provider.icons([target("/Applications/Hello.app")]);

		// Then Quick Look was asked for the bundle and the tile carries its icon
		expect(generated).toEqual(["/Applications/Hello.app"]);
		expect(icons.get("/Applications/Hello.app")).toBe(iconUrl("/Applications/Hello.app", MTIME));
	});

	it("serves a 640px preview for a bundle, so the Info panel shows the app rather than a letter", async () => {
		const provider = createIconProvider({
			platform: "darwin",
			thumbnail: async (_path, size) => (size === PREVIEW_ICON_SIZE ? BYTES : null),
		});

		expect(await provider.preview(target("/Applications/Hello.app"))).toBe(
			iconUrl("/Applications/Hello.app", MTIME, PREVIEW_ICON_SIZE),
		);
	});
});

describe("preview lane", () => {
	it("never queues the Inspector preview behind a stuck listing batch", async () => {
		// Given a one-permit listing pool fully occupied by a stalled batch
		const barrier = Promise.withResolvers<void>();
		const provider = createIconProvider({
			platform: "darwin",
			thumbnailConcurrency: 1,
			previewConcurrency: 1,
			thumbnail: async (_path, size) => {
				if (size === PREVIEW_ICON_SIZE) return BYTES;
				await barrier.promise;
				return BYTES;
			},
		});
		const listing = provider.icons([target("/docs/a.png"), target("/docs/b.png")]);

		// When the inspector asks for a preview while the listing pool is stuck
		const url = await provider.preview(target("/docs/deck.pdf"));

		// Then it answers through its own lane instead of timing out behind the batch
		expect(url).toBe(iconUrl("/docs/deck.pdf", MTIME, PREVIEW_ICON_SIZE));
		barrier.resolve();
		await listing;
	});
});
