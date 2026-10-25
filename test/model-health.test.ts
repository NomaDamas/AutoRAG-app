import { describe, expect, it } from "vitest";
import { checkModelHealth, type ModelHealthDeps } from "../src/main/model-health";

type Complete = ModelHealthDeps["complete"];
type Reply = Awaited<ReturnType<Complete>>;

const MODEL = { provider: "custom", id: "m-1" } as const;

const reply = (over: Partial<Reply> = {}): Reply => ({ stopReason: "stop", content: [{ type: "text", text: "OK" }], ...over }) as Reply;

function deps(complete: Complete, over: Partial<ModelHealthDeps> = {}): ModelHealthDeps {
	return { resolveModel: async () => ({ model: MODEL as never, apiKey: "key-a" }), complete, timeoutMs: 1_000, now: () => 0, ...over };
}

describe("checkModelHealth", () => {
	it("passes when the chosen model answers, calling that model with its own key", async () => {
		const calls: { model: unknown; apiKey: unknown }[] = [];
		const result = await checkModelHealth(
			deps(async (model, _context, options) => {
				calls.push({ model, apiKey: options?.apiKey });
				return reply();
			}),
		);
		expect(result).toEqual({ ok: true, latencyMs: 0 });
		expect(calls).toEqual([{ model: MODEL, apiKey: "key-a" }]);
	});

	it("takes the key from the per-provider map when the model carries none", async () => {
		let seen: unknown;
		await checkModelHealth(
			deps(
				async (_model, _context, options) => {
					seen = options?.apiKey;
					return reply();
				},
				{ resolveModel: async () => ({ model: MODEL as never, providerApiKeys: { custom: "key-b" } }) },
			),
		);
		expect(seen).toBe("key-b");
	});

	it("counts a reply cut short by the token budget as an answer: reasoning models spend it thinking", async () => {
		expect(await checkModelHealth(deps(async () => reply({ stopReason: "length", content: [] })))).toMatchObject({ ok: true });
	});

	it("fails with the provider's own message when the call errors", async () => {
		const result = await checkModelHealth(deps(async () => reply({ stopReason: "error", errorMessage: "401 invalid api key" })));
		expect(result).toEqual({ ok: false, error: "401 invalid api key" });
	});

	it("fails when the call throws, or when no model can be resolved", async () => {
		expect(await checkModelHealth(deps(async () => Promise.reject(new Error("socket hang up"))))).toEqual({ ok: false, error: "socket hang up" });
		const none = await checkModelHealth(deps(async () => reply(), { resolveModel: async () => Promise.reject(new Error("no model is configured")) }));
		expect(none).toEqual({ ok: false, error: "no model is configured" });
	});

	it("gives up after the timeout instead of leaving the step waiting", async () => {
		const hang: Complete = (_model, _context, options) => {
			const { promise, reject } = Promise.withResolvers<Reply>();
			options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			return promise;
		};
		const result = await checkModelHealth(deps(hang, { timeoutMs: 20 }));
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toMatch(/respond|timed out/iu);
	});
});
