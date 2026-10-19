import { lstat, readdir } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { measureFolder, type ChildStats, type ExtensionCount, type FolderStats, type FolderStatsOptions, type ModifiedSpread } from "../../folder-stats";

/**
 * The agent's only way to look at the disk, and it can only look inside the
 * folders the person chose. `folder_survey` reports facts about a folder:
 * how many files of each type it holds, subfolders included, when they were last
 * changed, and a spread of file names, for the folder and for each subfolder.
 * It says nothing about what should be indexed; the agent decides that from the
 * names, much as a person glancing at a folder listing would.
 *
 * `list_folder` shows the names directly inside one folder, files and subfolders,
 * for a closer look at a subfolder the survey only summarised.
 */

export type SurveyReport = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

export interface FolderSurvey {
	/** Surveys one folder; refused unless it is an existing folder inside a chosen one. */
	report(path: string, signal: AbortSignal): Promise<SurveyReport>;
	/** Names directly inside one folder; refused on the same terms. */
	list(path: string): Promise<SurveyReport>;
	/** The agent surveyed exactly this folder. */
	counted(path: string): boolean;
	readonly tools: readonly ToolDefinition[];
}

/** Subfolders a survey names; past this the rest are only counted. */
const MAX_CHILDREN = 500;
/**
 * Subfolders described in full (types, dates, sample names, their own subfolders), largest first.
 * The others get one line with their name and counts, which is what a person scanning a listing
 * sees; a full block is about 600 characters, so five hundred of them would flood the model.
 */
const DETAILED_CHILDREN = 40;
/** Extensions listed per folder before the tail is summed. */
const MAX_EXTENSIONS = 10;
/** Folders listed inside one subfolder before the rest are counted. */
const MAX_PARTS = 12;
/** Entries one `list_folder` call shows. */
const MAX_LISTED = 200;

function extensionLine(extensions: readonly ExtensionCount[]): string {
	const shown = extensions.slice(0, MAX_EXTENSIONS);
	const rest = extensions.slice(MAX_EXTENSIONS).reduce((sum, item) => sum + item.files, 0);
	return `${shown.map((item) => `${item.extension} ${item.files}${item.indexed ? " (indexed)" : ""}`).join(", ")}${rest > 0 ? `, other ${rest}` : ""}`;
}

