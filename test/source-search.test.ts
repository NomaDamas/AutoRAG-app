import { describe, expect, it } from "vitest";
import type { RetrievalDiagnostic, RetrievalResult, RetrievalSelection } from "@autorag/librarian";
import { createSourceSearch, sourceHit, type SourceSearchRuntime } from "../src/main/source-search";

function result(id: string, score: number, metadata: Record<string, unknown>, content = "회의 일정 정리"): RetrievalResult {
	return { id, content, source: `src:${id}`, score, metadata };
}

function service(options: {
	readonly raw: Record<string, unknown>;
	readonly registered?: readonly string[];
	readonly answer?: (selection: RetrievalSelection | undefined) => { results: RetrievalResult[]; diagnostics: RetrievalDiagnostic[] } | Promise<never>;
}) {
	const selections: (RetrievalSelection | undefined)[] = [];
	let opened = 0;
	const runtime: SourceSearchRuntime = {
		listDatasources: () => (options.registered ?? Object.keys(options.raw.datasources as object)).map((datasourceId) => ({ datasourceId })),
		searchSelected: async (_query, selection) => {
			selections.push(selection);
			return (await options.answer?.(selection)) ?? { results: [], diagnostics: [] };
		},
	};
	const search = createSourceSearch({
		loadConfig: async () => ({ raw: options.raw, key: JSON.stringify(options.raw) }),
		open: () => {
			opened += 1;
			return runtime;
		},
	});
	return { search, selections, opened: () => opened };
}

describe("datasource search", () => {
	it("lists enabled, registered datasources with their template type", async () => {
		const { search } = service({
			raw: { datasources: { kakao: {}, nomadamas: { type: "discord" }, spotlight: { enabled: false }, ghost: { type: "rss" } } },
			registered: ["kakao", "nomadamas", "spotlight"],
		});
		expect(await search.datasources()).toEqual([
			{ id: "kakao", type: "kakao" },
			{ id: "nomadamas", type: "discord" },
		]);
	});

	it("asks only the one datasource, never the local index", async () => {
		const { search, selections } = service({ raw: { datasources: { slack: {} } } });
		await search.search("slack", "deploy");
		expect(selections).toEqual([{ datasourceIds: ["slack"], local: false }]);
	});

	it("returns hits best first, capped at the limit", async () => {
		const { search } = service({
			raw: { datasources: { kakao: {} } },
			answer: () => ({ results: [result("a", 0.2, {}), result("b", 0.9, {}), result("c", 0.5, {})], diagnostics: [] }),
		});
		const outcome = await search.search("kakao", "회의", 2);
		expect(outcome.state).toBe("ok");
		expect(outcome.hits.map((hit) => hit.id)).toEqual(["b", "c"]);
	});

	it("reports a datasource that failed and answered nothing as an error with its reason", async () => {
		const { search } = service({
			raw: { datasources: { kakao: {} } },
			answer: () => ({ results: [], diagnostics: [{ code: "retrieval-method-failed", severity: "error", message: "kakao-hybrid failed", reason: "katok: not found" }] }),
		});
		expect(await search.search("kakao", "회의")).toEqual({ state: "error", hits: [], error: "katok: not found" });
	});

	it("turns a thrown search into an error outcome, but lets a cancellation through", async () => {
		const { search } = service({ raw: { datasources: { slack: {} } }, answer: () => Promise.reject(new Error("slack CLI crashed")) });
		expect(await search.search("slack", "x")).toEqual({ state: "error", hits: [], error: "slack CLI crashed" });
		const controller = new AbortController();
		controller.abort();
		await expect(search.search("slack", "x", undefined, controller.signal)).rejects.toThrow("slack CLI crashed");
	});

	it("does not touch the runtime for an empty query and rebuilds it only when the config changes", async () => {
		const { search, selections, opened } = service({ raw: { datasources: { slack: {} } } });
		expect(await search.search("slack", "   ")).toEqual({ state: "ok", hits: [], error: null });
		expect(selections).toHaveLength(0);
		await search.datasources();
		await search.search("slack", "a");
		expect(opened()).toBe(1);
	});
});

describe("datasource hit rows", () => {
	it("names a KakaoTalk message by its room and sender", () => {
		const hit = sourceHit(result("k", 1, { chatName: "대표자톡방", senderNickname: "이기헌", publishedAt: 1775814015000 }), "회의");
		expect([hit.title, hit.author, hit.timestamp, hit.url]).toEqual(["대표자톡방", "이기헌", 1775814015000, null]);
	});

	it("names a mail by its subject and sender, dated from its ISO date", () => {
		const hit = sourceHit(result("m", 1, { subject: "요즘 뜨는 AI", from: "help@nomadcoders.co", date: "2026-10-30T03:16:43Z" }), "AI");
		expect([hit.title, hit.author, hit.timestamp]).toEqual(["요즘 뜨는 AI", "help@nomadcoders.co", Date.parse("2026-10-30T03:16:43Z")]);
	});

	it("keeps a browser page's http(s) url and drops any other scheme", () => {
		expect(sourceHit(result("b", 1, { title: "코엑스", url: "https://coex.co.kr/x", domain: "coex.co.kr" }), "x").url).toBe("https://coex.co.kr/x");
		expect(sourceHit(result("b", 1, { url: "file:///etc/passwd" }), "x").url).toBeNull();
	});

	it("reads a Slack epoch-seconds timestamp and falls back to the source for a title", () => {
		const hit = sourceHit(result("s", 1, { timestamp: "1732757337" }), "x");
		expect([hit.title, hit.timestamp]).toEqual(["src:s", 1732757337000]);
	});
});
