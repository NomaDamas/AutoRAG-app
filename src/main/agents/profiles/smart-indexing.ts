import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppSettings } from "../../../shared/settings-contract";
import { DEFAULT_CODE_FOLDER_NAMES } from "../../../shared/settings-contract";
import type { AgentProfile } from "../agent-factory";

/**
 * The smart-indexing helper: before the first index it looks through the folders
 * the user chose and proposes the sub-folders that are not worth indexing, such
 * as app and system data, logs, source code and its build output, recordings
 * and caches. It reads and lists but cannot write, and it answers only through
 * the `propose_exclusions` tool, which checks every path against the real disk
 * so a hallucinated or out-of-scope folder never reaches the user.
 */

export type ReplyLanguage = AppSettings["language"];

/** A folder the agent proposes to leave out, attributed to the selected folder it lies under. */
export interface ExclusionProposal {
	readonly path: string;
	readonly root: string;
	readonly reason: string;
}

export interface ProposalEntry {
	readonly path: string;
	readonly reason: string;
}

export interface ProposalOutcome {
	readonly accepted: readonly string[];
	/** Each refused path with the reason the model is told, in English. */
	readonly rejected: readonly { readonly path: string; readonly why: string }[];
}

export interface ProposalCollector {
	/** Checks and records entries; the outcome is what the model gets back. */
	propose(entries: readonly ProposalEntry[]): Promise<ProposalOutcome>;
	proposals(): readonly ExclusionProposal[];
	/** The agent called the tool at least once: an empty {@link proposals} then means "nothing to exclude", not "no answer". */
	answered(): boolean;
	readonly tool: ToolDefinition;
}

/** `path` lies strictly below `root` (not the root itself, not a sibling). */
function isBelow(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function createProposalCollector(roots: readonly string[]): ProposalCollector {
	const selected = roots.map((root) => resolve(root));
	let kept: ExclusionProposal[] = [];
	let called = false;

	/** Why `entry` cannot be recorded, or null when it can. */
	async function refusal(entry: ProposalEntry): Promise<string | null> {
		if (!isAbsolute(entry.path)) return "the path must be absolute";
		if (entry.reason.trim() === "") return "give a one-sentence reason";
		const path = resolve(entry.path);
		if (selected.includes(path)) return "this is a selected folder itself; propose a folder inside it";
		if (!selected.some((root) => isBelow(root, path))) return "the path is outside the selected folders";
		const covering = kept.find((proposal) => proposal.path === path || isBelow(proposal.path, path));
		if (covering !== undefined) return `already covered by the proposal for ${covering.path}`;
		try {
			// lstat: a symbolic link is never followed out of the selected folders.
			if (!(await lstat(path)).isDirectory()) return "this is not a folder (a file or a symbolic link)";
		} catch {
			return "this folder does not exist";
		}
		return null;
	}

	async function propose(entries: readonly ProposalEntry[]): Promise<ProposalOutcome> {
		const accepted: string[] = [];
		const rejected: { path: string; why: string }[] = [];
		for (const entry of entries) {
			const why = await refusal(entry);
			if (why !== null) {
				rejected.push({ path: entry.path, why });
				continue;
			}
			const path = resolve(entry.path);
			const root = selected.find((candidate) => isBelow(candidate, path)) as string;
			// A folder that swallows ones proposed earlier replaces them.
			kept = [...kept.filter((proposal) => !isBelow(path, proposal.path)), { path, root, reason: entry.reason.trim() }];
			accepted.push(path);
		}
		return { accepted, rejected };
	}

	const tool = defineTool({
		name: "propose_exclusions",
		label: "Propose exclusions",
		description:
			"Report the folders that should be left out of the index. Call it once, after exploring, with every folder; an empty list means nothing needs excluding. " +
			"Each path must be an existing folder strictly inside one of the selected folders. Refused paths come back with the reason, and you may call again to correct them.",
		parameters: Type.Object({
			exclusions: Type.Array(
				Type.Object({
					path: Type.String({ description: "Absolute path of the folder to leave out." }),
					reason: Type.String({ description: "One short sentence saying why it is not worth indexing." }),
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			called = true;
			const outcome = await propose(params.exclusions);
			const lines = [
				...outcome.accepted.map((path) => `Recorded: ${path}`),
				...outcome.rejected.map((entry) => `Refused: ${entry.path} (${entry.why})`),
				`${kept.length} folder(s) recorded in total.`,
			];
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	return { propose, proposals: () => kept, answered: () => called, tool };
}

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

/** The agent's whole instruction; `roots` are the folders the user selected. */
export function smartIndexingPrompt(roots: readonly string[], language: ReplyLanguage, extensions: readonly string[]): string {
	return [
		"You help a person decide what their personal document search should cover.",
		"They chose these folders to index:",
		...roots.map((root) => `- ${root}`),
		"",
		`The index reads only files with these extensions: ${[...extensions].sort().join(", ")}. Everything else (images, video, logs, binaries, most source code) is never indexed, so a folder without such files costs nothing and must not be proposed.`,
		"Documents are worth indexing: PDF, Word, Hancom/HWP, spreadsheets, slides, notes, markdown, plain text, e-books, and the person's own work files.",
		"Your job is to look inside the chosen folders and name the sub-folders that should be LEFT OUT because indexing them costs time and only adds noise:",
		"- application and system data: app support folders, chat-app downloads, browser profiles, caches, game and launcher data, backups of apps",
		"- machine-written logs, dumps, exports, telemetry and generated reports",
		"- source-code projects, build output, dependency folders, virtual environments, notebooks' checkpoints",
		"- media recordings, raw captures, installers, disk images, and datasets made of very many small machine-made files",
		"",
		"Never propose a folder that holds the person's own documents, even when it also holds some clutter. When unsure, leave it in.",
		`The app already skips every folder that starts with a dot and these names, so do not propose them: ${DEFAULT_CODE_FOLDER_NAMES.join(", ")}.`,
		"",
		"How to work: list each chosen folder, then go into the folders that look large, generic or machine-made. Use find with a name pattern to estimate what a folder holds and read a few files only when a name is ambiguous. Be economical: do not open every folder and do not read large files.",
		"Prefer the highest-level folder that is junk as a whole over listing its children.",
		"When you are done, call propose_exclusions once with every folder you found, then stop. If nothing should be excluded, call it with an empty list.",
		`Write every reason as one short sentence in ${LANGUAGE_NAME[language]}. Do not reply with prose; the tool call is your answer.`,
	].join("\n");
}

export interface SmartIndexingProfileInput {
	readonly roots: readonly string[];
	readonly language: ReplyLanguage;
	/** Extensions (lower-case, with the dot) the index reads; the pre-scan's own list. */
	readonly extensions: readonly string[];
	/** The collector whose tool the agent answers through; the caller reads the result from it. */
	readonly collector: ProposalCollector;
}

export function smartIndexingProfile(input: SmartIndexingProfileInput): AgentProfile {
	return {
		id: "smart-indexing",
		systemPrompt: smartIndexingPrompt(input.roots, input.language, input.extensions),
		tools: ["read", "grep", "find", "ls"],
		customTools: [input.collector.tool],
		thinking: "low",
	};
}
