/**
 * What smart indexing treats as "not worth indexing", as numbers. One place on
 * purpose: the agent's prompt, the `folder_stats` tool's verdicts and the text the
 * onboarding screen shows the user are all built from it, so the rules the user
 * reads are the rules the agent was given.
 *
 * Every figure counts only files the index reads (supported extension, under the
 * size cap), the same files the folder pre-scan counts. A folder is judged on
 * its own totals, subfolders included.
 */

export const SMART_INDEXING_CRITERIA = {
	/** A folder with fewer indexed files than this is never proposed: leaving it out saves too little. */
	minIndexedFiles: 20,
	/**
	 * A series: machine-written plain text such as daily logs or chat exports. Many
	 * files, almost all one plain-text type, whose names differ only in digits.
	 */
	series: {
		minIndexedFiles: 50,
		/** Share of the indexed files that have the most common extension. */
		minTopExtensionShare: 0.9,
		/** Distinct file names (digits ignored) divided by indexed files. */
		maxStemRatio: 0.1,
		/**
		 * Only these count. Markdown and mail are left out on purpose: daily notes and
		 * mail archives are numbered too, and they are the person's own.
		 */
		extensions: [".txt", ".text"],
	},
	/** Sparse: a large folder where documents are a small share, so it is mostly media, binaries or code. */
	sparse: {
		minTotalFiles: 300,
		/** Indexed files divided by all files; the criterion holds strictly below it. */
		maxIndexedShare: 0.1,
	},
	/** App data: a folder whose own name, or a parent's below the chosen folder, is one of these (case ignored). */
	appData: {
		names: [
			"Telegram Desktop",
			"KakaoTalk",
			"Zoom",
			"Slack",
			"Discord",
			"Application Support",
			"AppData",
			"logs",
			"log",
			"cache",
			"caches",
			"tmp",
			"temp",
			"crashes",
			"crash reports",
			"dumps",
			"telemetry",
		],
	},
} as const;

export type CriterionId = "series" | "sparse" | "appData";

/** What `folder_stats` measures for one folder; the input to {@link evaluateCriteria}. */
export interface FolderMeasure {
	readonly indexedFiles: number;
	readonly totalFiles: number;
	/** The extension most indexed files have (lower case, with the dot), null with none. */
	readonly topExtension: string | null;
	readonly topExtensionShare: number;
	readonly stemRatio: number;
	/** The first name on the way from the chosen folder to this one that is in the app-data list. */
	readonly appDataName: string | null;
}

const APP_DATA_LOWER: readonly string[] = SMART_INDEXING_CRITERIA.appData.names.map((name) => name.toLowerCase());

export function appDataNameOn(names: readonly string[]): string | null {
	return names.find((name) => APP_DATA_LOWER.includes(name.toLowerCase())) ?? null;
}

/** The criteria that hold for the folder, in the order series, sparse, appData; empty when none or too few files. */
export function evaluateCriteria(measure: FolderMeasure): CriterionId[] {
	const { minIndexedFiles, series, sparse } = SMART_INDEXING_CRITERIA;
	if (measure.indexedFiles < minIndexedFiles) return [];
	const held: CriterionId[] = [];
	const seriesExtensions: readonly string[] = series.extensions;
	if (
		measure.indexedFiles >= series.minIndexedFiles &&
		measure.topExtension !== null &&
		seriesExtensions.includes(measure.topExtension) &&
		measure.topExtensionShare >= series.minTopExtensionShare &&
		measure.stemRatio <= series.maxStemRatio
	) {
		held.push("series");
	}
	if (measure.totalFiles >= sparse.minTotalFiles && measure.indexedFiles / measure.totalFiles < sparse.maxIndexedShare) held.push("sparse");
	if (measure.appDataName !== null) held.push("appData");
	return held;
}
