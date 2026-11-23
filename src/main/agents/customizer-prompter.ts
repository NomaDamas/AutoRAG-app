import { randomUUID } from "node:crypto";
import type { AppCustomizerEvent, AppCustomizerPrompt, AppCustomizerPromptAnswer } from "../../shared/app-customizer-contract";

/**
 * How a Settings assistant asks the person for something the model must not handle: a secret typed into a masked field, or a
 * yes/no on an action that changes the machine (run a command, add a server that starts a program).
 *
 * The prompt is an event in the panel; the answer comes back over its own channel to the main process and resolves the tool's
 * promise there. A secret therefore never passes through the model, the chat history, the event stream or the renderer's
 * state beyond the field the person is typing in.
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface SecretPromptInput {
	readonly title: string;
	readonly detail: string;
	readonly hint?: string;
}

export interface ConfirmPromptInput {
	readonly title: string;
	readonly lines: readonly string[];
}

/** A prompt pinned to the run that asked it. */
export interface RunPrompter {
	/** Resolves `{kind:"secret"}` with the typed value, or `{kind:"cancelled"}`. */
	askSecret(input: SecretPromptInput): Promise<Extract<AppCustomizerPromptAnswer, { kind: "secret" | "cancelled" }>>;
	/** Resolves `{kind:"confirm"}` or `{kind:"cancelled"}`. */
	askConfirm(input: ConfirmPromptInput): Promise<Extract<AppCustomizerPromptAnswer, { kind: "confirm" | "cancelled" }>>;
}

export interface CustomizerPrompter {
	forRun(run: { readonly runId: string; readonly sessionId: string }): RunPrompter;
	/** The person's answer; false when the id is unknown, already answered, or the answer is not the kind the prompt asked for. */
	answer(promptId: string, answer: AppCustomizerPromptAnswer): boolean;
	/** The run stopped or ended: every prompt it still has open is closed as cancelled. */
	closeRun(runId: string): void;
}

interface Open {
	readonly runId: string;
	readonly sessionId: string;
	readonly kind: AppCustomizerPrompt["kind"];
	readonly settle: (answer: AppCustomizerPromptAnswer) => void;
}

export function createCustomizerPrompter(deps: {
	readonly send: (event: AppCustomizerEvent) => void;
	readonly timeoutMs?: number;
}): CustomizerPrompter {
	const open = new Map<string, Open>();
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	function ask<K extends AppCustomizerPrompt["kind"]>(
		run: { readonly runId: string; readonly sessionId: string },
		prompt: AppCustomizerPrompt & { readonly kind: K },
	): Promise<AppCustomizerPromptAnswer> {
		const { promise, resolve } = Promise.withResolvers<AppCustomizerPromptAnswer>();
		let done = false;
		const timer = setTimeout(() => finish({ kind: "cancelled" }), timeoutMs);
		function finish(answer: AppCustomizerPromptAnswer): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			open.delete(prompt.id);
			deps.send({ type: "prompt-closed", runId: run.runId, sessionId: run.sessionId, promptId: prompt.id });
			resolve(answer);
		}
		open.set(prompt.id, { runId: run.runId, sessionId: run.sessionId, kind: prompt.kind, settle: finish });
		deps.send({ type: "prompt", runId: run.runId, sessionId: run.sessionId, prompt });
		return promise;
	}

	return {
		forRun: (run) => ({
			askSecret: async (input) => {
				const answer = await ask(run, { kind: "secret", id: randomUUID(), title: input.title, detail: input.detail, ...(input.hint === undefined ? {} : { hint: input.hint }) });
				return answer.kind === "secret" ? answer : { kind: "cancelled" };
			},
			askConfirm: async (input) => {
				const answer = await ask(run, { kind: "confirm", id: randomUUID(), title: input.title, lines: input.lines });
				return answer.kind === "confirm" ? answer : { kind: "cancelled" };
			},
		}),
		answer: (promptId, answer) => {
			const entry = open.get(promptId);
			if (entry === undefined) return false;
			if (answer.kind === "cancelled") {
				entry.settle(answer);
				return true;
			}
			if (answer.kind !== entry.kind) return false;
			if (answer.kind === "secret" && answer.value.trim().length === 0) return false;
			entry.settle(answer);
			return true;
		},
		closeRun: (runId) => {
			for (const entry of [...open.values()]) if (entry.runId === runId) entry.settle({ kind: "cancelled" });
		},
	};
}
