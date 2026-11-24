import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, FileCode2, FileText, Highlighter, Loader2, RotateCcw, Save, Sparkles, X } from "lucide-react";
import type { AnnotationMark, DocumentEditEvent } from "../../../preview/shared/annotation";
import { MAX_INSTRUCTION } from "../../../preview/shared/annotation";
import type { PreviewDocument, QuickLookWindowBridge } from "../../../preview/shared/contract";
import { ChromeProvider, type QuickLookChrome } from "../../../preview/ui/chrome";
import { PreviewBody } from "../../../preview/ui/body";
import type {
	DocumentEditorLoad,
	DocumentEditorTextPayload,
	DocumentLineEnding,
} from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";
import { hostPlatform } from "../lib/shortcuts";
import { EditorMarkupOverlay } from "./EditorMarkupOverlay";
import { WysiwygDocumentEditor } from "./WysiwygDocumentEditor";

const AUTOSAVE_DELAY_MS = 1000;
const AUTOSAVE_STORAGE_KEY = "dazzi.documentEditor.autosave";

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

type AiRunState =
	| { readonly status: "running"; readonly runId: string; readonly progress: string; readonly draft: string }
	| { readonly status: "done"; readonly runId: string; readonly changed: boolean; readonly reply: string }
	| { readonly status: "error"; readonly runId: string; readonly message: string }
	| { readonly status: "cancelled"; readonly runId: string }
	| { readonly status: "undone"; readonly runId: string };

function readAutosavePref(): boolean {
	try {
		return window.localStorage.getItem(AUTOSAVE_STORAGE_KEY) !== "false";
	} catch {
		return true;
	}
}

function writeAutosavePref(enabled: boolean): void {
	try {
		window.localStorage.setItem(AUTOSAVE_STORAGE_KEY, enabled ? "true" : "false");
	} catch {
		// Ignore restricted storage.
	}
}

function textStats(text: string): { readonly lines: number; readonly words: number; readonly chars: number } {
	const lines = text === "" ? 1 : text.split("\n").length;
	const trimmed = text.trim();
	const words = trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
	return { lines, words, chars: text.length };
}

/**
 * Inert QuickLookChrome bridge so `PreviewBody` renders package documents
 * (docx, pptx, xlsx, hwp, hwpx, odt, odp, ods) directly inside a Finder tab
 * without needing the separate Quick Look BrowserWindow.
 */
function useEmbeddedPreviewChrome(platform: string, language: "ko" | "en" | "ja" | "zh"): QuickLookChrome {
	return useMemo<QuickLookChrome>(() => {
		const noop = (): void => {};
		const noopSub = () => noop;
		const bridge: QuickLookWindowBridge = {
			platform,
			language,
			onLanguage: noopSub,
			onLoad: noopSub,
			onUnload: noopSub,
			onZoom: noopSub,
			onApp: noopSub,
			onOffice: noopSub,
			onSlides: noopSub,
			onThumbnail: noopSub,
			onDecoded: noopSub,
			ready: noop,
			zoomed: noop,
			request: async () => {},
			details: async () => {
				throw new Error("Unavailable in embedded preview");
			},
			sha256: async () => "",
			folderSize: async () => ({ bytes: 0, complete: true }),
			audioMetadata: async () => ({ title: null, artist: null, album: null, year: null, duration: null, bitrate: null, sampleRate: null, channels: null, codec: null, picture: null }),
			videoAudio: async () => ({ kind: "native" }),
			videoPlayback: async () => ({ kind: "native" }),
			cancelVideoPlayback: noop,
			onVideoPlaybackProgress: noopSub,
			dataPreview: async () => ({ kind: "unreadable", reason: "corrupt" }),
			archivePreview: async () => ({ kind: "unreadable", reason: "corrupt" }),
			certificatePreview: async () => ({ kind: "unreadable", reason: "empty" }),
			share: async () => {},
			copyText: async (text) => {
				await navigator.clipboard?.writeText(text).catch(() => {});
			},
			textEntry: noop,
			editDocument: async () => {},
			cancelEdit: async () => {},
			undoEdit: async () => false,
			onEditEvent: noopSub,
		};
		return {
			bridge,
			toolbar: null,
			report: noop,
			resize: noop,
			hideTitle: noop,
			app: null,
		};
	}, [platform, language]);
}

