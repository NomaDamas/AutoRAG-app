import { stat } from "node:fs/promises";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import type { AppCustomizerSurface } from "../../../shared/app-customizer-contract";
import {
	addSearchRoots,
	excludePath,
	includePath,
	isAbsolutePath,
	isGlobExclusion,
	removeSearchRoot,
	type RejectedRoot,
} from "../../../shared/index-scope-edit";
import {
	isJsonObject,
	type AutoRagConfigUpdate,
	type JsonObject,
	type JsonValue,
} from "../../../shared/settings-contract";
import { DUPEY_SCAN_INTERVALS, REFRESH_INTERVALS } from "../../../shared/settings-options";
import { intentPromptLine, withIntentTools, type ReplyLanguage } from "../profile-progress";
import {
	createCustomizerKit,
	REPLY_LANGUAGE_NAME,
	textResult,
	type ConfigCustomizerDeps,
	type ConfigCustomizerProfileInput,
	type CustomizerToolkit,
	type Localized,
} from "./customizer-kit";

export type { ReplyLanguage };

export interface SearchCustomizerToolkitDeps extends ConfigCustomizerDeps {
	/** The host platform, for wording only; the scope rules accept both separators. */
	readonly platform?: NodeJS.Platform;
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
	return value !== undefined && isJsonObject(value) ? value : null;
}

