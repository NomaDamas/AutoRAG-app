import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { openPlanRuntime, preferPlanOAuth, type PlanRuntime } from "../src/main/dazzi-session-auth";

const MODEL = { provider: "dazzi", id: "deepseek/deepseek-v4.1-flash" };

function runtime(registered: boolean, refreshRegisters = false): PlanRuntime & { refresh: Mock<PlanRuntime["refresh"]> } {
	let known = registered;
	return {
		getModel: (provider, id) => (known && provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
		refresh: vi.fn(async () => {
			if (refreshRegisters) known = true;
		}),
	};
}

describe("preferPlanOAuth", () => {
	it("leaves a model of another provider untouched", async () => {
		const resolved = { model: { provider: "openrouter", id: "x" }, apiKey: "or-key", providerApiKeys: { openrouter: "or-key" } };
		const open = vi.fn(async () => runtime(true));
		expect(await preferPlanOAuth(resolved, open)).toBe(resolved);
		expect(open).not.toHaveBeenCalled();
	});

	it("drops the plan key when the runtime already lists the model, so the stored OAuth credential is used", async () => {
		const resolved = { model: MODEL, apiKey: "plan-key", providerApiKeys: { dazzi: "plan-key", openrouter: "or-key" } };
		const result = await preferPlanOAuth(resolved, async () => runtime(true));
		expect(result.apiKey).toBeUndefined();
		expect(result.providerApiKeys).toEqual({ openrouter: "or-key" });
		expect(result.model).toBe(MODEL);
	});

	it("omits providerApiKeys entirely when the plan key was the only one", async () => {
		const result = await preferPlanOAuth({ model: MODEL, apiKey: "plan-key", providerApiKeys: { dazzi: "plan-key" } }, async () => runtime(true));
		expect("providerApiKeys" in result).toBe(false);
		expect("apiKey" in result).toBe(false);
	});

	it("loads the catalog once when a fresh install has no snapshot, then drops the key", async () => {
		const rt = runtime(false, true);
		const result = await preferPlanOAuth({ model: MODEL, apiKey: "plan-key" }, async () => rt);
		expect(rt.refresh).toHaveBeenCalledTimes(1);
		expect(rt.refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ["dazzi"], force: true });
		expect(result.apiKey).toBeUndefined();
	});

	it("keeps the key when the model stays unlisted: the session then registers it from the key", async () => {
		const rt = runtime(false, false);
		const resolved = { model: MODEL, apiKey: "plan-key", providerApiKeys: { dazzi: "plan-key" } };
		expect(await preferPlanOAuth(resolved, async () => rt)).toBe(resolved);
		expect(rt.refresh).toHaveBeenCalledTimes(1);
	});

	it("keeps the key when the catalog cannot be loaded (offline)", async () => {
		const rt = runtime(false);
		rt.refresh.mockRejectedValue(new Error("offline"));
		const resolved = { model: MODEL, apiKey: "plan-key" };
		expect(await preferPlanOAuth(resolved, async () => rt)).toBe(resolved);
	});

	it("keeps the key when the runtime cannot be opened", async () => {
		const resolved = { model: MODEL, apiKey: "plan-key" };
		expect(
			await preferPlanOAuth(resolved, async () => {
				throw new Error("auth.json is unreadable");
			}),
		).toBe(resolved);
	});

	it("does nothing without a plan key to drop", async () => {
		const open = vi.fn(async () => runtime(true));
		const resolved = { model: MODEL };
		expect(await preferPlanOAuth(resolved, open)).toBe(resolved);
		expect(open).not.toHaveBeenCalled();
	});
});

describe("openPlanRuntime", () => {
	const dirs: string[] = [];
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("lists a model from the persisted plan catalog in the agent dir", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dazzi-session-auth-"));
		dirs.push(dir);
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ dazzi: { type: "oauth", access: "plan-key", refresh: "", expires: Number.MAX_SAFE_INTEGER } }),
		);
		await writeFile(
			join(dir, "models-store.json"),
			JSON.stringify({
				dazzi: {
					models: [
						{
							type: "chat",
							id: MODEL.id,
							name: "DeepSeek",
							api: "openai-responses",
							provider: "dazzi",
							baseUrl: "https://api.dazziapp.com/v1",
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							reasoning: false,
							contextWindow: 128000,
							maxTokens: 16000,
						},
					],
				},
			}),
		);
		const real = await openPlanRuntime(dir, {});
		const resolved = { model: MODEL, apiKey: "plan-key", providerApiKeys: { dazzi: "plan-key" } };
		const result = await preferPlanOAuth(resolved, async () => real);
		expect(result.apiKey).toBeUndefined();
		expect(real.hasConfiguredAuth("dazzi")).toBe(true);
	});
});