function EmbeddedPackagePreview({ document }: { readonly document: PreviewDocument }): ReactElement {
	const { i18n } = useTranslation();
	const lang = (i18n.language === "en" || i18n.language === "ja" || i18n.language === "zh" ? i18n.language : "ko");
	const chrome = useEmbeddedPreviewChrome(hostPlatform(), lang);
	return (
		<ChromeProvider value={chrome}>
			<div className="ql__stage relative flex min-h-0 flex-1 flex-col overflow-hidden bg-subtle">
				<PreviewBody file={document} />
			</div>
		</ChromeProvider>
	);
}

export interface DocumentEditorTabProps {
	readonly filePath: string;
	readonly onOpenExternal?: (path: string) => void;
}

/**
 * In-app Document Editor tab rendered inside a Finder pane.
 *
 * - Text-based WYSIWYG files (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`, `.txt`):
 *   TipTap WYSIWYG editor with Rich / Source toggle, formatting toolbar, autosave,
 *   Cmd/Ctrl+S manual save, and integrated AI editing + Undo.
 * - Code / tabular text files (`.ts`, `.js`, `.py`, `.json`, `.csv`, etc.):
 *   Monospace source editor with line count, autosave, Cmd/Ctrl+S, and AI editing.
 * - Package documents (`.docx`, `.pptx`, `.xlsx`, `.hwp`, `.hwpx`, `.odt`, `.odp`, `.ods`):
 *   Embedded preview + interactive mark-up overlay (pen/box/underline) + AI editing + Undo.
 */
