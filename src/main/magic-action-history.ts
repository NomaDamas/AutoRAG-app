import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { MagicActionSaveRequest } from "../shared/magic-actions-contract";
import type { ChatAttachment, ChatRecord } from "../shared/search-contract";
import type { ChatStore } from "./chat-store";

/**
 * 대화 기록에 저장 (Figma 568:7807): a finished magic action becomes a chat of its own in AI 에이전트's history. The
 * action's name is the question, the files it ran on are its attachments, and its output is the answer, so the
 * conversation reads like one the person had. The chat has no model session behind it; a follow-up starts one.
 */
export async function saveMagicActionToHistory(
	chatStore: ChatStore,
	request: MagicActionSaveRequest,
	now: () => Date = () => new Date(),
): Promise<string> {
	const id = randomUUID();
	const at = now().toISOString();
	const attachments = await Promise.all(request.paths.map(attachmentFor));
	const record: ChatRecord = {
		id,
		title: request.actionLabel,
		snippet: "",
		updatedAt: at,
		messages: [
			{ role: "user", text: request.actionLabel, attachments, at },
			{ role: "assistant", sessionId: "", quick: { answer: request.output, evidence: [] }, deep: null, stopped: false, at },
		],
	};
	await chatStore.save(record);
	return id;
}

async function attachmentFor(path: string): Promise<ChatAttachment> {
	const kind = await stat(path).then(
		(info) => (info.isDirectory() ? "folder" : "file"),
		() => "file" as const,
	);
	return { kind, id: path, name: basename(path) };
}
