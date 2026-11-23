import { describe, expect, it } from "vitest";
import {
	assertManifestMatchesPins,
	assertPinsMeetFloors,
	compareVersions,
	deriveVersionFloors,
	loadToolPins,
	readLibrarianRequirements,
} from "../scripts/release/pins.mjs";
import { formatChangesMarkdown, resolveUpdatedPins } from "../scripts/release/refresh-pins.mjs";
describe("readLibrarianRequirements", () => {
	it("extracts MINSYNC_MIN_VERSION, DUPEY_MIN_VERSION, and JIKJI_MIN_VERSION from the installed librarian", () => {
		const requirements = readLibrarianRequirements();
		expect(requirements.minsync).toMatch(/^\d+\.\d+\.\d+$/u);
		expect(requirements.dupey).toMatch(/^\d+\.\d+\.\d+$/u);
		expect(requirements.jikji).toMatch(/^\d+\.\d+\.\d+$/u);
		// Must not lag behind the librarian's actual constants.
		expect(compareVersions(requirements.minsync, "0.7.4")).toBeGreaterThanOrEqual(0);
		expect(compareVersions(requirements.dupey, "0.3.1")).toBeGreaterThanOrEqual(0);
	});
});

describe("tool-pins.json against librarian floors", () => {
	it("satisfies every floor derived from the pinned librarian and app constraints", () => {
		const pins = loadToolPins();
		const floors = deriveVersionFloors(pins, readLibrarianRequirements());
		expect(() => assertPinsMeetFloors(pins, floors)).not.toThrow();
		expect(compareVersions(pins.tools.minsync.version, floors.minsync)).toBeGreaterThanOrEqual(0);
		expect(compareVersions(pins.tools.dupey.version, floors.dupey)).toBeGreaterThanOrEqual(0);
		expect(compareVersions(pins.tools.jikji.version, floors.jikji)).toBeGreaterThanOrEqual(0);
		expect(compareVersions(pins.tools["@nomadamas/mailcrawl"].version, floors["@nomadamas/mailcrawl"])).toBeGreaterThanOrEqual(0);
		expect(compareVersions(pins.tools.lazykatok.version, floors.lazykatok)).toBeGreaterThanOrEqual(0);
	});

	it("fails when a pin drops below what the pinned librarian requires", () => {
		const pins = loadToolPins();
		const stalePins = {
			...pins,
			tools: {
				...pins.tools,
				minsync: { ...pins.tools.minsync, version: "0.7.1" },
			},
		};
		const floors = deriveVersionFloors(stalePins, { minsync: "0.7.4", dupey: "0.3.1", jikji: "0.2.0" });
		expect(() => assertPinsMeetFloors(stalePins, floors)).toThrow(/minsync 0\.7\.1 is below the required 0\.7\.4/u);
	});

	it("fails when a declared floor in tool-pins.json is lower than what the librarian requires", () => {
		const pins = loadToolPins();
		const conflicting = {
			...pins,
			tools: {
				...pins.tools,
				minsync: { ...pins.tools.minsync, floor: "0.7.1" },
			},
		};
		expect(() => deriveVersionFloors(conflicting, { minsync: "0.7.4", dupey: "0.3.1", jikji: "0.2.0" })).toThrow(
			/minsync.*0\.7\.1.*0\.7\.4/u,
		);
	});

	it("fails when a pinned tool's platform asset is missing a sha256 digest", () => {
		const pins = loadToolPins();
		expect(pins.tools.minsync.assets["darwin-arm64"].sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(pins.tools.minsync.assets["win32-x64"].sha256).toMatch(/^[0-9a-f]{64}$/u);
		expect(pins.node.sha256["darwin-arm64"]).toMatch(/^[0-9a-f]{64}$/u);
		expect(pins.node.sha256["win32-x64"]).toMatch(/^[0-9a-f]{64}$/u);
	});
});

describe("assertManifestMatchesPins", () => {
	const pins = loadToolPins();

	function fullManifest(platform: "darwin-arm64" | "win32-x64") {
		const tools = [
			{ name: "node", version: pins.node.version },
			{ name: "autorag", version: pins.librarian.version },
			...Object.entries(pins.tools)
				.filter(([, entry]) => !entry.platforms || entry.platforms.includes(platform))
				.map(([name, entry]) => ({ name, version: entry.version })),
		];
		return { schema: 1, platform, daemon: pins.daemon, tools };
	}

	it("passes and returns comparison rows when tools/manifest.json matches tool-pins.json", () => {
		const result = assertManifestMatchesPins(fullManifest("darwin-arm64"), pins);
		expect(result.rows.length).toBeGreaterThan(10);
		expect(result.rows.every((row: { ok: boolean }) => row.ok)).toBe(true);
	});

	it("ignores tools exclusive to another platform (lazykatok on win32-x64)", () => {
		const result = assertManifestMatchesPins(fullManifest("win32-x64"), pins);
		expect(result.rows.some((row: { name: string }) => row.name === "lazykatok")).toBe(false);
		expect(result.rows.every((row: { ok: boolean }) => row.ok)).toBe(true);
	});

	it("fails loudly when any manifest tool version differs from the pin file", () => {
		const manifest = fullManifest("darwin-arm64");
		const idx = manifest.tools.findIndex((t) => t.name === "minsync");
		manifest.tools[idx] = { name: "minsync", version: "0.7.3" };
		expect(() => assertManifestMatchesPins(manifest, pins)).toThrow(/minsync.*pinned 0\.7\.6.*manifest 0\.7\.3/u);
	});

	it("fails when a pinned tool for the platform is missing from a full manifest", () => {
		const manifest = fullManifest("darwin-arm64");
		manifest.tools = manifest.tools.filter((t) => t.name !== "dupey");
		expect(() => assertManifestMatchesPins(manifest, pins)).toThrow(/dupey.*missing/u);
	});

	it("checks only the requested subset when onlyNames is passed", () => {

		const partial = {
			schema: 1,
			platform: "darwin-arm64",
			daemon: pins.daemon,
			tools: [{ name: "minsync", version: pins.tools.minsync.version }],
		};
		const result = assertManifestMatchesPins(partial, pins, { onlyNames: ["minsync"] });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.ok).toBe(true);
	});
});

