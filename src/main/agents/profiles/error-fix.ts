import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import { ERROR_FIX_SETTINGS_PAGES, MAX_ERROR_FIX_ACTIONS, MAX_ERROR_FIX_LABEL_CHARS, type ErrorFixAction, type ErrorFixChange, type ErrorFixResult, type ErrorFixSettingsPage, type ErrorFixStatus, type ErrorFixStep, type ErrorFixSurface, type ErrorFixTrace } from "../../../shared/error-fix-contract";
import type { AppSettings, ConfigRefreshResult } from "../../../shared/settings-contract";
import { isJsonObject } from "../../../shared/settings-contract";
import type { AutoRagConfigService } from "../../autorag-config-service";
import { createFixTools } from "./error-fix-files";

/**
 * The error-fix helper ("AI로 고치기"): given an error the app showed, it looks at
 * the files the error points to, repairs what is wrong, and says in the person's
 * language what it did or what they have to do. It runs on the AI Search model,
 * like the smart-indexing helper.
 *
 * It works with pi's own tools: read, ls, find, grep, edit, write and bash, wrapped
 * in `error-fix-files.ts` by the few rules that keep a repair from becoming damage
 * (the config is shown without secrets and written through the validating service
 * the Settings pages use, after a dated copy; the model, credentials and the
 * paths AutoRAG manages are refused; the AI's own sign-in files are never opened;
 * the person's own documents are not written). Beside them it has three tools only
 * the app can offer: `diagnose` (what the app knows that is not in a file),
 * `refresh_index` (the index under the app's refresh lock) and `report_result`,
 * the answer, which refuses "fixed" unless something was really changed.
 */

export type ReplyLanguage = AppSettings["language"];

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

const MAX_MESSAGE_CHARS = 2000;
const MAX_PATHS = 80;
const MAX_SUMMARY_CHARS = 1500;
const MAX_STEP_CHARS = 300;
const MAX_STEPS = 6;
/** A command or a path shown in the activity list is cut here. */
const MAX_STEP_DETAIL_CHARS = 160;
/** How long `refresh_index` waits for an index run: a first index of a big folder takes far longer than the agent should stand by. */
const DEFAULT_REFRESH_WAIT_MS = 90_000;

export interface ErrorFixToolkitDeps {
	/** The working folder of the agent's file and shell tools. */
	readonly cwd: string;
	/** pi's agent dir: the AI's own sign-in and key files, which no tool opens. */
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** The shared AutoRAG config as the Settings pages edit it: redacted reads, validated writes. */
	readonly config: Pick<AutoRagConfigService, "get" | "patch">;
	/** What the app knows beyond the config file (model, datasources, the index); anything JSON-serializable. */
	readonly diagnostics: () => Promise<unknown>;
	/** Runs the local index once under the app's refresh lock. */
	readonly refreshIndex: () => Promise<ConfigRefreshResult>;
	/** True once the run was stopped; the file, shell and index tools then refuse. */
	readonly cancelled?: () => boolean;
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
	/** Path → what it was before the run and is now, in the order first changed. */
	const changes = new Map<string, ErrorFixChange>();
	const commands: string[] = [];
	let indexRebuilt = false;
	let answer: Answer | null = null;

	const files = createFixTools({
		cwd: deps.cwd,
		agentDir: deps.agentDir,
		env: deps.env,
		config: deps.config,
		cancelled: deps.cancelled ?? (() => false),
		...(deps.now === undefined ? {} : { now: deps.now }),
		onChange: (change) => {
			const previous = changes.get(change.path);
			if (previous === undefined) changes.set(change.path, change);
			else {
				const backup = previous.backup ?? change.backup;
				changes.set(change.path, { path: change.path, before: previous.before, after: change.after, ...(backup === undefined ? {} : { backup }) });
			}
		},
		onCommand: (command) => commands.push(command.length > MAX_STEP_CHARS ? `${command.slice(0, MAX_STEP_CHARS)}…` : command),
	});

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

	const trace = (): ErrorFixTrace => ({ changes: [...changes.values()], backupPath: files.backupPath(), commands: [...commands] });

	const diagnose = defineTool({
		name: "diagnose",
		label: "Diagnose",
		description:
			"Read what only the app knows: the shared AutoRAG config (secrets redacted) and whether it loads, whether every folder or file path written in the config exists, the chosen AI model, the data sources and the state of the index. A good first look.",
		parameters: Type.Object({}),
		execute: async () => {
			const snapshot = await deps.config.get();
			const found: { at: string; path: string }[] = [];
			pathsIn(snapshot.config, "", found);
			const paths = await Promise.all(found.map(async (entry) => ({ ...entry, exists: await exists(entry.path) })));
			const app = await deps.diagnostics().catch((error: unknown) => ({ error: errorText(error) }));
			return text(JSON.stringify({ configPath: snapshot.configPath, configExists: snapshot.configExists, configError: snapshot.error, config: snapshot.config, paths, app }, null, 1));
		},
	});

