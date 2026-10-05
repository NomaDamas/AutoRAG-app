import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOsKindResolver, kindQueryForPlatform, parseKindStdout } from "../src/main/file-kind";

describe("kindQueryForPlatform", () => {
	it("reads Spotlight metadata on macOS, the same string Finder's Kind column shows", () => {
		expect(kindQueryForPlatform("darwin", "/tmp/a.mp4")).toEqual({
			command: "/usr/bin/mdls",
			args: ["-name", "kMDItemKind", "-raw", "/tmp/a.mp4"],
		});
	});

	it("reads the Explorer type description from the registry on Windows", () => {
		const query = kindQueryForPlatform("win32", "C:\\docs\\a.mp4");
		const script = query?.args[query.args.length - 1] ?? "";
		expect(query?.command).toBe("powershell.exe");
		expect(script).toContain("HKEY_CLASSES_ROOT");
		expect(script).toContain("C:\\docs\\a.mp4");
	});

	it("has no OS query on an unsupported platform", () => {
		expect(kindQueryForPlatform("linux", "/tmp/a.mp4")).toBeNull();
	});
});

describe("parseKindStdout", () => {
	it("reads the mdls raw value verbatim", () => {
		expect(parseKindStdout("MPEG-4 movie")).toBe("MPEG-4 movie");
	});

	it("unquotes an attribute-style value", () => {
		expect(parseKindStdout('"PDF document"')).toBe("PDF document");
	});

	it("treats a missing kind as null", () => {
		expect(parseKindStdout("(null)")).toBeNull();
		expect(parseKindStdout("")).toBeNull();
		expect(parseKindStdout("  \n ")).toBeNull();
		expect(parseKindStdout('"(null)"')).toBeNull();
	});
});

describe("createOsKindResolver", () => {
	it("runs one OS query per extension and reuses the answer", async () => {
		// Given a resolver whose runner records every query
		const queried: string[] = [];
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async (query) => {
				queried.push(query.args[query.args.length - 1] ?? "");
				return "MPEG-4 movie";
			},
		});

		// When two files share an extension
		const first = await resolver.kindFor("/tmp/a.mp4", "mp4");
		const second = await resolver.kindFor("/tmp/b.mp4", "mp4");

		// Then one query answered both
		expect(first).toBe("MPEG-4 movie");
		expect(second).toBe("MPEG-4 movie");
		expect(queried).toEqual(["/tmp/a.mp4"]);
	});

	it("queries a different extension separately", async () => {
		// Given a resolver with a per-extension answer
		const queried: string[] = [];
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async (query) => {
				const path = query.args[query.args.length - 1] ?? "";
				queried.push(path);
				return path.endsWith(".pdf") ? "PDF document" : "MPEG-4 movie";
			},
		});

		// When two distinct extensions are resolved
		expect(await resolver.kindFor("/tmp/a.mp4", "mp4")).toBe("MPEG-4 movie");
		expect(await resolver.kindFor("/tmp/b.pdf", "pdf")).toBe("PDF document");

		// Then both were queried
		expect(queried).toEqual(["/tmp/a.mp4", "/tmp/b.pdf"]);
	});

	it("keys an extensionless file by its path, not by an empty extension", async () => {
		// Given a resolver with a per-path answer
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async (query) => `kind:${query.args[query.args.length - 1]}`,
		});

		// When two extensionless files are resolved
		expect(await resolver.kindFor("/tmp/README", "")).toBe("kind:/tmp/README");
		expect(await resolver.kindFor("/tmp/Makefile", "")).toBe("kind:/tmp/Makefile");
	});

	it("degrades to null and warns verbatim when the OS query fails", async () => {
		// Given a failing runner
		const warnings: string[] = [];
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async () => {
				throw new Error("mdls: No such file or directory");
			},
			warn: (message) => {
				warnings.push(message);
			},
		});

		// When the kind is requested
		expect(await resolver.kindFor("/tmp/a.mp4", "mp4")).toBeNull();

		// Then the failure text is visible, never swallowed
		expect(warnings.join("\n")).toContain("mdls: No such file or directory");
	});

	it("does not let one failed lookup erase the kind for its whole extension", async () => {
		// Given a runner that cannot answer for one PDF but can for the next
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async (query) => {
				if (query.args.at(-1) === "/tmp/broken.pdf") throw new Error("could not find /tmp/broken.pdf.");
				return "PDF document";
			},
			warn: () => {},
		});

		// When the broken file resolves first
		expect(await resolver.kindFor("/tmp/broken.pdf", "pdf")).toBeNull();

		// Then a later PDF still gets its OS kind
		expect(await resolver.kindFor("/tmp/report.pdf", "pdf")).toBe("PDF document");
	});

	it("skips a symlink whose target is gone without hiding the kind of its extension", async () => {
		// Given an alias to an uninstalled app, a real app, and a file the OS fails on
		const dir = await mkdtemp(join(tmpdir(), "autorag-file-kind-"));
		const dangling = join(dir, "Gone.app");
		const app = join(dir, "Real.app");
		const broken = join(dir, "broken.bin");
		await symlink(join(dir, "deleted", "Gone.app"), dangling);
		await writeFile(app, "x");
		await writeFile(broken, "x");
		const queried: string[] = [];
		const warnings: string[] = [];
		const resolver = createOsKindResolver({
			platform: "darwin",
			run: async (query) => {
				const path = query.args.at(-1) ?? "";
				queried.push(path);
				if (path === broken) throw new Error(`${path}: could not find it.`);
				return "Application";
			},
			warn: (message) => warnings.push(message),
		});

		// When the dangling alias resolves first
		expect(await resolver.kindFor(dangling, "app")).toBeNull();
		expect(await resolver.kindFor(app, "app")).toBe("Application");
		expect(await resolver.kindFor(broken, "bin")).toBeNull();

		// Then the alias spawned no query and logged nothing; only the real failure warns
		expect(queried).toEqual([app, broken]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(broken);
		await rm(dir, { recursive: true, force: true });
	});

	it("returns null without querying on an unsupported platform", async () => {
		// Given a Linux platform
		let ran = false;
		const resolver = createOsKindResolver({
			platform: "linux",
			run: async () => {
				ran = true;
				return "MPEG-4 movie";
			},
		});

		// When the kind is requested
		expect(await resolver.kindFor("/tmp/a.mp4", "mp4")).toBeNull();

		// Then no process was spawned
		expect(ran).toBe(false);
	});
});
