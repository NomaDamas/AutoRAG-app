import { useEffect, useMemo, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Placeholder from "@tiptap/extension-placeholder";
import {
	Bold,
	Code,
	Code2,
	Heading1,
	Heading2,
	Heading3,
	Italic,
	List,
	ListOrdered,
	ListTodo,
	Minus,
	Quote,
	Redo2,
	Strikethrough,
	Table,
	Undo2,
} from "lucide-react";
import type { WysiwygFormat } from "../../../shared/document-editor-contract";
import { cn } from "../lib/cn";

export interface WysiwygEditorProps {
	readonly format: WysiwygFormat;
	/** Source text stored on disk / current buffer. */
	readonly value: string;
	/** Incremented when disk reloads (e.g. after AI edit or Undo) so the editor adopts `value` cleanly. */
	readonly externalVersion: number;
	readonly readOnly?: boolean;
	readonly onChange: (nextText: string) => void;
	readonly onSelectionChange?: (selectedText: string) => void;
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts plain text lines into simple HTML paragraphs for TipTap while preserving blank lines. */
export function plainTextToHtml(text: string): string {
	if (text === "") return "<p></p>";
	return text
		.split("\n")
		.map((line) => (line === "" ? "<p></p>" : `<p>${escapeHtml(line)}</p>`))
		.join("");
}

/** Extracts plain text paragraphs from TipTap editor without introducing Markdown syntax. */
export function editorToPlainText(editor: { getText(options?: { blockSeparator?: string }): string }): string {
	return editor.getText({ blockSeparator: "\n" });
}

const FORMAT_BTN =
	"flex size-26 flex-none items-center justify-center rounded-6 border-0 bg-transparent text-ink-body transition-colors hover:bg-hover-icon hover:text-ink disabled:opacity-35";
const FORMAT_BTN_ACTIVE = "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent";

/**
 * TipTap v3 WYSIWYG editor tailored to Dazzi's v7 Bloom surface.
 * - `markdown`: native `@tiptap/markdown` round-trip (`contentType: "markdown"` / `editor.getMarkdown()`).
 * - `html`: native HTML parsing/serialization (`editor.getHTML()`).
 * - `plain`: paragraph-per-line rich editing serialized back as plain text.
 */
export function WysiwygDocumentEditor({
	format,
	value,
	externalVersion,
	readOnly = false,
	onChange,
	onSelectionChange,
}: WysiwygEditorProps): ReactElement {
	const { t } = useTranslation();
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSelectionRef = useRef(onSelectionChange);
	onSelectionRef.current = onSelectionChange;
	/** Prevents our own `setContent` sync from echoing back as an edit. */
	const syncingRef = useRef(false);
	/** Tracks the last text emitted or loaded by the editor so initial/sync normalization never marks the file dirty. */
	const lastEmittedRef = useRef(value);
	const baselineRef = useRef<string | null>(null);
	const lastExternalVersionRef = useRef(externalVersion);
	const readyRef = useRef(false);
	const lastDocRef = useRef<unknown>(null);
	const extensions = useMemo(
		() => [
			StarterKit.configure({
				heading: { levels: [1, 2, 3] },
			}),
			...(format === "markdown" ? [Markdown.configure({ indentation: { style: "space", size: 2 } })] : []),
			TableKit.configure({
				table: { resizable: false },
			}),
			TaskList,
			TaskItem.configure({ nested: true }),
			Placeholder.configure({
				placeholder: t("documentEditor.placeholder"),
			}),
		],
		[format, t],
	);

	const initialContent = useMemo(() => {
		if (format === "plain") return plainTextToHtml(value);
		return value;
	}, [format, value]);

	const editor = useEditor(
		{
			extensions,
			content: initialContent,
			...(format === "markdown" ? { contentType: "markdown" as const } : {}),
			editable: !readOnly,
			immediatelyRender: true,
			shouldRerenderOnTransaction: true,
			onCreate: ({ editor: instance }) => {
				lastDocRef.current = instance.state.doc;
				baselineRef.current =
					format === "markdown"
						? instance.getMarkdown()
						: format === "html"
							? instance.getHTML()
							: editorToPlainText(instance);
				readyRef.current = true;
			},
			onUpdate: ({ editor: instance, transaction }) => {
				if (syncingRef.current || !readyRef.current || !transaction.docChanged) return;
				if (lastDocRef.current !== null && instance.state.doc.eq(lastDocRef.current as typeof instance.state.doc)) return;
				const next =
					format === "markdown"
						? instance.getMarkdown()
						: format === "html"
							? instance.getHTML()
							: editorToPlainText(instance);
				if (baselineRef.current !== null && next === baselineRef.current) {
					lastDocRef.current = instance.state.doc;
					return;
				}
				// Ignore any non-user programmatic initialization transaction before the user focuses or clicks the toolbar.
				if (!instance.isFocused && transaction.getMeta("pointer") === undefined && transaction.getMeta("inputType") === undefined) {
					lastDocRef.current = instance.state.doc;
					baselineRef.current = next;
					return;
				}
				lastDocRef.current = instance.state.doc;
				baselineRef.current = null;
				lastEmittedRef.current = next;
				onChangeRef.current(next);
			},
			onSelectionUpdate: ({ editor: instance }) => {
				const { from, to } = instance.state.selection;
				const selected = from === to ? "" : instance.state.doc.textBetween(from, to, "\n").trim();
				onSelectionRef.current?.(selected);
			},
		},
		[extensions],
	);

	useEffect(() => {
		if (editor === null) return;
		editor.setEditable(!readOnly);
	}, [editor, readOnly]);

	useEffect(() => {
		if (editor === null) return;
		const versionChanged = externalVersion !== lastExternalVersionRef.current;
		if (!versionChanged && value === lastEmittedRef.current) return;
		lastExternalVersionRef.current = externalVersion;
		lastEmittedRef.current = value;
		syncingRef.current = true;
		try {
			if (format === "markdown") {
				editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
			} else if (format === "html") {
				editor.commands.setContent(value, { emitUpdate: false });
			} else {
				editor.commands.setContent(plainTextToHtml(value), { emitUpdate: false });
			}
			lastDocRef.current = editor.state.doc;
			baselineRef.current =
				format === "markdown"
					? editor.getMarkdown()
					: format === "html"
						? editor.getHTML()
						: editorToPlainText(editor);
		} finally {
			syncingRef.current = false;
		}
	}, [editor, format, value, externalVersion]);

	const richControls = format !== "plain";

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{richControls && editor !== null ? (
				<div
					className="doc-editor__format-bar flex flex-none flex-wrap items-center gap-2 border-b border-divider bg-subtle px-14 py-6"
					role="toolbar"
					aria-label={t("documentEditor.modes.rich")}
				>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("bold") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.bold")}
						title={t("documentEditor.toolbar.bold")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleBold().run()}
					>
						<Bold size={14} strokeWidth={2.2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("italic") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.italic")}
						title={t("documentEditor.toolbar.italic")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleItalic().run()}
					>
						<Italic size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("strike") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.strike")}
						title={t("documentEditor.toolbar.strike")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleStrike().run()}
					>
						<Strikethrough size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("code") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.code")}
						title={t("documentEditor.toolbar.code")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleCode().run()}
					>
						<Code size={14} strokeWidth={2} />
					</button>
					<span className="mx-4 h-14 w-px bg-divider" aria-hidden="true" />
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("heading", { level: 1 }) && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.h1")}
						title={t("documentEditor.toolbar.h1")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
					>
						<Heading1 size={15} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("heading", { level: 2 }) && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.h2")}
						title={t("documentEditor.toolbar.h2")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
					>
						<Heading2 size={15} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("heading", { level: 3 }) && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.h3")}
						title={t("documentEditor.toolbar.h3")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
					>
						<Heading3 size={15} strokeWidth={2} />
					</button>
					<span className="mx-4 h-14 w-px bg-divider" aria-hidden="true" />
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("bulletList") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.bulletList")}
						title={t("documentEditor.toolbar.bulletList")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleBulletList().run()}
					>
						<List size={15} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("orderedList") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.orderedList")}
						title={t("documentEditor.toolbar.orderedList")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleOrderedList().run()}
					>
						<ListOrdered size={15} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("taskList") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.taskList")}
						title={t("documentEditor.toolbar.taskList")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleTaskList().run()}
					>
						<ListTodo size={15} strokeWidth={2} />
					</button>
					<span className="mx-4 h-14 w-px bg-divider" aria-hidden="true" />
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("blockquote") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.quote")}
						title={t("documentEditor.toolbar.quote")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleBlockquote().run()}
					>
						<Quote size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("codeBlock") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.codeBlock")}
						title={t("documentEditor.toolbar.codeBlock")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().toggleCodeBlock().run()}
					>
						<Code2 size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={cn(FORMAT_BTN, editor.isActive("table") && FORMAT_BTN_ACTIVE)}
						aria-label={t("documentEditor.toolbar.table")}
						title={t("documentEditor.toolbar.table")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
					>
						<Table size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={FORMAT_BTN}
						aria-label={t("documentEditor.toolbar.rule")}
						title={t("documentEditor.toolbar.rule")}
						disabled={readOnly}
						onClick={() => editor.chain().focus().setHorizontalRule().run()}
					>
						<Minus size={14} strokeWidth={2} />
					</button>
					<span className="mx-4 h-14 w-px bg-divider" aria-hidden="true" />
					<button
						type="button"
						className={FORMAT_BTN}
						aria-label={t("documentEditor.toolbar.undo")}
						title={t("documentEditor.toolbar.undo")}
						disabled={readOnly || !editor.can().undo()}
						onClick={() => editor.chain().focus().undo().run()}
					>
						<Undo2 size={14} strokeWidth={2} />
					</button>
					<button
						type="button"
						className={FORMAT_BTN}
						aria-label={t("documentEditor.toolbar.redo")}
						title={t("documentEditor.toolbar.redo")}
						disabled={readOnly || !editor.can().redo()}
						onClick={() => editor.chain().focus().redo().run()}
					>
						<Redo2 size={14} strokeWidth={2} />
					</button>
				</div>
			) : null}
			<div className="doc-editor__prose min-h-0 flex-1 overflow-auto bg-window">
				<div className="mx-auto min-h-full max-w-[780px] px-36 py-28">
					<EditorContent editor={editor} />
				</div>
			</div>
		</div>
	);
}
