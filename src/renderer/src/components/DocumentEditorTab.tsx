import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink, FileCode2, FileText, Highlighter, Loader2, Save, Sparkles } from "lucide-react";
import type { AnnotationMark } from "../../../preview/shared/annotation";
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
import { useDocumentEditorSidebar } from "./DocumentEditorSidebarContext";
import { EditorMarkupOverlay } from "./EditorMarkupOverlay";
import { WysiwygDocumentEditor } from "./WysiwygDocumentEditor";

const PdfDocumentEditor = lazy(() => import("./PdfDocumentEditor").then((m) => ({ default: m.PdfDocumentEditor })));

const AUTOSAVE_DELAY_MS = 1000;

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

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
	const lang = i18n.language === "en" || i18n.language === "ja" || i18n.language === "zh" ? i18n.language : "ko";
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
	readonly onOpenEditorFile?: (path: string) => void;
}

/**
 * In-app Document Editor tab rendered inside a Finder pane.
 *
 * - Text-based WYSIWYG files (`.md`, `.markdown`, `.mdx`, `.html`, `.htm`, `.txt`):
 *   TipTap WYSIWYG editor with Rich / Source toggle, formatting toolbar, always-on autosave,
 *   and Cmd/Ctrl+S immediate save.
 * - Code / tabular text files (`.ts`, `.js`, `.py`, `.json`, `.csv`, etc.):
 *   Monospace source editor with always-on autosave and Cmd/Ctrl+S.
 * - Package documents (`.docx`, `.pptx`, `.xlsx`, `.hwp`, `.hwpx`, `.odt`, `.odp`, `.ods`):
 *   Embedded preview + interactive mark-up overlay (pen/box/underline).
 * - PDF documents (`.pdf`):
 *   `PdfDocumentEditor` with signature pad & placement, text stamp, crop, rotate, reorder,
 *   delete, extract pages, and snapshot undo.
 *
 * AI editing chat lives in the right sidebar (`DocumentEditorAiSidebar`), synced via
 * `DocumentEditorSidebarContext` so marks and text selections flow straight into the chat.
 */
