import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { loadMirrorIndex, type ParsedMirrorEntry } from "@autorag/librarian";
import { readRawConfigObject, writeConfigObject } from "@autorag/librarian/core";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Model, Api, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ProfileModel } from "@autorag/librarian/profiles";
import {
	ONBOARDING_CHANNELS,
	type FirstRunDemo,
	type FirstRunFolder,
	type FirstRunFolderKind,
	type OnboardingSnapshot,
	type PermissionStatus,
	type SetupStage,
	type SetupStatus,
} from "../shared/onboarding-contract";
import type { AppSettings, ConfigRefreshResult } from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import { t } from "../shared/i18n/core";
import { applyIndexingConfig } from "./onboarding-config";
import { computeIndexingProgress, type IndexingRunPhase } from "./onboarding-progress";
import { readLibrarianFile, statLibrarianFile } from "./librarian-file";
import type { RunOutcome } from "./index-problem-service";
import type { FolderScanOptions } from "./onboarding-scan";
import { createSmartIndexingService, type SmartIndexingService } from "./smart-indexing-service";
import type { SmartExclusion, SmartIndexingEvent } from "../shared/smart-indexing-contract";

/**
 * The main-process half of the first run. The Finder window opens with the
 * pending flag; the renderer overlay shows the folders it is about to read
 * (`folders`), the person switches any of them, and `start` takes the chosen
 * ones. A single progress bar follows while this service does the rest on its own:
 *
 *  scanning  (0→8)   pre-scan the chosen folders, which gives the file total;
 *  planning  (8→15)  when a model can be called, take every smart-indexing
 *                    exclusion it proposes; otherwise continue silently;
 *  indexing (15→90)  write the folders into the shared config keyword-only
 *                    (parsed mirror + MinSync SPLADE; no dense embedder) and run
 *                    the first index;
 *  preparing (90→99) start a duplicate (dupey) scan and pick one question from
 *                    the user's own documents that keyword retrieval proves
 *                    answers from that document;
 *  ready     (100).
 *
 * Which folders to read is the only question; no account, plan, model, source,
 * or embedding question is asked before the first index. Persisted state is only `{ completed, indexing? }`; a run that
 * failed is restarted by `start`, a run in flight or finished is returned as is.
 */

const POLL_INTERVAL_MS = 1000;
/** Longest smart indexing may look at the folders before the first run moves on without it. */
const SMART_INDEXING_TIMEOUT_MS = 120_000;
/** Longest the model may take to write the tour's questions. */
const DEMO_MODEL_TIMEOUT_MS = 45_000;
const DEMO_MAX_TOKENS = 900;
const MIN_TOPIC_CHARS = 4;
const MAX_TOPIC_CHARS = 36;
/** The whole preparing stage is bounded so the user never waits forever. */
const PREPARING_TIMEOUT_MS = 90_000;
/** Indexing's share of the one bar: `computeIndexingProgress` yields 0–100 and this maps it to 15–90. */
const INDEXING_START = 15;
const INDEXING_SPAN = 75;
const MIN_DOC_BYTES = 1_500;
const MAX_DOC_BYTES = 400_000;
const MAX_DEMO_DOCS = 8;
const EXCERPT_CHARS = 2_000;
const MIN_EXCERPT_CHARS = 200;

/** Extensions the tour's question should never be built from: source or configuration, not the person's own writing. */
const SKIP_EXTENSIONS: Readonly<Record<string, true>> = {
	".ts": true,
	".tsx": true,
	".js": true,
	".jsx": true,
	".mjs": true,
	".cjs": true,
	".json": true,
	".jsonl": true,
	".yml": true,
	".yaml": true,
	".toml": true,
	".ini": true,
	".cfg": true,
	".conf": true,
	".css": true,
	".scss": true,
	".less": true,
	".html": true,
	".htm": true,
	".xml": true,
	".lock": true,
	".sh": true,
	".bash": true,
	".zsh": true,
	".ps1": true,
	".py": true,
	".rb": true,
	".go": true,
	".rs": true,
	".java": true,
	".kt": true,
	".c": true,
	".cc": true,
	".cpp": true,
	".h": true,
	".hpp": true,
	".cs": true,
	".swift": true,
	".sql": true,
	".env": true,
	".gitignore": true,
};
/** The forms the tour's question is best written from; anything else that is not {@link SKIP_EXTENSIONS} is still a candidate, but ranks lower. */
const PREFERRED_EXTENSIONS: Readonly<Record<string, true>> = {
	".pdf": true,
	".doc": true,
	".docx": true,
	".hwp": true,
	".hwpx": true,
	".ppt": true,
	".pptx": true,
	".xls": true,
	".xlsx": true,
	".pages": true,
	".numbers": true,
	".key": true,
	".rtf": true,
	".md": true,
	".markdown": true,
	".txt": true,
};

