import { describe, expect, it } from "vitest";
import {
	createFinderTags,
	spotlightLiteral,
	storedColor,
	tagNameOfStored,
	validTagName,
	type TagCommandRunner,
} from "../src/main/finder-tags";

const TAGS_XATTR = "com.apple.metadata:_kMDItemUserTags";

/** The registry plist `FinderTagDict` decodes to, as `plutil -convert json` prints it. */
const REGISTRY_JSON = JSON.stringify({
	FinderTagDictVersion: 2,
	FinderTags: [
		{ l: 6, n: "Research", p: true },
		{ l: 7, n: "Career", p: true },
		{ n: "Work" },
	],
});

/** A fake machine: per-path stored tag arrays, a registry, and every helper call recorded. */
function fakeMac(options: { registry?: string | null; stored?: Record<string, readonly string[]>; mdfind?: string[] } = {}) {
	const stored = new Map<string, readonly string[]>(Object.entries(options.stored ?? {}));
	const calls: { command: string; args: readonly string[] }[] = [];
	const run: TagCommandRunner = async (command, args, input) => {
		calls.push({ command, args });
		if (command === "/usr/bin/osascript") return Buffer.from(JSON.stringify(["None", "Gray", "Green", "Purple", "Blue", "Yellow", "Red", "Orange"]));
		if (command === "/usr/bin/sqlite3") {
			if (options.registry === null) throw new Error("unable to open database file");
			return Buffer.from(Buffer.from("registry").toString("hex"));
		}
		if (command === "/usr/bin/defaults") return Buffer.from("defaults");
		if (command === "/usr/bin/mdfind") return Buffer.from((options.mdfind ?? []).join("\u0000"));
		if (command === "/usr/bin/plutil") {
			if (args[0] === "-extract") return Buffer.from(JSON.stringify(["", "Research", "Career"]));
			// Registry reads and xattr reads arrive as bytes; writes arrive as the JSON we hand it.
			const text = Buffer.from(input ?? "").toString("utf8");
			if (text === "registry") return Buffer.from(options.registry ?? REGISTRY_JSON);
			if (args[1] === "binary1") return Buffer.from(`bin:${text}`);
			return Buffer.from(text.startsWith("stored:") ? text.slice("stored:".length) : "[]");
		}
		if (command === "/usr/bin/xattr") {
			const flag = args[0];
			const path = args[args.length - 1] ?? "";
			if (flag === "-p") {
				const value = stored.get(path);
				if (value === undefined) {
					if (!path.startsWith("/exists")) throw new Error(`xattr: No such file: ${path}`);
					throw new Error(`xattr: ${path}: No such xattr: ${TAGS_XATTR}`);
				}
				return Buffer.from(Buffer.from(`stored:${JSON.stringify(value)}`).toString("hex"));
			}
			if (flag === "-w") {
				const written = Buffer.from(args[3] ?? "", "hex").toString("utf8");
				stored.set(path, JSON.parse(written.slice("bin:".length)) as string[]);
				return Buffer.alloc(0);
			}
			if (flag === "-d") {
				stored.delete(path);
				return Buffer.alloc(0);
			}
		}
		throw new Error(`unexpected ${command} ${args.join(" ")}`);
	};
	return { run, stored, calls };
}

function tags(mac: ReturnType<typeof fakeMac>, extra: Parameters<typeof createFinderTags>[0] = {}) {
	return createFinderTags({
		platform: "darwin",
		run: mac.run,
		homeDir: "/home",
		registryFiles: async () => ["/home/kvs.sqlite"],
		warn: () => {},
		...extra,
	});
}

describe("stored tag entries", () => {
	it("splits a stored entry into its name and the colour Finder appended", () => {
		expect(tagNameOfStored("Urgent\n6")).toBe("Urgent");
		expect(storedColor("Urgent\n6")).toBe(6);
		expect(tagNameOfStored("Red\n6\n0")).toBe("Red");
		expect(tagNameOfStored("Plain")).toBe("Plain");
		expect(storedColor("Plain")).toBe(0);
		expect(storedColor("Odd\n9")).toBe(0);
	});

	it("keeps a digit that is part of the name", () => {
		expect(tagNameOfStored("Q3 2026")).toBe("Q3 2026");
		expect(tagNameOfStored("Q3 2026\n4")).toBe("Q3 2026");
	});

	it("escapes the characters that end or widen a Spotlight literal", () => {
		expect(spotlightLiteral('say "hi"')).toBe('say \\"hi\\"');
		expect(spotlightLiteral("a*b")).toBe("a\\*b");
		expect(spotlightLiteral("back\\slash")).toBe("back\\\\slash");
		expect(spotlightLiteral("한글 태그")).toBe("한글 태그");
	});

	it("rejects names a file cannot store", () => {
		expect(validTagName("  Research ")).toBe("Research");
		expect(() => validTagName("   ")).toThrow();
		expect(() => validTagName("two\nlines")).toThrow();
		expect(() => validTagName("x".repeat(256))).toThrow();
	});
});

