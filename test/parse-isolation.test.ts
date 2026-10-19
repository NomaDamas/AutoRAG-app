import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createParsePool, findParseWorker, type ParsePool, type ParsePoolOptions } from "../src/main/parse-isolation";

const FIXTURE = new URL("./fixtures/parse-worker-fixture.mjs", import.meta.url);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const unreachable = async (): Promise<never> => {
	throw new Error("in-process parse must not run");
};

const pools: ParsePool[] = [];
function pool(overrides: Partial<ParsePoolOptions> = {}): ParsePool {
	const created = createParsePool({ workerUrl: FIXTURE, timeoutMs: 5000, maxHeapMb: 64, inProcess: unreachable, ...overrides });
	pools.push(created);
	return created;
}

afterEach(async () => {
	await Promise.all(pools.splice(0).map((created) => created.dispose()));
});

describe("createParsePool", () => {
	it("returns what the worker parsed", async () => {
		expect(await pool().parse(text("hello"), { ocr: false })).toEqual({ success: true, markdown: "parsed hello" });
	});

	it("kills a parse that spins, which a same-thread timer cannot interrupt, and keeps serving", async () => {
		const parsing = pool({ timeoutMs: 200 });
		const started = Date.now();

		await expect(parsing.parse(text("spin"), { ocr: false })).rejects.toThrow(/timed out after 200ms/u);
		expect(Date.now() - started).toBeLessThan(2000);
		expect(await parsing.parse(text("after"), { ocr: false })).toEqual({ success: true, markdown: "parsed after" });
		expect(parsing.takeFailures()).toEqual({ timedOut: 1, crashed: 0 });
	});

	it("turns an exhausted heap into a rejection and keeps serving", async () => {
		const parsing = pool();

		await expect(parsing.parse(text("oom"), { ocr: false })).rejects.toThrow();
		expect(await parsing.parse(text("after"), { ocr: false })).toEqual({ success: true, markdown: "parsed after" });
		expect(parsing.takeFailures()).toEqual({ timedOut: 0, crashed: 1 });
	});

	it("passes a parser exception on without counting it as a crash", async () => {
		const parsing = pool();

		await expect(parsing.parse(text("throw"), { ocr: false })).rejects.toThrow("kaboom");
		expect(await parsing.parse(text("after"), { ocr: false })).toEqual({ success: true, markdown: "parsed after" });
		expect(parsing.takeFailures()).toEqual({ timedOut: 0, crashed: 0 });
	});

	it("runs concurrent calls one after another", async () => {
		const parsing = pool();

		const results = await Promise.all(["a", "b", "c"].map((name) => parsing.parse(text(name), { ocr: false })));

		expect(results.map((result) => (result.success ? result.markdown : ""))).toEqual(["parsed a", "parsed b", "parsed c"]);
	});

	it("starts a fresh worker after the recycle limit", async () => {
		const parsing = pool({ recycleAfter: 2 });

		for (const name of ["a", "b", "c", "d"]) expect(await parsing.parse(text(name), { ocr: false })).toEqual({ success: true, markdown: `parsed ${name}` });
	});

	it("hands an OCR provider function to the in-process parser, which cannot cross a thread", async () => {
		const parsing = pool({ inProcess: async () => ({ success: true, markdown: "in process" }) });

		expect(await parsing.parse(text("x"), { ocr: async () => "" })).toEqual({ success: true, markdown: "in process" });
	});

	it("rejects when the worker file cannot start", async () => {
		const parsing = pool({ workerUrl: new URL("./fixtures/does-not-exist.mjs", import.meta.url) });

		await expect(parsing.parse(text("x"), { ocr: false })).rejects.toThrow();
	});

	it("does not copy the caller's buffer away", async () => {
		const bytes = text("keep");

		await pool().parse(bytes, { ocr: false });

		expect(new TextDecoder().decode(bytes)).toBe("keep");
	});
});

describe("the real worker", () => {
	it("parses through kordoc and reports a document it cannot read as a failure, not a crash", async () => {
		const real = findParseWorker(new URL("../src/main/parse-isolation.ts", import.meta.url).href);
		expect(real).not.toBeNull();
		const parsing = pool({ workerUrl: real as URL, maxHeapMb: 512 });

		const outcome = await parsing.parse(text("this is not a document"), { ocr: false });

		expect(outcome.success).toBe(false);
		expect(parsing.takeFailures()).toEqual({ timedOut: 0, crashed: 0 });
	});
});

describe("findParseWorker", () => {
	const worker = (path: string): boolean => path.replaceAll("\\", "/").endsWith("/out/main/parse-worker.mjs");
	const moduleUrl = (path: string): string => pathToFileURL(resolve(path)).href;

	it("finds the worker beside a module, or one directory up from a shared chunk", () => {
		expect(fileURLToPath(findParseWorker(moduleUrl("/app/out/main/parse-isolation.js"), worker) as URL)).toBe(resolve("/app/out/main/parse-worker.mjs"));
		expect(fileURLToPath(findParseWorker(moduleUrl("/app/out/main/chunks/parse-isolation-abc.js"), worker) as URL)).toBe(resolve("/app/out/main/parse-worker.mjs"));
	});

	it("reports a missing worker instead of guessing", () => {
		expect(findParseWorker(moduleUrl("/elsewhere/parse-isolation.js"), worker)).toBeNull();
	});
});
