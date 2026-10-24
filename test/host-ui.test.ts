import { describe, expect, it } from "vitest";
import { createHostUi, parseApprovalDialog, type RunInteraction } from "../src/main/host-ui";
import type { InteractionAnswer } from "../src/shared/interaction-contract";

// The dialog the librarian's file-change gate shows (src/agent/permission-gate.ts, v2.12.0): a title and four fixed choices.
const ALLOW_ONCE = "Allow once";
const DENY = "Deny";
const DENY_WITH_NOTE = "Deny and tell the model what to do instead";

const autoTitle = [
	"Jev declined to approve this automatically (the request names a different file). Approve it yourself?",
	"    delete, move",
	"    $ rm /Users/me/Downloads/old.pdf",
].join("\n");
const autoOptions = [ALLOW_ONCE, "Allow all delete/move operations this session", DENY, DENY_WITH_NOTE];

describe("parseApprovalDialog", () => {
	it("reads Jev's reason, the categories, the call, and what a session grant covers", () => {
		expect(parseApprovalDialog(autoTitle, autoOptions)).toEqual({
			kind: "approval",
			reason: "the request names a different file",
			categories: ["delete", "move"],
			call: "rm /Users/me/Downloads/old.pdf",
			sessionScope: "categories",
		});
	});

	it("reads the ask-mode dialog: no categories, every call, and the tool only named in the heading", () => {
		const title = ["Approve this bash call?", "    $ ls -la"].join("\n");
		expect(parseApprovalDialog(title, [ALLOW_ONCE, "Allow all such calls this session", DENY, DENY_WITH_NOTE])).toEqual({
			kind: "approval",
			reason: "",
			categories: [],
			call: "ls -la",
			sessionScope: "all",
		});
	});

	it("reads the dialog for a call Jev could not classify", () => {
		const title = [
			"Jev could not classify this call (Jev is not configured), so it needs your approval. It may change your files.",
			"    unclassified",
			"    $ make clean",
		].join("\n");
		expect(parseApprovalDialog(title, [ALLOW_ONCE, "Allow all unclassified calls this session", DENY, DENY_WITH_NOTE])).toEqual({
			kind: "approval",
			reason: "Jev is not configured",
			categories: [],
			call: "make clean",
			sessionScope: "unclassified",
		});
	});

	it("keeps a multi-line command whole", () => {
		const title = ["Approve this bash call?", "    $ cd /tmp && \\", "  rm -rf build"].join("\n");
		expect(parseApprovalDialog(title, [ALLOW_ONCE, "Allow all such calls this session", DENY, DENY_WITH_NOTE])?.call).toBe(
			"cd /tmp && \\\n  rm -rf build",
		);
	});

	it("is not an approval when the choices are not the gate's", () => {
		expect(parseApprovalDialog("Pick one", ["A", "B"])).toBeNull();
		expect(parseApprovalDialog("Approve this bash call?", [ALLOW_ONCE, "x", "Nope", DENY_WITH_NOTE])).toBeNull();
	});
});

function run(answers: InteractionAnswer[]): { run: RunInteraction; opened: Parameters<RunInteraction["open"]>[0][] } {
	const opened: Parameters<RunInteraction["open"]>[0][] = [];
	return {
		opened,
		run: {
			open: async (body) => {
				opened.push(body);
				return answers.shift() ?? { kind: "cancel" };
			},
		},
	};
}

describe("host UI for the pi session", () => {
	it("maps each approval button to the choice string the gate compares against", async () => {
		const table: [InteractionAnswer, string | undefined][] = [
			[{ kind: "approval", choice: "allow-once" }, ALLOW_ONCE],
			[{ kind: "approval", choice: "allow-session" }, autoOptions[1]],
			[{ kind: "approval", choice: "deny" }, DENY],
			[{ kind: "approval", choice: "deny-with-note", note: "copy it" }, DENY_WITH_NOTE],
			// Dismissed: no choice at all, which the gate treats as a denial.
			[{ kind: "cancel" }, undefined],
		];
		for (const [answer, expected] of table) {
			const { run: bound } = run([answer]);
			const ui = createHostUi(() => bound);
			expect(await ui.select(autoTitle, autoOptions)).toBe(expected);
		}
	});

	it("hands the denial note to the follow-up input the gate asks for", async () => {
		const { run: bound } = run([{ kind: "approval", choice: "deny-with-note", note: "  work on a copy  " }]);
		const ui = createHostUi(() => bound);
		expect(await ui.select(autoTitle, autoOptions)).toBe(DENY_WITH_NOTE);
		expect(await ui.input("What should the model do instead?", "e.g. work on a copy")).toBe("  work on a copy  ");
		// The note is spent: a later input is a real question again.
		const { run: next, opened } = run([{ kind: "question", answers: [{ kind: "freeform", text: "Ada" }] }]);
		const later = createHostUi(() => next);
		expect(await later.input("Name?")).toBe("Ada");
		expect(opened).toHaveLength(1);
	});

	it("shows any other select as a single-choice question and returns the chosen title", async () => {
		const { run: bound, opened } = run([{ kind: "question", answers: [{ kind: "selection", selections: ["B"] }] }]);
		const ui = createHostUi(() => bound);
		expect(await ui.select("Pick one", ["A", "B"])).toBe("B");
		expect(opened).toEqual([
			{
				kind: "question",
				questions: [{ question: "Pick one", options: [{ title: "A" }, { title: "B" }], allowMultiple: false, allowFreeform: false }],
			},
		]);
	});

	it("shows an input as a text question and returns what was written, undefined when dismissed or skipped", async () => {
		const { run: bound } = run([
			{ kind: "question", answers: [{ kind: "freeform", text: "hello" }] },
			{ kind: "cancel" },
			{ kind: "question", answers: [null] },
		]);
		const ui = createHostUi(() => bound);
		expect(await ui.input("Say something")).toBe("hello");
		expect(await ui.input("Say something")).toBeUndefined();
		expect(await ui.input("Say something")).toBeUndefined();
	});

	it("has nobody to ask when no run is bound: dialogs come back empty rather than hanging", async () => {
		const ui = createHostUi(() => undefined);
		expect(await ui.select(autoTitle, autoOptions)).toBeUndefined();
		expect(await ui.input("Say something")).toBeUndefined();
		expect(await ui.confirm("Sure?", "really")).toBe(false);
	});

	it("passes the dialog's abort signal on, so Stop closes the question", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const bound: RunInteraction = {
			open: async (_body, signal) => {
				signals.push(signal);
				return { kind: "cancel" };
			},
		};
		const ui = createHostUi(() => bound);
		const controller = new AbortController();
		await ui.select("Pick", ["A"], { signal: controller.signal });
		expect(signals[0]).toBe(controller.signal);
	});

	it("ignores the terminal-only surface instead of throwing", () => {
		const ui = createHostUi(() => undefined);
		expect(() => {
			ui.notify("hi", "info");
			ui.setStatus("k", "v");
			ui.setWidget("w", undefined);
			ui.setWorkingMessage("x");
			ui.setTitle("t");
		}).not.toThrow();
		expect(ui.onTerminalInput(() => undefined)).toBeTypeOf("function");
		expect(ui.getEditorText()).toBe("");
	});
});