describe("resolveUpdatedPins", () => {
	it("updates versions and publisher digests and flags vector-space bumps in markdown summary", async () => {
		const current = {
			schema: 1,
			librarian: { repo: "Marker-Inc-Korea/AutoRAG", ref: "abc", version: "2.14.0" },
			daemon: { owner: "minsync serve", engine: "inl", engineVersion: "0.3.4", discovery: ["~/.cache/im-not-llm/serve"] },
			node: { version: "24.22.0", tag: "v24.22.0", sha256: { "darwin-arm64": "old", "win32-x64": "old" } },
			tools: {
				minsync: {
					source: "github",
					repo: "NomaDamas/MinSync",
					version: "0.7.5",
					tag: "v0.7.5",
					affectsVectorSpace: true,
					assets: {
						"darwin-arm64": { name: "minsync-v0.7.5-aarch64-apple-darwin.tar.gz", sha256: "a".repeat(64) },
						"win32-x64": { name: "minsync-v0.7.5-x86_64-pc-windows-msvc.zip", sha256: "b".repeat(64) },
					},
				},
				dupey: { source: "cargo", crate: "dupey", version: "0.3.1", checksum: "c".repeat(64) },
				"@nomadamas/mailcrawl": { source: "npm", version: "0.3.1", floor: "0.3.0", integrity: "sha512-old" },
			},
		};
		const { next, changes } = await resolveUpdatedPins(current, {
			latestNode24: async () => "v24.22.3",
			fetchText: async () =>
				`${"1".repeat(64)}  node-v24.22.3-darwin-arm64.tar.gz\n${"2".repeat(64)}  node-v24.22.3-win-x64.zip\n`,
			latestRelease: async () => ({
				tag_name: "v0.7.6",
				assets: [
					{ name: "minsync-v0.7.6-aarch64-apple-darwin.tar.gz", digest: `sha256:${"d".repeat(64)}` },
					{ name: "minsync-v0.7.6-x86_64-pc-windows-msvc.zip", digest: `sha256:${"e".repeat(64)}` },
				],
			}),
			latestCrateInfo: async () => ({ version: "0.3.1", checksum: "c".repeat(64) }),
			latestNpmInfo: async () => ({ version: "0.3.2", integrity: "sha512-new" }),
		});

		expect(next.node.version).toBe("24.22.3");
		expect(next.tools.minsync.version).toBe("0.7.6");
		expect(next.tools.minsync.assets["darwin-arm64"].sha256).toBe("d".repeat(64));
		expect(next.tools["@nomadamas/mailcrawl"].integrity).toBe("sha512-new");
		expect(changes.map((c: { name: string }) => c.name)).toEqual(["node", "minsync", "@nomadamas/mailcrawl"]);

		const md = formatChangesMarkdown(changes);
		expect(md).toContain("Vector-space notice");
		expect(md).toContain("`minsync`");
	});

	it("rejects a GitHub release asset that lacks a publisher sha256 digest", async () => {
		const current = {
			schema: 1,
			librarian: { repo: "Marker-Inc-Korea/AutoRAG", ref: "abc", version: "2.14.0" },
			daemon: { owner: "minsync serve", engine: "inl", engineVersion: "0.3.4", discovery: [] },
			node: { version: "24.22.3", tag: "v24.22.3", sha256: { "darwin-arm64": "1".repeat(64), "win32-x64": "2".repeat(64) } },
			tools: {
				minsync: { source: "github", repo: "NomaDamas/MinSync", version: "0.7.5", tag: "v0.7.5", assets: {} },
			},
		};
		await expect(
			resolveUpdatedPins(current, {
				latestNode24: async () => "v24.22.3",
				fetchText: async () =>
					`${"1".repeat(64)}  node-v24.22.3-darwin-arm64.tar.gz\n${"2".repeat(64)}  node-v24.22.3-win-x64.zip\n`,
				latestRelease: async () => ({
					tag_name: "v0.7.6",
					assets: [
						{ name: "minsync-v0.7.6-aarch64-apple-darwin.tar.gz" },
						{ name: "minsync-v0.7.6-x86_64-pc-windows-msvc.zip" },
					],
				}),
				latestCrateInfo: async () => ({ version: "0.3.1", checksum: "c".repeat(64) }),
				latestNpmInfo: async () => ({ version: "0.3.2", integrity: "sha512-new" }),
			}),
		).rejects.toThrow(/publisher digest is missing/u);
	});
});
