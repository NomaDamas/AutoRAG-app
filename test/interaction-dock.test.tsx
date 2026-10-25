// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractionDock } from "../src/renderer/src/components/InteractionDock";
import type { ApprovalRequest, InteractionRequest, Question, QuestionRequest } from "../src/shared/interaction-contract";
import { setAppLanguage, t } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const answer = vi.fn(async () => true);
let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("ko");
	answer.mockClear();
	Reflect.set(globalThis, "autorag", { interaction: { answer } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	Reflect.deleteProperty(globalThis, "autorag");
});

function render(request: InteractionRequest): void {
	act(() => root.render(<InteractionDock request={request} onStop={() => undefined} />));
}

const question = (patch: Partial<Question> = {}): Question => ({ question: "Which?", options: [], allowMultiple: false, allowFreeform: true, ...patch });

const questionRequest = (questions: readonly Question[], patch: Partial<QuestionRequest> = {}): QuestionRequest => ({
	kind: "question",
	id: "q1",
	searchId: "s1",
	questions,
	...patch,
});

const approvalRequest = (patch: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
	kind: "approval",
	id: "a1",
	searchId: "s1",
	reason: "",
	categories: [],
	call: "rm -rf build",
	sessionScope: "all",
	...patch,
});

function buttonByText(label: string): HTMLButtonElement {
	const found = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
	if (found === undefined) throw new Error(`no button labelled ${label}`);
	return found as HTMLButtonElement;
}

function options(role: "radio" | "checkbox"): HTMLButtonElement[] {
	return [...host.querySelectorAll<HTMLButtonElement>(`button[role="${role}"]`)];
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
	});
}

/** Type into a controlled field the way React reads it: through the native value setter plus an input event. */
function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(el, value);
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("InteractionDock question card", () => {
	it("submits a single-choice question as soon as an option is picked", () => {
		render(
			questionRequest([
				question({ question: "Which plan?", options: [{ title: "Free" }, { title: "Pro" }], allowFreeform: false }),
			]),
		);

		act(() => options("radio")[1]?.click());

		expect(answer).toHaveBeenCalledTimes(1);
		expect(answer).toHaveBeenCalledWith("q1", { kind: "question", answers: [{ kind: "selection", selections: ["Pro"] }] });
	});

	it("keeps a multiple-choice question open until Submit and sends the picks in option order", () => {
		render(
			questionRequest([
				question({ options: [{ title: "A" }, { title: "B" }, { title: "C" }], allowMultiple: true, allowFreeform: false }),
			]),
		);

		const submit = buttonByText(t("interaction.submit"));
		expect(submit.disabled).toBe(true);

		act(() => options("checkbox")[2]?.click());
		act(() => options("checkbox")[0]?.click());
		expect(buttonByText(t("interaction.submit")).disabled).toBe(false);
		expect(answer).not.toHaveBeenCalled();

		act(() => buttonByText(t("interaction.submit")).click());
		expect(answer).toHaveBeenCalledWith("q1", { kind: "question", answers: [{ kind: "selection", selections: ["A", "C"] }] });
	});

	it("never sends an empty freeform text and ignores an IME-composing Enter", () => {
		render(questionRequest([question({ options: [] })]));
		expect(answer).not.toHaveBeenCalled();

		const textarea = host.querySelector("textarea");
		expect(textarea).not.toBeNull();

		act(() => setField(textarea!, "   "));
		press(textarea!, "Enter");
		expect(answer).not.toHaveBeenCalled();

		act(() => setField(textarea!, "  use the June plan  "));
		press(textarea!, "Enter", { isComposing: true });
		expect(answer).not.toHaveBeenCalled();

		press(textarea!, "Enter");
		expect(answer).toHaveBeenCalledWith("q1", { kind: "question", answers: [{ kind: "freeform", text: "use the June plan" }] });
	});

	it("steps through a batch and sends ordered answers with null for the skipped question", () => {
		render(
			questionRequest([
				question({ question: "One?", options: [{ title: "a" }], allowFreeform: false }),
				question({ question: "Two?", options: [{ title: "b" }], allowFreeform: false }),
				question({ question: "Three?", options: [{ title: "c" }], allowFreeform: false }),
			]),
		);

		act(() => options("radio")[0]?.click());
		act(() => buttonByText(t("interaction.next")).click());
		expect(host.textContent).toContain(t("interaction.step", { current: 2, total: 3 }));
		expect(host.textContent).toContain(t("interaction.answeredCount", { answered: 1, total: 3 }));
		act(() => buttonByText(t("interaction.next")).click());
		act(() => options("radio")[0]?.click());
		act(() => buttonByText(t("interaction.submit")).click());

		expect(answer).toHaveBeenCalledWith("q1", {
			kind: "question",
			answers: [{ kind: "selection", selections: ["a"] }, null, { kind: "selection", selections: ["c"] }],
		});
	});

	it("cancels the question on Escape instead of stopping the run", () => {
		const stop = vi.fn();
		act(() => root.render(<InteractionDock request={questionRequest([question({ options: [{ title: "A" }] })])} onStop={stop} />));

		press(document.body, "Escape");

		expect(answer).toHaveBeenCalledWith("q1", { kind: "cancel" });
		expect(stop).not.toHaveBeenCalled();
	});
});