export function DocumentEditorTab({ filePath, onOpenExternal }: DocumentEditorTabProps): ReactElement {
	const { t, i18n } = useTranslation();
	const editorApi = window.autorag.documentEditor;

	const [loaded, setLoaded] = useState<DocumentEditorLoad | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	// Text editor state
	const [text, setText] = useState("");
	const [savedText, setSavedText] = useState("");
	const [mtimeMs, setMtimeMs] = useState<number>(0);
	const [ending, setEnding] = useState<DocumentLineEnding>("LF");
	const [externalVersion, setExternalVersion] = useState(0);
	const [viewMode, setViewMode] = useState<"rich" | "source">("rich");
	const [autosave, setAutosave] = useState<boolean>(readAutosavePref);
	const [saveState, setSaveState] = useState<SaveState>("saved");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [selectedText, setSelectedText] = useState("");

	// AI & Mark-up state
	const [aiOpen, setAiOpen] = useState(true);
	const [markupActive, setMarkupActive] = useState(false);
	const [marks, setMarks] = useState<readonly AnnotationMark[]>([]);
	const [markupRevision, setMarkupRevision] = useState(0);
	const [instruction, setInstruction] = useState("");
	const [aiRun, setAiRun] = useState<AiRunState | null>(null);

	const stageRef = useRef<HTMLDivElement | null>(null);
	const runIdRef = useRef<string | null>(null);
	const savingRef = useRef(false);
	const textRef = useRef(text);
	textRef.current = text;
	const savedTextRef = useRef(savedText);
	savedTextRef.current = savedText;
	const mtimeRef = useRef(mtimeMs);
	mtimeRef.current = mtimeMs;
	const endingRef = useRef(ending);
	endingRef.current = ending;
	const loadedRef = useRef(loaded);
	loadedRef.current = loaded;

	const dirty = loaded?.kind === "text" && text !== savedText;

	const reloadFile = useCallback(async (): Promise<void> => {
		setLoading(true);
		setLoadError(null);
		try {
			const next = await editorApi.open(filePath);
			setLoaded(next);
			setMtimeMs(next.mtimeMs);
			if (next.kind === "text") {
				setText(next.text);
				setSavedText(next.text);
				setEnding(next.ending);
				setExternalVersion((v) => v + 1);
				setSaveState("saved");
				setSaveError(null);
				setViewMode(next.surface === "wysiwyg" ? "rich" : "source");
				setMarkupActive(false);
			} else {
				setMarkupActive(true);
				setMarkupRevision((r) => r + 1);
				setAiOpen(true);
			}
		} catch (error: unknown) {
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, [editorApi, filePath]);

	useEffect(() => {
		setMarks([]);
		setAiRun(null);
		runIdRef.current = null;
		setSelectedText("");
		void reloadFile();
	}, [reloadFile]);

	// Cancel an in-flight AI edit if the tab unmounts.
	useEffect(
		() => () => {
			const activeId = runIdRef.current;
			if (activeId !== null) void editorApi.aiCancel(activeId);
		},
		[editorApi],
	);

	// Subscribe to AI edit events for this tab's active run.
	useEffect(
		() =>
			editorApi.onAiEvent((event: DocumentEditEvent) => {
				if (event.runId !== runIdRef.current) return;
				setAiRun((current) => {
					switch (event.type) {
						case "started":
							return current;
						case "progress":
							return current?.status === "running" ? { ...current, progress: event.text } : current;
						case "draft":
							return current?.status === "running" ? { ...current, draft: event.text } : current;
						case "done":
							return { status: "done", runId: event.runId, changed: event.changed, reply: event.reply };
						case "error":
							return { status: "error", runId: event.runId, message: event.message };
						case "cancelled":
							return { status: "cancelled", runId: event.runId };
						case "undone":
							return { status: "undone", runId: event.runId };
					}
				});
			}),
		[editorApi],
	);

	const saveNow = useCallback(
		async (force = false): Promise<boolean> => {
			const current = loadedRef.current;
			if (current === null || current.kind !== "text" || current.truncated) return false;
			const contentToSave = textRef.current;
			if (!force && contentToSave === savedTextRef.current) {
				setSaveState("saved");
				return true;
			}
			if (savingRef.current) return false;
			savingRef.current = true;
			setSaveState("saving");
			setSaveError(null);
			try {
				const result = await editorApi.save({
					path: filePath,
					text: contentToSave,
					ending: endingRef.current,
					expectedMtimeMs: mtimeRef.current,
					force,
				});
				if (!result.ok) {
					setSaveState("conflict");
					return false;
				}
				setMtimeMs(result.mtimeMs);
				setSavedText(contentToSave);
				setSaveState(textRef.current === contentToSave ? "saved" : "unsaved");
				return true;
			} catch (error: unknown) {
				setSaveState("error");
				setSaveError(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				savingRef.current = false;
			}
		},
		[editorApi, filePath],
	);

	// Debounced autosave when enabled and text is dirty.
	useEffect(() => {
		if (!autosave || !dirty || loaded?.kind !== "text" || loaded.truncated || saveState === "conflict") return;
		const timer = window.setTimeout(() => {
			void saveNow(false);
		}, AUTOSAVE_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [autosave, dirty, loaded, saveNow, saveState, text]);

	// Cmd/Ctrl+S manual save inside this tab.
	const onRootKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				event.stopPropagation();
				void saveNow(false);
			}
		},
		[saveNow],
	);

	const onTextEdited = useCallback((nextText: string) => {
		setText(nextText);
		setSaveState((current) => (current === "conflict" ? current : nextText === savedTextRef.current ? "saved" : "unsaved"));
	}, []);

	const toggleAutosave = useCallback(() => {
		setAutosave((current) => {
			const next = !current;
			writeAutosavePref(next);
			return next;
		});
	}, []);

	const submitAiEdit = useCallback(async () => {
		const trimmed = instruction.trim();
		if (trimmed === "" || aiRun?.status === "running") return;
		// Flush unsaved manual edits first so the AI sees the exact content on screen.
		if (loadedRef.current?.kind === "text" && textRef.current !== savedTextRef.current && !loadedRef.current.truncated) {
			const flushed = await saveNow(false);
			if (!flushed) return;
		}
		const runId = `doc-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		runIdRef.current = runId;
		setAiRun({ status: "running", runId, progress: "", draft: "" });

		const promptInstruction =
			selectedText !== "" && marks.length === 0
				? `${trimmed}\n\nSelected text in editor:\n"""\n${selectedText.slice(0, 2000)}\n"""`
				: trimmed;

		const rect = stageRef.current?.getBoundingClientRect();
		const capture =
			rect !== undefined && rect.width > 0 && rect.height > 0
				? { rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } }
				: undefined;

		try {
			const outcome = await editorApi.aiStart(
				runId,
				{ path: filePath, instruction: promptInstruction, marks },
				capture,
			);
			setInstruction("");
			if (outcome.changed) {
				setMarks([]);
				await reloadFile();
			}
		} catch (error: unknown) {
			if (runIdRef.current === runId) {
				setAiRun({
					status: "error",
					runId,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}, [aiRun?.status, editorApi, filePath, instruction, marks, reloadFile, saveNow, selectedText]);

	const undoAiEdit = useCallback(async () => {
		if (aiRun?.status !== "done" || !aiRun.changed) return;
		const undone = await editorApi.aiUndo(aiRun.runId);
		if (undone) {
			await reloadFile();
		}
	}, [aiRun, editorApi, reloadFile]);

	const stats = useMemo(() => (loaded?.kind === "text" ? textStats(text) : null), [loaded?.kind, text]);
	const isText = loaded?.kind === "text";
	const textPayload: DocumentEditorTextPayload | null = isText ? loaded : null;
	const canRich = textPayload?.surface === "wysiwyg" && textPayload.wysiwygFormat !== null;
	const aiRunning = aiRun?.status === "running";

	const statusLabel = (() => {
		if (!isText) return null;
		switch (saveState) {
			case "saving":
				return t("documentEditor.status.saving");
			case "unsaved":
				return t("documentEditor.status.unsaved");
			case "error":
			case "conflict":
				return t("documentEditor.status.error");
			case "saved":
				return t("documentEditor.status.saved");
		}
	})();

	return (
		<div
			className="doc-editor flex min-h-0 flex-1 flex-col bg-window text-ink"
			data-document-editor={filePath}
			data-editor-surface={loaded?.surface ?? "loading"}
			onKeyDown={onRootKeyDown}
		>
			{/* Top editor header bar */}
			<header className="doc-editor__header flex h-38 flex-none items-center gap-8 border-b border-divider bg-chrome px-14">
				<div className="flex min-w-0 items-center gap-6">
					{loaded?.surface === "code" ? (
						<FileCode2 size={15} className="flex-none text-ink-muted" />
					) : (
						<FileText size={15} className="flex-none text-accent" />
					)}
					<span className="truncate text-body font-semibold text-ink" title={filePath}>
						{loaded?.name ?? filePath.split(/[\\/]/).at(-1) ?? filePath}
					</span>
					{isText && statusLabel !== null ? (
						<span
							className={cn(
								"inline-flex flex-none items-center gap-4 rounded-full px-8 py-2 text-badge font-medium",
								saveState === "saved" && "bg-subtle text-ink-muted",
								saveState === "saving" && "bg-accent-soft text-accent",
								saveState === "unsaved" && "bg-warning-soft text-warning",
								(saveState === "error" || saveState === "conflict") && "bg-error-soft text-error",
							)}
							data-save-state={saveState}
						>
							{saveState === "saving" ? <Loader2 size={10} className="animate-spin" /> : null}
							{saveState === "saved" ? <Check size={10} /> : null}
							{statusLabel}
						</span>
					) : null}
				</div>

				<div className="flex-1" />

				{/* Rich / Source segmented switch for WYSIWYG text files */}
				{canRich ? (
					<div
						className="inline-flex h-24 items-center rounded-7 bg-input p-2"
						role="group"
						aria-label={t("quickLook.markdown.viewMode")}
					>
						<button
							type="button"
							aria-pressed={viewMode === "rich"}
							className={cn(
								"h-20 rounded-5 border-0 px-10 text-meta font-medium transition-colors",
								viewMode === "rich" ? "bg-window text-ink shadow-xs" : "bg-transparent text-ink-muted hover:text-ink",
							)}
							onClick={() => setViewMode("rich")}
						>
							{t("documentEditor.modes.rich")}
						</button>
						<button
							type="button"
							aria-pressed={viewMode === "source"}
							className={cn(
								"h-20 rounded-5 border-0 px-10 text-meta font-medium transition-colors",
								viewMode === "source" ? "bg-window text-ink shadow-xs" : "bg-transparent text-ink-muted hover:text-ink",
							)}
							onClick={() => setViewMode("source")}
						>
							{t("documentEditor.modes.source")}
						</button>
					</div>
				) : null}

				{/* Autosave toggle + manual Save button for text files */}
				{isText ? (
					<>
						<label className="inline-flex cursor-pointer items-center gap-5 text-meta text-ink-muted select-none">
							<input
								type="checkbox"
								checked={autosave}
								onChange={toggleAutosave}
								className="size-13 accent-accent"
							/>
							{t("documentEditor.autosave")}
						</label>
						<button
							type="button"
							disabled={textPayload?.truncated === true || (!dirty && saveState === "saved") || saveState === "saving"}
							onClick={() => void saveNow(false)}
							className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row disabled:opacity-45"
							title={`${t("documentEditor.toolbar.save")} (${hostPlatform() === "darwin" ? "⌘S" : "Ctrl+S"})`}
						>
							<Save size={13} />
							{t("documentEditor.toolbar.save")}
						</button>
					</>
				) : null}

				{/* Markup toggle on text/rich documents, or Open External on package docs */}
				{isText ? (
					<button
						type="button"
						aria-pressed={markupActive}
						onClick={() => {
							setMarkupActive((open) => {
								const next = !open;
								if (next) setAiOpen(true);
								return next;
							});
						}}
						className={cn(
							"inline-flex h-26 items-center gap-5 rounded-6 border px-10 text-meta font-medium transition-colors",
							markupActive
								? "border-accent bg-accent-soft text-accent"
								: "border-border bg-window text-ink-body hover:bg-hover-row",
						)}
						title={t("documentEditor.toolbar.markupToggle")}
					>
						<Highlighter size={13} />
					</button>
				) : onOpenExternal !== undefined ? (
					<button
						type="button"
						onClick={() => onOpenExternal(filePath)}
						className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row"
					>
						<ExternalLink size={13} />
						{t("documentEditor.package.openExternal")}
					</button>
				) : null}

				{/* AI panel toggle */}
				<button
					type="button"
					aria-pressed={aiOpen}
					onClick={() => setAiOpen((open) => !open)}
					className={cn(
						"inline-flex h-26 items-center gap-5 rounded-6 border px-10 text-meta font-medium transition-colors",
						aiOpen
							? "border-accent bg-accent text-on-accent"
							: "border-border bg-window text-ink hover:bg-hover-row",
					)}
				>
					<Sparkles size={13} />
					{t("documentEditor.toolbar.aiToggle")}
				</button>
			</header>

			{/* Banners: truncation, conflict, save error */}
			{textPayload?.truncated ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-warning-soft px-14 py-6 text-meta text-warning">
					<span>{t("documentEditor.truncatedWarning")}</span>
				</div>
			) : null}
			{saveState === "conflict" ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-error-soft px-14 py-6 text-meta text-error" role="alert">
					<span>{t("documentEditor.conflict")}</span>
					<div className="flex items-center gap-6">
						<button
							type="button"
							className="h-24 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink"
							onClick={() => void reloadFile()}
						>
							{t("documentEditor.reload")}
						</button>
						<button
							type="button"
							className="h-24 rounded-6 border-0 bg-error px-10 text-meta font-medium text-white"
							onClick={() => void saveNow(true)}
						>
							{t("documentEditor.overwrite")}
						</button>
					</div>
				</div>
			) : null}
			{saveError !== null ? (
				<div className="flex flex-none items-center justify-between gap-8 border-b border-divider bg-error-soft px-14 py-6 text-meta text-error" role="alert">
					<span>{t("documentEditor.saveFailed", { message: saveError })}</span>
				</div>
			) : null}

			{/* Main editor stage */}
			<div ref={stageRef} className="doc-editor__stage relative flex min-h-0 flex-1 flex-col overflow-hidden">
				{loading && loaded === null ? (
					<div className="flex flex-1 items-center justify-center gap-8 text-body text-ink-muted">
						<Loader2 size={16} className="animate-spin" />
						<span>{t("documentEditor.loading")}</span>
					</div>
				) : loadError !== null ? (
					<div className="flex flex-1 flex-col items-center justify-center gap-10 px-24 text-center">
						<p className="text-body text-error">{t("documentEditor.loadFailed", { message: loadError })}</p>
						<button
							type="button"
							className="h-28 rounded-6 border border-border bg-window px-12 text-meta font-medium text-ink hover:bg-hover-row"
							onClick={() => void reloadFile()}
						>
							{t("documentEditor.reload")}
						</button>
					</div>
				) : loaded?.kind === "package" ? (
					<EmbeddedPackagePreview document={loaded.document} />
				) : textPayload !== null ? (
					canRich && viewMode === "rich" ? (
						<WysiwygDocumentEditor
							format={textPayload.wysiwygFormat!}
							value={text}
							externalVersion={externalVersion}
							readOnly={textPayload.truncated || aiRunning}
							onChange={onTextEdited}
							onSelectionChange={setSelectedText}
						/>
					) : (
						<textarea
							className="doc-editor__source min-h-0 flex-1 resize-none border-0 bg-window px-24 py-18 font-mono text-[13px] leading-[1.65] text-ink outline-none select-text"
							aria-label={loaded?.name ?? filePath}
							value={text}
							readOnly={textPayload.truncated || aiRunning}
							spellCheck={false}
							onChange={(event) => onTextEdited(event.target.value)}
							onSelect={(event) => {
								const el = event.currentTarget;
								const sel = el.value.slice(el.selectionStart, el.selectionEnd).trim();
								setSelectedText(sel);
							}}
						/>
					)
				) : null}

				{/* Interactive mark-up layer (always on for package docs, toggleable on text docs) */}
				{loaded !== null ? (
					<EditorMarkupOverlay
						stageRef={stageRef}
						active={markupActive}
						disabled={aiRunning}
						revision={markupRevision}
						onMarksChange={setMarks}
					/>
				) : null}
			</div>

			{/* Docked AI editing bar */}
			{aiOpen && loaded !== null ? (
				<section
					className="doc-editor__ai flex flex-none flex-col gap-6 border-t border-divider bg-subtle px-14 py-10"
					aria-label={t("documentEditor.ai.title")}
				>
					{aiRun !== null ? (
						<div className="flex items-start gap-8 text-meta" data-edit-state={aiRun.status === "done" ? (aiRun.changed ? "changed" : "unchanged") : aiRun.status} role="status">
							{aiRun.status === "running" ? (
								<>
									<Loader2 size={14} className="mt-2 flex-none animate-spin text-accent" />
									<div className="min-w-0 flex-1">
										<div className="font-medium text-ink">{t("documentEditor.ai.working")}</div>
										{aiRun.progress !== "" ? <div className="truncate text-ink-muted">{aiRun.progress}</div> : null}
										{aiRun.draft !== "" ? (
											<div className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap text-ink-muted">{aiRun.draft}</div>
										) : null}
									</div>
									<button
										type="button"
										className="h-24 flex-none rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row"
										onClick={() => void editorApi.aiCancel(aiRun.runId)}
									>
										{t("common.cancel")}
									</button>
								</>
							) : aiRun.status === "done" ? (
								<>
									<div className="min-w-0 flex-1">
										<div className="font-medium text-ink">
											{aiRun.changed ? t("documentEditor.ai.changed") : t("documentEditor.ai.unchanged")}
										</div>
										{aiRun.reply !== "" ? (
											<div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-ink-muted">{aiRun.reply}</div>
										) : null}
									</div>
									{aiRun.changed ? (
										<button
											type="button"
											className="inline-flex h-24 flex-none items-center gap-4 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row"
											onClick={() => void undoAiEdit()}
										>
											<RotateCcw size={12} />
											{t("documentEditor.ai.undo")}
										</button>
									) : null}
									<button
										type="button"
										aria-label={t("common.close")}
										className="flex size-22 flex-none items-center justify-center rounded-5 border-0 bg-transparent text-ink-muted hover:bg-hover-icon hover:text-ink"
										onClick={() => setAiRun(null)}
									>
										<X size={13} />
									</button>
								</>
							) : aiRun.status === "error" ? (
								<div className="flex-1 text-error" role="alert">
									{t("documentEditor.ai.failed", { message: aiRun.message })}
								</div>
							) : aiRun.status === "cancelled" ? (
								<div className="flex-1 text-ink-muted">{t("documentEditor.ai.cancelled")}</div>
							) : (
								<div className="flex-1 text-ink-muted">{t("documentEditor.ai.undone")}</div>
							)}
						</div>
					) : null}

					<div className="flex items-center gap-8">
						<div className="flex min-w-0 flex-1 items-center gap-6 rounded-9 border border-border bg-window px-10 py-6 focus-within:border-accent">
							<Sparkles size={14} className="flex-none text-accent" />
							<input
								type="text"
								className="min-w-0 flex-1 border-0 bg-transparent text-body text-ink outline-none placeholder:text-ink-faint"
								value={instruction}
								maxLength={MAX_INSTRUCTION}
								disabled={aiRunning}
								aria-label={t("documentEditor.ai.title")}
								placeholder={
									loaded.kind === "package"
										? t("documentEditor.package.hint")
										: t("documentEditor.ai.placeholder")
								}
								onChange={(event) => setInstruction(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
										event.preventDefault();
										void submitAiEdit();
									}
								}}
							/>
							{marks.length > 0 ? (
								<span className="flex-none rounded-full bg-accent-soft px-7 py-1 text-badge font-medium text-accent">
									{t("documentEditor.ai.marksBadge", { count: marks.length })}
								</span>
							) : selectedText !== "" ? (
								<span className="flex-none rounded-full bg-accent-soft px-7 py-1 text-badge font-medium text-accent">
									{t("documentEditor.ai.selectionBadge", { chars: selectedText.length })}
								</span>
							) : null}
						</div>
						<button
							type="button"
							disabled={aiRunning || instruction.trim() === ""}
							onClick={() => void submitAiEdit()}
							className="h-32 flex-none rounded-8 border-0 bg-accent px-14 text-meta font-semibold text-on-accent hover:opacity-90 disabled:opacity-40"
						>
							{t("documentEditor.ai.send")}
						</button>
					</div>
				</section>
			) : null}

			{/* Compact footer with stats & file metadata */}
			<footer className="doc-editor__footer flex h-24 flex-none items-center gap-12 border-t border-divider bg-chrome px-14 text-badge text-ink-muted">
				<span className="truncate font-mono" title={filePath}>
					{filePath}
				</span>
				<span className="flex-1" />
				{textPayload !== null && stats !== null ? (
					<>
						<span>{t("documentEditor.footer.lines", { count: stats.lines.toLocaleString(i18n.language) })}</span>
						<span>{t("documentEditor.footer.words", { count: stats.words.toLocaleString(i18n.language) })}</span>
						<span>{t("documentEditor.footer.chars", { count: stats.chars.toLocaleString(i18n.language) })}</span>
						<span>{textPayload.encoding}</span>
						<span>{ending}</span>
					</>
				) : loaded?.kind === "package" ? (
					<span className="uppercase">{loaded.ext}</span>
				) : null}
			</footer>
		</div>
	);
}
