import { describe, expect, it } from "vitest";
import type { RetrievalDiagnostic, RetrievalResult, RetrievalSelection } from "@autorag/librarian";
import { createSourceSearch, sourceHit, type SourceSearchRuntime } from "../src/main/source-search";
import { createSearchRelevanceGate } from "../src/main/search-relevance-gate";

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

	it("auto-passes exact/approx matches and drops unrelated datasource hits below Jev 0.5", async () => {
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({
				primary: {
					name: "jev",
					judge: async (req) => ({
						model: "jev-1.13",
						answers: req.questions.map((q) => ({ answer: q.question.includes("이스타항공") ? 0.88 : 0.03 })),
					}),
				},
			}),
			coalesceMs: 0,
		});
		const search = createSourceSearch({
			loadConfig: async () => ({ raw: { datasources: { telegram: {}, kakao: {} } }, key: "k" }),
			open: () => ({
				listDatasources: () => [{ datasourceId: "telegram" }, { datasourceId: "kakao" }],
				searchSelected: async (_query, selection) => ({
					results:
						selection?.datasourceIds?.[0] === "telegram"
							? [result("tg-noise", 1, { chatTitle: "Dev" }, "게이트 형식을 이해했습니다")]
							: [
									result("kk-noise", 1, { chatName: "단톡방" }, "오늘 저녁 뭐 먹을까요"),
									result("kk-sem", 0.8, { chatName: "알림톡" }, "[이스타항공] 온라인 체크인 안내"),
									result("kk-lex", 0.6, { chatName: "여행방" }, "비행기 예약 확인서 보냈어"),
								],
					diagnostics: [],
				}),
			}),
			relevanceGate: gate,
		});

		const [tg, kk] = await Promise.all([
			search.search("telegram", "비행기예약확인증"),
			search.search("kakao", "비행기예약확인증"),
		]);

		expect(tg).toEqual({ state: "ok", hits: [], error: null });
		expect(kk.hits.map((hit) => hit.id)).toEqual(["kk-lex", "kk-sem"]);
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

	describe("AI Sessions (wombat) hits", () => {
		const label = "[claude-code:sess-1 | turns 3-4 | 2026-10-22 | Release flow | /work/app]";
		const wombat = (metadata: Record<string, unknown> = {}, body = "we cut the patch release from main after CI is green") =>
			result("w", 1, { datasourceId: "wombat", agent: "claude-code", sessionKey: "claude-code:sess-1", title: "Release flow", startedAt: "2026-10-22T12:06:50Z", ...metadata }, `${label}\n${body}`);

		it("is named by the session's title, written by the agent that ran it, and dated from its start", () => {
			const hit = sourceHit(wombat(), "patch release");
			expect([hit.title, hit.author, hit.timestamp, hit.url]).toEqual(["Release flow", "claude-code", Date.parse("2026-10-22T12:06:50Z"), null]);
		});

		it("shows the conversation, not the label line the model needs and a person already reads in the title", () => {
			const hit = sourceHit(wombat(), "patch release");
			expect(hit.snippet).toBe("we cut the patch release from main after CI is green");
			expect(hit.content).toBe("we cut the patch release from main after CI is green");
			expect(hit.snippet).not.toContain("claude-code:sess-1");
		});

		const firstChunk = [
			"claude-code/work-alpha/s1__a719d1b96e4d.md",
			"# Session claude-code:s1",
			"- agent: claude-code",
			"- session_id: s1",
			"- source_path: /Users/me/.claude/projects/p/s1.jsonl",
			"- cwd: /work/alpha",
			"- started_at: 2026-10-16T01:00:00Z",
			"",
			"## Turn 1 | User | 2026-10-16T01:00:00Z [src:L1]",
			"",
			"how do I stop the ingress from dropping long uploads",
			"",
			"## Turn 2 | Assistant | 2026-10-16T01:00:10Z [src:L2]",
			"",
			"Raise the proxy read timeout on the ingress controller.",
		].join("\n");

		it("drops wombat's mirror header, so a row never prints a file path or the session's bookkeeping", () => {
			const hit = sourceHit(wombat({}, firstChunk), "ingress");
			expect(hit.content).toBe("User: how do I stop the ingress from dropping long uploads Assistant: Raise the proxy read timeout on the ingress controller.");
			for (const noise of ["source_path", "/Users/me", "session_id", ".md", "[src:", "2026-10-16T01"]) expect(hit.content, noise).not.toContain(noise);
			expect(hit.snippet).not.toContain("source_path");
		});

		it("also cleans a later chunk, which starts with the path and the session heading instead of the header block", () => {
			const later = ["claude-code/work-alpha/s1__a719d1b96e4d.md > Session claude-code:s1", "## Turn 50 | Assistant | 2026-10-16T01:24:10Z [src:L50]", "", "answer 24: raise the timeout"].join("\n");
			expect(sourceHit(wombat({}, later), "timeout").content).toBe("Assistant: answer 24: raise the timeout");
		});

		it("keeps a turn's own text that merely contains such markers", () => {
			const body = "## Turn 1 | User | x [src:L1] is how a mirror marks a turn";
			expect(sourceHit(wombat({}, `claude-code/a.md\n${body}`), "mirror").content).toContain("is how a mirror marks a turn");
		});

		it("falls back to the session key when the session has no title, and keeps a body that merely looks like a label", () => {
			expect(sourceHit(wombat({ title: "" }), "x").title).toBe("claude-code:sess-1");
			const body = "[not a label] this is the message";
			const hit = sourceHit(result("w2", 1, { datasourceId: "wombat", agent: "codex", title: "T" }, body), "message");
			expect(hit.snippet).toBe(body);
		});

		it("leaves every other datasource's content untouched, even when it starts with a bracket", () => {
			const hit = sourceHit(result("k", 1, { chatName: "room" }, "[공지] 내일 회의"), "회의");
			expect(hit.content).toBe("[공지] 내일 회의");
		});
	});
});