function listOf(value: JsonValue | undefined): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function boolOf(value: JsonValue | undefined): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function numberOf(value: JsonValue | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** A list is written whole; an empty one removes the key, as the rest of Settings does. */
function listUpdate(key: string, list: readonly string[]): AutoRagConfigUpdate {
	return list.length === 0 ? { path: [key], remove: true } : { path: [key], value: [...list] };
}

function localized(ko: string, en: string, ja: string, zh: string): Localized {
	return { ko, en, ja, zh };
}

const SCOPE_SUMMARY = localized("검색 범위(폴더·제외 항목)를 변경", "Updated the search scope (folders & exclusions)", "検索範囲(フォルダ・除外項目)を変更", "已更新搜索范围（文件夹与排除项）");
const OPTIONS_SUMMARY = localized("검색 유지 옵션을 변경", "Updated the indexing options", "インデックス維持オプションを変更", "已更新索引选项");
const DUPLICATES_SUMMARY = localized("중복 파일 정리 설정을 변경", "Updated the duplicate-file settings", "重複ファイル設定を変更", "已更新重复文件设置");

const REJECTION_LABEL: Readonly<Record<RejectedRoot["reason"], string>> = {
	duplicate: "is already a search folder",
	"inside-target": "is inside a folder that is already indexed",
	"not-absolute": "is not an absolute path",
};

const SURFACE_FOCUS: Readonly<Record<string, string>> = {
	indexing: "which folders are indexed and what is left out, the keep-up-to-date cadence, file-name watching, and automatic code-folder exclusion",
	duplicates: "how identical and similar duplicate files are handled and how often the version scan runs",
};

export function createSearchCustomizerToolkit(deps: SearchCustomizerToolkitDeps): CustomizerToolkit {
	const kit = createCustomizerKit({
		...(deps.language === undefined ? {} : { language: deps.language }),
		...(deps.cancelled === undefined ? {} : { cancelled: deps.cancelled }),
	});
	const { ensureLive, lang, record } = kit;

	const getSearchSettings = defineTool({
		name: "get_search_settings",
		label: "Inspect Search & Indexing Settings",
		description:
			"Read what Dazzi currently indexes: `searchPaths`, `excludePaths` (with which entries are globs), the local refresh cadence (`appIndexing.refreshIntervalMs`, 0 = manual), file-name watching (`fsearch.watch`), code-folder exclusion (`appIndexing.excludeCodeFolders`), and the duplicate-file settings (`excludeExactDuplicates`, `dupey`, and the app's scan interval).",
		parameters: Type.Object({}),
		execute: async () => {
			ensureLive();
			const [snapshot, app] = await Promise.all([deps.settings.configGet(), deps.settings.get()]);
			const cfg = snapshot.config;
			const appIndexing = asRecord(cfg.appIndexing) ?? {};
			const fsearch = cfg.fsearch;
			const dupey = cfg.dupey;
			const dupeyObject = asRecord(dupey) ?? {};
			const excludePaths = listOf(cfg.excludePaths);
			return textResult({
				ok: true,
				searchPaths: listOf(cfg.searchPaths),
				excludePaths,
				exclusions: excludePaths.map((entry) => ({ path: entry, glob: isGlobExclusion(entry) })),
				refreshIntervalMs: numberOf(appIndexing.refreshIntervalMs) ?? 0,
				refreshIntervalOptionsMs: [0, ...REFRESH_INTERVALS.map((option) => option.ms)],
				fileNameWatch: boolOf(asRecord(fsearch)?.watch) ?? true,
				fsearchFalse: fsearch === false,
				excludeCodeFolders: boolOf(appIndexing.excludeCodeFolders) ?? true,
				excludeExactDuplicates: boolOf(cfg.excludeExactDuplicates) ?? true,
				dupeyEnabled: dupey === undefined ? true : dupey !== false && boolOf(dupeyObject.enabled) !== false,
				dupeyScanIntervalMinutes: app.dupeyScanIntervalMinutes,
				dupeyIntervalOptions: DUPEY_SCAN_INTERVALS.map((interval) => interval.value),
				workspacePath: cfg.workspacePath ?? null,
			});
		},
	});

	const updateIndexScope = defineTool({
		name: "update_index_scope",
		label: "Update Index Search Scope",
		description:
			"Change which folders Dazzi indexes and what it leaves out. `addFolders` must be absolute paths that exist as folders on disk; a duplicate or a folder inside an already-indexed one is refused. Requests are applied removals-first so a folder can be swapped for one inside it in the same call.",
		parameters: Type.Object({
			addFolders: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of folders to start indexing." })),
			removeFolders: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths of folders to stop indexing; exclusions that only meant something under them go too." })),
			addExclusions: Type.Optional(Type.Array(Type.String(), { description: "Absolute paths or globs (`*`, `?`, `[`) to leave out of the index." })),
			removeExclusions: Type.Optional(Type.Array(Type.String(), { description: "Exclusion entries to bring back into the index." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const warnings: string[] = [];
			const snapshot = await deps.settings.configGet();
			const cfg = snapshot.config;
			let searchPaths: readonly string[] = listOf(cfg.searchPaths);
			let excludePaths: readonly string[] = listOf(cfg.excludePaths);
			const originalSearchPaths = searchPaths;
			const originalExcludePaths = excludePaths;

			for (const raw of params.removeFolders ?? []) {
				const next = removeSearchRoot({ searchPaths, excludePaths }, raw.trim());
				searchPaths = next.searchPaths;
				excludePaths = next.excludePaths;
			}

			const picked: string[] = [];
			for (const raw of params.addFolders ?? []) {
				const candidate = raw.trim();
				if (candidate.length === 0) continue;
				let isDirectory = false;
				try {
					isDirectory = (await stat(candidate)).isDirectory();
				} catch {
					warnings.push(`'${candidate}' was not added: it does not exist on disk.`);
					continue;
				}
				if (!isDirectory) {
					warnings.push(`'${candidate}' was not added: it is not a folder.`);
					continue;
				}
				picked.push(candidate);
			}
			if (picked.length > 0) {
				const result = addSearchRoots({ searchPaths, excludePaths }, picked);
				searchPaths = result.searchPaths;
				for (const rejected of result.rejected) {
					warnings.push(`'${rejected.path}' was not added (${rejected.reason}): it ${REJECTION_LABEL[rejected.reason]}.`);
				}
			}

			for (const raw of params.addExclusions ?? []) {
				const entry = raw.trim();
				if (entry.length === 0) continue;
				if (!isAbsolutePath(entry) && !isGlobExclusion(entry)) {
					warnings.push(`'${entry}' was not excluded: an exclusion must be an absolute path or a glob.`);
					continue;
				}
				excludePaths = excludePath(excludePaths, entry);
			}
			for (const raw of params.removeExclusions ?? []) {
				const entry = raw.trim();
				if (entry.length === 0) continue;
				excludePaths = includePath(excludePaths, entry);
			}

			const searchChanged = !sameList(searchPaths, originalSearchPaths);
			const excludeChanged = !sameList(excludePaths, originalExcludePaths);
			const fields: string[] = [];
			if (searchChanged) fields.push("searchPaths");
			if (excludeChanged) fields.push("excludePaths");

			if (fields.length > 0) {
				ensureLive();
				const updates: AutoRagConfigUpdate[] = [];
				if (searchChanged) updates.push(listUpdate("searchPaths", searchPaths));
				if (excludeChanged) updates.push(listUpdate("excludePaths", excludePaths));
				try {
					await deps.settings.configPatch(updates);
				} catch (error) {
					return textResult({ ok: false, error: errorText(error), warnings });
				}
				record({ kind: "search", summary: SCOPE_SUMMARY, fields, ...(warnings.length > 0 ? { warnings } : {}) });
			}
			return textResult({ ok: true, warnings, searchPaths, excludePaths, fields });
		},
	});

	const updateIndexOptions = defineTool({
		name: "update_index_options",
		label: "Update Indexing Options",
		description:
			"Set the local refresh cadence (`appIndexing.refreshIntervalMs`; 0 = manual, otherwise one of the offered millisecond values), file-name watching (`fsearch.watch`), and automatic code-folder exclusion (`appIndexing.excludeCodeFolders`). Changing the cadence also nudges the OS background job to match.",
		parameters: Type.Object({
			refreshIntervalMs: Type.Optional(Type.Number({ description: "0 for manual, or one of the offered periodic refresh intervals in milliseconds." })),
			fileNameWatch: Type.Optional(Type.Boolean({ description: "Keep the name search current as files change (`fsearch.watch`)." })),
			excludeCodeFolders: Type.Optional(Type.Boolean({ description: "Skip dependency/code folders like node_modules (`appIndexing.excludeCodeFolders`)." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const warnings: string[] = [];
			const snapshot = await deps.settings.configGet();
			const cfg = snapshot.config;
			const updates: AutoRagConfigUpdate[] = [];
			const fields: string[] = [];
			let intervalApplied = false;

			if (params.refreshIntervalMs !== undefined) {
				const ms = params.refreshIntervalMs;
				if (ms !== 0 && !REFRESH_INTERVALS.some((option) => option.ms === ms)) {
					warnings.push(`refreshIntervalMs ${ms} was ignored: use 0 or one of ${[0, ...REFRESH_INTERVALS.map((option) => option.ms)].join(", ")}.`);
				} else {
					updates.push({ path: ["appIndexing", "refreshIntervalMs"], value: ms });
					fields.push("appIndexing.refreshIntervalMs");
					intervalApplied = true;
				}
			}

			if (params.fileNameWatch !== undefined) {
				if (cfg.fsearch === false) {
					warnings.push("File-name watching was not changed: `fsearch` is disabled in the config, so the switch is unavailable.");
				} else {
					updates.push({ path: ["fsearch", "watch"], value: params.fileNameWatch });
					fields.push("fsearch.watch");
				}
			}

			if (params.excludeCodeFolders !== undefined) {
				updates.push({ path: ["appIndexing", "excludeCodeFolders"], value: params.excludeCodeFolders });
				fields.push("appIndexing.excludeCodeFolders");
			}

			const wrote = updates.length > 0;
			if (wrote) {
				ensureLive();
				try {
					await deps.settings.configPatch(updates);
				} catch (error) {
					return textResult({ ok: false, error: errorText(error), warnings });
				}
			}

			if (intervalApplied) {
				try {
					await deps.settings.refreshScheduleApply();
				} catch (error) {
					warnings.push(`The background refresh job could not be updated: ${errorText(error)}`);
				}
			}

			if (wrote) record({ kind: "search", summary: OPTIONS_SUMMARY, fields, ...(warnings.length > 0 ? { warnings } : {}) });
			return textResult({ ok: true, warnings, fields });
		},
	});

	const updateDuplicates = defineTool({
		name: "update_duplicates",
		label: "Update Duplicate-file Settings",
		description:
			"Toggle showing identical files once (`excludeExactDuplicates`) and the similar-version scan (`dupey`), and set how often the version scan runs (an app preference, `dupeyScanIntervalMinutes`). No file is ever deleted or moved.",
		parameters: Type.Object({
			excludeExactDuplicates: Type.Optional(Type.Boolean({ description: "Show identical files once (`excludeExactDuplicates`)." })),
			versionScan: Type.Optional(Type.Boolean({ description: "Enable or disable the similar-version scan (`dupey.enabled`)." })),
			scanIntervalMinutes: Type.Optional(Type.Number({ description: "How often the version scan runs, one of the offered minute values." })),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const warnings: string[] = [];
			const snapshot = await deps.settings.configGet();
			const cfg = snapshot.config;
			const updates: AutoRagConfigUpdate[] = [];
			const fields: string[] = [];

			if (params.excludeExactDuplicates !== undefined) {
				updates.push({ path: ["excludeExactDuplicates"], value: params.excludeExactDuplicates });
				fields.push("excludeExactDuplicates");
			}
			if (params.versionScan !== undefined) {
				const current = asRecord(cfg.dupey) ?? {};
				updates.push({ path: ["dupey"], value: { ...current, enabled: params.versionScan } });
				fields.push("dupey");
			}
			if (updates.length > 0) {
				ensureLive();
				try {
					await deps.settings.configPatch(updates);
				} catch (error) {
					return textResult({ ok: false, error: errorText(error), warnings });
				}
			}

			let intervalApplied = false;
			if (params.scanIntervalMinutes !== undefined) {
				const minutes = params.scanIntervalMinutes;
				if (!DUPEY_SCAN_INTERVALS.some((interval) => interval.value === minutes)) {
					warnings.push(`scanIntervalMinutes ${minutes} was ignored: use one of ${DUPEY_SCAN_INTERVALS.map((interval) => interval.value).join(", ")}.`);
				} else {
					ensureLive();
					try {
						await deps.settings.set({ dupeyScanIntervalMinutes: minutes });
						fields.push("dupeyScanIntervalMinutes");
						intervalApplied = true;
					} catch (error) {
						return textResult({ ok: false, error: errorText(error), warnings });
					}
				}
			}

			if (updates.length > 0 || intervalApplied) {
				record({ kind: "search", summary: DUPLICATES_SUMMARY, fields, ...(warnings.length > 0 ? { warnings } : {}) });
			}
			return textResult({ ok: true, warnings, fields });
		},
	});

	const tools: readonly ToolDefinition[] = [getSearchSettings, updateIndexScope, updateIndexOptions, updateDuplicates];
	return kit.toolkit(tools);
}

function systemPrompt(language: ReplyLanguage, surface: AppCustomizerSurface): string {
	const replyLang = REPLY_LANGUAGE_NAME[language];
	const focus = SURFACE_FOCUS[surface] ?? SURFACE_FOCUS.indexing;
	return [
		"You are Dazzi's Search & Indexing Customization Assistant (`search-customizer`), embedded in Settings.",
		`Reply in the language the person writes in (their latest message decides); if it is unclear, reply in ${replyLang}. Be concise and warm.`,
		"",
		"## Role & Scope",
		`- This session is about: ${focus}.`,
		"- `update_index_scope`: which folders are indexed (`searchPaths`) and what is left out (`excludePaths`).",
		"- `update_index_options`: the local refresh cadence (`appIndexing.refreshIntervalMs`), file-name watching (`fsearch.watch`), and automatic code-folder exclusion (`appIndexing.excludeCodeFolders`).",
		"- `update_duplicates`: whether identical files are shown once (`excludeExactDuplicates`), the similar-version scan (`dupey`), and how often it runs.",
		"",
		"## Non-Negotiable Invariants",
		"- Closed scope: change only the settings above. API keys, credentials, sign-in, remote access, approval mode, and datasource connectors are out of scope — refuse and explain.",
		"- NEVER run an index build or refresh, and NEVER delete, move, rename or trash any file or folder. The tools only write config values and app preferences.",
		"- A new search folder must be an absolute path that exists on disk; a folder already indexed, or inside one that is, is refused — never duplicated.",
		"- An exclusion is an absolute path or a glob (`*`, `?`, `[`); every value is written exactly as the Settings page writes it.",
		"- A cancelled run must stop at once: never claim a change that was not written.",
		"",
		"## Workflow",
		"1. Call `get_search_settings` first when unsure what is currently set.",
		"2. Apply the change with the matching `update_*` tool: apply the valid part, and report any refused part as a warning.",
		"3. Summarize in 1-3 short sentences what changed and what was refused.",
		"",
		intentPromptLine(language),
	].join("\n");
}

export function searchCustomizerProfile(input: ConfigCustomizerProfileInput): AgentProfile {
	return {
		id: "search-customizer",
		systemPrompt: systemPrompt(input.language, input.surface),
		tools: [],
		customTools: withIntentTools(input.toolkit.tools, { language: input.language }),
		thinking: "low",
	};
}
