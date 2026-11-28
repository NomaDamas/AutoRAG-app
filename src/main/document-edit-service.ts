import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createProfileSession, type ProfileModel } from "@autorag/librarian/profiles";
import { documentEditMode, type DocumentEditEvent, type DocumentEditRequest } from "../preview/shared/annotation";
import { documentEditMessage, documentEditProfile } from "./agents/profiles/document-edit";
import { subscribeProfileProgress, type ReplyLanguage } from "./agents/profile-progress";
import { errorText, modelFailure } from "./agents/session-failure";
import type { WriteJudge } from "./agents/write-gate";
import type { PdfEditorIo } from "./pdf-editor-io";
import type { PdfAssetRequest, PdfAssetResult } from "../shared/document-editor-contract";

/** Files larger than this are not kept for undo, so they are not edited either. */
const MAX_EDIT_BYTES = 64 * 1024 * 1024;
const MAX_REPLY_CHARS = 16 * 1024;

export interface DocumentEditServiceDeps {
	readonly resolveModel: () => Promise<ProfileModel>;
	readonly agentDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly language: () => ReplyLanguage;
	/** Where the original bytes of each edited file wait for an undo. */
	readonly backupDir: string;
	readonly platform?: NodeJS.Platform;
	readonly homeDir?: string;
	readonly writeJudge?: WriteJudge;
	/** Shared PDF editor engine for `pdf` mode so AI and human edits share one mutex & live-sync. */
	readonly pdfIo?: PdfEditorIo;
}

/** The Quick Look window a run belongs to: its event sink and a capture of what it shows. */
export interface DocumentEditIo {
	readonly send: (event: DocumentEditEvent) => void;
	/** A PNG of the preview with the marks drawn on it, or null when none can be taken. */
	readonly screenshot: () => Promise<Buffer | null>;
	/** Asks the open editor to render content (text box, note, stamp, watermark, image) or find text; absent without a UI. */
	readonly renderAsset?: (request: PdfAssetRequest) => Promise<PdfAssetResult>;
}

export interface DocumentEditOutcome {
	readonly changed: boolean;
}

export interface DocumentEditService {
	start(runId: string, request: DocumentEditRequest, io: DocumentEditIo): Promise<DocumentEditOutcome>;
	cancel(runId: string): Promise<void>;
	/** Puts the bytes back that the file had before run `runId`; false when there is nothing to undo. */
	undo(runId: string, send: (event: DocumentEditEvent) => void): Promise<boolean>;
	dispose(): Promise<void>;
}

interface ActiveRun {
	readonly abort: AbortController;
	cancelled: boolean;
}

