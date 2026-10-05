import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFinderMetadataResolver,
	parseFinderMetadataPlist,
	type FinderCommandRunner,
} from "../src/main/finder-metadata";

const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";
const COMMENT_XATTR = "com.apple.metadata:kMDItemFinderComment";

/** Real `xattr -p -x` output for a `_kMDItemUserTags` array ["Urgent", "Blue\n4"]. */
const TAGS_HEX =
	"62 70 6C 69 73 74 30 30 A2 01 02 56 55 72 67 65 6E 74 56 42 6C 75 65 0A 34 08 0B 12 " +
	"00 00 00 00 00 00 01 01 00 00 00 00 00 00 00 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 19";

/** Real `xattr -p -x` output for a `kMDItemFinderComment` string "Review & ship". */
const COMMENT_HEX =
	"62 70 6C 69 73 74 30 30 5D 52 65 76 69 65 77 20 26 20 73 68 69 70 08 00 00 00 00 00 00 " +
	"01 01 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 16";

/** What `plutil -convert xml1` prints for TAGS_HEX. */
const TAGS_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><array><string>Urgent</string><string>Blue\n4</string></array></plist>';

/** What `plutil -convert xml1` prints for COMMENT_HEX. */
const COMMENT_XML =
	'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><string>Review &amp; ship</string></plist>';

function hexBytes(hex: string): string {
	return Buffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex").toString("hex");
}

