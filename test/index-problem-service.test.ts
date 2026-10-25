import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIndexProblemService, type IndexProblemService, type RunOutcome } from "../src/main/index-problem-service";
import type { IndexProblem } from "../src/shared/index-problem-contract";

const dirs: string[] = [];
const services: IndexProblemService[] = [];
afterEach(async () => {
	// A change writes in the background; remove the directory only once nothing is still being written into it.
	await Promise.all(services.splice(0).map((instance) => instance.flush()));
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "index-problem-"));
	dirs.push(dir);
	return join(dir, "index-problem.json");
}

const preflightRejected: RunOutcome = {
	ok: false,
	error: "embedder answered 402",
	diagnostics: [{ code: "embedder-preflight-failed", severity: "error", message: "402", reason: "rejected" }],
};
const clean: RunOutcome = { ok: true, error: null, diagnostics: [] };
const skipping: RunOutcome = { ok: true, error: null, diagnostics: [{ code: "parse-killed", severity: "warning", message: "x", count: 5 }] };

function service(filePath: string, run: () => Promise<RunOutcome | null> = async () => clean) {
	const sent: IndexProblem[] = [];
	const instance = createIndexProblemService({ filePath, send: (problem) => sent.push(problem), run, now: () => Date.parse("2026-10-24T05:00:00Z") });
	services.push(instance);
	return { instance, sent };
}

describe("index problem service", () => {
	it("keeps why a run stopped, classified, and tells the window once", async () => {
		const { instance, sent } = service(await workFile());
		instance.record(preflightRejected);
		expect(instance.get()).toEqual({
			failure: { reason: "embedder-config", folders: [], code: "embedder-preflight-failed" },
			skipped: 0,
			at: "2026-10-24T05:00:00.000Z",
			retrying: false,
		});
		expect(sent).toHaveLength(1);
	});

	it("does not tell the window again when a run changes nothing", async () => {
		const { instance, sent } = service(await workFile());
		instance.record(clean);
		instance.record(clean);
		expect(sent).toHaveLength(0);
	});

	it("keeps the skipped count of a finished run, and a later clean run clears it", async () => {
		const { instance } = service(await workFile());
		instance.record(skipping);
		expect(instance.get().failure).toBeNull();
		expect(instance.get().skipped).toBe(5);
		instance.record(clean);
		expect(instance.get()).toEqual({ failure: null, skipped: 0, at: null, retrying: false });
	});

	it("leaves the skipped count alone when only the failure is known to be over", async () => {
		const { instance } = service(await workFile());
		instance.record(skipping);
		instance.record(preflightRejected);
		instance.clearFailure();
		expect(instance.get().failure).toBeNull();
		expect(instance.get().skipped).toBe(0);
		instance.record(skipping);
		instance.clearFailure();
		expect(instance.get().skipped).toBe(5);
	});

	it("is still there after a relaunch", async () => {
		const file = await workFile();
		const first = service(file);
		first.instance.record(preflightRejected);
		await first.instance.flush();
		const second = service(file);
		expect(second.instance.get().failure?.reason).toBe("embedder-config");
		expect(second.instance.get().retrying).toBe(false);
	});

	it("ignores a state file it cannot read", async () => {
		const file = await workFile();
		await writeFile(file, '{"failure":{"reason":"nonsense","folders":[],"code":null},"skipped":-3,"at":7}');
		expect(service(file).instance.get()).toEqual({ failure: null, skipped: 0, at: null, retrying: false });
		await writeFile(file, "not json");
		expect(service(file).instance.get().failure).toBeNull();
	});

	it("forgets the problem when dismissed, and stays forgotten after a relaunch", async () => {
		const file = await workFile();
		const { instance, sent } = service(file);
		instance.record(preflightRejected);
		instance.dismiss();
		expect(instance.get().failure).toBeNull();
		expect(sent).toHaveLength(2);
		await instance.flush();
		expect(service(file).instance.get().failure).toBeNull();
		expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ failure: null, skipped: 0 });
	});

	it("runs once for concurrent retries, shows it as retrying, and records what the run found", async () => {
		const gate = Promise.withResolvers<RunOutcome | null>();
		let runs = 0;
		const { instance, sent } = service(await workFile(), () => {
			runs += 1;
			return gate.promise;
		});
		instance.record(preflightRejected);
		const first = instance.retry();
		const second = instance.retry();
		expect(instance.get().retrying).toBe(true);
		gate.resolve(clean);
		await Promise.all([first, second]);
		expect(runs).toBe(1);
		expect(instance.get()).toEqual({ failure: null, skipped: 0, at: null, retrying: false });
		expect(sent.some((problem) => problem.retrying)).toBe(true);
	});

	it("leaves the problem as it was when another run held the lock and nothing was learned", async () => {
		const { instance } = service(await workFile(), async () => null);
		instance.record(preflightRejected);
		const before = instance.get().failure;
		await instance.retry();
		expect(instance.get().failure).toBe(before);
		expect(instance.get().retrying).toBe(false);
	});

	it("records a retry that throws as a failure of unknown cause instead of rejecting", async () => {
		const { instance } = service(await workFile(), async () => {
			throw new Error("boom");
		});
		await instance.retry();
		expect(instance.get().failure).toMatchObject({ reason: "unknown" });
		expect(instance.get().retrying).toBe(false);
	});
});