export function DocumentEditorTab({ filePath, onOpenExternal, onOpenEditorFile }: DocumentEditorTabProps): ReactElement {
	const { t, i18n } = useTranslation();
	const editorApi = window.autorag.documentEditor;
	const sidebar = useDocumentEditorSidebar();

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
	const [saveState, setSaveState] = useState<SaveState>("saved");
	const [saveError, setSaveError] = useState<string | null>(null);
	const [selectedText, setSelectedText] = useState("");

	// Mark-up overlay state (synced to right-sidebar AI chat)
	const [markupActive, setMarkupActive] = useState(false);
	const [marks, setMarks] = useState<readonly AnnotationMark[]>([]);
	const [markupRevision, setMarkupRevision] = useState(0);

	const stageRef = useRef<HTMLDivElement | null>(null);
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
	const aiRunning = sidebar?.isRunning(filePath) ?? false;

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
			} else if (next.kind === "package") {
				setMarkupActive(true);
				setMarkupRevision((r) => r + 1);
			} else {
				setMarkupActive(false);
			}
		} catch (error: unknown) {
			setLoadError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, [editorApi, filePath]);

	useEffect(() => {
		setMarks([]);
		setSelectedText("");
		void reloadFile();
	}, [reloadFile]);

	const saveNow = useCallback(
		async (force = false): Promise<boolean> => {
			const current = loadedRef.current;
			if (current === null || current.kind !== "text" || current.truncated) return true;
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

	// Always-on debounced autosave whenever text is dirty (except truncated files or unresolved conflicts).
	useEffect(() => {
		if (!dirty || loaded?.kind !== "text" || loaded.truncated || saveState === "conflict") return;
		const timer = window.setTimeout(() => {
			void saveNow(false);
		}, AUTOSAVE_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [dirty, loaded, saveNow, saveState, text]);

	// Publish live marks, selection, and hooks to the right-sidebar AI editing chat.
	const clearMarks = useCallback(() => {
		setMarks([]);
		setMarkupRevision((r) => r + 1);
	}, []);

	const captureRect = useCallback(() => {
		const rect = stageRef.current?.getBoundingClientRect();
		if (rect === undefined || rect.width <= 0 || rect.height <= 0) return undefined;
		return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
	}, []);

	const registerTab = sidebar?.registerTab;
	const unregisterTab = sidebar?.unregisterTab;
	const openRightSidebar = sidebar?.openRightSidebar;

	useEffect(() => {
		if (registerTab === undefined || loaded === null) return;
		registerTab({
			filePath,
			fileName: loaded.name,
			surface: loaded.surface,
			marks,
			selectedText,
			markupActive,
			setMarkupActive: (active) => {
				setMarkupActive(active);
				if (active) openRightSidebar?.();
			},
			clearMarks,
			flushUnsaved: () => saveNow(false),
			reloadAfterAi: reloadFile,
			captureRect,
		});
	}, [registerTab, openRightSidebar, loaded, filePath, marks, selectedText, markupActive, clearMarks, saveNow, reloadFile, captureRect]);

	useEffect(
		() => () => {
			unregisterTab?.(filePath);
		},
		[unregisterTab, filePath],
	);

	// Cmd/Ctrl+S immediate save inside this tab.
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

	const stats = useMemo(() => (loaded?.kind === "text" ? textStats(text) : null), [loaded?.kind, text]);
	const isText = loaded?.kind === "text";
	const textPayload: DocumentEditorTextPayload | null = isText ? loaded : null;
	const canRich = textPayload?.surface === "wysiwyg" && textPayload.wysiwygFormat !== null;

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

				{/* Manual Save trigger (autosave is always on) */}
				{isText ? (
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
				) : null}

				{/* Markup toggle -> opens right-sidebar AI chat when activated */}
				{loaded !== null ? (
					<button
						type="button"
						aria-pressed={markupActive}
						onClick={() => {
							setMarkupActive((open) => {
								const next = !open;
								if (next) sidebar?.openRightSidebar();
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
						{marks.length > 0 ? <span className="tabular-nums">{marks.length}</span> : null}
					</button>
				) : null}

				{loaded?.kind === "package" && onOpenExternal !== undefined ? (
					<button
						type="button"
						onClick={() => onOpenExternal(filePath)}
						className="inline-flex h-26 items-center gap-5 rounded-6 border border-border bg-window px-10 text-meta font-medium text-ink hover:bg-hover-row"
					>
						<ExternalLink size={13} />
						{t("documentEditor.package.openExternal")}
					</button>
				) : null}

				{/* Right-sidebar AI chat button */}
				{loaded !== null && sidebar !== null ? (
					<button
						type="button"
						onClick={() => sidebar.openRightSidebar()}
						className="inline-flex h-26 items-center gap-5 rounded-6 border border-accent bg-accent px-10 text-meta font-medium text-on-accent hover:opacity-90"
					>
						<Sparkles size={13} />
						{t("documentEditor.toolbar.aiToggle")}
					</button>
				) : null}
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
				) : loaded?.kind === "pdf" ? (
					<Suspense
						fallback={
							<div className="flex flex-1 items-center justify-center gap-8 text-body text-ink-muted">
								<Loader2 size={16} className="animate-spin" />
								<span>{t("documentEditor.loading")}</span>
							</div>
						}
					>
						<PdfDocumentEditor
							payload={loaded}
							onPayloadChange={(next) => {
								setLoaded(next);
								setMtimeMs(next.mtimeMs);
							}}
							{...(onOpenExternal === undefined ? {} : { onOpenExternal })}
							{...(onOpenEditorFile === undefined ? {} : { onOpenExtracted: onOpenEditorFile })}
						/>
					</Suspense>
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

				{/* Interactive mark-up layer (annotations stream directly into the right-sidebar AI chat) */}
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
				) : loaded?.kind === "pdf" ? (
					<>
						<span>{t("documentEditor.footer.pages", { count: loaded.pageCount })}</span>
						<span>PDF</span>
					</>
				) : loaded?.kind === "package" ? (
					<span className="uppercase">{loaded.ext}</span>
				) : null}
			</footer>
		</div>
	);
}
