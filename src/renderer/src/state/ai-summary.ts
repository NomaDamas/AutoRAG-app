/**
 * The "AI 요약" request: what to send and which attachments to send it with.
 *
 * The main process pastes each attachment's own context in front of the run's
 * first prompt (`src/main/attachment-context.ts`), so the prompt itself stays
 * short. Attaching and sending must happen in one step — {@link summaryRequest}
 * folds the summary attachment into whatever drafts the dock already holds, and
 * the caller hands that merged array to the run, instead of attaching through
 * React state and then sending before the state settles.
 *
 * The prompt follows the app's Interface language setting, so a Korean UI asks
 * in Korean and an English UI asks in English.
 */

import type { ChatAttachment } from "../../../shared/search-contract";
import type { AppSettings } from "../../../shared/settings-contract";
import { mergeAttachments } from "./attachments";

export type SummaryLanguage = AppSettings["language"];

/**
 * The summary wording per language. `file` covers files, links, images, and any
 * mixed set (the attachment context still grounds each item); `folder` is for
 * an all-folder set, whose context is the child listing, so it asks about the
 * contents. Each names the three things a summary is judged on and asks for the
 * source paths as citations.
 */
export const SUMMARY_PROMPTS: Record<SummaryLanguage, { readonly file: string; readonly folder: string }> = {
	ko: {
		file: "첨부한 파일을 요약해줘. 핵심 내용 · 주요 수치 · 주의사항 순으로, 근거가 된 파일 경로를 출처로 인용해줘.",
		folder: "첨부한 폴더의 구성을 요약해줘. 하위 항목의 역할과 눈에 띄는 파일을 근거 경로와 함께 정리해줘.",
	},
	en: {
		file: "Summarize the attached file. Cover the key points, notable figures, and any cautions in that order, and cite the source file paths you relied on.",
		folder: "Summarize the attached folder's structure. Explain what the entries are for and call out the notable files with their source paths.",
	},
	ja: {
		file: "添付したファイルを要約してください。要点・主要な数値・注意事項の順にまとめ、根拠にしたファイルのパスを出典として引用してください。",
		folder: "添付したフォルダの構成を要約してください。中身の役割と目立つファイルを、根拠となるパスとともに整理してください。",
	},
	zh: {
		file: "请总结附件文件。按要点、主要数据、注意事项的顺序整理，并引用作为依据的文件路径作为出处。",
		folder: "请总结附件文件夹的结构。说明各项内容的用途，并结合作为依据的路径列出显著的文件。",
	},
};

/**
 * The summary prompt for a set of attachments in the UI's language. Only an
 * all-folder set gets the folder wording; files, links, images, and any mixed
 * set use the file wording.
 */
export function summaryPrompt(language: SummaryLanguage, atts: readonly ChatAttachment[]): string {
	const wording = SUMMARY_PROMPTS[language];
	return atts.length > 0 && atts.every((att) => att.kind === "folder") ? wording.folder : wording.file;
}

/**
 * The one-shot "AI 요약" payload: the merged attachment list (drafts the dock
 * already holds plus the summary target, deduped by id) and the prompt to run
 * it with. Both are computed together so the attachment is part of the same
 * run as the prompt, never a state update the run can outrace.
 */
export function summaryRequest(
	language: SummaryLanguage,
	current: readonly ChatAttachment[],
	target: readonly ChatAttachment[],
): { readonly prompt: string; readonly attachments: readonly ChatAttachment[] } {
	const attachments = mergeAttachments(current, target);
	return { prompt: summaryPrompt(language, attachments), attachments };
}
