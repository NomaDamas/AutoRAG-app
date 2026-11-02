import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppSettings } from "../../../shared/settings-contract";
import { DEFAULT_CODE_FOLDER_NAMES } from "../../../shared/settings-contract";
import type { AgentProfile } from "@autorag/librarian/profiles";
import type { FolderSurvey } from "./folder-stats";
import { intentPromptLine, withIntentTools } from "../profile-progress";

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

export function createProposalCollector(roots: readonly string[], survey?: FolderSurvey): ProposalCollector {
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
		if (survey !== undefined && !survey.counted(path)) return "survey this folder with folder_survey first (a survey of the folder above it also counts), then propose it";
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

/** The agent's whole instruction; `roots` are the folders to look through. It judges from names, counts and dates, in words, with no thresholds. */
export function smartIndexingPrompt(roots: readonly string[], language: ReplyLanguage, extensions: readonly string[]): string {
	return [
		"You help a person decide what their personal document search should cover.",
		"These are the folders to look through:",
		...roots.map((root) => `- ${root}`),
		"",
		`The search index reads documents: files with these extensions: ${[...extensions].sort().join(", ")}. A survey lists every file type in a folder, the ones the index reads marked "(indexed)" and all the others too. Treat every file type as evidence about what a folder is; do not skip a folder because it holds few or no indexed files.`,
		"",
		"Your job: name the sub-folders to LEAVE OUT of the index. Judge one question about each folder: is what is in it written or collected by a person for their own use, or is it generated by a program as a by-product, or is it a code project?",
		"- Keep: documents the person wrote, saved, received or gathered on purpose, such as reports, notes, contracts, papers, study material, drafts, scans, and folders named for a project, a person, a course or a date of their own.",
		"- Leave out: logs, dumps and telemetry; exports and downloads that apps keep for themselves (chat-app downloads and exports, browser and app data, caches, temp and crash files); output generated from other sources (build output, generated documentation, reports a tool produced, converted or extracted copies of other files); installers, disk images, backups made by an app; and machine-named series of many files, such as hundreds of numbered or timestamped files that look alike.",
		"- Code repositories: always leave out a code repository, even when the person wrote it themselves. Recognise one by its names: source files of a programming language (.js .ts .py .java .go .rs .c .cpp .less .scss and similar) making up most of the folder, a manifest or lockfile (package.json, requirements.txt, pyproject.toml, Cargo.toml, go.mod, pom.xml, yarn.lock, .gitignore), folders such as src, lib, test, tests, client, server or app, and the site or docs folder of a software project. A copy cloned from elsewhere is a code repository as well. A few notes or documents that sit beside code do not make a folder worth keeping when the rest of it is code; leave out the repository folder as a whole.",
		"Judge by what the file and folder names say, together with the counts of every file type and the dates when the files changed: a folder whose files were all written within a day or two, with names that follow one pattern, looks generated; a folder whose names vary and whose dates are spread out over months looks like a person's own.",
		"You cannot open files and must not guess at their contents. You see names, counts by type and dates, and that is enough: a person glancing at the listing would tell the same way.",
		`The app already skips every folder that starts with a dot and these names, so do not propose them: ${DEFAULT_CODE_FOLDER_NAMES.join(", ")}.`,
		"",
		"Leaving out a folder that holds the person's own documents makes them disappear from search, which is much worse than indexing some clutter. When in doubt, leave it in. This does not apply to code repositories, which are always left out.",
		"",
		"How to work:",
		"1. Call folder_survey on each of the folders above. It gives counts by file type, when the files changed, a spread of file names, and the same for each subfolder; a large folder's smaller subfolders get one line each.",
		"2. A folder is mixed when its sample names show more than one pattern or kind of file, or when most of its files changed together while others changed at other times. A summary of a mixed folder says nothing about the parts: call folder_survey on it (or list_folder to see its names) before deciding, and keep going down while the parts are mixed. Do not stop at a folder because its total looks ordinary. You can only look inside the folders above.",
		"3. Go through every subfolder the survey names, not only the large ones, and decide each one. Propose the highest-level folder that is generated, or is a code repository, as a whole, not each of its children. A folder that mixes the person's files with generated ones or with code stays; propose the generated or code subfolders instead. Only propose a folder you have surveyed.",
		"4. When you have looked at what matters, call propose_exclusions once with every folder, then stop. If nothing should be left out, call it with an empty list.",
		intentPromptLine(language),
		`Write each reason as one short sentence in ${LANGUAGE_NAME[language]} that says what the names showed (for example the kind of files, how alike they are, and when they were written). Do not reply with prose; the tool call is your answer.`,
	].join("\n");
}

export interface SmartIndexingProfileInput {
	readonly roots: readonly string[];
	readonly language: ReplyLanguage;
	/** Extensions (lower-case, with the dot) the index reads; the pre-scan's own list. */
	readonly extensions: readonly string[];
	/** The collector whose tool the agent answers through; the caller reads the result from it. */
	readonly collector: ProposalCollector;
	/** The survey and listing tools offered to the agent: the only way it can look at the disk. */
	readonly survey: FolderSurvey;
}

export function smartIndexingProfile(input: SmartIndexingProfileInput): AgentProfile {
	return {
		id: "smart-indexing",
		systemPrompt: smartIndexingPrompt(input.roots, input.language, input.extensions),
		// pi's read/ls/find/grep open any path on the machine, so the agent gets none of them:
		// only the survey and the listing, both confined to the chosen folders.
		tools: [],
		customTools: withIntentTools([...input.survey.tools, input.collector.tool], { language: input.language, exclude: ["propose_exclusions"] }),
		thinking: "low",
	};
}