function dateText(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function modifiedLine(modified: ModifiedSpread | null): string {
	if (modified === null) return "modified: no files";
	const together = Math.round(modified.sameDayShare * 100);
	return `modified ${dateText(modified.oldest)} to ${dateText(modified.newest)} (${Math.round(modified.spanDays)} days apart); ${together}% changed within a day of the median`;
}

function nameLine(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

/** One line for a subfolder that is not described in full: its name, its counts and what it mostly holds. */
function childLine(child: ChildStats): string {
	const top = child.extensions[0];
	const mix = top === undefined ? "" : `, mostly ${top.extension} ${top.files}`;
	return `- ${child.name}/ ${child.totalFiles} files, indexed ${child.indexedFiles}${mix}`;
}

function childBlock(child: ChildStats): string[] {
	return [
		`- ${child.name}/ ${child.totalFiles} files, indexed ${child.indexedFiles} of ${child.totalFiles}`,
		`    types: ${extensionLine(child.extensions)}`,
		`    ${modifiedLine(child.modified)}`,
		`    sample names: ${nameLine(child.sample)}`,
		...(child.subfolders.length === 0 ? [] : [`    subfolders: ${child.subfolders.slice(0, MAX_PARTS).map((part) => `${part.name}/ ${part.totalFiles}`).join(", ")}${child.subfolders.length > MAX_PARTS ? `, and ${child.subfolders.length - MAX_PARTS} more` : ""}`]),
	];
}

export function formatSurvey(path: string, stats: FolderStats): string {
	const lines = [
		`${path}`,
		`${stats.indexedFiles} indexed files of ${stats.totalFiles} files in all${stats.truncated ? " (partial: the walk stopped early, real counts are higher)" : ""}.`,
		`types: ${extensionLine(stats.extensions)}`,
		modifiedLine(stats.modified),
		`sample names: ${nameLine(stats.sample)}`,
	];
	if (stats.ownFiles.length > 0) lines.push(`files directly in this folder: ${nameLine(stats.ownFiles)}`);
	if (stats.children.length > 0) {
		const named = stats.children.slice(0, MAX_CHILDREN);
		lines.push(`subfolders (most files first; the largest ${Math.min(DETAILED_CHILDREN, named.length)} in detail, the rest one line each):`);
		named.forEach((child, index) => {
			if (index < DETAILED_CHILDREN) lines.push(...childBlock(child));
			else lines.push(childLine(child));
		});
		const more = stats.children.length - MAX_CHILDREN;
		if (more > 0) lines.push(`- ... and ${more} more subfolders`);
	}
	return lines.join("\n");
}

export function createFolderSurvey(roots: readonly string[], options: FolderStatsOptions): FolderSurvey {
	const selected = roots.map((root) => resolve(root));
	const surveyed = new Set<string>();

	/** The folder to look at, or why it cannot be looked at. */
	async function folderIn(path: string): Promise<{ readonly ok: true; readonly target: string; readonly root: string } | { readonly ok: false; readonly why: string }> {
		if (!isAbsolute(path)) return { ok: false, why: "the path must be absolute" };
		const target = resolve(path);
		const root = selected.find((candidate) => {
			const rel = relative(candidate, target);
			return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
		});
		if (root === undefined) return { ok: false, why: "the path is outside the chosen folders" };
		try {
			// lstat: a symbolic link is not followed out of the chosen folders.
			if (!(await lstat(target)).isDirectory()) return { ok: false, why: "this is not a folder" };
		} catch {
			return { ok: false, why: "this folder does not exist" };
		}
		return { ok: true, target, root };
	}

	async function report(path: string, signal: AbortSignal): Promise<SurveyReport> {
		const folder = await folderIn(path);
		if (!folder.ok) return folder;
		surveyed.add(folder.target);
		const stats = await measureFolder(folder.target, options, signal);
		// The report describes each subfolder it lists (counts, dates, names), so those count as looked at too.
		for (const child of stats.children.slice(0, MAX_CHILDREN)) surveyed.add(resolve(folder.target, child.name));
		return { ok: true, text: formatSurvey(folder.target === folder.root ? `${folder.target} (chosen folder ${basename(folder.root)})` : folder.target, stats) };
	}

	async function list(path: string): Promise<SurveyReport> {
		const folder = await folderIn(path);
		if (!folder.ok) return folder;
		const entries = await readdir(folder.target, { withFileTypes: true }).catch(() => []);
		const visible = entries.filter((entry) => !entry.name.startsWith("."));
		const names = visible.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort((a, b) => a.localeCompare(b));
		const shown = names.slice(0, MAX_LISTED);
		const more = names.length - shown.length;
		return { ok: true, text: `${folder.target}\n${shown.join("\n")}${more > 0 ? `\n... and ${more} more` : ""}` };
	}

	const survey = defineTool({
		name: "folder_survey",
		label: "Folder survey",
		description:
			"Facts about a folder: file counts by extension (subfolders included), when the files were last changed, a spread of file names, and the same for each subfolder. " +
			"It does not say what should be indexed. The path must be a chosen folder or a folder inside one.",
		parameters: Type.Object({ path: Type.String({ description: "Absolute path of the folder to survey." }) }),
		execute: async (_toolCallId, params, signal) => {
			const result = await report(params.path, signal ?? new AbortController().signal);
			return { content: [{ type: "text", text: result.ok ? result.text : `Refused: ${result.why}` }], details: undefined };
		},
	});

	const listing = defineTool({
		name: "list_folder",
		label: "List folder",
		description: "The names directly inside one folder (subfolders end with /). Use it for a closer look at a subfolder the survey only summarised. Hidden entries are not shown.",
		parameters: Type.Object({ path: Type.String({ description: "Absolute path of the folder to list." }) }),
		execute: async (_toolCallId, params) => {
			const result = await list(params.path);
			return { content: [{ type: "text", text: result.ok ? result.text : `Refused: ${result.why}` }], details: undefined };
		},
	});

	return { report, list, counted: (path) => surveyed.has(resolve(path)), tools: [survey, listing] };
}