const LANGUAGE_INSTRUCTION: Readonly<Record<AppSettings["language"], string>> = {
	ko: "Write each question in natural Korean, at most 45 characters.",
	en: "Write each question in natural English, at most 12 words.",
	ja: "Write each question in natural Japanese, at most 45 characters.",
	zh: "Write each question in natural Chinese, at most 45 characters.",
};

export interface FirstRunServiceDeps {
	readonly userDataDir: string;
	readonly env: NodeJS.ProcessEnv;
	/** The process cwd the app seeds a fresh config's `workspacePath` with. */
	readonly cwd: string;
	readonly platform: NodeJS.Platform;
	readonly home: string;
	/** Desktop / Documents / Downloads on Windows (resolved through `app.getPath`); ignored off Windows. */
	readonly knownFolders: { readonly desktop: string; readonly documents: string; readonly downloads: string };
	/** macOS iCloud Drive path, or null where there is none. */
	readonly iCloudDrivePath: string | null;
	/** Other cloud drives to offer switched off; defaults to {@link detectCloudFolders} over `home`. */
	readonly cloudFolders?: () => readonly { readonly path: string; readonly kind: FirstRunFolderKind }[];
	readonly configPath: string;
	readonly resolveWorkspacePath: () => Promise<string>;
	/** The first index (`parsed` + `minsync`), through the app's shared local-index runner. */
	readonly refresh: (methods?: readonly string[]) => Promise<ConfigRefreshResult>;
	/** Reports how the first index ended, so the Finder keeps showing a problem after the first run is over. */
	readonly recordIndex: (outcome: RunOutcome) => void;
	/** Starts (or re-emits) a pre-scan per path; resolves once every scan finished. */
	readonly scanFolders: (paths: readonly string[]) => Promise<void>;
	/** Sum of the given folders' finished pre-scans, for the indexing denominator. */
	readonly folderTotals: (paths: readonly string[]) => number;
	/** True when a folder's pre-scan failed (for example a refused macOS folder prompt), so it is left out of the index. */
	readonly scanFailed?: (path: string) => boolean;
	/** Starts a duplicate (dupey) scan in the background; errors are ignored (dupey may be missing). */
	readonly refreshDuplicates: () => Promise<void>;
	/** The answer model in the shared config with its credentials; rejects when none is configured. */
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly complete: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;
	/** Keyword retrieval over the first index's effective config, used to verify the tour's question. */
	readonly retrieve: (query: string, options?: { readonly topK?: number }) => Promise<readonly { readonly source: string }[]>;
	/** The pre-scan's file rules for smart indexing, so its proposal counts match. */
	readonly scanOptions: FolderScanOptions;
	/** Pi's agent home; defaults to Pi's own. */
	readonly agentDir?: string;
	/** The Interface language, read per run: the tour's question and smart-indexing reasons are written in it. */
	readonly language: () => AppSettings["language"];
	readonly send: (channel: string, payload: unknown) => void;
	readonly openExternal: (url: string) => Promise<void>;
	readonly startPowerSaveBlocker: () => number;
	readonly stopPowerSaveBlocker: (id: number) => void;
	readonly probeFullDiskAccess: () => Promise<boolean>;
	readonly onComplete: () => void;
	/** Provisions anonymous model access (the guest credential + adopted models) before indexing and the tour. */
	readonly ensureModelAccess?: () => Promise<unknown>;
	readonly now?: () => number;
}

export interface FirstRunService {
	/** True while the first run still has to happen (quit-confirmation gate and window flag). */
	pending(): boolean;
	load(): Promise<OnboardingSnapshot>;
	/** The OS's own folders (switched on) and other cloud drives found on this computer (switched off). */
	folders(): Promise<readonly FirstRunFolder[]>;
	permissions(): Promise<PermissionStatus>;
	openFullDiskAccess(): Promise<void>;
	/** `folders` are paths from {@link folders}; others are ignored. Omitted: the last run's folders, else the default ones. */
	start(folders?: readonly string[]): Promise<SetupStatus>;
	status(): Promise<SetupStatus>;
	/** Sync: is a first-run index still in flight (quit-confirmation gate). */
	isIndexing(): boolean;
	complete(): Promise<void>;
	dispose(): void;
}

interface PersistedIndexingState {
	readonly startedAt: string;
	readonly finishedAt: string | null;
}

interface PersistedOnboardingState {
	readonly completed: boolean;
	readonly indexing?: PersistedIndexingState;
}

interface ParsedMirrorSnapshot {
	readonly processedFiles: number;
	readonly recentFile: string | null;
}

interface DemoDoc {
	readonly sourcePath: string;
	readonly realSourcePath: string;
	readonly excerpt: string;
}

/** Cloud drives the File Provider mounts under `~/Library/CloudStorage` (macOS), by folder-name prefix. */
const CLOUD_STORAGE_PREFIXES: readonly (readonly [string, FirstRunFolderKind])[] = [
	["GoogleDrive-", "googleDrive"],
	["Dropbox", "dropbox"],
	["OneDrive-", "oneDrive"],
];