function indexedPlist(dict = ""): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${dict}</dict></plist>`;
}

const INDEXED = indexedPlist(
	[
		"<key>kMDItemFSCreationDate</key><date>2026-09-01T12:00:00Z</date>",
		"<key>kMDItemDateAdded</key><date>2026-09-02T12:00:00Z</date>",
		"<key>kMDItemLastUsedDate</key><date>2026-09-03T12:00:00Z</date>",
		"<key>kMDItemStarRating</key><integer>4</integer>",
		"<key>kMDItemPixelWidth</key><integer>1920</integer>",
		"<key>kMDItemPixelHeight</key><integer>1080</integer>",
	].join(""),
);

interface RunnerFixtures {
	readonly tags?: string;
	readonly comment?: string;
	readonly tagsXml?: string;
	readonly commentXml?: string;
	readonly mdls?: string;
	readonly application?: string;
}

/** Answers xattr from fixtures, plutil from the matching XML, mdls from `INDEXED`, and the opener from Launch Services. */
function fixtureRunner(overrides: RunnerFixtures = {}): FinderCommandRunner {
	return async (command, args, input) => {
		if (command === "/usr/bin/xattr") {
			const name = args[2] ?? "";
			if (name === TAGS_XATTR) return overrides.tags ?? TAGS_HEX;
			if (name === COMMENT_XATTR) return overrides.comment ?? COMMENT_HEX;
			throw new Error(`No such xattr: ${name}`);
		}
		if (command === "/usr/bin/plutil") {
			const hex = Buffer.from(input ?? new Uint8Array()).toString("hex");
			if (hex === hexBytes(TAGS_HEX)) return overrides.tagsXml ?? TAGS_XML;
			if (hex === hexBytes(COMMENT_HEX)) return overrides.commentXml ?? COMMENT_XML;
			throw new Error("plutil: unexpected input");
		}
		if (command === "/usr/bin/mdls") return overrides.mdls ?? INDEXED;
		if (command === "/usr/bin/osascript") return overrides.application ?? "Preview";
		throw new Error(`unexpected command ${command}`);
	};
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-finder-metadata-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function tempFile(name: string): Promise<string> {
	const path = join(root, name);
	await writeFile(path, "x");
	return path;
}

describe("parseFinderMetadataPlist", () => {
	it("maps the indexed dates, tags, comments, dimensions, and rating", () => {
		const xml = indexedPlist(
			[
				"<key>kMDItemFSCreationDate</key><date>2026-09-01T12:00:00Z</date>",
				"<key>kMDItemDateAdded</key><date>2026-09-02T12:00:00Z</date>",
				"<key>kMDItemLastUsedDate</key><date>2026-09-03T12:00:00Z</date>",
				"<key>kMDItemUserTags</key><array><string>Urgent</string><string>Blue</string></array>",
				"<key>kMDItemFinderComment</key><string>Review &amp; ship</string>",
				"<key>kMDItemPixelWidth</key><integer>1920</integer>",
				"<key>kMDItemPixelHeight</key><integer>1080</integer>",
				"<key>kMDItemRating</key><integer>80</integer>",
			].join(""),
		);
		expect(parseFinderMetadataPlist(xml)).toEqual({
			createdAt: "2026-09-01T12:00:00.000Z",
			addedAt: "2026-09-02T12:00:00.000Z",
			lastOpenedAt: "2026-09-03T12:00:00.000Z",
			tags: ["Urgent", "Blue"],
			comments: "Review & ship",
			width: 1920,
			height: 1080,
			rating: 4,
			application: null,
		});
	});

	it("returns explicit empty values for missing indexed fields", () => {
		expect(parseFinderMetadataPlist(indexedPlist())).toEqual({
			createdAt: null,
			addedAt: null,
			lastOpenedAt: null,
			tags: [],
			comments: null,
			width: null,
			height: null,
			rating: null,
			application: null,
		});
	});
});

describe("createFinderMetadataResolver", () => {
	it("merges extended-attribute tags and comment with indexed dates and rating", async () => {
		const resolve = createFinderMetadataResolver({ platform: "darwin", run: fixtureRunner(), warn: () => {} });
		const metadata = await resolve(await tempFile("doc.txt"));
		expect(metadata).toEqual({
			createdAt: "2026-09-01T12:00:00.000Z",
			addedAt: "2026-09-02T12:00:00.000Z",
			lastOpenedAt: "2026-09-03T12:00:00.000Z",
			tags: ["Urgent", "Blue"],
			comments: "Review & ship",
			width: 1920,
			height: 1080,
			rating: 4,
			application: "Preview",
		});
	});

	it("strips the colour suffix from decoded tags and accepts an empty tag array", async () => {
		const resolve = createFinderMetadataResolver({
			platform: "darwin",
			run: fixtureRunner({ tagsXml: "<plist version=\"1.0\"><array/></plist>" }),
			warn: () => {},
		});
		expect((await resolve(await tempFile("empty.txt")))?.tags).toEqual([]);
	});

	it("reports tags, comment, dimensions, and the default app when the index knows nothing", async () => {
		const resolve = createFinderMetadataResolver({
			platform: "darwin",
			run: fixtureRunner({ mdls: indexedPlist() }),
			readImage: async () => ({ width: 64, height: 48 }),
			warn: () => {},
		});
		expect(await resolve(await tempFile("pic.png"))).toEqual({
			createdAt: null,
			addedAt: null,
			lastOpenedAt: null,
			tags: ["Urgent", "Blue"],
			comments: "Review & ship",
			width: 64,
			height: 48,
			rating: null,
			application: "Preview",
		});
	});

	it("falls back to the indexed tags and comment when an extended attribute cannot be decoded", async () => {
		const run: FinderCommandRunner = async (command, args) => {
			if (command === "/usr/bin/xattr") return args[2] === TAGS_XATTR ? TAGS_HEX : COMMENT_HEX;
			if (command === "/usr/bin/plutil") throw new Error("not a property list");
			if (command === "/usr/bin/mdls") {
				return indexedPlist(
					"<key>kMDItemUserTags</key><array><string>Indexed</string></array><key>kMDItemFinderComment</key><string>Indexed note</string>",
				);
			}
			return "Preview";
		};
		const warnings: string[] = [];
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, warn: (message) => warnings.push(message) });
		const metadata = await resolve(await tempFile("broken.txt"));
		expect(metadata?.tags).toEqual(["Indexed"]);
		expect(metadata?.comments).toBe("Indexed note");
		expect(warnings.some((message) => message.includes("is not a property list"))).toBe(true);
	});

	it("returns null without spawning anything on a platform with no Finder metadata", async () => {
		const run = vi.fn(fixtureRunner());
		const resolve = createFinderMetadataResolver({ platform: "win32", run, warn: () => {} });
		expect(await resolve(await tempFile("doc.txt"))).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it("spawns no helper for a protected folder the user cannot read", async () => {
		// Given a folder like /Volumes/X/.Trashes: listable from its parent, but not readable
		const protectedDir = join(root, ".Trashes");
		await mkdir(protectedDir);
		await chmod(protectedDir, 0o300);
		const run = vi.fn(fixtureRunner());
		const warnings: string[] = [];
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, warn: (message) => warnings.push(message) });

		// When its metadata is requested
		const metadata = await resolve(protectedDir);
		await chmod(protectedDir, 0o700);

		// Then there is none, and no xattr/mdls process was started to fail on it
		expect(metadata).toBeNull();
		expect(run).not.toHaveBeenCalled();
		expect(warnings).toEqual([]);
	});

	it("leaves every optional value null when the helpers answer nothing", async () => {
		const run: FinderCommandRunner = async (command) => {
			if (command === "/usr/bin/mdls") return indexedPlist();
			throw new Error(`No such xattr: ${command === "/usr/bin/xattr" ? "attr" : command}`);
		};
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, warn: () => {} });
		expect(await resolve(await tempFile("plain.txt"))).toEqual({
			createdAt: null,
			addedAt: null,
			lastOpenedAt: null,
			tags: [],
			comments: null,
			width: null,
			height: null,
			rating: null,
			application: null,
		});
	});

	it("treats a missing extended attribute silently but warns on a real lookup failure", async () => {
		const warnings: string[] = [];
		let fail = false;
		const run: FinderCommandRunner = async (command, args) => {
			if (command === "/usr/bin/xattr") {
				if (!fail) throw new Error(`No such xattr: ${args[2]}`);
				throw new Error("xattr: spawn failed");
			}
			if (command === "/usr/bin/mdls") return indexedPlist();
			return "";
		};
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, warn: (message) => warnings.push(message) });
		await resolve(await tempFile("quiet.txt"));
		expect(warnings).toEqual([]);
		fail = true;
		await resolve(await tempFile("loud.txt"));
		expect(warnings.some((message) => message.includes("xattr: spawn failed"))).toBe(true);
	});

	it("recomputes when metadata changes at the same modification time", async () => {
		const path = await tempFile("fresh.txt");
		let mdls = indexedPlist("<key>kMDItemDateAdded</key><date>2026-09-02T12:00:00Z</date>");
		const run: FinderCommandRunner = async (command) => {
			if (command === "/usr/bin/mdls") return mdls;
			if (command === "/usr/bin/osascript") return "Preview";
			throw new Error("No such xattr: x");
		};
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, now: () => 1000, warn: () => {} });

		expect((await resolve(path))?.addedAt).toBe("2026-09-02T12:00:00.000Z");
		const before = await stat(path);
		mdls = indexedPlist("<key>kMDItemDateAdded</key><date>2026-09-05T12:00:00Z</date>");
		// chmod bumps the inode change time while leaving the modification time untouched.
		await chmod(path, 0o600);
		const after = await stat(path);
		expect(after.mtimeMs).toBe(before.mtimeMs);

		expect((await resolve(path))?.addedAt).toBe("2026-09-05T12:00:00.000Z");
	});

	it("does not cache an index failure forever", async () => {
		const path = await tempFile("retry.txt");
		let calls = 0;
		let clock = 0;
		const run: FinderCommandRunner = async (command) => {
			if (command === "/usr/bin/mdls") {
				calls += 1;
				if (calls === 1) throw new Error("index unavailable");
				return indexedPlist("<key>kMDItemDateAdded</key><date>2026-09-02T12:00:00Z</date>");
			}
			if (command === "/usr/bin/osascript") return "Preview";
			throw new Error("No such xattr: x");
		};
		const warnings: string[] = [];
		const resolve = createFinderMetadataResolver({
			platform: "darwin",
			run,
			now: () => clock,
			ttlMs: 1000,
			warn: (message) => warnings.push(message),
		});

		expect((await resolve(path))?.addedAt).toBeNull();
		expect(warnings.some((message) => message.includes("mdls failed"))).toBe(true);
		clock = 5000;
		expect((await resolve(path))?.addedAt).toBe("2026-09-02T12:00:00.000Z");
	});

	it("bounds concurrent lookups regardless of how many are requested", async () => {
		let active = 0;
		let maxActive = 0;
		const run: FinderCommandRunner = async (command, args) => {
			if (command === "/usr/bin/xattr") throw new Error(`No such xattr: ${args[2]}`);
			if (command !== "/usr/bin/mdls") return "Preview";
			active += 1;
			maxActive = Math.max(maxActive, active);
			await delay(5);
			active -= 1;
			return indexedPlist();
		};
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, concurrency: 2, warn: () => {} });
		const paths = await Promise.all(Array.from({ length: 6 }, (_, index) => tempFile(`c${index}.txt`)));
		await Promise.all(paths.map((path) => resolve(path)));
		expect(maxActive).toBeGreaterThan(1);
		expect(maxActive).toBeLessThanOrEqual(2);
	});

	it("asks Launch Services once per extension", async () => {
		let applicationCalls = 0;
		const run: FinderCommandRunner = async (command, args) => {
			if (command === "/usr/bin/osascript") {
				applicationCalls += 1;
				return "Preview";
			}
			if (command === "/usr/bin/mdls") return indexedPlist();
			throw new Error(`No such xattr: ${args[2]}`);
		};
		const resolve = createFinderMetadataResolver({ platform: "darwin", run, warn: () => {} });
		const [first, second] = await Promise.all([resolve(await tempFile("a.png")), resolve(await tempFile("b.png"))]);
		expect(first?.application).toBe("Preview");
		expect(second?.application).toBe("Preview");
		expect(applicationCalls).toBe(1);
	});
});
