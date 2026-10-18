import { lstat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { evaluateCriteria, type CriterionId } from "../../../shared/smart-indexing-criteria";
import { measureFolder, type FolderStats, type FolderStatsOptions } from "../../folder-stats";

/**
 * The agent's counting tool. Listing a folder says what it is called; this says
 * how many files of each type it holds, subfolders included, and which of the
 * criteria in `smart-indexing-criteria.ts` hold for it and for each of its
 * subfolders. The model decides from these numbers rather than from file names
 * it happened to open.
 */

export type StatsReport = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly why: string };

export interface FolderStatsTool {
	/** Measures one folder; refused unless it is an existing folder inside a chosen one. */
	report(path: string, signal: AbortSignal): Promise<StatsReport>;
	/** The agent measured exactly this folder. */
	counted(path: string): boolean;
	readonly tool: ToolDefinition;
}

/** Subfolders listed in a report; the rest are summed into one line. */
const MAX_CHILDREN = 25;
/** Extensions listed in a report before the tail is summed. */
const MAX_EXTENSIONS = 12;

const CRITERION_TEXT: Readonly<Record<CriterionId, string>> = {
	series: "series (machine-written plain-text series)",
	sparse: "sparse (documents are a small share)",
	appData: "appData (app or system folder name)",
};

function percent(share: number): string {
	return `${Math.round(share * 100)}%`;
}

export function formatFolderStats(path: string, stats: FolderStats): string {
	const lines = [
		`${path}`,
		`${stats.indexedFiles} indexed files of ${stats.totalFiles} files in all${stats.truncated ? " (partial: the walk stopped early, real counts are higher)" : ""}.`,
	];
	const shown = stats.extensions.slice(0, MAX_EXTENSIONS);
	const rest = stats.extensions.slice(MAX_EXTENSIONS).reduce((sum, item) => sum + item.files, 0);
	lines.push(`extensions: ${shown.map((item) => `${item.extension} ${item.files}${item.indexed ? " (indexed)" : ""}`).join(", ")}${rest > 0 ? `, other ${rest}` : ""}`);
	const own = evaluateCriteria(stats.measure);
	lines.push(
		`this folder: top indexed type ${stats.measure.topExtension ?? "none"} ${percent(stats.measure.topExtensionShare)}, distinct names ${percent(stats.measure.stemRatio)}${stats.measure.appDataName === null ? "" : `, app-data name "${stats.measure.appDataName}"`}`,
	);
	lines.push(`criteria met: ${own.length === 0 ? "none" : own.map((id) => CRITERION_TEXT[id]).join("; ")}`);
	if (stats.children.length > 0) {
		lines.push("subfolders (most indexed files first):");
		for (const child of stats.children.slice(0, MAX_CHILDREN)) {
			const met = evaluateCriteria(child.measure);
			const top = child.measure.topExtension === null ? "" : `, top ${child.measure.topExtension} ${percent(child.measure.topExtensionShare)}, distinct names ${percent(child.measure.stemRatio)}`;
			lines.push(`- ${child.name}/ indexed ${child.indexedFiles} of ${child.totalFiles}${top}${met.length === 0 ? "" : ` -> ${met.join(", ")}`}`);
		}
		const more = stats.children.length - MAX_CHILDREN;
		if (more > 0) lines.push(`- ... and ${more} more subfolders`);
	}
	return lines.join("\n");
}

export function createFolderStats(roots: readonly string[], options: FolderStatsOptions): FolderStatsTool {
	const selected = roots.map((root) => resolve(root));
	const measuredPaths = new Set<string>();

	async function report(path: string, signal: AbortSignal): Promise<StatsReport> {
		if (!isAbsolute(path)) return { ok: false, why: "the path must be absolute" };
		const target = resolve(path);
		const root = selected.find((candidate) => target === candidate || (relative(candidate, target) !== "" && !relative(candidate, target).startsWith("..") && !isAbsolute(relative(candidate, target))));
		if (root === undefined) return { ok: false, why: "the path is outside the chosen folders" };
		try {
			if (!(await lstat(target)).isDirectory()) return { ok: false, why: "this is not a folder" };
		} catch {
			return { ok: false, why: "this folder does not exist" };
		}
		const names = target === root ? [] : relative(root, target).split(sep);
		measuredPaths.add(target);
		const stats = await measureFolder(target, names, options, signal);
		return { ok: true, text: formatFolderStats(target === root ? `${target} (chosen folder ${basename(root)})` : target, stats) };
	}

	const tool = defineTool({
		name: "folder_stats",
		label: "Folder statistics",
		description:
			"Count the files in a folder by extension, subfolders included, and see which exclusion criteria hold for it and for each of its subfolders. " +
			"Use it on every chosen folder and on every subfolder that looks large, generic or machine-made. The path must be an existing folder inside a chosen folder.",
		parameters: Type.Object({ path: Type.String({ description: "Absolute path of the folder to count." }) }),
		execute: async (_toolCallId, params, signal) => {
			const result = await report(params.path, signal ?? new AbortController().signal);
			return { content: [{ type: "text", text: result.ok ? result.text : `Refused: ${result.why}` }], details: undefined };
		},
	});

	return { report, counted: (path) => measuredPaths.has(resolve(path)), tool };
}