/**
 * Cloud drives found on this computer besides iCloud Drive: macOS File Provider
 * mounts, and a classic `~/Dropbox` on either platform. They are offered
 * switched off, since they often hold far more than the person's own files.
 */
export function detectCloudFolders(home: string, platform: NodeJS.Platform): readonly { readonly path: string; readonly kind: FirstRunFolderKind }[] {
	const found: { path: string; kind: FirstRunFolderKind }[] = [];
	if (platform === "darwin") {
		const root = join(home, "Library", "CloudStorage");
		let names: string[] = [];
		try {
			names = readdirSync(root).sort((a, b) => a.localeCompare(b));
		} catch {
			names = [];
		}
		for (const [prefix, kind] of CLOUD_STORAGE_PREFIXES) {
			for (const name of names) {
				if (!name.startsWith(prefix)) continue;
				const path = join(root, name);
				try {
					if (statSync(path).isDirectory()) found.push({ path, kind });
				} catch {
					// gone between the listing and the stat
				}
			}
		}
	}
	const dropbox = join(home, "Dropbox");
	if (!found.some((folder) => folder.kind === "dropbox")) {
		try {
			if (statSync(dropbox).isDirectory()) found.push({ path: dropbox, kind: "dropbox" });
		} catch {
			// no classic Dropbox folder
		}
	}
	return found;
}

function onboardingStatePath(userDataDir: string): string {
	return join(userDataDir, "onboarding", "state.json");
}

function readOnboardingState(userDataDir: string): PersistedOnboardingState | null {
	const path = onboardingStatePath(userDataDir);
	if (!existsSync(path)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isJsonObject(parsed) || typeof parsed.completed !== "boolean") return null;
		return parsed as unknown as PersistedOnboardingState;
	} catch {
		return null;
	}
}

/** Pending when no state file exists and the QA skip flag is unset; otherwise the stored flag. */
export function readOnboardingPending(userDataDir: string, env: NodeJS.ProcessEnv): boolean {
	const state = readOnboardingState(userDataDir);
	if (state !== null) return !state.completed;
	return env.AUTORAG_SKIP_ONBOARDING !== "1";
}

/** Map a librarian refresh phase to the keyword-only phase the bar understands (`jikji`/search phases fold into finalizing). */
function toIndexingPhase(value: unknown): IndexingRunPhase | null {
	if (value === "parsed" || value === "minsync" || value === "finalizing") return value;
	if (value === "jikji" || value === "everything" || value === "fsearch") return "finalizing";
	return null;
}

/** Count what the parsed mirror actually handled, and find the newest entry. */
function snapshotParsedStage(workspaceRoot: string): ParsedMirrorSnapshot {
	try {
		const index = loadMirrorIndex(workspaceRoot);
		const entries = Object.values(index.entries);
		const skippedCount = Object.keys(index.skipped ?? {}).length;
		let recentFile: string | null = null;
		let newest = "";
		for (const entry of entries) {
			if (entry.updatedAt >= newest) {
				newest = entry.updatedAt;
				recentFile = basename(entry.sourcePath);
			}
		}
		return { processedFiles: entries.length + skippedCount, recentFile };
	} catch {
		return { processedFiles: 0, recentFile: null };
	}
}

/** Count the committed file entries in MinSync's crash-resume log (`progress.jsonl`). */
function countMinSyncProgress(text: string | null): number {
	if (text === null) return 0;
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	return Math.max(0, lines.length - 1);
}

function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The parsed markdown's own size, or null when it is gone. */
function outputSize(path: string): number | null {
	try {
		return statSync(path).size;
	} catch {
		return null;
	}
}

/** Read the parsed markdown of one document, skipping its YAML front matter, and keep the head of the body. */
function readExcerpt(outputPath: string): string | null {
	const text = readLibrarianFile(outputPath);
	if (text === null) return null;
	let body = text;
	if (body.startsWith("---")) {
		const close = body.indexOf("\n---", 3);
		if (close >= 0) {
			const after = body.indexOf("\n", close + 1);
			body = after < 0 ? "" : body.slice(after + 1);
		}
	}
	const excerpt = body.replace(/\r/gu, "").trim().slice(0, EXCERPT_CHARS);
	return excerpt.length >= MIN_EXCERPT_CHARS ? excerpt : null;
}

/**
 * Pick up to {@link MAX_DEMO_DOCS} documents to write the tour's question from:
 * substantial parsed output, not source or configuration, recent first, one per
 * folder before a folder is used twice.
 */
