import { describe, expect, it } from "vitest";
import { preflightEmbedder } from "../src/main/embedder-preflight";

interface RecordedCall {
	readonly url: string;
	readonly init: RequestInit;
}

/** A fetch that answers every request the same way and remembers what it was asked. */
interface RecordedFetch {
	readonly fetchImpl: typeof fetch;
	readonly calls: RecordedCall[];
}

function respond(status: number, body: unknown): RecordedFetch {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
	}) as typeof fetch;
	return { fetchImpl, calls };
}

const openai = { id: "openai:acme/embed-small", baseUrl: "https://gateway.example/api", dimension: 3, apiKeyEnv: "OPENAI_API_KEY" };
const vectors = { data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }] };

describe("preflightEmbedder", () => {
	it("sends one embedding request the way MinSync does and accepts a vector of the declared dimension", async () => {
		const server = respond(200, vectors);

		const outcome = await preflightEmbedder(openai, { env: { OPENAI_API_KEY: "sk-test" }, fetchImpl: server.fetchImpl });

		expect(outcome).toEqual({ ok: true });
		expect(server.calls).toHaveLength(1);
		const { url, init } = server.calls[0] as RecordedCall;
		expect(url).toBe("https://gateway.example/api/v1/embeddings");
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
		expect(JSON.parse(init.body as string)).toEqual({ model: "acme/embed-small", input: ["ping"] });
	});

	it("tells the user to drop a trailing /v1 when the gateway answers 404", async () => {
		const server = respond(404, "Not Found");

		const outcome = await preflightEmbedder({ ...openai, baseUrl: "https://gateway.example/api/v1/" }, { env: { OPENAI_API_KEY: "k" }, fetchImpl: server.fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("https://gateway.example/api/v1");
		// The corrected URL appears on its own, not just as the prefix of the wrong one.
		expect(outcome.message).toMatch(/https:\/\/gateway\.example\/api(?!\/v1)/u);
	});

	it("does not blame /v1 for a 404 when the base URL has none", async () => {
		const server = respond(404, "no such model");

		const outcome = await preflightEmbedder(openai, { env: { OPENAI_API_KEY: "k" }, fetchImpl: server.fetchImpl });

		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("404");
		expect(outcome.message).not.toContain("/v1");
	});

	it("reports the provider's own reason for a rejected key or an empty balance", async () => {
		const unauthorized = await preflightEmbedder(openai, {
			env: { OPENAI_API_KEY: "bad" },
			fetchImpl: respond(401, { error: { message: "Missing Authentication header" } }).fetchImpl,
		});
		const credits = await preflightEmbedder(openai, {
			env: { OPENAI_API_KEY: "k" },
			fetchImpl: respond(402, { error: { message: "Insufficient credits" } }).fetchImpl,
		});

		expect(unauthorized.ok).toBe(false);
		expect(credits.ok).toBe(false);
		if (!unauthorized.ok) expect(unauthorized.message).toMatch(/401.*Missing Authentication header/su);
		if (!credits.ok) expect(credits.message).toMatch(/402.*Insufficient credits/su);
	});

	it("fails before any request when OPENAI_API_KEY is unset, naming both variables", async () => {
		const server = respond(200, vectors);

		const outcome = await preflightEmbedder({ ...openai, apiKeyEnv: "OPENROUTER_API_KEY" }, { env: { OPENROUTER_API_KEY: "sk-or" }, fetchImpl: server.fetchImpl });

		expect(server.calls).toHaveLength(0);
		expect(outcome.ok).toBe(false);
		if (outcome.ok) return;
		expect(outcome.message).toContain("OPENROUTER_API_KEY");
		expect(outcome.message).toContain("OPENAI_API_KEY");
	});

	it("accepts an openai: embedder whose key is in OPENAI_API_KEY even when apiKeyEnv names another variable", async () => {
		const outcome = await preflightEmbedder({ ...openai, apiKeyEnv: "OPENROUTER_API_KEY" }, { env: { OPENAI_API_KEY: "k" }, fetchImpl: respond(200, vectors).fetchImpl });

		expect(outcome).toEqual({ ok: true });
	});

	it("rejects a vector whose length is not the configured dimension", async () => {
		const outcome = await preflightEmbedder({ ...openai, dimension: 1024 }, { env: { OPENAI_API_KEY: "k" }, fetchImpl: respond(200, vectors).fetchImpl });

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toMatch(/3.*1024/su);
	});

	it("rejects an answer that carries no vector", async () => {
		const outcome = await preflightEmbedder(openai, { env: { OPENAI_API_KEY: "k" }, fetchImpl: respond(200, { data: [] }).fetchImpl });

		expect(outcome.ok).toBe(false);
	});

	it("reports an unreachable server with its address", async () => {
		const fetchImpl = (async () => {
			throw new TypeError("fetch failed");
		}) as typeof fetch;

		const outcome = await preflightEmbedder(openai, { env: { OPENAI_API_KEY: "k" }, fetchImpl });

		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.message).toContain("https://gateway.example/api");
	});

	it("probes a tei: embedder at /embed without a key", async () => {
		const server = respond(200, [[0.1, 0.2, 0.3]]);

		const outcome = await preflightEmbedder({ id: "tei:acme/embed", baseUrl: "http://127.0.0.1:8080", dimension: 3 }, { env: {}, fetchImpl: server.fetchImpl });

		expect(outcome).toEqual({ ok: true });
		const { url, init } = server.calls[0] as RecordedCall;
		expect(url).toBe("http://127.0.0.1:8080/embed");
		expect(JSON.parse(init.body as string)).toEqual({ inputs: ["ping"] });
	});

	it.each([
		["no embedder", undefined],
		["a native embedder", { id: "native:Qwen/Qwen3-Embedding-0.6B", dimension: 1024 }],
		["a runtime profile", { profile: "qwen3-embedding-0.6b" }],
	])("does nothing for %s", async (_name, embedder) => {
		const server = respond(200, vectors);

		expect(await preflightEmbedder(embedder, { env: {}, fetchImpl: server.fetchImpl })).toEqual({ ok: true });
		expect(server.calls).toHaveLength(0);
	});
});
