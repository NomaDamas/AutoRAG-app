import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileeCliOptions, FileeConvertRequest, FileeConvertResult } from "@autorag/librarian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversionService, type ConversionService, type ConversionServiceDeps, type FileeSettings } from "../src/main/conversion-service";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-convert-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

interface Call {
	readonly request: FileeConvertRequest;
	readonly options: FileeCliOptions;
}

/** A converter that writes `outputs` (name → contents) into the requested outputDir, like Filee does. */
function fakeConverter(outputs: Readonly<Record<string, string>>, calls: Call[] = []): ConversionServiceDeps["convert"] {
	return async (request, options) => {
		calls.push({ request, options });
		const dir = request.outputDir as string;
		const written: string[] = [];
		for (const [name, contents] of Object.entries(outputs)) {
			const path = join(dir, name);
			await writeFile(path, contents);
			written.push(path);
		}
		const source = request.inputs[0] as string;
		return done(source, written);
	};
}

function done(source: string, outputs: readonly string[]): FileeConvertResult {
	return { preset: "x", target: "x", converted: 1, skipped: 0, failed: 0, files: [{ source, state: "done", outputs }] };
}

function service(
	convert: ConversionServiceDeps["convert"],
	settings: FileeSettings = {},
): ConversionService {
	return createConversionService({
		settings: () => settings,
		resolveOptions: async (options) => ({ ...options, executable: "/fake/filee-cli" }),
		convert,
	});
}

async function source(name: string, contents = "source"): Promise<string> {
	const path = join(root, name);
	await writeFile(path, contents);
	return path;
}

describe("conversion service: plan", () => {
	it("answers from the route matrix", async () => {
		const converter = service(fakeConverter({}));
		expect(await converter.plan("a.hwpx", "a.pdf")).toEqual({ kind: "convert", from: "hwpx", to: "pdf" });
		expect(await converter.plan("a.mp3", "a.pdf")).toEqual({ kind: "unsupported", from: "mp3", to: "pdf" });
		expect(await converter.plan("a.pdf", "b.pdf")).toEqual({ kind: "rename" });
	});

	it("stays a plain rename when the config switches Filee off", async () => {
		const converter = service(fakeConverter({}), { enabled: false });
		expect(await converter.plan("a.hwpx", "a.pdf")).toEqual({ kind: "rename" });
		expect(await converter.plan("a.mp3", "a.pdf")).toEqual({ kind: "rename" });
	});
});