describe("the tag catalog", () => {
	it("reports nothing off macOS, without spawning a helper", async () => {
		const mac = fakeMac();
		const catalog = await createFinderTags({ platform: "win32", run: mac.run }).catalog();
		expect(catalog).toEqual({ supported: false, tags: [], colorNames: [], colorsDenied: false });
		expect(mac.calls).toEqual([]);
	});

	it("lists Finder's registry, then the standard colour tags it has not customized", async () => {
		const catalog = await tags(fakeMac()).catalog();
		expect(catalog.supported).toBe(true);
		const named = catalog.tags.map((tag) => [tag.name, tag.color, tag.sidebar]);
		expect(named.slice(0, 3)).toEqual([
			["Research", 6, true],
			["Career", 7, true],
			["Work", 0, false],
		]);
		expect(named).toContainEqual(["Red", 6, false]);
		expect(named).toContainEqual(["Gray", 1, false]);
	});

	it("falls back to Finder's favourite names when the registry cannot be read", async () => {
		const catalog = await tags(fakeMac({ registry: null })).catalog();
		const sidebar = catalog.tags.filter((tag) => tag.sidebar).map((tag) => tag.name);
		expect(sidebar).toEqual(["Research", "Career"]);
	});

	it("shows the seven colour tags as the sidebar on a Mac that never customized tags", async () => {
		const mac = fakeMac({ registry: JSON.stringify({ FinderTags: [] }) });
		const catalog = await tags(mac).catalog();
		expect(catalog.tags.map((tag) => tag.name)).toEqual(["Red", "Orange", "Yellow", "Green", "Blue", "Purple", "Gray"]);
		expect(catalog.tags.every((tag) => tag.sidebar)).toBe(true);
	});

	it("reports the colours as denied when macOS refuses the app the registry (no Full Disk Access)", async () => {
		const mac = fakeMac();
		const sqliteDenied: TagCommandRunner = (command, args, input) =>
			command === "/usr/bin/sqlite3"
				? Promise.reject(new Error('unable to open database "/home/kvs.sqlite": authorization denied'))
				: mac.run(command, args, input);
		const catalog = await tags(mac, { run: sqliteDenied }).catalog();
		// The names still come from Finder's preferences, but every custom tag has lost its colour.
		expect(catalog.tags.filter((tag) => tag.sidebar).map((tag) => [tag.name, tag.color])).toEqual([["Research", 0], ["Career", 0]]);
		expect(catalog.colorsDenied).toBe(true);
	});

	it("reports the colours as denied when the registry folder cannot even be listed", async () => {
		const listDenied = async (): Promise<readonly string[]> => {
			throw Object.assign(new Error("EPERM: operation not permitted, scandir '/home/Library/Daemon Containers'"), { code: "EPERM" });
		};
		const catalog = await tags(fakeMac(), { registryFiles: listDenied }).catalog();
		expect(catalog.colorsDenied).toBe(true);
		expect(catalog.tags.filter((tag) => tag.sidebar).map((tag) => tag.name)).toEqual(["Research", "Career"]);
	});

	it("does not blame permissions when the registry is merely absent or readable", async () => {
		expect((await tags(fakeMac({ registry: null })).catalog()).colorsDenied).toBe(false);
		expect((await tags(fakeMac()).catalog()).colorsDenied).toBe(false);
		expect((await createFinderTags({ platform: "win32" }).catalog()).colorsDenied).toBe(false);
	});
});

