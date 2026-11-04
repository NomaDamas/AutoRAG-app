import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchDocumentsStreamEvent } from "@autorag/librarian";
import type { FirstRunDemo } from "../shared/onboarding-contract";
import type { AppSettings } from "../shared/settings-contract";
import type { LiveAgentEvent } from "./search-service";

/**
 * Mini-fixture corpus and deterministic preview agent for `make onboarding-skip-index`.
 *
 * `make onboarding` indexes the developer's real default folders; when those
 * hold tens of thousands of files, reaching the post-setup tour takes minutes.
 * `--skip-index` points the sandboxed run at a tiny four-file home directory:
 *
 *  - `Documents/2026-3분기-사업기획안 (최종).md` + `2026-3분기-사업기획안.md`:
 *    a near-duplicate pair so `dupey` builds a real two-version stack in <200 ms;
 *  - `Documents/11월-출시-체크리스트.md`: a second cited source so the tour's
 *    Evidence panel and Evidence Folder bundle multiple real files on disk;
 *  - `Desktop/주간-회의록-요약.txt`: a second default folder with realistic text.
 */

export const SKIP_INDEX_PLAN_FINAL = "2026-3분기-사업기획안 (최종).md";
export const SKIP_INDEX_PLAN_DRAFT = "2026-3분기-사업기획안.md";
export const SKIP_INDEX_CHECKLIST = "11월-출시-체크리스트.md";
const SKIP_INDEX_MEETING_NOTES = "주간-회의록-요약.txt";

const PLAN_SHARED_TAIL = [
	"",
	"## 2. 채널별 실행 내역",
	"- 검색 광고의 비효율 키워드를 정리하고 오가닉 콘텐츠 비중을 높여 CAC를 낮췄습니다.",
	"- 온보딩 구간의 불필요한 입력 단계를 걷어내 첫 주 잔존율이 61%에서 74%로 올랐습니다.",
	"- 팀 문서 정리 및 중복 버전 관리 수요가 가장 높은 세그먼트로 확인되었습니다.",
	"",
	"## 3. 4분기 정식 출시 일정",
	"- 정식 배포 목표일은 **2026년 11월 18일(수)**로 확정했습니다.",
	"- 출시 전 체크리스트와 보안 점검은 별도 문서(`11월-출시-체크리스트.md`)에서 관리합니다.",
	"",
].join("\n");

function planDocumentBody(customers: number, statusLine: string): string {
	return [
		"# 2026년 3분기 사업기획안 및 성과 요약",
		"",
		`> 문서 상태: ${statusLine}`,
		"",
		"## 1. 핵심 지표 요약",
		"- **마케팅 비용**: 채널 효율화로 전분기 대비 **18% 절감**했습니다.",
		`- **신규 유료 고객**: 3분기 누적 **${customers}명** 순증을 기록했습니다.`,
		"- **평균 첫 검색 도달 시간**: 설치 후 첫 검색까지 걸리는 시간을 4분에서 40초 이내로 단축했습니다.",
		PLAN_SHARED_TAIL,
	].join("\n");
}

const CHECKLIST_BODY = [
	"# 11월 정식 출시 체크리스트",
	"",
	"## 배포 기준일",
	"- 정식 출시일: **2026년 11월 18일(수) 오전 10:00 KST**",
	"- 코드 프리즈: 2026년 11월 15일(일) 18:00",
	"",
	"## 필수 확인 항목",
	"1. macOS 및 Windows 설치 패키지 서명·공증 검증 완료",
	"2. 첫 실행 인덱싱 후 근거 하이라이트 및 임시 근거 폴더 동작 확인",
	"3. 중복 문서 버전 묶음(최신본 판별) 스모크 테스트 통과",
	"",
].join("\n");

const MEETING_NOTES_BODY = [
	"2026-11 주간 제품 회의록 요약",
	"",
	"- 온보딩에서 질문을 줄이고 기본값으로 바로 쓸 수 있게 하기로 합의함.",
	"- 3분기 마케팅 예산 18% 절감분을 4분기 제품 개선 리소스로 전환.",
	"- 다음 점검 회의: 금요일 오후 3시.",
	"",
].join("\n");

/** Writes the four mini-fixture files into `fixtureHome` with deterministic mtimes so `(최종)` is always the newest head. */
export function seedSkipIndexFixtureHome(fixtureHome: string): void {
	const documents = join(fixtureHome, "Documents");
	const desktop = join(fixtureHome, "Desktop");
	const downloads = join(fixtureHome, "Downloads");
	mkdirSync(documents, { recursive: true });
	mkdirSync(desktop, { recursive: true });
	mkdirSync(downloads, { recursive: true });

	const draftPath = join(documents, SKIP_INDEX_PLAN_DRAFT);
	const finalPath = join(documents, SKIP_INDEX_PLAN_FINAL);
	const checklistPath = join(documents, SKIP_INDEX_CHECKLIST);
	const notesPath = join(desktop, SKIP_INDEX_MEETING_NOTES);

	writeFileSync(draftPath, planDocumentBody(412, "초안 (2026-10-12)"), "utf8");
	writeFileSync(finalPath, planDocumentBody(418, "최종 확정본 (2026-10-28)"), "utf8");
	writeFileSync(checklistPath, CHECKLIST_BODY, "utf8");
	writeFileSync(notesPath, MEETING_NOTES_BODY, "utf8");

	const nowSeconds = Math.floor(Date.now() / 1000);
	utimesSync(draftPath, nowSeconds - 3600, nowSeconds - 3600);
	utimesSync(checklistPath, nowSeconds - 1800, nowSeconds - 1800);
	utimesSync(notesPath, nowSeconds - 900, nowSeconds - 900);
	utimesSync(finalPath, nowSeconds, nowSeconds);
}