interface Backup {
	readonly path: string;
	readonly file: string;
	/** Digest of the file right after the edit: an undo never overwrites a later change. */
	readonly after: string;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function assistantText(message: unknown): string {
	const msg = recordOf(message);
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return "";
	return msg.content
		.map((entry) => recordOf(entry))
		.filter((entry) => entry?.type === "text" && typeof entry.text === "string")
		.map((entry) => (entry?.text as string).trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
}

function hasToolCall(message: unknown): boolean {
	const msg = recordOf(message);
	return msg?.role === "assistant" && Array.isArray(msg.content) && msg.content.some((entry) => recordOf(entry)?.type === "toolCall");
}

function latestReply(session: AgentSession): string {
	for (let i = session.messages.length - 1; i >= 0; i -= 1) {
		const text = assistantText(session.messages[i]);
		if (text.length > 0) return text.length <= MAX_REPLY_CHARS ? text : text.slice(0, MAX_REPLY_CHARS);
	}
	return "";
}

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function createDocumentEditService(deps: DocumentEditServiceDeps): DocumentEditService {
	const runs = new Map<string, ActiveRun>();
	const backups = new Map<string, Backup>();

	async function run(runId: string, active: ActiveRun, request: DocumentEditRequest, io: DocumentEditIo): Promise<DocumentEditOutcome> {
		const { send } = io;
		const mode = documentEditMode(extname(request.path).slice(1));
		if (mode === null) throw new Error(`Dazzi cannot edit ${extname(request.path) || "this kind of"} files.`);
		const info = await stat(request.path);
		if (!info.isFile()) throw new Error(`${request.path} is not a file.`);
		if (info.size > MAX_EDIT_BYTES) throw new Error(`${request.path} is too large to edit here.`);

		const before = await readFile(request.path);
		const [model, screenshot] = await Promise.all([deps.resolveModel(), io.screenshot().catch(() => null)]);
		const scratchDir = await mkdtemp(join(tmpdir(), "dazzi-document-edit-"));
		let session: AgentSession | undefined;
		const unsubscribe: Array<() => void> = [];
		const aiPdfSnapshotIds: string[] = [];
		let humanPdfEditedDuringRun = false;
		if (mode === "pdf" && deps.pdfIo !== undefined) {
			unsubscribe.push(
				deps.pdfIo.onChanged((ev) => {
					if (ev.path !== request.path) return;
					if (ev.source === "ai" && ev.snapshotId !== undefined) {
						aiPdfSnapshotIds.push(ev.snapshotId);
					} else if (ev.source === "human") {
						humanPdfEditedDuringRun = true;
					}
				}),
			);
		}
		try {
			session = await createProfileSession({
				profile: documentEditProfile({
					language: deps.language(),
					path: request.path,
					mode,
					scratchDir,
					agentDir: deps.agentDir,
					env: deps.env,
					...(deps.platform === undefined ? {} : { platform: deps.platform }),
					...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }),
					...(deps.writeJudge === undefined ? {} : { writeJudge: deps.writeJudge }),
					...(deps.pdfIo === undefined ? {} : { pdfIo: deps.pdfIo }),
					supportsImage: model.model.input.includes("image"),
					...(io.renderAsset === undefined ? {} : { renderAsset: io.renderAsset }),
					cancelled: () => active.cancelled,
				}),
				cwd: scratchDir,
				agentDir: deps.agentDir,
				env: deps.env,
				model,
			});
			const opened = session;
			active.abort.signal.addEventListener("abort", () => void opened.abort(), { once: true });
			unsubscribe.push(
				subscribeProfileProgress(opened, (text) => {
					if (!active.cancelled) send({ type: "progress", runId, text });
				}),
			);
			let lastDraft = "";
			const toolsUsed: string[] = [];
			unsubscribe.push(
				opened.subscribe((event) => {
					const started = recordOf(event);
					if (started?.type === "tool_execution_start" && typeof started.toolName === "string") toolsUsed.push(started.toolName);
				}),
			);
			unsubscribe.push(
				opened.subscribe((event) => {
					const ev = recordOf(event);
					if (active.cancelled || ev?.type !== "message_update") return;
					const draft = hasToolCall(ev.message) ? "" : assistantText(ev.message);
					if (draft !== lastDraft) {
						lastDraft = draft;
						send({ type: "draft", runId, text: draft });
					}
				}),
			);

			const images =
				screenshot !== null && model.model.input.includes("image")
					? [{ type: "image" as const, data: screenshot.toString("base64"), mimeType: "image/png" }]
					: undefined;
			await opened.prompt(documentEditMessage(request), images === undefined ? undefined : { images });
			// Tool names only (no arguments or document content): diagnoses what the agent actually did.
			console.log(`[document-edit] ${runId} ${mode} tools: ${toolsUsed.length === 0 ? "(none)" : toolsUsed.join(", ")}`);

			const after = await readFile(request.path).catch(() => null);
			// In PDF co-editing mode, only count edits performed by the AI (never let a
			// concurrent human edit falsely mark a failed/no-op AI turn as changed, and
			// back up the snapshot captured right before the AI's own first mutation so
			// Undo preserves earlier human edits).
			const pdfToolMutated = mode === "pdf" && deps.pdfIo !== undefined && aiPdfSnapshotIds.length > 0;
			const changed =
				mode === "pdf" && deps.pdfIo !== undefined
					? pdfToolMutated || (!humanPdfEditedDuringRun && after !== null && !after.equals(before))
					: after !== null && !after.equals(before);
			if (changed && after !== null) {
				const backupBytes =
					pdfToolMutated && deps.pdfIo !== undefined
						? ((await deps.pdfIo.readSnapshot(aiPdfSnapshotIds[0]!)) ?? before)
						: before;
				await mkdir(deps.backupDir, { recursive: true });
				const file = join(deps.backupDir, `${runId.replace(/[^A-Za-z0-9_-]/gu, "_")}${extname(request.path)}`);
				await writeFile(file, backupBytes);
				backups.set(runId, { path: request.path, file, after: digest(after) });
			}
			if (active.cancelled) {
				send({ type: "cancelled", runId });
				return { changed };
			}
			const failure = modelFailure(opened);
			if (failure !== null && !changed) throw new Error(failure);
			send({ type: "done", runId, path: request.path, changed, reply: latestReply(opened) });
			return { changed };
		} finally {
			for (const stop of unsubscribe) stop();
			session?.dispose();
			await rm(scratchDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	return {
		start: async (runId, request, io) => {
			const active: ActiveRun = { abort: new AbortController(), cancelled: false };
			runs.set(runId, active);
			io.send({ type: "started", runId, path: request.path });
			try {
				return await run(runId, active, request, io);
			} catch (error) {
				io.send(active.cancelled ? { type: "cancelled", runId } : { type: "error", runId, message: errorText(error) });
				return { changed: backups.has(runId) };
			} finally {
				runs.delete(runId);
			}
		},
		cancel: async (runId) => {
			const active = runs.get(runId);
			if (active === undefined || active.cancelled) return;
			active.cancelled = true;
			active.abort.abort();
		},
		undo: async (runId, send) => {
			const backup = backups.get(runId);
			if (backup === undefined) return false;
			const backupWrite = async (): Promise<boolean> => {
				const current = await readFile(backup.path).catch(() => null);
				if (current !== null && digest(current) !== backup.after) {
					send({ type: "error", runId, message: `${backup.path} changed after the edit, so it was not rolled back.` });
					return false;
				}
				await writeFile(backup.path, await readFile(backup.file));
				backups.delete(runId);
				await rm(backup.file, { force: true }).catch(() => undefined);
				send({ type: "undone", runId, path: backup.path });
				return true;
			};
			if (deps.pdfIo !== undefined && extname(backup.path).toLowerCase() === ".pdf") {
				return deps.pdfIo.withLock(backup.path, backupWrite);
			}
			return backupWrite();
		},
		dispose: async () => {
			for (const active of runs.values()) {
				active.cancelled = true;
				active.abort.abort();
			}
			runs.clear();
			await rm(deps.backupDir, { recursive: true, force: true }).catch(() => undefined);
			backups.clear();
		},
	};
}