function collectDemoDocs(workspaceRoot: string): readonly DemoDoc[] {
	let entries: ParsedMirrorEntry[];
	try {
		entries = Object.values(loadMirrorIndex(workspaceRoot).entries);
	} catch {
		return [];
	}
	const pool = entries
		.map((entry) => ({ entry, ext: extname(entry.sourcePath).toLowerCase() }))
		.filter(({ ext }) => SKIP_EXTENSIONS[ext] !== true)
		.sort((a, b) => {
			const preferred = (PREFERRED_EXTENSIONS[a.ext] === true ? 0 : 1) - (PREFERRED_EXTENSIONS[b.ext] === true ? 0 : 1);
			return preferred !== 0 ? preferred : b.entry.sourceMtimeNs - a.entry.sourceMtimeNs;
		});
	const sized: ParsedMirrorEntry[] = [];
	for (const { entry } of pool) {
		const size = outputSize(entry.outputPath);
		if (size === null || size < MIN_DOC_BYTES || size > MAX_DOC_BYTES) continue;
		sized.push(entry);
	}
	const chosen: ParsedMirrorEntry[] = [];
	const usedFolders = new Set<string>();
	for (const entry of sized) {
		if (chosen.length >= MAX_DEMO_DOCS) break;
		const folder = dirname(entry.sourcePath);
		if (usedFolders.has(folder)) continue;
		usedFolders.add(folder);
		chosen.push(entry);
	}
	for (const entry of sized) {
		if (chosen.length >= MAX_DEMO_DOCS) break;
		if (!chosen.includes(entry)) chosen.push(entry);
	}
	const docs: DemoDoc[] = [];
	for (const entry of chosen) {
		const excerpt = readExcerpt(entry.outputPath);
		if (excerpt === null) continue;
		docs.push({ sourcePath: entry.sourcePath, realSourcePath: realpathOr(entry.sourcePath), excerpt });
	}
	return docs;
}

function demoPrompt(docs: readonly DemoDoc[], language: AppSettings["language"]): string {
	const numbered = docs.map((doc, index) => `[${index + 1}]\n${doc.excerpt}`).join("\n\n");
	return [
		"You are writing the single question a new user's guided tour will ask about their own files.",
		"For each numbered document excerpt below, write ONE natural, specific question a person would ask that only that document can answer.",
		`${LANGUAGE_INSTRUCTION[language]} Never mention a file, folder, or path in the question.`,
		"Reply with ONLY a JSON array such as [{\"doc\":1,\"question\":\"...\"}], one entry per document, and nothing else.",
		"",
		numbered,
	].join("\n");
}

