import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppSettings } from "../../../shared/settings-contract";
import { SMART_INDEXING_CRITERIA } from "../../../shared/smart-indexing-criteria";
import { DEFAULT_CODE_FOLDER_NAMES } from "../../../shared/settings-contract";
import type { AgentProfile } from "../agent-factory";
import type { FolderStatsTool } from "./folder-stats";

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

export function createProposalCollector(roots: readonly string[], stats?: FolderStatsTool): ProposalCollector {
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
		if (stats !== undefined && !stats.counted(path)) return "count this folder with folder_stats first, then propose it";
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

const pct = (share: number): string => `${Math.round(share * 100)}%`;

/** The agent's whole instruction; `roots` are the folders to look through. The criteria are written from {@link SMART_INDEXING_CRITERIA}, the same numbers `folder_stats` computes its verdicts from. */
export function smartIndexingPrompt(roots: readonly string[], language: ReplyLanguage, extensions: readonly string[]): string {
	const { minIndexedFiles, series, sparse, appData } = SMART_INDEXING_CRITERIA;
	return [
		"You help a person decide what their personal document search should cover.",
		"These are the folders to look through:",
		...roots.map((root) => `- ${root}`),
		"",
		`The index reads only files with these extensions: ${[...extensions].sort().join(", ")}. Every other file (images, video, logs, binaries, most source code) is never indexed. The numbers you see count only the indexed files unless they say "files in all".`,
		"Your job is to name the sub-folders that should be LEFT OUT of the index because they cost indexing time and add noise instead of the person's own documents.",
		"",
		"Criteria. A sub-folder is left out only when one of these holds for the folder as a whole, subfolders included; folder_stats computes each from real counts and prints which ones hold:",
		`0. Too small to matter: a folder with fewer than ${minIndexedFiles} indexed files is never proposed, whatever else is true.`,
		`1. series (machine-written plain-text series, such as daily logs or chat exports): at least ${series.minIndexedFiles} indexed files, ${pct(series.minTopExtensionShare)} or more of them the same type and that type one of ${series.extensions.join(", ")}, and distinct file names (digits ignored) at ${pct(series.maxStemRatio)} or fewer of the indexed files. Markdown, mail and Office documents are not a series: numbered daily notes are the person's own.`,
		`2. sparse (documents are a small share of a large folder): at least ${sparse.minTotalFiles} files in all and indexed files below ${pct(sparse.maxIndexedShare)} of them.`,
		`3. appData (app or system folder): the folder's own name, or the name of a folder on the way down from the chosen folder, is one of: ${appData.names.join(", ")} (case ignored).`,
		"",
		"Everything else stays in, however it looks. When a number is close to a limit, leave the folder in. Never propose a folder that holds the person's own documents.",
		`The app already skips every folder that starts with a dot and these names, so do not propose them: ${DEFAULT_CODE_FOLDER_NAMES.join(", ")}.`,
		"",
		"How to work:",
		"1. Call folder_stats on each chosen folder. It counts every file by extension, subfolders included, and lists the largest subfolders with their own numbers and the criteria that hold for each.",
		"2. Call folder_stats again on every subfolder that is large or whose criteria are unclear, and go one level further down only while a folder is mixed. Use ls or find only to see names; never decide from file names or from a few files you opened.",
		"3. A folder in which a criterion holds is proposed; propose the highest-level folder for which it holds rather than its children. Only propose a folder you counted with folder_stats and whose criteria you saw hold.",
		"4. When you have counted what matters, call propose_exclusions once with every folder, then stop. If no folder meets a criterion, call it with an empty list.",
		`Write each reason as one short sentence in ${LANGUAGE_NAME[language]} that says which criterion held and the numbers (for example the file count and the share). Do not reply with prose; the tool call is your answer.`,
	].join("\n");
}

export interface SmartIndexingProfileInput {
	readonly roots: readonly string[];
	readonly language: ReplyLanguage;
	/** Extensions (lower-case, with the dot) the index reads; the pre-scan's own list. */
	readonly extensions: readonly string[];
	/** The collector whose tool the agent answers through; the caller reads the result from it. */
	readonly collector: ProposalCollector;
	/** The counting tool; its tool is offered to the agent. */
	readonly stats: FolderStatsTool;
}

export function smartIndexingProfile(input: SmartIndexingProfileInput): AgentProfile {
	return {
		id: "smart-indexing",
		systemPrompt: smartIndexingPrompt(input.roots, input.language, input.extensions),
		tools: ["read", "find", "ls"],
		customTools: [input.stats.tool, input.collector.tool],
		thinking: "low",
	};
}
