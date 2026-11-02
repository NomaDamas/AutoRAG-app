import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TProperties } from "typebox";
import type { AppSettings } from "../../shared/settings-contract";

/**
 * Live intent progress for every pi helper-agent profile (`smart-indexing`,
 * `error-fix`, and any profile added later), mirroring AutoRAG's own `i`
 * intent-tracing field:
 *
 * - Every working tool declares `i` first in its schema, so the model generates
 *   a short phrase in the user's interface language saying what that call is
 *   doing before the rest of the arguments stream.
 * - `prepareArguments` fills in `""` when a scripted test call omits `i`, and
 *   `execute` removes `i` before the tool's own handler runs.
 * - `subscribeProfileProgress` streams each completed `i` (with a fallback to a
 *   short pre-tool assistant note) so the renderer can show it with the text
 *   shimmer effect instead of static fixed text.
 */

export type ReplyLanguage = AppSettings["language"];

export const INTENT_FIELD = "i";
const MAX_INTENT_LENGTH = 120;

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

/** Checks whether `"i": "..."` has closed its string literal inside streaming JSON. */
const CLOSED_INTENT_STRING = /"i"\s*:\s*"(?:[^"\\]|\\.)*"/u;

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function normalizeIntent(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value
		.replace(/\s+/gu, " ")
		.trim()
		.replace(/\s*[.。]+$/u, "")
		.trim();
	return text === "" || text.length > MAX_INTENT_LENGTH ? undefined : text;
}

function intentDescription(language: ReplyLanguage): string {
	return `One short plain phrase in ${LANGUAGE_NAME[language]} saying what you are checking or doing right now (shown to the user as live progress; no file paths, commands or jargon).`;
}

export function intentPromptLine(language: ReplyLanguage): string {
	return `Every tool takes a short \`${INTENT_FIELD}\` argument first: one short plain phrase in ${LANGUAGE_NAME[language]} saying what you are checking or doing right now (no file paths, shell commands or jargon). It is shown to the person as live progress, so do not write separate progress notes.`;
}

export interface WithIntentToolsOptions {
	readonly language: ReplyLanguage;
	/** Answer-only tools that end the run and need no live progress phrase. */
	readonly exclude?: readonly string[];
}

export function withIntentTools(tools: readonly ToolDefinition[], options: WithIntentToolsOptions): readonly ToolDefinition[] {
	const excluded = new Set(options.exclude ?? []);
	const description = intentDescription(options.language);

	return tools.map((tool) => {
		if (excluded.has(tool.name)) return tool;
		const schemaRecord = recordOf(tool.parameters);
		const existing = recordOf(schemaRecord?.properties) as TProperties | undefined;
		if (existing === undefined || INTENT_FIELD in existing) return tool;

		const parameters = Type.Object({
			[INTENT_FIELD]: Type.String({ description }),
			...existing,
		});
		const innerPrepare = tool.prepareArguments;
		const innerExecute = tool.execute as (...args: unknown[]) => Promise<unknown>;

		return {
			...tool,
			parameters,
			prepareArguments: (raw: unknown) => {
				const prepared = innerPrepare ? innerPrepare(raw) : raw;
				const obj = recordOf(prepared);
				if (obj === undefined || typeof obj[INTENT_FIELD] === "string") return prepared;
				return { ...obj, [INTENT_FIELD]: "" };
			},
			execute: async (...args: unknown[]) => {
				const params = recordOf(args[1]);
				if (params !== undefined && INTENT_FIELD in params) {
					const { [INTENT_FIELD]: _intent, ...rest } = params;
					const next = [...args];
					next[1] = rest;
					return innerExecute(...next);
				}
				return innerExecute(...args);
			},
		} as unknown as ToolDefinition;
	});
}

function intentFromMessage(message: unknown, streaming: boolean): string | undefined {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return undefined;
	for (let index = msg.content.length - 1; index >= 0; index -= 1) {
		const block = recordOf(msg.content[index]);
		if (block?.type !== "toolCall") continue;
		if (streaming && typeof block.partialJson === "string" && !CLOSED_INTENT_STRING.test(block.partialJson)) continue;
		const intent = normalizeIntent(recordOf(block.arguments)?.[INTENT_FIELD]);
		if (intent !== undefined) return intent;
	}
	if (!streaming && msg.stopReason === "toolUse") {
		const note = msg.content
			.map((entry) => recordOf(entry))
			.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
			.map((entry) => entry?.text as string)
			.join(" ");
		if (!note.includes("\n")) return normalizeIntent(note);
	}
	return undefined;
}

/** Streams live progress phrases from a pi profile session to `onProgress`. */
export function subscribeProfileProgress(session: AgentSession, onProgress: (text: string) => void): () => void {
	let lastShown: string | undefined;
	const emit = (candidate: string | undefined): void => {
		if (candidate === undefined || candidate === lastShown) return;
		lastShown = candidate;
		onProgress(candidate);
	};

	return session.subscribe((event) => {
		if (event.type === "message_update") {
			emit(intentFromMessage(event.message, true));
			return;
		}
		if (event.type === "message_end") {
			emit(intentFromMessage(event.message, false));
			return;
		}
		if (event.type === "tool_execution_start") {
			emit(normalizeIntent(recordOf(event.args)?.[INTENT_FIELD]));
		}
	});
}