function assistantText(reply: AssistantMessage): string {
	return reply.content
		.filter((part): part is Extract<AssistantMessage["content"][number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** Parse the model's JSON array of `{ doc, question }`, ignoring anything malformed. */
export function parseDemoQuestions(text: string): readonly { readonly doc: number; readonly question: string }[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const questions: { doc: number; question: string }[] = [];
	for (const item of parsed) {
		if (!isJsonObject(item)) continue;
		const { doc, question } = item;
		if (typeof doc !== "number" || !Number.isInteger(doc) || doc < 1) continue;
		if (typeof question !== "string" || question.trim().length === 0) continue;
		questions.push({ doc, question: question.trim() });
	}
	return questions;
}

/** The topic a document opens with: its first line, minus markdown marks, cut to a short phrase. Null when it has none. */
export function documentTopic(excerpt: string): string | null {
	for (const line of excerpt.split("\n")) {
		const topic = line
			.replace(/^(?:[\s#>*\-+•]|\d+[.)]\s)+/u, "")
			.replace(/[*_`|]/gu, "")
			.trim();
		if (topic.length >= MIN_TOPIC_CHARS) return topic.length > MAX_TOPIC_CHARS ? topic.slice(0, MAX_TOPIC_CHARS).trim() : topic;
	}
	return null;
}

/** A question per document built from its own opening line, for when no model can write one. */
function titleQuestions(docs: readonly DemoDoc[]): readonly { readonly doc: number; readonly question: string }[] {
	const questions: { doc: number; question: string }[] = [];
	docs.forEach((doc, index) => {
		const topic = documentTopic(doc.excerpt);
		if (topic !== null) questions.push({ doc: index + 1, question: t("main.onboarding.demoTopicQuestion", { topic }) });
	});
	return questions;
}

/** Resolve with `fallback` if `promise` has not settled within `ms`; the underlying work is left to finish on its own. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	const { promise: timeout, resolve } = Promise.withResolvers<T>();
	const timer = setTimeout(() => resolve(fallback), ms);
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A candidate document the tour's question may come from: its path and its realpath. */
export interface DemoCandidate {
	readonly sourcePath: string;
	readonly realSourcePath: string;
}

/**
 * Keep only the questions keyword retrieval actually answers from their own
 * document, then choose the one that ranked best and answered fastest. A
 * question learned from the wrong document would teach the tour nothing.
 */
export async function pickVerifiedDemo(
	docs: readonly DemoCandidate[],
	answers: readonly { readonly doc: number; readonly question: string }[],
	retrieve: (query: string, options?: { readonly topK?: number }) => Promise<readonly { readonly source: string }[]>,
	now: () => number = Date.now,
): Promise<FirstRunDemo | null> {
	let best: { readonly demo: FirstRunDemo; readonly rank: number } | null = null;
	for (const { doc, question } of answers) {
		const candidate = docs[doc - 1];
		if (candidate === undefined) continue;
		const askedAt = now();
		let results: readonly { readonly source: string }[];
		try {
			results = await retrieve(question, { topK: 5 });
		} catch {
			continue;
		}
		const latencyMs = now() - askedAt;
		const rank = results.findIndex((result) => realpathOr(result.source) === candidate.realSourcePath);
		if (rank < 0) continue;
		if (best === null || rank < best.rank || (rank === best.rank && latencyMs < best.demo.latencyMs)) {
			best = { demo: { question, sourcePath: candidate.sourcePath, latencyMs }, rank };
		}
	}
	return best?.demo ?? null;
}

export function createFirstRunService(deps: FirstRunServiceDeps): FirstRunService {
	const agentDir = deps.agentDir ?? getAgentDir();
	const now = deps.now ?? Date.now;
	const existing = readOnboardingState(deps.userDataDir);
	let stateFile: PersistedOnboardingState = existing ?? { completed: false };
	let pending = existing !== null ? !existing.completed : deps.env.AUTORAG_SKIP_ONBOARDING !== "1";

	let stage: SetupStage = "idle";
	let progress = 0;
	let remainingMinutes: number | null = null;
	let totalFiles = 0;
	let processedFiles = 0;
	let recentFile: string | null = null;
	let excludedFolders = 0;
	let demo: FirstRunDemo | null = null;
	let error: string | null = null;
	let startedAt: string | null = null;
	let finishedAt: string | null = null;

	let runPromise: Promise<void> | null = null;
	let pollTimer: NodeJS.Timeout | null = null;
	let powerBlockerId: number | null = null;
	let workspacePath: string | null = null;
	let selectedFolders: readonly string[] = [];
	/** What the person chose on the folder screen; a retry without a choice reads these again. */
	let chosenFolders: readonly string[] | null = null;
	let excludedFiles = 0;
	let phase: IndexingRunPhase | null = null;
	let phaseStartedAt = 0;
	let runId = 0;
	let progressSignature = "";
	let minsyncSignature = "";
	let parsedSnapshot: ParsedMirrorSnapshot = { processedFiles: 0, recentFile: null };
	let minsyncFiles = 0;

	const smartIndexing: SmartIndexingService = createSmartIndexingService({
		send: (event) => handleSmartEvent(event),
		resolveModel: deps.resolveModel,
		agentDir,
		env: deps.env,
		language: deps.language,
		// The cloud drives the folder screen offers switched off: smart indexing leaves them out as wholes, never reads them.
		cloudRoots: async () => (deps.cloudFolders?.() ?? detectCloudFolders(deps.home, deps.platform)).map((folder) => folder.path),
		scanOptions: deps.scanOptions,
		timeoutMs: SMART_INDEXING_TIMEOUT_MS,
	});
	let planWaiter: { readonly runId: string; readonly resolve: (exclusions: readonly SmartExclusion[]) => void } | null = null;
	let planRun = 0;

	let persistChain: Promise<void> = Promise.resolve();
	const warnPersistFailed = (caught: unknown): void => {
		console.warn("[first-run] could not save the onboarding state:", caught);
	};
	const persist = (): Promise<void> => {
		const path = onboardingStatePath(deps.userDataDir);
		const run = async (): Promise<void> => {
			await mkdir(join(deps.userDataDir, "onboarding"), { recursive: true });
			await writeFile(path, `${JSON.stringify(stateFile, null, 2)}\n`, "utf8");
		};
		persistChain = persistChain.then(run, run);
		return persistChain;
	};

	const snapshot = (): SetupStatus => ({
		stage,
		progress: Math.round(progress),
		remainingMinutes,
		totalFiles,
		processedFiles,
		recentFile,
		excludedFolders,
		demo,
		error,
		startedAt,
		finishedAt,
	});
	const emitStatus = (): void => deps.send(ONBOARDING_CHANNELS.progress, snapshot());
	/** Every stage change moves the bar forward only; a late write can never undo a finished stage. */
	const setStage = (next: SetupStage, at: number): void => {
		stage = next;
		progress = Math.max(progress, at);
	};
	const setProgress = (value: number): void => {
		progress = Math.max(progress, value);
	};

	function handleSmartEvent(event: SmartIndexingEvent): void {
		const waiter = planWaiter;
		if (waiter === null || event.runId !== waiter.runId) return;
		if (event.type === "result") {
			planWaiter = null;
			waiter.resolve(event.exclusions);
		} else if (event.type === "error" || event.type === "cancelled") {
			planWaiter = null;
			waiter.resolve([]);
		}
	}

	/** One smart-indexing analysis of `roots`; every proposal is taken, a failure or cancel simply yields none. */
	function planExclusions(roots: readonly string[]): Promise<readonly SmartExclusion[]> {
		const runIdString = `first-run-${++planRun}`;
		const { promise, resolve } = Promise.withResolvers<readonly SmartExclusion[]>();
		planWaiter = { runId: runIdString, resolve };
		void smartIndexing.analyze(runIdString, roots);
		const timer = setTimeout(() => {
			if (planWaiter?.runId !== runIdString) return;
			planWaiter = null;
			void smartIndexing.cancel(runIdString);
			resolve([]);
		}, SMART_INDEXING_TIMEOUT_MS + 5_000);
		return promise.finally(() => clearTimeout(timer));
	}

	/** Every folder the first run offers: the OS's own folders that exist (on), then other cloud drives (off). */
	function offeredFolders(): readonly FirstRunFolder[] {
		const own: { readonly path: string; readonly kind: FirstRunFolderKind }[] =
			deps.platform === "win32"
				? [
						{ path: deps.knownFolders.desktop, kind: "desktop" },
						{ path: deps.knownFolders.documents, kind: "documents" },
						{ path: deps.knownFolders.downloads, kind: "downloads" },
					]
				: [
						{ path: join(deps.home, "Desktop"), kind: "desktop" },
						{ path: join(deps.home, "Documents"), kind: "documents" },
						{ path: join(deps.home, "Downloads"), kind: "downloads" },
					];
		if (deps.iCloudDrivePath !== null) own.push({ path: deps.iCloudDrivePath, kind: "iCloudDrive" });
		const offered: FirstRunFolder[] = own.filter(({ path }) => existsSync(path)).map((folder) => ({ ...folder, selected: true }));
		for (const cloud of deps.cloudFolders?.() ?? detectCloudFolders(deps.home, deps.platform)) {
			if (!offered.some((folder) => folder.path === cloud.path)) offered.push({ ...cloud, selected: false });
		}
		return offered;
	}

	function defaultFolders(): readonly string[] {
		return offeredFolders()
			.filter((folder) => folder.selected)
			.map((folder) => folder.path);
	}

	/** The folders a run reads: the chosen ones that are still offered, in the offered order. */
	function chooseFolders(requested: readonly string[] | undefined): readonly string[] {
		if (requested === undefined) return chosenFolders ?? defaultFolders();
		const wanted = new Set(requested);
		return offeredFolders()
			.map((folder) => folder.path)
			.filter((path) => wanted.has(path));
	}

	function readIfChanged(path: string, previousSignature: string): { readonly text: string | null; readonly signature: string } {
		const info = statLibrarianFile(path);
		if (info === null) return { text: null, signature: previousSignature };
		const signature = `${info.mtimeMs}:${info.size}`;
		if (signature === previousSignature) return { text: null, signature };
		const text = readLibrarianFile(path);
		return text === null ? { text: null, signature: previousSignature } : { text, signature };
	}

	/**
	 * One poll. The reads are synchronous and the snapshot is applied only if this
	 * run is still the live one, so a tick that straddles the end of the refresh
	 * cannot undo a stage the run already finished.
	 */
	async function tick(): Promise<void> {
		if (workspacePath === null || stage !== "indexing") return;
		const ownRun = runId;
		const root = join(workspacePath, ".autorag");
		const progressRead = readIfChanged(join(root, "refresh-progress.json"), progressSignature);
		const minsyncRead = readIfChanged(join(root, "minsync", ".minsync", "progress.jsonl"), minsyncSignature);
		if (ownRun !== runId || stage !== "indexing") return;
		let inspectStage = false;
		if (progressRead.text !== null) {
			progressSignature = progressRead.signature;
			let parsed: unknown;
			try {
				parsed = JSON.parse(progressRead.text);
			} catch {
				parsed = null;
			}
			if (isJsonObject(parsed)) {
				const nextPhase = toIndexingPhase(parsed.phase);
				if (nextPhase !== null && nextPhase !== phase) {
					phase = nextPhase;
					phaseStartedAt = now();
				}
				if (isJsonObject(parsed.parsedCounts) && typeof parsed.parsedCounts.scanned === "number") {
					parsedSnapshot = { ...parsedSnapshot, processedFiles: Math.max(parsedSnapshot.processedFiles, parsed.parsedCounts.scanned) };
					inspectStage = true;
				}
				if (isJsonObject(parsed.minsync) && typeof parsed.minsync.synced === "number") {
					minsyncFiles = Math.max(minsyncFiles, parsed.minsync.synced);
				}
			}
		}
		if (inspectStage && existsSync(join(root, "parsed", "stage"))) {
			const stageSnapshot = snapshotParsedStage(workspacePath);
			parsedSnapshot = {
				processedFiles: Math.max(parsedSnapshot.processedFiles, stageSnapshot.processedFiles),
				recentFile: stageSnapshot.recentFile ?? parsedSnapshot.recentFile,
			};
		}
		if (minsyncRead.text !== null) {
			minsyncSignature = minsyncRead.signature;
			minsyncFiles = Math.max(minsyncFiles, countMinSyncProgress(minsyncRead.text));
		}
		const total = Math.max(0, deps.folderTotals(selectedFolders) - excludedFiles);
		const { progress: within, remainingMinutes: remaining } = computeIndexingProgress({
			state: "running",
			phase,
			processedFiles: parsedSnapshot.processedFiles,
			totalFiles: total,
			minsyncFiles,
			phaseElapsedMs: phase === null ? 0 : now() - phaseStartedAt,
		});
		totalFiles = total;
		processedFiles = parsedSnapshot.processedFiles;
		recentFile = parsedSnapshot.recentFile;
		remainingMinutes = remaining;
		setProgress(INDEXING_START + (within * INDEXING_SPAN) / 100);
		emitStatus();
	}

	function stopPolling(): void {
		clearInterval(pollTimer ?? undefined);
		pollTimer = null;
	}

	async function scanStage(): Promise<readonly string[]> {
		setStage("scanning", 4);
		emitStatus();
		// One folder at a time, so macOS per-folder consent dialogs arrive one after another instead of piling up;
		// any folder the user refuses fails its pre-scan and is left out rather than failing the whole index.
		const readable: string[] = [];
		for (const folder of chosenFolders ?? defaultFolders()) {
			await deps.scanFolders([folder]);
			if (deps.scanFailed?.(folder) !== true) readable.push(folder);
		}
		totalFiles = deps.folderTotals(readable);
		setProgress(8);
		emitStatus();
		return readable;
	}

	async function planningStage(roots: readonly string[]): Promise<readonly SmartExclusion[]> {
		setStage("planning", 8);
		emitStatus();
		const exclusions = roots.length === 0 ? [] : await planExclusions(roots);
		excludedFolders = exclusions.length;
		excludedFiles = exclusions.reduce((sum, exclusion) => sum + exclusion.files, 0);
		setProgress(15);
		emitStatus();
		return exclusions;
	}

	/** The last snapshot after the refresh returned, so a keyword-only run that ended early still counts what it read. */
	async function settleIndexing(result: ConfigRefreshResult): Promise<void> {
		stopPolling();
		runId += 1;
		await tick().catch(() => undefined);
		if (workspacePath !== null && existsSync(join(workspacePath, ".autorag", "parsed", "stage"))) {
			const stageSnapshot = snapshotParsedStage(workspacePath);
			processedFiles = Math.max(processedFiles, stageSnapshot.processedFiles, result.scanned);
			recentFile = stageSnapshot.recentFile ?? recentFile;
		} else if (result.scanned > processedFiles) {
			processedFiles = result.scanned;
		}
		const finished = new Date(now()).toISOString();
		stateFile = { ...stateFile, indexing: { startedAt: startedAt ?? finished, finishedAt: finished } };
		void persist().catch(warnPersistFailed);
		deps.recordIndex({ ok: result.ok, error: result.error, diagnostics: result.diagnostics });
		if (result.ok) {
			setProgress(90);
			return;
		}
		stage = "failed";
		error = result.error ?? t("main.onboarding.indexingFailed");
		remainingMinutes = null;
		finishedAt = finished;
		emitStatus();
	}

	async function indexingStage(folders: readonly string[], exclusions: readonly SmartExclusion[]): Promise<ConfigRefreshResult> {
		setStage("indexing", 15);
		emitStatus();
		const raw = existsSync(deps.configPath) ? readRawConfigObject(deps.configPath) : {};
		const next = applyIndexingConfig({
			raw,
			folders,
			excludePaths: exclusions.map((exclusion) => exclusion.path),
			semanticSearch: false,
			// The app seeds `workspacePath = cwd` (the repo in dev, `/` when packaged); the first index belongs in the AutoRAG home instead. A workspace the user set explicitly stays.
			workspacePath: typeof raw.workspacePath !== "string" || raw.workspacePath === deps.cwd ? join(deps.env.AUTORAG_HOME?.trim() || join(deps.home, ".autorag"), "workspace") : null,
		});
		writeConfigObject(deps.configPath, next);
		selectedFolders = folders;
		workspacePath = await deps.resolveWorkspacePath();
		runId += 1;
		phase = null;
		phaseStartedAt = now();
		progressSignature = "";
		minsyncSignature = "";
		parsedSnapshot = { processedFiles: 0, recentFile: null };
		minsyncFiles = 0;
		totalFiles = Math.max(0, deps.folderTotals(folders) - excludedFiles);
		powerBlockerId = deps.startPowerSaveBlocker();
		pollTimer = setInterval(() => void tick().catch(() => undefined), POLL_INTERVAL_MS);
		const result = await deps.refresh(["parsed", "minsync"]).catch((caught: unknown): ConfigRefreshResult => ({
			ok: false,
			methods: ["parsed", "minsync"],
			scanned: 0,
			written: 0,
			deleted: 0,
			skipped: 0,
			diagnostics: [],
			error: caught instanceof Error ? caught.message : String(caught),
		}));
		await settleIndexing(result);
		return result;
	}

	/**
	 * One model call writes a question per document; only the ones keyword
	 * retrieval proves are returned. Without a callable model (offline, no
	 * credential) or when none of its questions verify, the questions come from
	 * the documents' own titles instead, so the tour still shows AI Search.
	 */
	async function buildDemo(): Promise<FirstRunDemo | null> {
		if (workspacePath === null) return null;
		const docs = collectDemoDocs(workspacePath);
		if (docs.length === 0) return null;
		const written = await writeModelQuestions(docs).catch(() => []);
		const demo = written.length === 0 ? null : await pickVerifiedDemo(docs, written, deps.retrieve, now);
		return demo ?? pickVerifiedDemo(docs, titleQuestions(docs), deps.retrieve, now);
	}

	async function writeModelQuestions(docs: readonly DemoDoc[]): Promise<ReturnType<typeof parseDemoQuestions>> {
		const resolved: ProfileModel = await deps.resolveModel();
		const apiKey = resolved.apiKey ?? resolved.providerApiKeys?.[resolved.model.provider];
		const signal = AbortSignal.timeout(DEMO_MODEL_TIMEOUT_MS);
		const reply = await deps.complete(
			resolved.model,
			{ messages: [{ role: "user", content: demoPrompt(docs, deps.language()), timestamp: now() }] },
			{ ...(apiKey === undefined ? {} : { apiKey }), maxTokens: DEMO_MAX_TOKENS, signal },
		);
		return parseDemoQuestions(assistantText(reply));
	}

	async function preparingStage(): Promise<void> {
		setStage("preparing", 90);
		emitStatus();
		const work = Promise.all([deps.refreshDuplicates().catch(() => undefined), buildDemo().catch(() => null)]);
		const chosen = await withTimeout(
			work.then(([, demoQuestion]) => demoQuestion),
			PREPARING_TIMEOUT_MS,
			null,
		);
		demo = chosen;
		setProgress(99);
		emitStatus();
	}

	async function run(): Promise<void> {
		startedAt = new Date(now()).toISOString();
		finishedAt = null;
		error = null;
		demo = null;
		totalFiles = 0;
		processedFiles = 0;
		recentFile = null;
		excludedFolders = 0;
		excludedFiles = 0;
		remainingMinutes = null;
		powerBlockerId = deps.startPowerSaveBlocker();
		try {
			// Before the first index and the tour: a fresh unauthenticated launch provisions the
			// guest credential and the plan's models, so smart indexing and buildDemo() have a model.
			await deps.ensureModelAccess?.().catch(() => undefined);
			const folders = await scanStage();
			const exclusions = await planningStage(folders);
			const result = await indexingStage(folders, exclusions);
			if (!result.ok) return;
			await preparingStage();
			setStage("ready", 100);
			progress = 100;
			remainingMinutes = null;
			finishedAt = new Date(now()).toISOString();
			emitStatus();
		} catch (caught) {
			stopPolling();
			stage = "failed";
			error = caught instanceof Error ? caught.message : String(caught);
			remainingMinutes = null;
			finishedAt = new Date(now()).toISOString();
			emitStatus();
		} finally {
			if (powerBlockerId !== null) deps.stopPowerSaveBlocker(powerBlockerId);
			powerBlockerId = null;
		}
	}

	return {
		pending: () => pending,
		load: async () => ({ pending, tutorials: deps.env.AUTORAG_SKIP_ONBOARDING !== "1" }),
		folders: async () => offeredFolders(),
		permissions: async () => ({
			platform: deps.platform,
			fullDiskAccess: deps.platform === "darwin" ? await deps.probeFullDiskAccess() : null,
		}),
		openFullDiskAccess: () => deps.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"),
		start: async (folders) => {
			if (runPromise !== null) return snapshot();
			if (stage === "ready") return snapshot();
			chosenFolders = chooseFolders(folders);
			if (stage === "failed") {
				stage = "idle";
				progress = 0;
				error = null;
				demo = null;
				startedAt = null;
				finishedAt = null;
			}
			runPromise = run().finally(() => {
				runPromise = null;
			});
			return snapshot();
		},
		status: async () => snapshot(),
		isIndexing: () => runPromise !== null,
		complete: async () => {
			if (!pending) return;
			stateFile = { ...stateFile, completed: true };
			pending = false;
			await persist();
			deps.onComplete();
		},
		dispose: () => {
			stopPolling();
			if (powerBlockerId !== null) deps.stopPowerSaveBlocker(powerBlockerId);
			powerBlockerId = null;
		},
	};
}
