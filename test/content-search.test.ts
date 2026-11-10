import { describe, expect, it } from "vitest";
import type { RetrievalResult, RetrievalSelection } from "@autorag/librarian";
import { contentSnippet, createContentSearch, type ContentSearchRuntime } from "../src/main/content-search";
import { createSearchRelevanceGate } from "../src/main/search-relevance-gate";

function chunk(source: string, content: string, score: number, lineNumber?: number): RetrievalResult {
	return { id: `${source}:${score}`, content, source, score, metadata: lineNumber === undefined ? {} : { lineNumber } };
}

interface Recorded {
	readonly queries: { query: string; selection: RetrievalSelection | undefined; topK: number | undefined }[];
	opened: number;
}

function runtime(recorded: Recorded, answer: { results: RetrievalResult[]; unsearched?: { surface: string; methods: string[]; reason: string }[] }): ContentSearchRuntime {
	return {
		searchSelected: async (query, selection, options) => {
			recorded.queries.push({ query, selection, topK: options?.topK });
			return { results: answer.results, diagnostics: [], unsearched: (answer.unsearched ?? []) as never };
		},
	};
}

function service(answer: Parameters<typeof runtime>[1], raw: Record<string, unknown> = {}) {
	const recorded: Recorded = { queries: [], opened: 0 };
	let current = raw;
	const search = createContentSearch({
		loadConfig: async () => ({ raw: current, key: JSON.stringify(current) }),
		open: () => {
			recorded.opened += 1;
			return runtime(recorded, answer);
		},
	});
	return { search, recorded, setRaw: (next: Record<string, unknown>) => (current = next) };
}

describe("content search", () => {
	it("searches only the local MinSync hybrid index, never a datasource", async () => {
		const { search, recorded } = service({ results: [] });
		await search.search("refund policy");
		expect(recorded.queries).toHaveLength(1);
		expect(recorded.queries[0]?.selection).toEqual({ datasourceIds: [], local: true, methods: ["hybrid"] });
	});

	it("returns one row per file, the best chunk first, in score order", async () => {
		const { search } = service({
			results: [
				chunk("/d/a.md", "refund within seven days", 0.9, 3),
				chunk("/d/b.md", "no refund after use", 0.8),
				chunk("/d/a.md", "another refund passage", 0.7, 9),
			],
		});
		const outcome = await search.search("refund");
		expect(outcome.state).toBe("ok");
		expect(outcome.hits.map((hit) => [hit.path, hit.line])).toEqual([
			["/d/a.md", 3],
			["/d/b.md", null],
		]);
		expect(outcome.hits[0]?.snippet).toBe("refund within seven days");
	});

	it("stops at the hit limit", async () => {
		const results = Array.from({ length: 30 }, (_, index) => chunk(`/d/${index}.md`, "x", 1 - index / 100));
		const { search } = service({ results });
		expect((await search.search("x", 5)).hits).toHaveLength(5);
	});

	it("is off in keyword-only mode and never opens the index", async () => {
		const { search, recorded } = service({ results: [chunk("/d/a.md", "x", 1)] }, { appIndexing: { semanticSearch: false } });
		expect(await search.search("x")).toEqual({ state: "off", hits: [] });
		expect(recorded.opened).toBe(0);
	});

	it("reports the index as unavailable when the local surface was not searched", async () => {
		const { search } = service({ results: [], unsearched: [{ surface: "minsync", methods: ["hybrid"], reason: "no index" }] });
		expect(await search.search("x")).toEqual({ state: "unavailable", hits: [] });
	});

	it("answers nothing for a blank query without touching the index", async () => {
		const { search, recorded } = service({ results: [chunk("/d/a.md", "x", 1)] });
		expect(await search.search("   ")).toEqual({ state: "ok", hits: [] });
		expect(recorded.opened).toBe(0);
	});

	it("reuses the runtime while the config is unchanged and rebuilds it after a change", async () => {
		const { search, recorded, setRaw } = service({ results: [] });
		await search.search("a");
		await search.search("b");
		expect(recorded.opened).toBe(1);
		setRaw({ searchPaths: ["/other"] });
		await search.search("c");
		expect(recorded.opened).toBe(2);
	});

	it("keeps lexical/edit-distance hits automatically and gates semantic-only hits through Jev >= 0.5", async () => {
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({
				primary: {
					name: "jev",
					judge: async (req) => ({
						model: "jev-1.13",
						answers: req.questions.map((q) => ({ answer: q.question.includes("airline e-ticket") ? 0.82 : 0.08 })),
					}),
				},
			}),
			coalesceMs: 0,
		});
		const recorded: Recorded = { queries: [], opened: 0 };
		const search = createContentSearch({
			loadConfig: async () => ({ raw: {}, key: "k" }),
			open: () =>
				runtime(recorded, {
					results: [
						chunk("/d/noise.md", "completely unrelated build output", 0.99),
						chunk("/d/ticket.md", "airline e-ticket boarding confirmation", 0.85),
						chunk("/d/exact.md", "비행기 예약 확인서 사본", 0.7),
					],
				}),
			relevanceGate: gate,
		});

		const outcome = await search.search("비행기예약확인증");

		expect(outcome.state).toBe("ok");
		expect(outcome.hits.map((hit) => hit.path)).toEqual(["/d/exact.md", "/d/ticket.md"]);
	});
});

describe("contentSnippet", () => {
	it("collapses whitespace and keeps a short passage whole", () => {
		expect(contentSnippet("# Title\n\n  refund   policy\n", "refund")).toBe("# Title refund policy");
	});

	it("centres a long passage on the first query term, with ellipses", () => {
		const text = `${"a ".repeat(200)}the refund rule ${"b ".repeat(200)}`;
		const snippet = contentSnippet(text, "REFUND");
		expect(snippet.startsWith("…")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
		expect(snippet).toContain("the refund rule");
		expect(snippet.length).toBeLessThanOrEqual(162);
	});

	it("starts at the beginning when no term appears", () => {
		const snippet = contentSnippet("x".repeat(400), "absent");
		expect(snippet.startsWith("x")).toBe(true);
		expect(snippet.endsWith("…")).toBe(true);
	});
});
