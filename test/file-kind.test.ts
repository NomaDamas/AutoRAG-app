import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	createOsKindResolver,
	kindQueryForPlatform,
	parseKindStdout,
	parseWindowsKindStdout,
	windowsKindQuery,
	windowsRegistryExtension,
} from "../src/main/file-kind";

describe("kindQueryForPlatform", () => {
	it("reads Spotlight metadata on macOS, the same string Finder's Kind column shows", () => {
		expect(kindQueryForPlatform("darwin", "/tmp/a.mp4")).toEqual({
			command: "/usr/bin/mdls",
			args: ["-name", "kMDItemKind", "-raw", "/tmp/a.mp4"],
		});
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

	it("bounds the cache: a session over many extensionless files re-asks the coldest, never the hot extension", async () => {
		// Given a resolver that remembers at most three kinds
		const queried: string[] = [];
		const resolver = createOsKindResolver({
			platform: "darwin",
			cacheLimit: 3,
			run: async (query) => {
				queried.push(query.args[query.args.length - 1] ?? "");
				return "kind";
			},
		});

		// When a hot extension stays in use while many extensionless files pass through
		await resolver.kindFor("/tmp/a.png", "png");
		for (const name of ["one", "two", "three", "four"]) {
			await resolver.kindFor(`/tmp/${name}`, "");
			await resolver.kindFor("/tmp/b.png", "png");
		}
		await resolver.kindFor("/tmp/one", "");

		// Then png was asked once, and the evicted /tmp/one is asked again
		expect(queried.filter((path) => path.endsWith(".png"))).toEqual(["/tmp/a.png"]);
		expect(queried.filter((path) => path === "/tmp/one")).toHaveLength(2);
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

describe("windowsRegistryExtension", () => {
	it("reads the extension the way Explorer does", () => {
		expect(windowsRegistryExtension("C:\\docs\\report.PDF")).toBe(".pdf");
		expect(windowsRegistryExtension("C:\\docs\\archive.tar.gz")).toBe(".gz");
		expect(windowsRegistryExtension("C:\\docs\\.gitignore")).toBe(".gitignore");
		expect(windowsRegistryExtension("C:\\dir.d\\README")).toBe("");
		expect(windowsRegistryExtension("C:\\docs\\trailing.")).toBe("");
		expect(windowsRegistryExtension("C:/docs/a.txt")).toBe(".txt");
	});
});

describe("windowsKindQuery / parseWindowsKindStdout", () => {
	it("answers every extension with one stdout line, in order", () => {
		const query = windowsKindQuery([".txt", ".zzz", ".hwp"]);
		expect(query.command).toBe("powershell.exe");
		expect(query.extensions).toEqual([".txt", ".zzz", ".hwp"]);
		expect(parseWindowsKindStdout("Text Document\r\n\r\n한글 문서\r\n", 3)).toEqual(["Text Document", null, "한글 문서"]);
	});

	it("treats missing trailing lines as unknown rather than shifting answers", () => {
		expect(parseWindowsKindStdout("Text Document\r\n", 3)).toEqual(["Text Document", null, null]);
	});
});

describe("createOsKindResolver on Windows", () => {
	/** A runner that answers each extension in a batch from a table and records every batch. */
	function recordingRunner(answers: Record<string, string>) {
		const batches: (readonly string[])[] = [];
		const run = async (query: { readonly extensions?: readonly string[] }) => {
			const extensions = query.extensions ?? [];
			batches.push(extensions);
			return extensions.map((extension) => answers[extension] ?? "").join("\r\n");
		};
		return { batches, run };
	}

	it("never spawns for extensionless files, which the registry cannot answer", async () => {
		// Given 50 extensionless files, the shape that spawned 50 PowerShells before
		const { batches, run } = recordingRunner({});
		const resolver = createOsKindResolver({ platform: "win32", run });

		// When each is resolved
		const kinds = await Promise.all(Array.from({ length: 50 }, (_, index) => resolver.kindFor(`C:\\work\\Makefile${index}`, "")));

		// Then none asked the OS and none has a kind
		expect(kinds.every((kind) => kind === null)).toBe(true);
		expect(batches).toEqual([]);
	});

	it("answers many distinct extensions with one process", async () => {
		// Given a folder of 60 extensions, resolved in the same tick as the listing enrichment does
		const extensions = Array.from({ length: 60 }, (_, index) => `.e${index}`);
		const answers = Object.fromEntries(extensions.map((extension) => [extension, `Kind of ${extension}`]));
		const { batches, run } = recordingRunner(answers);
		const resolver = createOsKindResolver({ platform: "win32", run });

		// When every file asks for its kind
		const kinds = await Promise.all(extensions.map((extension, index) => resolver.kindFor(`C:\\f\\file${index}${extension}`, extension.slice(1))));

		// Then one process answered all of them, each file with its own kind
		expect(batches).toHaveLength(1);
		expect(batches[0]).toEqual(extensions);
		expect(kinds).toEqual(extensions.map((extension) => `Kind of ${extension}`));
	});

	it("shares one lookup between files of the same extension, whatever the case", async () => {
		const { batches, run } = recordingRunner({ ".pdf": "PDF Document" });
		const resolver = createOsKindResolver({ platform: "win32", run });

		const kinds = await Promise.all([
			resolver.kindFor("C:\\a.pdf", "pdf"),
			resolver.kindFor("C:\\b.PDF", "pdf"),
			resolver.kindFor("C:\\sub\\c.Pdf", "pdf"),
		]);

		expect(kinds).toEqual(["PDF Document", "PDF Document", "PDF Document"]);
		expect(batches).toEqual([[".pdf"]]);
	});

	it("asks only for extensions it has not answered yet", async () => {
		const { batches, run } = recordingRunner({ ".pdf": "PDF Document", ".hwp": "한글 문서" });
		const resolver = createOsKindResolver({ platform: "win32", run });

		await resolver.kindFor("C:\\a.pdf", "pdf");
		const second = await Promise.all([resolver.kindFor("C:\\b.pdf", "pdf"), resolver.kindFor("C:\\c.hwp", "hwp")]);

		expect(second).toEqual(["PDF Document", "한글 문서"]);
		expect(batches).toEqual([[".pdf"], [".hwp"]]);
	});

	it("runs one process at a time and batches what arrives meanwhile", async () => {
		// Given a runner we can hold open
		const batches: (readonly string[])[] = [];
		let active = 0;
		let maxActive = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolver = createOsKindResolver({
			platform: "win32",
			run: async (query) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const extensions = query.extensions ?? [];
				batches.push(extensions);
				if (batches.length === 1) await gate;
				active -= 1;
				return extensions.map((extension) => `kind ${extension}`).join("\n");
			},
		});

		// When a first extension is in flight and three more are requested meanwhile
		const first = resolver.kindFor("C:\\a.aaa", "aaa");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const rest = Promise.all([resolver.kindFor("C:\\b.bbb", "bbb"), resolver.kindFor("C:\\c.ccc", "ccc"), resolver.kindFor("C:\\d.ddd", "ddd")]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		release();

		// Then the process never overlapped, and the three waited for one shared next process
		expect(await first).toBe("kind .aaa");
		expect(await rest).toEqual(["kind .bbb", "kind .ccc", "kind .ddd"]);
		expect(maxActive).toBe(1);
		expect(batches).toEqual([[".aaa"], [".bbb", ".ccc", ".ddd"]]);
	});

	it("caps one process at 100 extensions", async () => {
		const extensions = Array.from({ length: 250 }, (_, index) => `.x${index}`);
		const { batches, run } = recordingRunner({});
		const resolver = createOsKindResolver({ platform: "win32", run });

		await Promise.all(extensions.map((extension, index) => resolver.kindFor(`C:\\f${index}${extension}`, "")));

		expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
	});

	it("warns verbatim and retries later when the process fails, without caching the failure", async () => {
		// Given a first process that fails and a second that works
		const warnings: string[] = [];
		let calls = 0;
		const resolver = createOsKindResolver({
			platform: "win32",
			run: async (query) => {
				calls += 1;
				if (calls === 1) throw new Error("powershell.exe: Command failed: timed out");
				return (query.extensions ?? []).map(() => "PDF Document").join("\n");
			},
			warn: (message) => warnings.push(message),
		});

		// When the first lookup fails
		expect(await resolver.kindFor("C:\\a.pdf", "pdf")).toBeNull();

		// Then the failure text is visible, and a later PDF still gets its kind
		expect(warnings.join("\n")).toContain("Command failed: timed out");
		expect(await resolver.kindFor("C:\\b.pdf", "pdf")).toBe("PDF Document");
	});

	it("does not remember a dotfile as having the empty extension", async () => {
		const { batches, run } = recordingRunner({ ".gitignore": "GITIGNORE File" });
		const resolver = createOsKindResolver({ platform: "win32", run });

		expect(await resolver.kindFor("C:\\repo\\.gitignore", "gitignore")).toBe("GITIGNORE File");
		expect(batches).toEqual([[".gitignore"]]);
	});
});

const runPowerShell = promisify(execFile);

/** The lookup as it was before batching: one `Registry::` provider chain per extension. The batch must answer identically. */
async function providerKind(extension: string): Promise<string | null> {
	const script = [
		"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		`$ext = '${extension}'`,
		"$progId = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $ext) -ErrorAction SilentlyContinue).'(default)'",
		"if ([string]::IsNullOrEmpty($progId)) { return }",
		"$typeName = (Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\' + $progId) -ErrorAction SilentlyContinue).'(default)'",
		"if (-not [string]::IsNullOrEmpty($typeName)) { [Console]::Out.Write($typeName) }",
	].join("; ");
	const { stdout } = await runPowerShell("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
	return parseKindStdout(stdout);
}

describe.skipIf(process.platform !== "win32")("the Windows registry lookup, on a real Windows", () => {
	const extensions = [".zip", ".png", ".pdf", ".txt", ".exe", ".dll", ".hwp", ".mp4", ".json", ".zzz-no-such-extension"];

	it("answers every extension exactly as the one-process-per-extension lookup did", async () => {
		const expected = await Promise.all(extensions.map(providerKind));
		const query = windowsKindQuery(extensions);
		const { stdout } = await runPowerShell(query.command, [...query.args], { encoding: "utf8", windowsHide: true });

		expect(parseWindowsKindStdout(stdout, extensions.length)).toEqual(expected);
		// The comparison is only meaningful if Windows knows some of them and not the made-up one.
		expect(expected.some((kind) => kind !== null)).toBe(true);
		expect(expected.at(-1)).toBeNull();
	});

	it("resolves files end to end through the default runner, extensionless files without a process", async () => {
		const resolver = createOsKindResolver();
		const files = ["C:\\x\\a.zip", "C:\\x\\b.exe", "C:\\x\\c.json", "C:\\x\\d.ZIP", "C:\\x\\Makefile"];
		const kinds = await Promise.all(files.map((file) => resolver.kindFor(file, file.includes(".") ? file.split(".").pop()?.toLowerCase() ?? "" : "")));
		const expected = await Promise.all([".zip", ".exe", ".json", ".zip"].map(providerKind));

		expect(kinds).toEqual([...expected, null]);
	});
});
