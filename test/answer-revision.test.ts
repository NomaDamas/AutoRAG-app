import { describe, expect, it } from "vitest";
import {
	type AnswerRevision,
	isAnswerChange,
	markRevisedAnswer,
	REVISION_MARK,
	remainderAfterRevised,
	revisedAnswer,
} from "../src/shared/answer-revision";

const first = "- 환불은 팀장 승인이 필요합니다 [1]\n- 한도는 50만 원입니다 [2]\n- 다음 주기에 지급됩니다";

function replace(claimId: string, original: string, replacement: string, reason = "근거 확인"): AnswerRevision {
	return { op: "replace", claimId, original, replacement, reason };
}
function retract(claimId: string, original: string, reason = "근거 없음"): AnswerRevision {
	return { op: "retract", claimId, original, reason };
}
function add(replacement: string, reason = "새 근거"): AnswerRevision {
	return { op: "add", replacement, reason };
}
const confirm = (claimId: string, original: string): AnswerRevision => ({ op: "confirm", claimId, original, reason: "맞음" });

describe("isAnswerChange", () => {
	it("is true for everything but a confirmation, which changes nothing the person reads", () => {
		expect(isAnswerChange(replace("c1", "a", "b"))).toBe(true);
		expect(isAnswerChange(retract("c1", "a"))).toBe(true);
		expect(isAnswerChange(add("a"))).toBe(true);
		expect(isAnswerChange(confirm("c1", "a"))).toBe(false);
	});
});

describe("revisedAnswer (the first answer with its corrections applied)", () => {
	it("replaces a claim where it stands", () => {
		const out = revisedAnswer(first, [replace("c1", "- 환불은 팀장 승인이 필요합니다 [1]", "- 환불은 이사 승인이 필요합니다 [3]")]);
		expect(out).toBe("- 환불은 이사 승인이 필요합니다 [3]\n- 한도는 50만 원입니다 [2]\n- 다음 주기에 지급됩니다");
	});

	it("drops a retracted claim with the whitespace after it, and the one before it when it was last", () => {
		expect(revisedAnswer(first, [retract("c2", "- 한도는 50만 원입니다 [2]")])).toBe("- 환불은 팀장 승인이 필요합니다 [1]\n- 다음 주기에 지급됩니다");
		expect(revisedAnswer(first, [retract("c3", "- 다음 주기에 지급됩니다")])).toBe("- 환불은 팀장 승인이 필요합니다 [1]\n- 한도는 50만 원입니다 [2]");
	});

	it("appends an addition after the answer: one line after a list, a blank line after prose", () => {
		expect(revisedAnswer(first, [add("- 예외는 기록됩니다 [3]")])).toBe(`${first}\n- 예외는 기록됩니다 [3]`);
		expect(revisedAnswer("승인이 필요합니다 [1].", [add("기록됩니다 [2].")])).toBe("승인이 필요합니다 [1].\n\n기록됩니다 [2].");
	});

	it("leaves the answer alone for a confirmation", () => {
		expect(revisedAnswer(first, [confirm("c1", "- 환불은 팀장 승인이 필요합니다 [1]")])).toBe(first);
	});

	it("skips a correction whose original is not in the text, so the result stays what the librarian could not have made", () => {
		expect(revisedAnswer(first, [replace("c1", "- 이 문장은 없습니다 [9]", "- 다른 문장 [3]")])).toBe(first);
	});

	it("applies two corrections to two claims with the same words, one each", () => {
		const twice = "- 같은 문장 [1]\n- 같은 문장 [1]";
		const out = revisedAnswer(twice, [replace("c1", "- 같은 문장 [1]", "- 첫째 [2]"), replace("c2", "- 같은 문장 [1]", "- 둘째 [3]")]);
		expect(out).toBe("- 첫째 [2]\n- 둘째 [3]");
	});

	it("applies a multi-line claim (a code block) as plain text", () => {
		const text = "설명입니다.\n```ts\nconst a = 1;\n```\n끝.";
		const out = revisedAnswer(text, [replace("c2", "```ts\nconst a = 1;\n```", "```ts\nconst a = 2;\n```")]);
		expect(out).toBe("설명입니다.\n```ts\nconst a = 2;\n```\n끝.");
	});
});

