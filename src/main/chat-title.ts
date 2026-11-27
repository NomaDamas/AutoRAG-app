import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProfileModel } from "@autorag/librarian/profiles";
import type { AppSettings } from "../shared/settings-contract";

/**
 * The AI 에이전트 tab's head names its chat: once the first answer is in, the configured answer model reads the first
 * question and the start of that answer and writes a short title in the interface language. Only the model the person
 * configured sees the text, the same one that answered it.
 */

const TITLE_TIMEOUT_MS = 20_000;
const TITLE_MAX_TOKENS = 64;
/** How much of the answer the model reads: enough to know what the chat is about. */
const ANSWER_EXCERPT_CHARS = 1_200;
const TITLE_MAX_CHARS = 40;

const LANGUAGE_INSTRUCTION: Readonly<Record<AppSettings["language"], string>> = {
	ko: "Write the title in natural Korean, at most 20 characters, as a noun phrase (no 요/다 ending).",
	en: "Write the title in natural English, at most 6 words, in sentence case.",
	ja: "Write the title in natural Japanese, at most 20 characters, as a noun phrase.",
	zh: "Write the title in natural Chinese, at most 16 characters, as a noun phrase.",
};

export interface ChatTitlerDeps {
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly complete: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
	readonly language: () => AppSettings["language"];
	readonly now?: () => number;
}

export function titlePrompt(question: string, answer: string, language: AppSettings["language"]): string {
	return [
		"Name this conversation for the header of a chat window, the way a chat app titles a thread.",
		"Say what the person is after, not how they asked. Never quote the question whole, never add quotes, emoji, or a trailing period.",
		LANGUAGE_INSTRUCTION[language],
		"Reply with the title only, on one line.",
		"",
		"Question:",
		question,
		"",
		"Start of the answer:",
		answer.slice(0, ANSWER_EXCERPT_CHARS),
	].join("\n");
}

/** The model's reply as a title: its first non-empty line without quotes or a closing period, or null when nothing is left. */
export function parseTitle(reply: string): string | null {
	const line = reply
		.split(/\r?\n/u)
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	if (line === undefined) return null;
	const cleaned = line
		.replace(/^(title|제목|タイトル|标题)\s*[:：]\s*/iu, "")
		.replace(/^["'“”‘’「」『』*#\s]+|["'“”‘’「」『』*.。\s]+$/gu, "")
		.trim();
	if (cleaned.length === 0) return null;
	return cleaned.length <= TITLE_MAX_CHARS ? cleaned : `${cleaned.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

function replyText(reply: AssistantMessage): string {
	return reply.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** A function that titles a chat from its first question and answer; it resolves null instead of throwing. */
export function createChatTitler(deps: ChatTitlerDeps): (question: string, answer: string) => Promise<string | null> {
	const now = deps.now ?? Date.now;
	return async (question, answer) => {
		try {
			const resolved = await deps.resolveModel();
			const apiKey = resolved.apiKey ?? resolved.providerApiKeys?.[resolved.model.provider];
			const reply = await deps.complete(
				resolved.model,
				{ messages: [{ role: "user", content: titlePrompt(question, answer, deps.language()), timestamp: now() }] },
				{ ...(apiKey === undefined ? {} : { apiKey }), maxTokens: TITLE_MAX_TOKENS, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
			);
			return parseTitle(replyText(reply));
		} catch {
			return null;
		}
	};
}
