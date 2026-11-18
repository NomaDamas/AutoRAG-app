import { describe, expect, it } from "vitest";
import type { BackendRequest, BackendResponse, JevBackend } from "jev-use";
import {
	createSearchRelevanceGate,
	JEV_RELEVANCE_THRESHOLD,
	matchesQueryLexicallyOrApprox,
	type RelevanceCandidate,
} from "../src/main/search-relevance-gate";

function candidate(id: string, content: string, extra: Partial<RelevanceCandidate> = {}): RelevanceCandidate {
	return {
		id,
		sourceLabel: extra.sourceLabel ?? "telegram",
		title: extra.title ?? null,
		subtitle: extra.subtitle ?? null,
		content,
	};
}

describe("matchesQueryLexicallyOrApprox", () => {
	it("auto-passes exact query words across Korean, English, NFD Hangul, and punctuation/underscore boundaries", () => {
		expect(matchesQueryLexicallyOrApprox("AutoRAG", "AutoRAG_소개자료_v0.5.pptx")).toBe(true);
		expect(matchesQueryLexicallyOrApprox("AutoRAG", "repo: autorag-research • branch: main")).toBe(true);
		expect(matchesQueryLexicallyOrApprox("보안".normalize("NFC"), `폴더 이름: ${"보안".normalize("NFD")}_점검`)).toBe(true);
		expect(matchesQueryLexicallyOrApprox("비행기를 찾아줘", "[항공권 안내] 비행기 탑승 수속 안내")).toBe(true);
		expect(matchesQueryLexicallyOrApprox("Q3 예산", "2026 Q3 마케팅 집행 내역")).toBe(true);
	});

	it("does not false-pass on English stopwords, partial ASCII stems, or generic Korean query tails", () => {
		expect(matchesQueryLexicallyOrApprox("flight to bali", "and the eggs is to be scrambled?")).toBe(false);
		expect(matchesQueryLexicallyOrApprox("art museum", "This is the seoul-subway-arrival start department")).toBe(false);
		expect(matchesQueryLexicallyOrApprox("비행기 예약 찾아줘", "관련 자료를 찾아 보고드리겠습니다")).toBe(false);
	});

	it("auto-passes high edit-distance similarity (near-verbatim phrase or minor inflection/typo) while rejecting distant text", () => {
		// 1 character difference in an 8-character Korean compound ("확인증" vs "확인서")
		expect(matchesQueryLexicallyOrApprox("비행기예약확인증", "첨부파일: 비행기 예약 확인서 발권본")).toBe(true);
		// Minor typo in an English identifier/sentence
		expect(matchesQueryLexicallyOrApprox("kubernetes cluster", "Deploying to the kubernets clustr node")).toBe(true);
		// Distant text sharing only 2 characters ("양자") out of 11 must NOT auto-pass
		expect(matchesQueryLexicallyOrApprox("양자역학슈뢰딩거방정식", "혹시 양자화는 어떻게 해서 쓰시나요??")).toBe(false);
	});
});

