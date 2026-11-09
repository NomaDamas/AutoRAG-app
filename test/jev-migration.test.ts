import { describe, expect, it } from "vitest";
import { migrateLegacyJev } from "../src/main/jev-migration";

describe("migrateLegacyJev", () => {
	it("turns the retired `jev: false` into the small chat model as decision model", () => {
		const raw = { searchPaths: ["/a"], jev: false };

		const result = migrateLegacyJev(raw);

		expect(result.changed).toBe(true);
		expect(result.raw).toEqual({ searchPaths: ["/a"], jev: { backend: "sllm" } });
	});

	it("reads `enabled: false` the same way and drops what the small chat model cannot take", () => {
		const raw = { jev: { enabled: false, backend: "openrouter", model: "typesafe/jev-1.13", fallback: true, confidenceThreshold: 0.8 } };

		expect(migrateLegacyJev(raw).raw).toEqual({ jev: { backend: "sllm", confidenceThreshold: 0.8 } });
	});

	it("keeps the Jev block of `enabled: true` and removes only the retired switch", () => {
		const raw = { jev: { enabled: true, backend: "dazzi", model: "jev-1.13" } };

		expect(migrateLegacyJev(raw).raw).toEqual({ jev: { backend: "dazzi", model: "jev-1.13" } });
	});

	it("renames the Vercel backend to its pi provider id and drops the model id that backend never served", () => {
		const bare = { jev: { backend: "vercel", model: "typesafe/jev-latest" } };
		const named = { jev: { backend: "vercel", model: "typesafe-ai/jev-1.14.0" } };

		expect(migrateLegacyJev(bare).raw).toEqual({ jev: { backend: "vercel-ai-gateway" } });
		expect(migrateLegacyJev(named).raw).toEqual({ jev: { backend: "vercel-ai-gateway", model: "typesafe-ai/jev-1.14.0" } });
	});

	it("points OpenRouter's latest alias at the id its catalog lists", () => {
		const raw = { jev: { backend: "openrouter", model: "typesafe/jev-latest" } };

		expect(migrateLegacyJev(raw).raw).toEqual({ jev: { backend: "openrouter", model: "~typesafe/jev-latest" } });
	});

	it("leaves a current block, an absent one and a non-config shape untouched (same object)", () => {
		const current = { jev: { backend: "sllm", sllm: { model: { provider: "openai", id: "x" } } } };
		const dazzi = { jev: { backend: "dazzi", model: "jev-1.13" } };
		const absent = { searchPaths: [] };
		const odd = { jev: "x" };

		for (const raw of [current, dazzi, absent, odd]) {
			const result = migrateLegacyJev(raw);
			expect(result.changed).toBe(false);
			expect(result.raw).toBe(raw);
		}
	});

	it("does not mutate its input", () => {
		const raw = { jev: { enabled: false } };

		migrateLegacyJev(raw);

		expect(raw).toEqual({ jev: { enabled: false } });
	});
});
