import type { AutoRAGAgentOptions } from "@autorag/librarian";
import { Type } from "typebox";
import type { Question, QuestionAnswer, QuestionOption } from "../shared/interaction-contract";
import type { RunInteraction } from "./host-ui";

/**
 * `ask_user`: the agent stops and asks the person, instead of guessing.
 *
 * The librarian ships this tool for its terminal UI (the community `pi-ask-user` extension), which draws a
 * terminal component the app has no way to show. The system prompt the librarian builds already tells the
 * model how to use a tool of this name (`ask_user` among the tool names), so the app registers its own with the
 * same name and parameter shape, and the question opens in the AI Search panel instead.
 *
 * The result text follows `pi-ask-user`'s (`User answered: ...`, `User cancelled the question`), because those
 * are the words the model has seen.
 */

export const ASK_USER_TOOL_NAME = "ask_user";

type AgentTool = NonNullable<AutoRAGAgentOptions["tools"]>[number];

const BATCH_MIN = 2;
const BATCH_MAX = 4;
const OPTION_TITLE_KEYS = ["title", "label", "text", "value", "name", "option"] as const;
const ENTRY_FIELDS = ["context", "options", "allowMultiple", "allowFreeform"] as const;

const optionSchema = Type.Object({
	title: Type.String({ description: "Short title for this option" }),
	description: Type.Optional(Type.String({ description: "Longer description explaining this option" })),
});

const parameters = Type.Object({
	question: Type.Optional(
		Type.String({
			description:
				"The question to ask the user. With questions, it is only an optional heading for the batch; put every actual question inside questions.",
		}),
	),
	questions: Type.Optional(
		Type.Array(
			Type.Object({
				question: Type.String({ description: "One question in the batch" }),
				context: Type.Optional(Type.String({ description: "Relevant context to show with this question (summary of findings)" })),
				options: Type.Optional(Type.Array(optionSchema, { description: "List of options for this question" })),
				allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
				allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
			}),
			{
				minItems: BATCH_MIN,
				maxItems: BATCH_MAX,
				description:
					"2-4 independent questions shown together, used instead of question. Set context, options, allowMultiple, and allowFreeform on each entry; the remaining parameters apply to the whole batch.",
			},
		),
	),
	context: Type.Optional(Type.String({ description: "Relevant context to show before the question (summary of findings)" })),
	options: Type.Optional(Type.Array(optionSchema, { description: "List of options for the user to choose from" })),
	allowMultiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options. Default: false" })),
	allowFreeform: Type.Optional(Type.Boolean({ description: "Add a freeform text option. Default: true" })),
	timeout: Type.Optional(Type.Number({ description: "Milliseconds after which the question closes unanswered. Default: wait for the user." })),
});

function coerceOption(option: unknown): QuestionOption | null {
	if (typeof option === "string" || typeof option === "number" || typeof option === "boolean") {
		const title = String(option).trim();
		return title === "" ? null : { title };
	}
	if (typeof option !== "object" || option === null) return null;
	const record: Record<string, unknown> = { ...option };
	for (const key of OPTION_TITLE_KEYS) {
		const value = record[key];
		if (typeof value !== "string" || value.trim() === "") continue;
		const description = record.description;
		return typeof description === "string" && description.trim() !== ""
			? { title: value.trim(), description }
			: { title: value.trim() };
	}
	return null;
}

function normalizeOptions(raw: unknown, label: string): QuestionOption[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error(`${label}options must be an array.`);
	const options = raw.map(coerceOption).filter((option): option is QuestionOption => option !== null);
	if (raw.length > 0 && options.length === 0) {
		throw new Error(
			`All ${raw.length} option(s) in ${label === "" ? "the call" : label.replace(/\.$/u, "")} were malformed, so nothing could be shown to the user. ` +
				`Each option must be a plain string or an object like { "title": "Short label", "description": "Optional detail" }. ` +
				`Call ask_user again with corrected options.`,
		);
	}
	return options;
}

type Fields = Readonly<Record<string, unknown>>;

/** The call's arguments as an object; pi checks them against the schema first, but a hand-made call may not match it. */
function fields(value: unknown): Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

