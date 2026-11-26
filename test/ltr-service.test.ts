import { describe, expect, it, vi } from "vitest";
import type { AutomationCliResult } from "../src/main/automation-service";
import { createLtrService, withoutAgentAutoTrain, type LtrServiceDeps } from "../src/main/ltr-service";
import { LTR_MODEL_ID_PATTERN } from "../src/shared/ltr-contract";

/** The model block `autorag ltr status|train --json` prints, as the librarian writes it. */
function librarianModel(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		createdAt: 1_795_079_711_856,
		featureNames: ["primary_rank", "rerank_rank"],
		objective: "rank:pairwise",
		trainedOnRuns: 568,
		loggedRunsAtTraining: 944,
		holdout: {
			queries: 142,
			baseline: { ndcg10: 0.798, mrr: 0.765 },
			model: { ndcg10: 0.812, mrr: 0.779 },
			deltaMrrCi95: [0.0001, 0.029],
			deltaNdcg10Ci95: [0.002, 0.026],
		},
		passedGate: true,
		trainer: { xgboost: "3.3.0" },
		seeds: 5,
		seedMrr: [0.783, 0.759, 0.765, 0.78, 0.777],
		...extra,
	};
}

function librarianStatus(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		enabled: false,
		selection: "latest",
		serving: { status: "disabled" },
		loggedRuns: 944,
		models: [librarianModel("xgb-1")],
		state: { lastAttemptRuns: 944, lastAttemptAt: 1_795_079_711_900, lastAttemptResult: "trained: holdout 142 queries" },
		autoTrain: { enabled: false, minNewRuns: 200, due: false },
		...extra,
	};
}

