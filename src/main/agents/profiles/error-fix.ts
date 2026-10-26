import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import { ERROR_FIX_SETTINGS_PAGES, MAX_ERROR_FIX_ACTIONS, MAX_ERROR_FIX_LABEL_CHARS, type ErrorFixAction, type ErrorFixChange, type ErrorFixResult, type ErrorFixSettingsPage, type ErrorFixStatus, type ErrorFixStep, type ErrorFixSurface, type ErrorFixTrace } from "../../../shared/error-fix-contract";
import type { AppSettings, AutoRagConfigUpdate, ConfigRefreshResult } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import { isJsonValue, isSecretKey, type AutoRagConfigService } from "../../autorag-config-service";

/**
 * The error-fix helper ("AI로 고치기"): given an error the app showed, it looks at
 * the shared AutoRAG config and the places the config points to, repairs what is
 * wrong there, and says in the person's language what it did or what they have
 * to do. It runs on the AI Search model, like the smart-indexing helper.
 *
 * It gets no pi file or shell tool (those open any path on the machine). It sees
 * and changes only through five tools, each of which validates: the config is
 * read with secrets redacted and written through the same validating service the
 * Settings pages use (after a dated copy of the file); the model, credentials
 * and the paths AutoRAG manages are refused; and `report_result` is the answer,
 * which refuses "fixed" unless something was really changed.
 */

export type ReplyLanguage = AppSettings["language"];

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_ENTRIES = 100;
const MAX_PATHS = 80;
const MAX_UPDATES = 8;
const MAX_VALUE_CHARS = 300;
const MAX_SUMMARY_CHARS = 1500;
const MAX_STEP_CHARS = 300;
const MAX_STEPS = 6;
/** How many paths `check_path` may look at in one run: enough to follow a moved folder, not to comb the machine for one that is gone. */
const MAX_LOOKS = 6;
/** How long `refresh_index` waits for an index run: a first index of a big folder takes far longer than the agent should stand by. */
const DEFAULT_REFRESH_WAIT_MS = 90_000;

export interface ErrorFixToolkitDeps {
	/** The shared AutoRAG config as the Settings pages edit it: redacted reads, validated writes. */
	readonly config: Pick<AutoRagConfigService, "get" | "patch">;
	/** What the app knows beyond the config file (model, datasources, the index); anything JSON-serializable. */
	readonly diagnostics: () => Promise<unknown>;
	/** Runs the local index once under the app's refresh lock. */
	readonly refreshIndex: () => Promise<ConfigRefreshResult>;
	/** Called as each tool starts, so the person can see what the agent is doing. */
	readonly onStep: (step: ErrorFixStep) => void;
	readonly now?: () => Date;
	/** How long `refresh_index` waits for the run before leaving it to finish in the background; default {@link DEFAULT_REFRESH_WAIT_MS}. */
	readonly refreshWaitMs?: number;
}

export interface ErrorFixToolkit {
	readonly tools: readonly ToolDefinition[];
	/** The agent's accepted answer with everything it changed, or null while it has given none. */
	result(): ErrorFixResult | null;
	/** What has been changed so far, answer or not. */
	trace(): ErrorFixTrace;
}