describe("createSearchRelevanceGate", () => {
	it("auto-passes lexical/approx matches without calling Jev and filters semantic-only hits at noul >= 0.5", async () => {
		const requests: BackendRequest[] = [];
		const primary: JevBackend = {
			name: "mock-jev",
			async judge(req): Promise<BackendResponse> {
				requests.push(req);
				return {
					model: "jev-1.13",
					answers: req.questions.map((q) => {
						if (q.question.includes("이스타항공")) return { answer: 0.86 };
						if (q.question.includes("경계선")) return { answer: JEV_RELEVANCE_THRESHOLD };
						return { answer: 0.04 };
					}),
				};
			},
		};
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({ primary }),
			coalesceMs: 0,
		});

		const kept = await gate.filter("비행기예약확인증", [
			candidate("noise-1", "게이트 형식을 이해했습니다. 슬라이드 HTML을 빌드하겠습니다."),
			candidate("semantic-low", "경계선 테스트 메시지"),
			candidate("lexical", "비행기 예약 확인서 PDF 첨부"),
			candidate("semantic-high", "[이스타항공] 온라인 체크인 안내"),
			candidate("noise-2", "and the eggs is scrambled?"),
		]);

		// The lexical/approx match skipped Jev completely; only the 4 non-lexical items were sent.
		expect(requests).toHaveLength(1);
		expect(requests[0]?.questions).toHaveLength(4);
		expect(String(requests[0]?.state)).toContain("비행기예약확인증");
		// Lexical match stays first, followed by Jev-kept items ordered by P(relevant) descending.
		expect(kept.map((item: RelevanceCandidate) => item.id)).toEqual(["lexical", "semantic-high", "semantic-low"]);
	});

	it("coalesces concurrent calls for the same query onto one state and fans oversized batches in parallel", async () => {
		let inFlight = 0;
		let maxConcurrent = 0;
		const seenStates: string[] = [];
		const batchSizes: number[] = [];
		const allArrived = Promise.withResolvers<void>();
		const primary: JevBackend = {
			name: "mock-jev",
			async judge(req): Promise<BackendResponse> {
				inFlight += 1;
				maxConcurrent = Math.max(maxConcurrent, inFlight);
				seenStates.push(String(req.state));
				batchSizes.push(req.questions.length);
				if (batchSizes.length === 3) allArrived.resolve();
				await allArrived.promise;
				inFlight -= 1;
				return {
					model: "jev-1.13",
					answers: req.questions.map((q) => ({ answer: q.question.includes("keep-") ? 0.8 : 0.1 })),
				};
			},
		};
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({ primary }),
			coalesceMs: 0,
			maxQuestionsPerBatch: 4,
		});

		const [localKept, telegramKept, whatsappKept] = await Promise.all([
			gate.filter("항공권 발권", [
				candidate("l1", "keep-local boarding pass", { sourceLabel: "local" }),
				candidate("l2", "drop-local grocery list", { sourceLabel: "local" }),
				candidate("l3", "drop-local meeting notes", { sourceLabel: "local" }),
			]),
			gate.filter("항공권 발권", [
				candidate("t1", "drop-tg random build log", { sourceLabel: "telegram" }),
				candidate("t2", "drop-tg subway arrival", { sourceLabel: "telegram" }),
				candidate("t3", "keep-tg flight e-ticket", { sourceLabel: "telegram" }),
			]),
			gate.filter("항공권 발권", [
				candidate("w1", "drop-wa scrambled eggs", { sourceLabel: "whatsapp" }),
				candidate("w2", "drop-wa homestay ubud", { sourceLabel: "whatsapp" }),
				candidate("w3", "keep-wa airline booking", { sourceLabel: "whatsapp" }),
			]),
		]);

		// 9 non-lexical questions across 3 sources coalesced onto the identical query state, split into parallel batches of <= 4 (4, 4, 1).
		expect(batchSizes).toEqual([4, 4, 1]);
		expect(new Set(seenStates).size).toBe(1);
		expect(maxConcurrent).toBe(3);
		expect(localKept.map((item: RelevanceCandidate) => item.id)).toEqual(["l1"]);
		expect(telegramKept.map((item: RelevanceCandidate) => item.id)).toEqual(["t3"]);
		expect(whatsappKept.map((item: RelevanceCandidate) => item.id)).toEqual(["w3"]);
	});

	it("falls back to the sLLM backend when primary Jev is unreachable", async () => {
		let primaryCalls = 0;
		let fallbackCalls = 0;
		const primary: JevBackend = {
			name: "dazzi",
			async judge(): Promise<BackendResponse> {
				primaryCalls += 1;
				throw new Error("HTTP 503: Jev unavailable");
			},
		};
		const fallback: JevBackend = {
			name: "sllm",
			async judge(req): Promise<BackendResponse> {
				fallbackCalls += 1;
				return {
					model: "sllm-test",
					answers: req.questions.map((q) => ({ answer: q.question.includes("tax invoice") ? 0.75 : 0.12 })),
				};
			},
		};
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({ primary, fallback }),
			coalesceMs: 0,
		});

		const kept = await gate.filter("세금계산서 발행", [
			candidate("a", "completely unrelated chat noise"),
			candidate("b", "relevant electronic tax invoice issuance guide"),
		]);

		expect(primaryCalls).toBe(1);
		expect(fallbackCalls).toBe(1);
		expect(kept.map((item: RelevanceCandidate) => item.id)).toEqual(["b"]);
	});

	it("fails open when neither Jev nor an sLLM fallback is configured or reachable", async () => {
		const gate = createSearchRelevanceGate({
			resolveBackends: async () => ({}),
			coalesceMs: 0,
		});
		const items = [candidate("a", "offline local hit one"), candidate("b", "offline local hit two")];

		const kept = await gate.filter("추상적인 질문", items);

		expect(kept).toEqual(items);
	});
});