	const refreshIndex = defineTool({
		name: "refresh_index",
		label: "Refresh index",
		description:
			"Run the local document index once and report what it did or why it failed. Use it after you repointed a search folder or a data source so the new place gets indexed, or when the error was about the index itself. It waits for a while; a long run keeps going in the background and its progress shows in the app.",
		parameters: Type.Object({}),
		execute: async () => {
			if (deps.cancelled?.() === true) return text("Refused: the run was cancelled.");
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
						kind: Type.String({ description: "settings or source." }),
						target: Type.String({ description: "A Settings page id, or a data source alias." }),
						label: Type.Optional(Type.String({ description: "The button's text, short, in the reply language." })),
					}),
				),
			),
		}),
		execute: async (_toolCallId, params) => {
			const summary = params.summary.trim().slice(0, MAX_SUMMARY_CHARS);
			if (summary === "") return text("Refused: give a short summary of what was wrong and what you did.");
			if (params.status === "fixed" && changes.size === 0 && commands.length === 0 && !indexRebuilt) {
				return text("Refused: you report \"fixed\" but changed nothing. Change the cause with edit, write, bash or refresh_index, or report \"needs-user\" or \"cannot-fix\" and explain.");
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
		tools: [...files.tools, diagnose, refreshIndex, reportResult],
		trace,
		result: () => (answer === null ? null : { ...answer, ...trace() }),
	};
}

/** The step the dialog shows for a tool call of the run, or null for a call that is not an action (the answer itself). */
export function stepOf(toolName: string, args: unknown): ErrorFixStep | null {
	const argument = (key: string): string | null => {
		const value: unknown = typeof args === "object" && args !== null ? Reflect.get(args, key) : undefined;
		return typeof value === "string" && value !== "" ? value : null;
	};
	const cut = (value: string | null): string | null => (value === null ? null : value.length > MAX_STEP_DETAIL_CHARS ? `${value.slice(0, MAX_STEP_DETAIL_CHARS)}…` : value);
	switch (toolName) {
		case "diagnose":
		case "refresh_index":
			return { tool: toolName, detail: null };
		case "read":
		case "ls":
		case "edit":
		case "write":
			return { tool: toolName, detail: cut(argument("path")) };
		case "find":
		case "grep":
			return { tool: toolName, detail: cut(argument("pattern")) };
		case "bash":
			return { tool: "bash", detail: cut(argument("command")) };
		default:
			return null;
	}
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
		"What you can reach, all through your tools: the files on this computer (read, ls, find and grep to look; the AutoRAG config is shown with its secrets hidden, and the AI's own sign-in and key files, or any file named like a key, are never opened), and edit and write to change the AutoRAG config, the files its data sources name and the app's workspace folder. bash runs a command for what the file tools cannot do (a permission, a missing program, a stuck process); use it for repairs, not to change the person's own documents, which are theirs and stay as they are. diagnose shows what only the app knows (the chosen model, the data sources, the index state) and which paths in the config do not exist. refresh_index runs the local document index once.",
		"",
		"How to work:",
		"1. Call diagnose first. It shows the config, whether it loads, which paths in it do not exist, the chosen model, the data sources and the index state.",
		"2. Match what it shows to the error. A search folder or data source path that no longer exists is the common case: use ls or find to see whether the folder moved or was renamed (the folder that still exists above it, and its neighbours, usually show where it went), and repoint it only when the new place is clearly the same folder (same name or the same contents). Look in the broken path's parent, the folder above it and the folders the config already names; that is a handful of looks, not a search of the computer. Never run grep or find over the whole home folder, the app's own folders or temporary folders: a folder that is not near where it was is not yours to hunt for, and a long walk costs the person time they do not have. If you do not find it there, or are not sure, do not guess and do not keep looking: report needs-user, and give a button to the page where they choose the folders (kind settings, target scope, with a label such as the example below). Other errors work the same way: read the config, the file or the log the error points at, find the cause, and change it; when what you find is outside Dazzi, say so and stop.",
		"3. Change as little as possible: only the setting the error points at. Never remove a folder or a data source just to make an error go away.",
		"4. If you repointed a search folder or a data source, call refresh_index once so the new place gets indexed (a long run goes on in the background; do not wait for it). Then call diagnose once more to confirm the cause is gone. Only then report fixed.",
		"5. Finish with report_result, once.",
		"6. Be economical: every tool call is one request to the AI model, and some plans allow only a few requests a minute. Call independent tools together in one turn, never repeat a check you already have the answer to, and make a config change in one edit. To change the AutoRAG config use edit (exact text) or write (the whole file as you saw it, the secret placeholders left as they are); the app checks the result, refuses a bad value and says why, and keeps a copy of the old file.",
		"",
		"Limits you must respect:",
		"- Never change the AI model, a sign-in, a subscription, a key or a token. If the error is about any of them (no model, wrong key, plan used up, model gone), report cannot-fix and give a button to Settings: target \"ai\" for the model, \"plan\" for the subscription.",
		"- A button is optional, and most answers need none. Give one only when the fix is a setting in Dazzi itself that the person has to change, and a Settings page below holds exactly that setting; say what to do in `nextSteps`. A cause outside Dazzi does not need a button, even when only the person can fix it: a permission the operating system refused (macOS privacy settings, Full Disk Access), a file or folder another program holds, the network, a provider outage, a bug, or a cause you already repaired. Explain it in `summary` and `nextSteps` and leave `actions` out. A Settings page that does not hold the setting is worse than no button, and a button that only lets the person look around is not a fix. Never invent a place to send them. Buttons go only to the Settings pages below or to one data source's page; there is no button to a folder.",
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
		// pi's own read, ls, find, grep, edit, write and bash, each wrapped by the toolkit (see `error-fix-files.ts`), plus the app's three.
		tools: [],
		customTools: input.toolkit.tools,
		thinking: "medium",
	};
}