const DEMO_QUESTION: Readonly<Record<AppSettings["language"], string>> = {
	ko: "3분기 마케팅 비용이랑 신규 고객 수는 어떻게 바뀌었어?",
	en: "How did Q3 marketing spend and new customers change, and when is launch?",
	ja: "第3四半期のマーケティング費用と新規顧客数はどう変わりましたか？",
	zh: "第三季度营销费用和新客户数有什么变化？",
};

/** Returns the tour's demo question when `home` holds the seeded mini-fixture documents; null otherwise. */
export function skipIndexDemo(home: string, language: AppSettings["language"]): FirstRunDemo | null {
	const sourcePath = join(home, "Documents", SKIP_INDEX_PLAN_FINAL);
	if (!existsSync(sourcePath)) return null;
	return {
		question: DEMO_QUESTION[language],
		sourcePath,
		latencyMs: 14,
	};
}

const DEMO_ANSWER: Readonly<Record<AppSettings["language"], string>> = {
	ko: "3분기 마케팅 비용은 채널 효율화로 전분기 대비 **18% 절감**했고, 신규 유료 고객은 최종 확정 기준 **418명** 순증했습니다 [1].\n\n4분기 정식 배포 목표일은 **2026년 11월 18일(수) 오전 10시**로 확정되어 출시 체크리스트에 따라 점검 중입니다 [2].",
	en: "Q3 marketing spend fell **18%** quarter over quarter through channel optimization, and net new paid customers reached **418** in the final plan [1].\n\nThe Q4 launch is set for **November 18, 2026 at 10:00 KST**, tracked in the release checklist [2].",
	ja: "第3四半期のマーケティング費用は前期比**18%削減**され、新規有料顧客は確定値で**418名**純増しました [1]。\n\n正式リリース日は**2026年11月18日(水) 10:00**に確定し、チェックリストに沿って準備が進んでいます [2]。",
	zh: "第三季度营销费用环比**降低了 18%**,最终确认的新增付费客户达到 **418 人** [1]。\n\n第四季度正式发布时间定于 **2026 年 11 月 18 日(周三)10:00**,正按发布清单推进 [2]。",
};

function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Deterministic `SearchAgent` for `make onboarding-skip-index`: streams a live
 * cited answer grounded in the real mini-fixture files on disk, so every step of
 * the tour (`answer` → `cite` → `evidence` → `evidenceFolder`) works offline and
 * in under a second.
 */
export function createSkipIndexPreviewAgent(options: {
	readonly fixtureHome: string;
	readonly language: () => AppSettings["language"];
}): {
	readonly searchDocumentsStream: (query: string) => AsyncGenerator<SearchDocumentsStreamEvent, void, void>;
	readonly setAttachmentContext: (context: string) => void;
	readonly subscribe: (listener: (event: LiveAgentEvent) => void) => () => void;
	readonly abort: () => void;
} {
	const listeners = new Set<(event: LiveAgentEvent) => void>();
	let aborted = false;

	const emitLive = (event: LiveAgentEvent): void => {
		for (const listener of listeners) listener(event);
	};

	return {
		setAttachmentContext: () => undefined,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		abort: () => {
			aborted = true;
		},
		async *searchDocumentsStream(query: string): AsyncGenerator<SearchDocumentsStreamEvent, void, void> {
			aborted = false;
			const sessionId = "skip-index-preview-session";
			const lang = options.language();
			const answer = DEMO_ANSWER[lang];
			const planPath = join(options.fixtureHome, "Documents", SKIP_INDEX_PLAN_FINAL);
			const checklistPath = join(options.fixtureHome, "Documents", SKIP_INDEX_CHECKLIST);

			emitLive({ type: "agent_start" });
			yield { type: "progress", sessionId, query, text: "Reviewing the query." };
			await pause(140);
			if (aborted) return;

			emitLive({ type: "message_start", message: { role: "assistant" } });
			emitLive({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "…" } });
			await pause(180);
			if (aborted) return;

			const chunks = answer.match(/.{1,18}/gsu) ?? [answer];
			for (const chunk of chunks) {
				if (aborted) return;
				emitLive({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: chunk } });
				await pause(32);
			}
			emitLive({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });

			yield {
				type: "complete",
				response: {
					sessionId,
					query,
					answer,
					searched: 4,
					warnings: [],
					diagnostics: [],
					retrievalTrace: [],
					results: [
						{
							number: 1,
							title: SKIP_INDEX_PLAN_FINAL,
							summary: "3분기 마케팅 비용 18% 절감 및 신규 유료 고객 418명 순증 확정",
							source: planPath,
							confidence: 0.96,
							evidence: [
								{
									excerpt: "## 1. 핵심 지표 요약\n- **마케팅 비용**: 채널 효율화로 전분기 대비 **18% 절감**했습니다.\n- **신규 유료 고객**: 3분기 누적 **418명** 순증을 기록했습니다.",
								},
							],
						},
						{
							number: 2,
							title: SKIP_INDEX_CHECKLIST,
							summary: "2026년 11월 18일 정식 출시 일정 및 필수 점검 항목",
							source: checklistPath,
							confidence: 0.93,
							evidence: [
								{
									excerpt: "## 배포 기준일\n- 정식 출시일: **2026년 11월 18일(수) 오전 10:00 KST**\n- 코드 프리즈: 2026년 11월 15일(일) 18:00",
								},
							],
						},
					],
				},
			};
		},
	};
}