describe("InteractionDock approval card", () => {
	it("uses the ask-mode headline and hides the tool-name reason when nothing was classified", () => {
		render(approvalRequest({ sessionScope: "all", reason: "shell" }));
		expect(host.textContent).toContain(t("interaction.approval.headlineRun"));
		expect(host.textContent).not.toContain("shell");
	});

	it("shows the change headline, the category chips, the call and the judgement reason", () => {
		render(
			approvalRequest({
				sessionScope: "categories",
				categories: ["delete", "rename"],
				call: "rm -rf build",
				reason: "removes the build output",
			}),
		);
		expect(host.textContent).toContain(t("interaction.approval.headlineChange"));
		expect(host.textContent).toContain(t("interaction.category.delete"));
		expect(host.textContent).toContain(t("interaction.category.rename"));
		expect(host.querySelector("pre")?.textContent).toBe("rm -rf build");
		expect(host.textContent).toContain("removes the build output");
		expect(host.textContent).toContain(t("interaction.allowSession.categories"));
	});

	it("does not approve on a stray Enter, but approves an explicit click on Allow once", () => {
		render(approvalRequest({ sessionScope: "categories", categories: ["edit"] }));
		const card = host.querySelector('[role="alertdialog"]');
		expect(card).not.toBeNull();

		press(card!, "Enter");
		expect(answer).not.toHaveBeenCalled();

		act(() => buttonByText(t("interaction.allowOnce")).click());
		expect(answer).toHaveBeenCalledWith("a1", { kind: "approval", choice: "allow-once" });
	});

	it("focuses Deny first, so the approving buttons need a deliberate click", () => {
		render(approvalRequest({ sessionScope: "categories", categories: ["edit"] }));
		expect(document.activeElement).toBe(buttonByText(t("interaction.deny")));
	});

	it("denies on Escape", () => {
		render(approvalRequest({ sessionScope: "categories", categories: ["edit"] }));
		press(document.body, "Escape");
		expect(answer).toHaveBeenCalledWith("a1", { kind: "approval", choice: "deny" });
	});

	it("sends a trimmed note with 'Deny and tell the model'", () => {
		render(approvalRequest({ sessionScope: "categories", categories: ["overwrite"] }));
		act(() => buttonByText(t("interaction.denyWithNote")).click());

		const input = host.querySelector("input");
		expect(input).not.toBeNull();
		act(() => setField(input!, "  work on a copy  "));

		act(() => {
			host.querySelector<HTMLButtonElement>(`button[aria-label="${t("interaction.sendNote")}"]`)?.click();
		});
		expect(answer).toHaveBeenCalledWith("a1", { kind: "approval", choice: "deny-with-note", note: "work on a copy" });
	});
});