describe("remainderAfterRevised (what the librarian's final answer says after the corrected first answer)", () => {
	const revisions = [replace("c1", "- 환불은 팀장 승인이 필요합니다 [1]", "- 환불은 이사 승인이 필요합니다 [3]")];
	const corrected = "- 환불은 이사 승인이 필요합니다 [3]\n- 한도는 50만 원입니다 [2]\n- 다음 주기에 지급됩니다";

	it("is empty when the final answer is the corrected first answer and nothing more", () => {
		expect(remainderAfterRevised(first, revisions, corrected)).toBe("");
	});

	it("is the closing text that follows the corrected first answer", () => {
		expect(remainderAfterRevised(first, revisions, `${corrected}\n\n재무팀 서명도 필요합니다 [4].`)).toBe("재무팀 서명도 필요합니다 [4].");
	});

	it("ignores whitespace differences between the two, since the librarian re-trims the answer", () => {
		expect(remainderAfterRevised(first, revisions, corrected.replace(/\n/gu, "\n\n"))).toBe("");
	});

	it("is null when the final answer does not start with the corrected first answer: the caller then shows it whole", () => {
		expect(remainderAfterRevised(first, revisions, "전혀 다른 답변입니다.")).toBeNull();
		expect(remainderAfterRevised(first, revisions, first)).toBeNull();
	});
});

describe("markRevisedAnswer (the answer to draw: corrections marked in place)", () => {
	const mark = (i: number): string => `${REVISION_MARK}${i}${REVISION_MARK}`;

	it("marks a replaced claim after its bullet and carries the words it struck and the words that replace them", () => {
		const { text, changes } = markRevisedAnswer(first, [replace("c1", "- 환불은 팀장 승인이 필요합니다 [1]", "- 환불은 이사 승인이 필요합니다 [3]", "7월 개정")]);
		expect(text).toBe(`- ${mark(0)}\n- 한도는 50만 원입니다 [2]\n- 다음 주기에 지급됩니다`);
		expect(changes).toEqual([
			{
				kind: "replace",
				claimId: "c1",
				deleted: "환불은 팀장 승인이 필요합니다 [1]",
				inserted: "환불은 이사 승인이 필요합니다 [3]",
				reason: "7월 개정",
			},
		]);
	});

	it("marks a retracted claim and keeps its bullet, so the line can collapse as a whole", () => {
		const { text, changes } = markRevisedAnswer(first, [retract("c2", "- 한도는 50만 원입니다 [2]")]);
		expect(text).toBe(`- 환불은 팀장 승인이 필요합니다 [1]\n- ${mark(0)}\n- 다음 주기에 지급됩니다`);
		expect(changes[0]).toMatchObject({ kind: "retract", deleted: "한도는 50만 원입니다 [2]", inserted: "" });
	});

	it("marks one sentence inside a paragraph without splitting the paragraph", () => {
		const { text } = markRevisedAnswer("앞 문장입니다 [1]. 틀린 문장입니다 [2]. 뒤 문장입니다.", [replace("c2", "틀린 문장입니다 [2].", "맞는 문장입니다 [3].")]);
		expect(text).toBe(`앞 문장입니다 [1]. ${mark(0)} 뒤 문장입니다.`);
	});

	it("appends an addition as a new line that keeps its own bullet", () => {
		const { text, changes } = markRevisedAnswer(first, [add("- 예외는 기록됩니다 [3]")]);
		expect(text).toBe(`${first}\n- ${mark(0)}`);
		expect(changes[0]).toMatchObject({ kind: "add", deleted: "", inserted: "예외는 기록됩니다 [3]" });
	});

	it("numbers the marks in the order the corrections were made", () => {
		const { text, changes } = markRevisedAnswer(first, [retract("c3", "- 다음 주기에 지급됩니다"), replace("c1", "- 환불은 팀장 승인이 필요합니다 [1]", "- 이사 승인 [3]")]);
		expect(changes.map((change) => change.claimId)).toEqual(["c3", "c1"]);
		expect(text).toBe(`- ${mark(1)}\n- 한도는 50만 원입니다 [2]\n- ${mark(0)}`);
	});

	it("writes a multi-line correction into the text and marks nothing: it is told in the details only", () => {
		const text = "설명입니다.\n```ts\nconst a = 1;\n```\n끝.";
		const out = markRevisedAnswer(text, [replace("c2", "```ts\nconst a = 1;\n```", "```ts\nconst a = 2;\n```")]);
		expect(out.text).toBe("설명입니다.\n```ts\nconst a = 2;\n```\n끝.");
		expect(out.changes).toEqual([]);
	});

	it("never marks a confirmation, or a correction whose original is not in the text", () => {
		const out = markRevisedAnswer(first, [confirm("c1", "- 환불은 팀장 승인이 필요합니다 [1]"), replace("c2", "- 없는 문장 [9]", "- 다른 문장")]);
		expect(out.text).toBe(first);
		expect(out.changes).toEqual([]);
	});
});