describe("conversion service: run", () => {
	it("converts into the new name beside the source and leaves the source alone", async () => {
		const path = await source("report.hwpx", "original");
		const calls: Call[] = [];
		const outcome = await service(fakeConverter({ "report.pdf": "%PDF" }, calls)).run({ id: "1", path, newName: "final.pdf" });

		expect(outcome.output).toBe(join(root, "final.pdf"));
		expect(await readFile(join(root, "final.pdf"), "utf8")).toBe("%PDF");
		expect(await readFile(path, "utf8")).toBe("original");
		// Nothing but the source and the result: the staging folder is gone.
		expect((await readdir(root)).sort()).toEqual(["final.pdf", "report.hwpx"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.request.inputs).toEqual([path]);
		expect(calls[0]?.request.to).toBe("pdf");
	});

	it("stages the output in a hidden folder of the source's own folder (a rename never crosses a device)", async () => {
		const path = await source("a.hwpx");
		const calls: Call[] = [];
		await service(fakeConverter({ "a.pdf": "x" }, calls)).run({ id: "1", path, newName: "a.pdf" });
		const outputDir = calls[0]?.request.outputDir as string;
		expect(outputDir.startsWith(join(root, "."))).toBe(true);
	});

	it("hands Filee its canonical format id, whatever spelling the user typed", async () => {
		const path = await source("photo.png");
		const calls: Call[] = [];
		await service(fakeConverter({ "photo.jpg": "x" }, calls)).run({ id: "1", path, newName: "photo.jpeg" });
		expect(calls[0]?.request.to).toBe("jpg");
		expect(await readdir(root)).toContain("photo.jpeg");
	});

	it("gives a multi-file result (one image per PDF page) a folder named after the new name", async () => {
		const path = await source("scan.pdf");
		const outcome = await service(fakeConverter({ "scan_p1.png": "1", "scan_p2.png": "2" })).run({ id: "1", path, newName: "pages.png" });

		expect(outcome.output).toBe(join(root, "pages"));
		expect((await readdir(join(root, "pages"))).sort()).toEqual(["scan_p1.png", "scan_p2.png"]);
		expect((await readdir(root)).sort()).toEqual(["pages", "scan.pdf"]);
	});

	it("refuses to replace a name that is already taken, before converting anything", async () => {
		const path = await source("a.hwpx");
		await writeFile(join(root, "a.pdf"), "precious");
		const calls: Call[] = [];
		await expect(service(fakeConverter({ "a.pdf": "new" }, calls)).run({ id: "1", path, newName: "a.pdf" })).rejects.toThrow("a.pdf");
		expect(calls).toHaveLength(0);
		expect(await readFile(join(root, "a.pdf"), "utf8")).toBe("precious");
	});

	it("refuses a multi-file result whose folder name is taken, and leaves no staging behind", async () => {
		const path = await source("scan.pdf");
		await mkdir(join(root, "pages"));
		await expect(service(fakeConverter({ "scan_p1.png": "1", "scan_p2.png": "2" })).run({ id: "1", path, newName: "pages.png" })).rejects.toThrow("pages");
		expect((await readdir(root)).sort()).toEqual(["pages", "scan.pdf"]);
	});

	it("rejects with Filee's reason and cleans up when the file fails", async () => {
		const path = await source("broken.hwpx");
		const failing: ConversionServiceDeps["convert"] = async (request) => ({
			preset: "x",
			target: "pdf",
			converted: 0,
			skipped: 0,
			failed: 1,
			files: [{ source: request.inputs[0] as string, state: "failed", outputs: [], error: "the document is corrupt" }],
		});
		await expect(service(failing).run({ id: "1", path, newName: "broken.pdf" })).rejects.toThrow("the document is corrupt");
		expect(await readdir(root)).toEqual(["broken.hwpx"]);
	});

	it("rejects when Filee reports success without writing anything", async () => {
		const path = await source("a.hwpx");
		await expect(service(async (request) => done(request.inputs[0] as string, [])).run({ id: "1", path, newName: "a.pdf" })).rejects.toThrow("a.pdf");
		expect(await readdir(root)).toEqual(["a.hwpx"]);
	});

	it("does not run a rename that is not a conversion", async () => {
		const path = await source("song.mp3");
		const calls: Call[] = [];
		await expect(service(fakeConverter({}, calls)).run({ id: "1", path, newName: "song.pdf" })).rejects.toThrow();
		await expect(service(fakeConverter({}, calls)).run({ id: "2", path, newName: "other.mp3" })).rejects.toThrow();
		expect(calls).toHaveLength(0);
	});

	it("rejects a name that carries a folder, so the result can only land beside the source", async () => {
		const path = await source("a.hwpx");
		await expect(service(fakeConverter({ "a.pdf": "x" })).run({ id: "1", path, newName: "../escape.pdf" })).rejects.toThrow();
		expect(await readdir(root)).toEqual(["a.hwpx"]);
	});

	it("rejects a source that is not a file", async () => {
		await expect(service(fakeConverter({})).run({ id: "1", path: join(root, "missing.hwpx"), newName: "missing.pdf" })).rejects.toThrow("missing.hwpx");
		await mkdir(join(root, "folder.hwpx"));
		await expect(service(fakeConverter({})).run({ id: "2", path: join(root, "folder.hwpx"), newName: "folder.pdf" })).rejects.toThrow("folder.hwpx");
	});

	it("passes the user's Filee settings to the converter", async () => {
		const path = await source("a.hwpx");
		const calls: Call[] = [];
		await service(fakeConverter({ "a.pdf": "x" }, calls), {
			binaryPath: "/opt/filee-cli",
			autoInstall: false,
			timeoutMs: 1234,
			dataDir: "/data/filee",
		}).run({ id: "1", path, newName: "a.pdf" });
		const options = calls[0]?.options;
		expect(options?.executable).toBe("/fake/filee-cli");
		expect(options?.timeoutMs).toBe(1234);
		expect(options?.dataDir).toBe("/data/filee");
		expect(options?.autoInstall).toBe(false);
		expect(options?.signal).toBeInstanceOf(AbortSignal);
	});

	it("cancel aborts a running conversion and leaves nothing behind", async () => {
		const path = await source("big.hwpx");
		const { promise: running, resolve: started } = Promise.withResolvers<void>();
		const converter = service(async (request, options) => {
			await writeFile(join(request.outputDir as string, "big.pdf"), "partial");
			started();
			const { promise: aborted, reject } = Promise.withResolvers<never>();
			options.signal?.addEventListener("abort", () => reject(new Error("filee was aborted.")), { once: true });
			await aborted;
			throw new Error("unreachable");
		});
		const outcome = converter.run({ id: "job-1", path, newName: "big.pdf" });
		const settled = outcome.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		await running;
		await converter.cancel("job-1");
		expect(await settled).not.toBe("resolved");
		expect(await readdir(root)).toEqual(["big.hwpx"]);
	});

	it("cancel of an unknown or finished job does nothing", async () => {
		await expect(service(fakeConverter({})).cancel("nope")).resolves.toBeUndefined();
	});
});