function trimmed(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toQuestion(entry: Fields, label: string): Question {
	const prefix = label === "" ? "" : `${label}.`;
	const question = trimmed(entry.question);
	if (question === "") throw new Error(`${prefix}question must be a non-empty string.`);
	const options = normalizeOptions(entry.options, prefix);
	const context = trimmed(entry.context);
	return {
		question,
		...(context === "" ? {} : { context }),
		options,
		allowMultiple: flag(entry.allowMultiple, false),
		// A question with no options can only be answered in words.
		allowFreeform: options.length === 0 ? true : flag(entry.allowFreeform, true),
	};
}

interface Asked {
	readonly heading?: string;
	readonly questions: readonly Question[];
	readonly batch: boolean;
}

function normalize(params: Fields): Asked {
	const entries = params.questions;
	if (entries === undefined || entries === null) {
		return { questions: [toQuestion(params, "")], batch: false };
	}
	const misplaced = ENTRY_FIELDS.filter((field) => params[field] !== undefined && params[field] !== null);
	if (misplaced.length > 0) {
		throw new Error(`${misplaced.join(", ")} cannot be set at the top level together with questions. Set them on each questions entry instead.`);
	}
	if (!Array.isArray(entries)) throw new Error(`questions must be an array of ${BATCH_MIN}-${BATCH_MAX} question objects.`);
	if (entries.length < BATCH_MIN) {
		throw new Error(`questions needs ${BATCH_MIN}-${BATCH_MAX} entries but got ${entries.length}. To ask one question, use question instead.`);
	}
	if (entries.length > BATCH_MAX) {
		throw new Error(`questions accepts at most ${BATCH_MAX} entries but got ${entries.length}. Ask the rest in a later ask_user call.`);
	}
	const seen = new Set<string>();
	const questions = entries.map((entry: unknown, index) => {
		const question = toQuestion(fields(entry), `questions[${index}]`);
		const key = question.question.toLowerCase();
		if (seen.has(key)) throw new Error(`questions[${index}] repeats the question "${question.question}". Each question in a batch must be distinct.`);
		seen.add(key);
		return question;
	});
	const heading = trimmed(params.question);
	return { ...(heading === "" ? {} : { heading }), questions, batch: true };
}

function summary(answer: QuestionAnswer): string {
	return answer.kind === "freeform" ? answer.text : answer.selections.join(", ");
}

export function createAskUserTool(current: () => RunInteraction | undefined): AgentTool {
	return {
		name: ASK_USER_TOOL_NAME,
		label: "Ask User",
		description:
			"Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask one focused question per call, or 2-4 independent questions together through questions. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
		parameters,
		// The model must not run other tool calls of the same turn (a shell command, a file edit) before the person has answered.
		executionMode: "sequential",
		execute: async (_toolCallId, input, signal) => {
			const params = fields(input);
			const asked = normalize(params);
			const run = current();
			if (run === undefined) {
				throw new Error("ask_user cannot reach anybody: nobody is there to answer in this run. Decide yourself from what you know, and say what you assumed.");
			}
			const timeout = typeof params.timeout === "number" ? params.timeout : 0;
			const deadline = timeout > 0 ? AbortSignal.timeout(timeout) : undefined;
			const stop = signal !== undefined && deadline !== undefined ? AbortSignal.any([signal, deadline]) : (signal ?? deadline);
			const answer = await run.open(
				{ kind: "question", ...(asked.heading === undefined ? {} : { heading: asked.heading }), questions: asked.questions },
				stop,
			);
			const cancelled = asked.batch ? "User cancelled the questions" : "User cancelled the question";
			const text = (body: string) => ({ content: [{ type: "text" as const, text: body }], details: undefined });
			if (answer.kind !== "question" || stop?.aborted === true) return text(cancelled);
			if (!asked.batch) {
				const first = answer.answers[0];
				return text(first === null || first === undefined ? cancelled : `User answered: ${summary(first)}`);
			}
			const answered = answer.answers.filter((item) => item !== null).length;
			const lines = asked.questions.map((question, index) => {
				const item = answer.answers[index];
				return `${index + 1}. ${question.question} → ${item === null || item === undefined ? "(skipped)" : summary(item)}`;
			});
			return text(
				[...(asked.heading === undefined ? [] : [asked.heading]), `User answered ${answered} of ${asked.questions.length} questions:`, ...lines].join("\n"),
			);
		},
	};
}