function text(value: string): { readonly content: [{ readonly type: "text"; readonly text: string }]; readonly details: undefined } {
	return { content: [{ type: "text", text: value }], details: undefined };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Compact JSON for the change log; long values are cut. */
function show(value: unknown): string | null {
	if (value === undefined) return null;
	const json = JSON.stringify(value);
	return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS)}…` : json;
}

function valueAt(root: unknown, path: readonly string[]): unknown {
	return path.reduce<unknown>((current, segment) => (isJsonObject(current) ? current[segment] : undefined), root);
}

/** The path of the first list that `path` would walk into, or null: a list is set whole, never by position. */
function listAlong(root: unknown, path: readonly string[]): string | null {
	let current = root;
	for (const [index, segment] of path.entries()) {
		if (Array.isArray(current)) return path.slice(0, index).join(".");
		current = isJsonObject(current) ? current[segment] : undefined;
	}
	return null;
}

/** Stamp for the backup name: `20261026101112`, the same shape the user's own `config.json.bak-…` files carry. */
function stamp(date: Date): string {
	return date.toISOString().replace(/\.\d+Z$/u, "").replace(/[-:T]/gu, "");
}

const LOOKS_LIKE_PATH = /^(?:\/|~\/|[A-Za-z]:[\\/])[^\n]{0,1000}$/u;

/** Every string in the config that names a place on disk, with where it was found. */
function pathsIn(value: unknown, at: string, found: { at: string; path: string }[]): void {
	if (found.length >= MAX_PATHS) return;
	if (typeof value === "string") {
		if (LOOKS_LIKE_PATH.test(value)) found.push({ at, path: value });
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => pathsIn(item, `${at}[${index}]`, found));
		return;
	}
	if (isJsonObject(value)) {
		for (const [key, child] of Object.entries(value)) pathsIn(child, at === "" ? key : `${at}.${key}`, found);
	}
}

async function exists(path: string): Promise<boolean> {
	return stat(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path).then(() => true, () => false);
}

interface Listing {
	readonly entries: readonly string[];
	readonly more: number;
}

async function listNames(directory: string): Promise<Listing> {
	const names = (await readdir(directory, { withFileTypes: true })).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort();
	return { entries: names.slice(0, MAX_ENTRIES), more: Math.max(0, names.length - MAX_ENTRIES) };
}

function listing(value: Listing): { readonly entries: readonly string[]; readonly more?: number } {
	return value.more === 0 ? { entries: value.entries } : { entries: value.entries, more: value.more };
}

async function inspectPath(path: string): Promise<unknown> {
	const entry = await stat(path).catch(() => null);
	if (entry !== null) {
		if (!entry.isDirectory()) return { path, exists: true, type: entry.isFile() ? "file" : "other" };
		try {
			return { path, exists: true, type: "directory", ...listing(await listNames(path)) };
		} catch (error) {
			return { path, exists: true, type: "directory", error: errorText(error) };
		}
	}
	// The closest folder that is still there shows where a moved or renamed one may have gone.
	for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
		const found = await stat(parent).catch(() => null);
		if (found === null) continue;
		if (!found.isDirectory()) return { path, exists: false };
		try {
			return { path, exists: false, nearestExisting: { path: parent, ...listing(await listNames(parent)) } };
		} catch (error) {
			return { path, exists: false, nearestExisting: { path: parent, error: errorText(error) } };
		}
	}
	return { path, exists: false };
}

function settingsPage(value: string | undefined): ErrorFixSettingsPage | null {
	return ERROR_FIX_SETTINGS_PAGES.find((page) => page === value) ?? null;
}

/** What the agent proposes for a button, before the app has checked where it goes. */
interface ProposedAction {
	readonly kind: string;
	readonly target: string;
	readonly label?: string | undefined;
}

function shortLabel(label: string | undefined): string {
	return (label ?? "").trim().slice(0, MAX_ERROR_FIX_LABEL_CHARS);
}

/** The action when its destination is one the app can take the person to, else why not (said to the agent, so it can correct itself). */
function checkAction(proposed: ProposedAction, sources: ReadonlySet<string>): { readonly action: ErrorFixAction } | { readonly dropped: string } {
	const label = shortLabel(proposed.label);
	if (proposed.kind === "settings") {
		const page = settingsPage(proposed.target);
		return page === null ? { dropped: `${proposed.target} (no such Settings page; use one of ${ERROR_FIX_SETTINGS_PAGES.join(", ")})` } : { action: { kind: "settings", target: page, label } };
	}
	if (proposed.kind === "source") {
		return sources.has(proposed.target) ? { action: { kind: "source", target: proposed.target, label } } : { dropped: `${proposed.target} (no configured data source has this alias; diagnose lists them)` };
	}
	return { dropped: `${proposed.kind} (not a kind of button; use settings or source)` };
}

/**
 * What each page the agent may point to holds, in the words the pages use themselves, so the agent picks the page that has
 * the setting. Kept beside the list of ids (`ERROR_FIX_SETTINGS_PAGES`); a test fails when a page has no line.
 */
const SETTINGS_PAGE_GUIDE: readonly string[] = [
	"scope: choose the folders Dazzi reads and searches, and what to leave out of them (use it when a search folder is gone, moved or must be changed)",
	"indexing: only the progress of the index and the refresh schedule of the folders and connected apps; no folder is chosen here",
	"apps: all connected apps (messengers, mail, cloud); a single app's page is a `source` button with its alias",
	"reading: the languages used to read and search documents",
	"duplicates: cleanup of the same content showing up twice in results",
	"web: using internet search results in answers",
	"mcp: connecting Dazzi to other agents and external MCP servers",
	"ai: AI services and the model for each role (also the embedding choice)",
	"plan: the subscription and AI usage",
	"account: the Dazzi account and sign-in",
	"general: appearance and startup behaviour",
];

interface Answer {
	readonly status: ErrorFixStatus;
	readonly summary: string;
	readonly nextSteps: readonly string[];
	readonly actions: readonly ErrorFixAction[];
}

export function createErrorFixToolkit(deps: ErrorFixToolkitDeps): ErrorFixToolkit {
	const now = deps.now ?? (() => new Date());
	/** Path → what it was before the run and is now, in the order first changed. */
	const changes = new Map<string, ErrorFixChange>();
	let backupPath: string | null = null;
	let indexRebuilt = false;
	let answer: Answer | null = null;

	type Settled = { readonly kind: "finished"; readonly result: ConfigRefreshResult } | { readonly kind: "failed"; readonly error: unknown } | { readonly kind: "running" };

	/** The run's outcome, or `running` when it outlives the wait; a run left behind settles on its own. */
	async function settled(run: Promise<ConfigRefreshResult>): Promise<Settled> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const waited = new Promise<Settled>((resolve) => {
			timer = setTimeout(() => resolve({ kind: "running" }), deps.refreshWaitMs ?? DEFAULT_REFRESH_WAIT_MS);
		});
		try {
			return await Promise.race([run.then((result): Settled => ({ kind: "finished", result }), (error: unknown): Settled => ({ kind: "failed", error })), waited]);
		} finally {
			clearTimeout(timer);
		}
	}

	const trace = (): ErrorFixTrace => ({ changes: [...changes.values()], backupPath });

	/** Copies the config aside once per run, before the first write; returns whether this call made the copy. */
	async function backupOnce(configPath: string): Promise<boolean> {
		if (backupPath !== null) return false;
		const target = `${configPath}.bak-${stamp(now())}-before-error-fix`;
		try {
			await copyFile(configPath, target);
		} catch {
			// No config file yet: there is nothing to lose.
			return false;
		}
		backupPath = target;
		return true;
	}

	/** Why an update may not be made, or null. The validating service still checks the value itself. */
	function refusal(update: { readonly path: readonly string[]; readonly value?: unknown; readonly remove?: boolean | undefined }): string | null {
		if (update.path.length === 0) return "give the config path as a list of keys";
		if (update.path[0] === "model") return "the AI model is the person's choice (Settings > AI); do not change it";
		const secret = update.path.find((segment) => isSecretKey(segment));
		if (secret !== undefined) return `"${secret}" holds a secret; keys and tokens are never edited here`;
		if ((update.value === undefined) === (update.remove !== true)) return "give either a value or remove: true";
		if (update.remove !== true && !isJsonValue(update.value)) return "the value must be plain JSON";
		return null;
	}

	const diagnose = defineTool({
		name: "diagnose",
		label: "Diagnose",
		description:
			"Read the app's state: the shared AutoRAG config (secrets redacted) and whether it loads, whether every folder or file path written in the config exists, the chosen AI model, the data sources and the state of the index. Start here.",
		parameters: Type.Object({}),
		execute: async () => {
			deps.onStep({ tool: "diagnose", detail: null });
			const snapshot = await deps.config.get();
			const found: { at: string; path: string }[] = [];
			pathsIn(snapshot.config, "", found);
			const paths = await Promise.all(found.map(async (entry) => ({ ...entry, exists: await exists(entry.path) })));
			const app = await deps.diagnostics().catch((error: unknown) => ({ error: errorText(error) }));
			return text(JSON.stringify({ configPath: snapshot.configPath, configExists: snapshot.configExists, configError: snapshot.error, config: snapshot.config, paths, app }, null, 1));
		},
	});

	/** How many paths `check_path` has looked at in this run. */
	let looks = 0;

	const checkPath = defineTool({
		name: "check_path",
		label: "Check path",
		description:
			"Look at one absolute path: whether it exists, whether it is a folder or a file, and for a folder the names inside (names only; no file is opened). For a path that is gone, it shows the closest folder that still exists and what is in it, so a moved or renamed folder can be found.",
		parameters: Type.Object({ path: Type.String({ description: "Absolute path." }) }),
		execute: async (_toolCallId, params) => {
			if (!isAbsolute(params.path)) return text("Refused: the path must be absolute.");
			if (looks >= MAX_LOOKS) return text(`Refused: you have looked at ${MAX_LOOKS} paths already. Do not search the machine for the folder; report with report_result what you found and give the person buttons to act.`);
			looks += 1;
			deps.onStep({ tool: "check_path", detail: params.path });
			return text(JSON.stringify(await inspectPath(params.path), null, 1));
		},
	});

	const updateConfig = defineTool({
		name: "update_config",
		label: "Update config",
		description:
			"Change the shared AutoRAG config. Each update sets the value at a path (a list of keys, for example [\"searchPaths\"] or [\"datasources\", \"kakao\", \"connector\", \"configPath\"]) or removes it with remove: true. The result is validated before it is written; a refused change comes back with the reason and nothing is written. A copy of the old config is kept first. The model, secrets and managed paths cannot be changed.",
		parameters: Type.Object({
			updates: Type.Array(
				Type.Object({
					path: Type.Array(Type.String()),
					value: Type.Optional(Type.Unknown({ description: "The new JSON value." })),
					remove: Type.Optional(Type.Boolean()),
				}),
			),
		}),
		execute: async (_toolCallId, params) => {
			if (params.updates.length === 0) return text("Refused: no updates given.");
			if (params.updates.length > MAX_UPDATES) return text(`Refused: at most ${MAX_UPDATES} updates at a time.`);
			const labels = params.updates.map((update) => update.path.join("."));
			for (const [index, update] of params.updates.entries()) {
				const why = refusal(update);
				if (why !== null) return text(`Refused ${labels[index] === "" ? "update" : labels[index]}: ${why}.`);
			}
			const updates: AutoRagConfigUpdate[] = [];
			for (const update of params.updates) {
				if (update.remove === true) updates.push({ path: update.path, remove: true });
				else if (isJsonValue(update.value)) updates.push({ path: update.path, value: update.value });
			}
			const before = await deps.config.get();
			for (const update of params.updates) {
				const list = listAlong(before.config, update.path);
				if (list !== null) return text(`Refused ${update.path.join(".")}: "${list}" is a list; set the whole list at its own path instead of one position in it.`);
			}
			deps.onStep({ tool: "update_config", detail: labels.join(", ") });
			const copied = await backupOnce(before.configPath);
			try {
				await deps.config.patch(updates);
			} catch (error) {
				// A rejected change leaves nothing behind, the copy made for it included.
				if (copied && backupPath !== null) {
					await rm(backupPath, { force: true });
					backupPath = null;
				}
				return text(`Refused: ${errorText(error)}`);
			}
			for (const update of params.updates) {
				const label = update.path.join(".");
				const previous = changes.get(label);
				changes.set(label, { path: label, before: previous === undefined ? show(valueAt(before.config, update.path)) : previous.before, after: update.remove === true ? null : show(update.value) });
			}
			return text(`Changed ${labels.join(", ")}. Call diagnose to confirm the config loads.`);
		},
	});

	const refreshIndex = defineTool({
		name: "refresh_index",
		label: "Refresh index",
		description:
			"Run the local document index once and report what it did or why it failed. Use it after you repointed a search folder or a data source so the new place gets indexed, or when the error was about the index itself. It waits for a while; a long run keeps going in the background and its progress shows in the app.",
		parameters: Type.Object({}),
		execute: async () => {
			deps.onStep({ tool: "refresh_index", detail: null });
			const outcome = await settled(deps.refreshIndex());
			if (outcome.kind === "failed") return text(`Index run failed: ${errorText(outcome.error)}`);
			if (outcome.kind === "running") return text("The index run is still going after a while. It continues in the background and its progress shows in the app; do not wait for it, finish your report.");
			const { result } = outcome;
			if (result.ok) indexRebuilt = true;
			const lines = [
				result.ok ? `Index run finished: scanned ${result.scanned}, written ${result.written}, deleted ${result.deleted}, skipped ${result.skipped}.` : `Index run failed: ${result.error ?? "no reason given"}`,
				...result.diagnostics.map((diagnostic) => `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`),
			];
			return text(lines.join("\n"));
		},
	});

	const reportResult = defineTool({
		name: "report_result",
		label: "Report result",
		description:
			"Give your answer, once, when you are done. status is \"fixed\" (you changed something and the cause is gone; refused when you changed nothing), \"needs-user\" (only the person can act) or \"cannot-fix\". summary: one to three sentences in the reply language, saying what was wrong and what you did. nextSteps: short steps for the person, only when they must act. actions: optional, and usually left out; up to three buttons that take the person to the place in the app where they have to act, each with a short label in the reply language. kind \"settings\" goes to a Settings page (target one of: " + ERROR_FIX_SETTINGS_PAGES.join(", ") + "), kind \"source\" to one configured data source's own page (target its alias from diagnose). A button whose destination does not exist is dropped and you are told, so you can correct it.",
		parameters: Type.Object({
			status: Type.Union([Type.Literal("fixed"), Type.Literal("needs-user"), Type.Literal("cannot-fix")]),
			summary: Type.String(),
			nextSteps: Type.Optional(Type.Array(Type.String())),
			actions: Type.Optional(
				Type.Array(
					Type.Object({
						kind: Type.String({ description: "settings, source or folder." }),
						target: Type.String({ description: "A Settings page id, a data source alias, or an absolute folder path." }),
						label: Type.Optional(Type.String({ description: "The button's text, short, in the reply language." })),
					}),
				),
			),
		}),
		execute: async (_toolCallId, params) => {
			const summary = params.summary.trim().slice(0, MAX_SUMMARY_CHARS);
			if (summary === "") return text("Refused: give a short summary of what was wrong and what you did.");
			if (params.status === "fixed" && changes.size === 0 && !indexRebuilt) {
				return text("Refused: you report \"fixed\" but changed nothing. Change the cause with update_config or refresh_index, or report \"needs-user\" or \"cannot-fix\" and explain.");
			}
			const snapshot = await deps.config.get();
			const sources = new Set(isJsonObject(snapshot.config.datasources) ? Object.keys(snapshot.config.datasources) : []);
			const kept: ErrorFixAction[] = [];
			const dropped: string[] = [];
			for (const proposed of params.actions ?? []) {
				const checked = checkAction(proposed, sources);
				if ("dropped" in checked) dropped.push(checked.dropped);
				else if (!kept.some((action) => action.kind === checked.action.kind && action.target === checked.action.target)) kept.push(checked.action);
			}
			answer = {
				status: params.status,
				summary,
				nextSteps: (params.nextSteps ?? []).map((step) => step.trim().slice(0, MAX_STEP_CHARS)).filter((step) => step !== "").slice(0, MAX_STEPS),
				actions: kept.slice(0, MAX_ERROR_FIX_ACTIONS),
			};
			return text(dropped.length === 0 ? "Recorded. Stop now; do not write anything else." : `Recorded, but these buttons were dropped: ${dropped.join("; ")}. Call report_result again with corrected actions if they matter.`);
		},
	});

	return {
		tools: [diagnose, checkPath, updateConfig, refreshIndex, reportResult],
		trace,
		result: () => (answer === null ? null : { ...answer, ...trace() }),
	};
}

/** A natural button label in each reply language, so the model has a model of the tone: what the button does, in the person's own words. */
const LABEL_EXAMPLE: Readonly<Record<ReplyLanguage, string>> = {
	ko: "\"검색할 폴더 다시 고르기\"",
	en: "\"Choose the search folder again\"",
	ja: "「検索するフォルダを選び直す」",
	zh: "“重新选择搜索文件夹”",
};

export function errorFixPrompt(input: { readonly message: string; readonly surface: ErrorFixSurface; readonly language: ReplyLanguage }): string {
	const message = input.message.length > MAX_MESSAGE_CHARS ? `${input.message.slice(0, MAX_MESSAGE_CHARS)}…` : input.message;
	const where = input.surface === "ai-search" ? "AI Search (the chat that answers questions from the person's own documents)" : input.surface;
	return [
		"You are the repair helper of Dazzi, a desktop app that searches a person's own documents and data sources with AI.",
		`The person just saw this error in ${where}:`,
		"<error>",
		message,
		"</error>",
		"",
		"Your job: find out why it happened and fix it when the cause is something you can reach; otherwise tell the person plainly what to do next.",
		"",
		"What you can reach, all through your tools: the shared AutoRAG config (diagnose reads it, update_config changes it), the folders and files it points to (check_path), and the local document index (refresh_index). You cannot open files, run programs or read anything else.",
		"",
		"How to work:",
		"1. Call diagnose first. It shows the config, whether it loads, which paths in it do not exist, the chosen model, the data sources and the index state.",
		"2. Match what it shows to the error. A search folder or data source path that no longer exists is the common case: use check_path to see whether the folder moved or was renamed (the listing of the closest folder that still exists, and of the folder above it, usually shows where it went), and repoint it only when the new place is clearly the same folder (same name or the same contents). Stay near the broken path: its parent and the folder above it, a few looks at most. Never go looking through the rest of the machine (the home folder, the app's own folders, temporary folders). If you do not find it there, or are not sure, do not guess: report needs-user and send the person to the page where they choose the folders (scope), not to the one that only shows indexing progress.",
		"3. Change as little as possible: only the setting the error points at. Never remove a folder or a data source just to make an error go away.",
		"4. If you repointed a search folder or a data source, call refresh_index once so the new place gets indexed (a long run goes on in the background; do not wait for it). Then call diagnose once more to confirm the cause is gone. Only then report fixed.",
		"5. Finish with report_result, once.",
		"6. Be economical: every tool call is one request to the AI model, and some plans allow only a few requests a minute. Call independent tools together in one turn, never repeat a check you already have the answer to, and set a list (such as searchPaths) whole in a single update_config instead of one position at a time.",
		"",
		"Limits you must respect:",
		"- Never change the AI model, a sign-in, a subscription, a key or a token. If the error is about any of them (no model, wrong key, plan used up, model gone), report cannot-fix and give a button to Settings: target \"ai\" for the model, \"plan\" for the subscription.",
		"- A button is optional, and most answers need none: give one only when the person has to change something in a particular place in the app, and say so in `nextSteps`. An error from the network, a provider outage, a bug, or a cause you already repaired needs no button; write the answer without `actions`. Never invent a place to send them. Buttons go only to the Settings pages below or to one data source's page; there is no button to a folder.",
		"- You cannot fix the network, a provider outage, or a bug in the app. Say so honestly with cannot-fix and what the person can try; do not claim a repair you did not make.",
		"- Do not change anything when the config is fine and the cause is outside it.",
		"",
		"What each Settings page (target) holds, so you pick the one that really has the setting:",
		...SETTINGS_PAGE_GUIDE.map((line) => `- ${line}`),
		"",
		`Write summary and nextSteps in ${LANGUAGE_NAME[input.language]}, in plain words for someone who is not technical: no stack traces, no jargon, file paths only where they help. Write each button's label in ${LANGUAGE_NAME[input.language]} too, as a short, natural phrase for what the button does, the way a person who speaks it would say it (not a word-for-word translation of a page name; for example: ${LABEL_EXAMPLE[input.language]}). Do not reply with prose; the report_result call is your answer.`,
	].join("\n");
}

export interface ErrorFixProfileInput {
	readonly message: string;
	readonly surface: ErrorFixSurface;
	readonly language: ReplyLanguage;
	readonly toolkit: ErrorFixToolkit;
}

export function errorFixProfile(input: ErrorFixProfileInput): AgentProfile {
	return {
		id: "error-fix",
		systemPrompt: errorFixPrompt(input),
		// pi's read/ls/find/grep/bash/edit/write reach any path on the machine, so the agent gets none of them.
		tools: [],
		customTools: input.toolkit.tools,
		thinking: "medium",
	};
}