describe("setting tags", () => {
	it("adds a tag with its registry colour and keeps the entries it was not asked to touch", async () => {
		const mac = fakeMac({ stored: { "/exists/a": ["Legacy\n3"] } });
		const result = await tags(mac).set(["/exists/a"], { add: ["Research"], remove: [] });
		expect(result).toEqual({ ok: ["/exists/a"], failed: [] });
		// The existing entry keeps its own suffix; the new one takes the registry's colour.
		expect(mac.stored.get("/exists/a")).toEqual(["Legacy\n3", "Research\n6"]);
	});

	it("writes a tag the registry does not know with no colour suffix", async () => {
		const mac = fakeMac({ stored: { "/exists/a": [] } });
		await tags(mac).set(["/exists/a"], { add: ["Brand New"], remove: [] });
		expect(mac.stored.get("/exists/a")).toEqual(["Brand New"]);
	});

	it("removes a tag case-insensitively and drops the attribute when nothing is left", async () => {
		const mac = fakeMac({ stored: { "/exists/a": ["Research\n6"] } });
		await tags(mac).set(["/exists/a"], { add: [], remove: ["RESEARCH"] });
		expect(mac.stored.has("/exists/a")).toBe(false);
	});

	it("does not write a file that already carries the tag", async () => {
		const mac = fakeMac({ stored: { "/exists/a": ["research\n6"] } });
		const result = await tags(mac).set(["/exists/a"], { add: ["Research"], remove: [] });
		expect(result.ok).toEqual(["/exists/a"]);
		expect(mac.calls.some((call) => call.command === "/usr/bin/xattr" && call.args[0] === "-w")).toBe(false);
	});

	it("tags a file that has no tags yet", async () => {
		const mac = fakeMac({ stored: {} });
		mac.stored.set("/exists/new", []);
		mac.stored.delete("/exists/new");
		const result = await tags(mac).set(["/exists/new"], { add: ["Career"], remove: [] });
		expect(result.failed).toEqual([]);
		expect(mac.stored.get("/exists/new")).toEqual(["Career\n7"]);
	});

	it("fails one path with the verbatim reason and still changes the others", async () => {
		const mac = fakeMac({ stored: { "/exists/a": [] } });
		const result = await tags(mac).set(["/missing/gone", "/exists/a"], { add: ["Work"], remove: [] });
		expect(result.ok).toEqual(["/exists/a"]);
		expect(result.failed).toEqual([{ path: "/missing/gone", message: "xattr: No such file: /missing/gone" }]);
	});

	it("refuses to overwrite a tag attribute that is not a list of names", async () => {
		const mac = fakeMac({ stored: { "/exists/a": [] } });
		const run: TagCommandRunner = async (command, args, input) => {
			if (command === "/usr/bin/plutil" && args[1] === "json") return Buffer.from('{"not":"an array"}');
			return mac.run(command, args, input);
		};
		const result = await tags(mac, { run }).set(["/exists/a"], { add: ["Work"], remove: [] });
		expect(result.ok).toEqual([]);
		expect(result.failed[0]?.path).toBe("/exists/a");
	});

	it("rejects an invalid name before touching any file", async () => {
		const mac = fakeMac({ stored: { "/exists/a": [] } });
		await expect(tags(mac).set(["/exists/a"], { add: ["a\nb"], remove: [] })).rejects.toThrow();
		expect(mac.calls.some((call) => call.command === "/usr/bin/xattr")).toBe(false);
	});

	it("refuses off macOS", async () => {
		await expect(createFinderTags({ platform: "linux" }).set(["/a"], { add: ["x"], remove: [] })).rejects.toThrow();
	});
});

describe("searching a tag", () => {
	it("asks Spotlight for the escaped, case-insensitive name", async () => {
		const mac = fakeMac({ mdfind: ["/a", "/b"] });
		const hits = await tags(mac).search('say "hi"');
		expect([...hits].sort()).toEqual(["/a", "/b"]);
		const query = mac.calls.find((call) => call.command === "/usr/bin/mdfind")?.args.at(-1);
		expect(query).toBe('kMDItemUserTags == "say \\"hi\\""cd');
	});

	it("lets this app's own recent write decide until Spotlight has caught up", async () => {
		let clock = 1_000;
		const mac = fakeMac({ mdfind: ["/exists/old"], stored: { "/exists/new": [], "/exists/old": ["Research\n6"] } });
		const finder = tags(mac, { now: () => clock });
		await finder.set(["/exists/new"], { add: ["Research"], remove: [] });
		await finder.set(["/exists/old"], { add: [], remove: ["Research"] });

		// Spotlight still lists the removed file and not the added one
		expect([...(await finder.search("Research"))].sort()).toEqual(["/exists/new"]);

		// Once the index has had time to catch up, its answer stands alone
		clock += 60_000;
		expect([...(await finder.search("Research"))]).toEqual(["/exists/old"]);
	});

	it("finds nothing off macOS", async () => {
		expect(await createFinderTags({ platform: "linux" }).search("x")).toEqual([]);
	});
});