const ok = (value: unknown): AutomationCliResult => ({ code: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" });
const failed = (value: unknown, code = 1): AutomationCliResult => ({ code, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

interface Harness {
	readonly service: ReturnType<typeof createLtrService>;
	readonly run: ReturnType<typeof vi.fn>;
}

function harness(responses: readonly AutomationCliResult[] | ((args: readonly string[]) => AutomationCliResult | Promise<AutomationCliResult>), deps: Partial<LtrServiceDeps> = {}): Harness {
	const queue = Array.isArray(responses) ? [...responses] : null;
	const run = vi.fn(async (args: readonly string[]) => {
		if (queue !== null) {
			const next = queue.shift();
			if (next === undefined) throw new Error(`unexpected CLI call: ${args.join(" ")}`);
			return next;
		}
		return (responses as (a: readonly string[]) => AutomationCliResult | Promise<AutomationCliResult>)(args);
	});
	return { service: createLtrService({ run, ...deps }), run };
}

describe("createLtrService.get", () => {
	it("asks the librarian for its status as JSON and reshapes it for the window", async () => {
		const { service, run } = harness([ok(librarianStatus({ enabled: true, serving: { status: "active", modelId: "xgb-1" } }))]);

		const snapshot = await service.get();

		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0]?.[0]).toEqual(["ltr", "status", "--json"]);
		expect(snapshot.enabled).toBe(true);
		expect(snapshot.serving).toEqual({ status: "active", modelId: "xgb-1" });
		expect(snapshot.loggedRuns).toBe(944);
		expect(snapshot.selection).toBe("latest");
		expect(snapshot.minTrainingRuns).toBe(300);
		expect(snapshot.models).toHaveLength(1);
		expect(snapshot.models[0]).toMatchObject({ id: "xgb-1", passedGate: true, trainedOnRuns: 568, seeds: 5 });
		expect(snapshot.models[0]?.holdout.deltaMrrCi95).toEqual([0.0001, 0.029]);
		expect(snapshot.models[0]?.holdout.deltaNdcg10Ci95).toEqual([0.002, 0.026]);
		expect(snapshot.lastAttempt).toEqual({ runs: 944, at: 1_795_079_711_900, result: "trained: holdout 142 queries" });
		expect(snapshot.autoTrain).toEqual({ enabled: false, minNewRuns: 200, due: false });
	});

	it("does not pass through the feature vocabulary or other fields the window never shows", async () => {
		const { service } = harness([ok(librarianStatus())]);

		const snapshot = await service.get();

		expect(JSON.stringify(snapshot)).not.toContain("featureNames");
		expect(JSON.stringify(snapshot)).not.toContain("primary_rank");
	});

	it("reports no attempt when the librarian has not tried to train yet", async () => {
		const { service } = harness([ok(librarianStatus({ models: [], state: {}, loggedRuns: 0 }))]);

		const snapshot = await service.get();

		expect(snapshot.lastAttempt).toBeNull();
		expect(snapshot.models).toEqual([]);
	});

	it("keeps a model whose gate verdict is missing out of `latest` by marking it not passed", async () => {
		const { service } = harness([ok(librarianStatus({ models: [librarianModel("xgb-2", { passedGate: undefined })] }))]);

		const snapshot = await service.get();

		expect(snapshot.models[0]?.passedGate).toBe(false);
	});

	it("carries the reason a selected model cannot serve", async () => {
		const { service } = harness([ok(librarianStatus({ enabled: true, serving: { status: "no-model", reason: "no model passed its holdout gate" } }))]);

		expect((await service.get()).serving).toEqual({ status: "no-model", reason: "no model passed its holdout gate" });
	});

	it("rejects when the CLI fails, saying why", async () => {
		const { service } = harness([{ code: 2, stdout: "", stderr: "Config file not found: /x" }]);

		await expect(service.get()).rejects.toThrow(/exit 2.*Config file not found/u);
	});

	it("rejects when the CLI prints something that is not a status", async () => {
		const { service } = harness([{ code: 0, stdout: "not json", stderr: "" }]);

		await expect(service.get()).rejects.toThrow(/status/iu);
		const { service: other } = harness([ok({ loggedRuns: "many" })]);
		await expect(other.get()).rejects.toThrow(/status/iu);
	});

	it("is an empty, disabled snapshot when the librarian CLI is not installed", async () => {
		const missing = new Error("cli missing");
		const { service } = harness([], { run: async () => Promise.reject(missing), isMissing: (error) => error === missing });

		const snapshot = await service.get();

		expect(snapshot.enabled).toBe(false);
		expect(snapshot.loggedRuns).toBe(0);
		expect(snapshot.models).toEqual([]);
	});

	it("says a training run is going while one is, so a window opened mid-run shows it", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<AutomationCliResult>();
		const trained = { status: "trained", model: librarianModel("xgb-3"), eligibleRuns: 200, loggedRuns: 250 };
		const { service } = harness((args) => (args[1] === "train" ? gate : ok(librarianStatus())));

		expect((await service.get()).training).toBe(false);
		const running = service.train();
		expect((await service.get()).training).toBe(true);
		release(ok(trained));
		await running;

		expect((await service.get()).training).toBe(false);
	});
});

describe("createLtrService.train", () => {
	it("trains with a long timeout, because fitting a large log takes far longer than a status read", async () => {
		const trained = { status: "trained", reason: "holdout 142 queries: MRR 0.765 -> 0.779", model: librarianModel("xgb-9"), eligibleRuns: 568, loggedRuns: 944 };
		const { service, run } = harness([ok(trained), ok(librarianStatus({ models: [librarianModel("xgb-9")] }))]);

		const outcome = await service.train();

		expect(run.mock.calls[0]?.[0]).toEqual(["ltr", "train", "--json"]);
		expect(run.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThanOrEqual(120_000);
		expect(outcome.status).toBe("trained");
		expect(outcome.reason).toBe("holdout 142 queries: MRR 0.765 -> 0.779");
		expect(outcome.model?.id).toBe("xgb-9");
		expect(outcome.eligibleRuns).toBe(568);
		expect(outcome.snapshot.models[0]?.id).toBe("xgb-9");
	});

	it("reports a rejected model as an outcome, not an error: the CLI exits 1 but the verdict is the answer", async () => {
		const rejected = { status: "rejected", reason: "did not beat the reranker's order: holdout 80 queries", model: librarianModel("xgb-7", { passedGate: false }), eligibleRuns: 300, loggedRuns: 400 };
		const { service } = harness([failed(rejected), ok(librarianStatus({ models: [librarianModel("xgb-7", { passedGate: false })] }))]);

		const outcome = await service.train();

		expect(outcome.status).toBe("rejected");
		expect(outcome.model?.passedGate).toBe(false);
		expect(outcome.reason).toMatch(/did not beat/u);
	});

	it("reports too little data with the librarian's own reason", async () => {
		const reason = "12 usable search runs in the log; at least 100 are needed (runs that taught nothing are skipped: 30 without a rerank, 5 with nothing cited)";
		const { service } = harness([failed({ status: "insufficient-data", reason, eligibleRuns: 12, loggedRuns: 47 }), ok(librarianStatus({ loggedRuns: 47, models: [] }))]);

		const outcome = await service.train();

		expect(outcome.status).toBe("insufficient-data");
		expect(outcome.reason).toBe(reason);
		expect(outcome.model).toBeNull();
		expect(outcome.loggedRuns).toBe(47);
	});

	it("reports a training failure the librarian describes", async () => {
		const { service } = harness([failed({ status: "failed", reason: "xgboost: out of memory", eligibleRuns: 500, loggedRuns: 900 }), ok(librarianStatus())]);

		const outcome = await service.train();

		expect(outcome.status).toBe("failed");
		expect(outcome.reason).toBe("xgboost: out of memory");
	});

	it("rejects when the CLI dies without a verdict (killed, timed out, crashed)", async () => {
		const { service } = harness([{ code: 1, stdout: "", stderr: "Killed" }]);

		await expect(service.train()).rejects.toThrow(/exit 1.*Killed/u);
	});

	it("shares one run between overlapping callers, so a second click never fits a second model", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<AutomationCliResult>();
		const trained = { status: "trained", model: librarianModel("xgb-3"), eligibleRuns: 200, loggedRuns: 250 };
		const { service, run } = harness((args) => (args[1] === "train" ? gate : ok(librarianStatus())));

		const first = service.train();
		const second = service.train();
		release(ok(trained));
		const [a, b] = await Promise.all([first, second]);

		expect(run.mock.calls.filter((call) => call[0][1] === "train")).toHaveLength(1);
		expect(a).toBe(b);
	});

	it("can train again after the first run settled", async () => {
		const trained = { status: "trained", model: librarianModel("xgb-3"), eligibleRuns: 200, loggedRuns: 250 };
		const { service, run } = harness((args) => (args[1] === "train" ? ok(trained) : ok(librarianStatus())));

		await service.train();
		await service.train();

		expect(run.mock.calls.filter((call) => call[0][1] === "train")).toHaveLength(2);
	});

	it("starts again after a run that threw", async () => {
		let calls = 0;
		const { service } = harness((args) => {
			if (args[1] !== "train") return ok(librarianStatus());
			calls += 1;
			return calls === 1 ? { code: 1, stdout: "", stderr: "boom" } : ok({ status: "trained", model: librarianModel("xgb-4"), eligibleRuns: 200, loggedRuns: 250 });
		});

		await expect(service.train()).rejects.toThrow(/boom/u);
		await expect(service.train()).resolves.toMatchObject({ status: "trained" });
	});

	it("tells listeners when training starts and ends, so the window can show it from any page", async () => {
		const events: boolean[] = [];
		const trained = { status: "trained", model: librarianModel("xgb-3"), eligibleRuns: 200, loggedRuns: 250 };
		const { service } = harness((args) => (args[1] === "train" ? ok(trained) : ok(librarianStatus())), { onTraining: (running) => events.push(running) });

		await service.train();

		expect(events).toEqual([true, false]);
	});

	it("tells listeners training ended even when it threw", async () => {
		const events: boolean[] = [];
		const { service } = harness([{ code: 1, stdout: "", stderr: "boom" }], { onTraining: (running) => events.push(running) });

		await expect(service.train()).rejects.toThrow();

		expect(events).toEqual([true, false]);
	});
});

describe("createLtrService.deleteModel", () => {
	it("deletes a stored model and returns the fresh snapshot", async () => {
		const { service, run } = harness([ok({ deleted: "xgb-1" }), ok(librarianStatus({ models: [] }))]);

		const snapshot = await service.deleteModel("xgb-1");

		expect(run.mock.calls[0]?.[0]).toEqual(["ltr", "delete", "xgb-1", "--json"]);
		expect(snapshot.models).toEqual([]);
	});

	it("never puts an id that is not a model id on a command line", async () => {
		const { service, run } = harness([]);

		for (const bad of ["", "../x", "a b", "--json", "-x", "x".repeat(65), "a/b", "a;rm"]) {
			await expect(service.deleteModel(bad)).rejects.toThrow(/model id/iu);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it("surfaces the librarian's refusal to delete the pinned model", async () => {
		const { service } = harness([{ code: 1, stdout: "", stderr: JSON.stringify({ ok: false, error: "model xgb-1 is pinned in the config; run `autorag ltr use latest` first" }) }]);

		await expect(service.deleteModel("xgb-1")).rejects.toThrow(/pinned in the config/u);
	});
});

describe("createLtrService.autoTrainIfDue", () => {
	const trained = { status: "trained", model: librarianModel("xgb-5"), eligibleRuns: 400, loggedRuns: 1_200 };

	it("does nothing while the config has not asked for automatic training", async () => {
		const { service, run } = harness([ok(librarianStatus({ autoTrain: { enabled: false, minNewRuns: 200, due: false } }))]);

		expect(await service.autoTrainIfDue()).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("does nothing when automatic training is on but not enough searches were logged since the last attempt", async () => {
		const { service, run } = harness([ok(librarianStatus({ autoTrain: { enabled: true, minNewRuns: 200, due: false } }))]);

		expect(await service.autoTrainIfDue()).toBeNull();
		expect(run.mock.calls.every((call) => call[0][1] === "status")).toBe(true);
	});

	it("trains once when it is due", async () => {
		const { service, run } = harness((args) => (args[1] === "train" ? ok(trained) : ok(librarianStatus({ autoTrain: { enabled: true, minNewRuns: 200, due: true } }))));

		const outcome = await service.autoTrainIfDue();

		expect(outcome?.status).toBe("trained");
		expect(run.mock.calls.filter((call) => call[0][1] === "train")).toHaveLength(1);
	});

	it("never throws: a failed automatic attempt is the librarian's to record, not a crash of the search that triggered it", async () => {
		const { service } = harness((args) => (args[1] === "train" ? { code: 1, stdout: "", stderr: "boom" } : ok(librarianStatus({ autoTrain: { enabled: true, minNewRuns: 200, due: true } }))));

		await expect(service.autoTrainIfDue()).resolves.toBeNull();
	});

	it("never throws when the status read fails either", async () => {
		const { service } = harness([{ code: 2, stdout: "", stderr: "bad config" }]);

		await expect(service.autoTrainIfDue()).resolves.toBeNull();
	});

	it("does not start a second attempt while a manual or earlier automatic one runs", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<AutomationCliResult>();
		const { service, run } = harness((args) => (args[1] === "train" ? gate : ok(librarianStatus({ autoTrain: { enabled: true, minNewRuns: 200, due: true } }))));

		const manual = service.train();
		const automatic = service.autoTrainIfDue();
		release(ok(trained));
		await Promise.all([manual, automatic]);

		expect(run.mock.calls.filter((call) => call[0][1] === "train")).toHaveLength(1);
	});
});

describe("withoutAgentAutoTrain", () => {
	it("removes automatic training from what the agent is given, because the app trains in its own process", () => {
		const options = { rankingLog: true, ltr: { enabled: true, model: "latest", autoTrain: { enabled: true, minNewRuns: 50 } } };

		const result = withoutAgentAutoTrain(options);

		expect(result.ltr).toEqual({ enabled: true, model: "latest" });
		expect(options.ltr.autoTrain).toEqual({ enabled: true, minNewRuns: 50 });
	});

	it("leaves options without an ltr block, or without automatic training, exactly as they were", () => {
		const bare = { rankingLog: false };
		expect(withoutAgentAutoTrain(bare)).toBe(bare);
		const noAuto = { ltr: { enabled: false } };
		expect(withoutAgentAutoTrain(noAuto)).toBe(noAuto);
	});
});

describe("LTR_MODEL_ID_PATTERN", () => {
	it("accepts the ids the librarian generates and refuses path-like ones", () => {
		expect(LTR_MODEL_ID_PATTERN.test("xgb-20261119091511-aebcf9")).toBe(true);
		expect(LTR_MODEL_ID_PATTERN.test("../x")).toBe(false);
		expect(LTR_MODEL_ID_PATTERN.test("latest ")).toBe(false);
	});
});

describe("withoutAgentAutoTrain against the librarian's real agent options", () => {
	it("finds automatic training where buildAgentOptions puts it, and removes only that", async () => {
		const { buildAgentOptions } = await import("@autorag/librarian");
		const options = buildAgentOptions({
			searchPaths: ["/tmp/docs"],
			workspacePath: "/tmp/ws",
			memoryPath: "/tmp/ws/memory.json",
			ltr: { enabled: true, model: "latest", autoTrain: { enabled: true, minNewRuns: 150 } },
		} as never);

		// If the librarian moves this block, this fails here instead of letting the Electron process train in-process.
		expect(options.ltr?.autoTrain).toEqual({ enabled: true, minNewRuns: 150 });
		const stripped = withoutAgentAutoTrain(options);
		expect(stripped.ltr).toMatchObject({ enabled: true, model: "latest" });
		expect(stripped.ltr).not.toHaveProperty("autoTrain");
		expect(stripped.rankingLog ?? true).toBe(options.rankingLog ?? true);
	});
});
