import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { AnnotationMark, DocumentEditEvent } from "../../../preview/shared/annotation";
import type { DocumentEditorSurface } from "../../../shared/document-editor-contract";

export interface EditorAiTurn {
	readonly id: string;
	readonly instruction: string;
	readonly marksCount: number;
	readonly selectionChars: number;
	readonly status: "running" | "done" | "error" | "cancelled" | "undone";
	readonly changed: boolean;
	readonly progress: string;
	readonly draft: string;
	readonly reply: string;
	readonly error: string | null;
}

export interface DocumentEditorTabRegistration {
	readonly filePath: string;
	readonly fileName: string;
	readonly surface: DocumentEditorSurface;
	readonly marks: readonly AnnotationMark[];
	readonly selectedText: string;
	readonly markupActive: boolean;
	readonly setMarkupActive: (active: boolean) => void;
	readonly clearMarks: () => void;
	readonly flushUnsaved: () => Promise<boolean>;
	readonly reloadAfterAi: () => Promise<void>;
	readonly captureRect: () => { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined;
}

export interface DocumentEditorSidebarValue {
	registerTab(reg: DocumentEditorTabRegistration): void;
	unregisterTab(filePath: string): void;
	getTab(filePath: string): DocumentEditorTabRegistration | null;
	turnsFor(filePath: string): readonly EditorAiTurn[];
	isRunning(filePath: string): boolean;
	clearTurns(filePath: string): void;
	sendInstruction(filePath: string, instruction: string): Promise<void>;
	cancelRun(filePath: string): Promise<void>;
	undoTurn(filePath: string, runId: string): Promise<void>;
	openRightSidebar(): void;
}

const DocumentEditorSidebarContext = createContext<DocumentEditorSidebarValue | null>(null);

export function useDocumentEditorSidebar(): DocumentEditorSidebarValue | null {
	return useContext(DocumentEditorSidebarContext);
}

export function DocumentEditorSidebarProvider({
	onOpenRightSidebar,
	children,
}: {
	readonly onOpenRightSidebar: () => void;
	readonly children: ReactNode;
}): ReactElement {
	const [tabs, setTabs] = useState<ReadonlyMap<string, DocumentEditorTabRegistration>>(() => new Map());
	const [turnsByFile, setTurnsByFile] = useState<ReadonlyMap<string, readonly EditorAiTurn[]>>(() => new Map());
	const tabsRef = useRef(tabs);
	tabsRef.current = tabs;
	const openSidebarRef = useRef(onOpenRightSidebar);
	openSidebarRef.current = onOpenRightSidebar;
	const openRightSidebar = useCallback(() => openSidebarRef.current(), []);
	const runToFileRef = useRef<Map<string, string>>(new Map());

	const updateTurn = useCallback((filePath: string, runId: string, updater: (turn: EditorAiTurn) => EditorAiTurn) => {
		setTurnsByFile((current) => {
			const list = current.get(filePath);
			if (list === undefined) return current;
			const next = new Map(current);
			next.set(
				filePath,
				list.map((turn) => (turn.id === runId ? updater(turn) : turn)),
			);
			return next;
		});
	}, []);

	// Subscribe once to main-process AI document-edit events and route by runId -> filePath.
	useEffect(() => {
		const api = window.autorag?.documentEditor;
		if (api === undefined) return;
		return api.onAiEvent((event: DocumentEditEvent) => {
			const filePath = runToFileRef.current.get(event.runId);
			if (filePath === undefined) return;
			updateTurn(filePath, event.runId, (turn) => {
				switch (event.type) {
					case "started":
						return turn;
					case "progress":
						return turn.status === "running" ? { ...turn, progress: event.text } : turn;
					case "draft":
						return turn.status === "running" ? { ...turn, draft: event.text } : turn;
					case "done":
						return { ...turn, status: "done", changed: event.changed, reply: event.reply, error: null };
					case "error":
						return { ...turn, status: "error", error: event.message };
					case "cancelled":
						return { ...turn, status: "cancelled" };
					case "undone":
						return { ...turn, status: "undone", changed: false };
				}
			});
		});
	}, [updateTurn]);

	const registerTab = useCallback((reg: DocumentEditorTabRegistration) => {
		setTabs((current) => {
			const next = new Map(current);
			next.set(reg.filePath, reg);
			return next;
		});
	}, []);

	const unregisterTab = useCallback((filePath: string) => {
		setTabs((current) => {
			if (!current.has(filePath)) return current;
			const next = new Map(current);
			next.delete(filePath);
			return next;
		});
	}, []);

	const getTab = useCallback((filePath: string): DocumentEditorTabRegistration | null => tabs.get(filePath) ?? null, [tabs]);

	const turnsFor = useCallback((filePath: string): readonly EditorAiTurn[] => turnsByFile.get(filePath) ?? [], [turnsByFile]);

	const isRunning = useCallback(
		(filePath: string): boolean => (turnsByFile.get(filePath) ?? []).some((turn) => turn.status === "running"),
		[turnsByFile],
	);

	const clearTurns = useCallback((filePath: string) => {
		setTurnsByFile((current) => {
			if (!current.has(filePath)) return current;
			const next = new Map(current);
			next.delete(filePath);
			return next;
		});
	}, []);

	const sendInstruction = useCallback(
		async (filePath: string, rawInstruction: string) => {
			const api = window.autorag?.documentEditor;
			const reg = tabsRef.current.get(filePath);
			const trimmed = rawInstruction.trim();
			if (api === undefined || reg === undefined || trimmed === "") return;

			const flushed = await reg.flushUnsaved();
			if (!flushed) return;

			const runId = `doc-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			runToFileRef.current.set(runId, filePath);

			const marks = reg.marks;
			const selectedText = reg.selectedText;
			const turn: EditorAiTurn = {
				id: runId,
				instruction: trimmed,
				marksCount: marks.length,
				selectionChars: marks.length === 0 ? selectedText.length : 0,
				status: "running",
				changed: false,
				progress: "",
				draft: "",
				reply: "",
				error: null,
			};
			setTurnsByFile((current) => {
				const next = new Map(current);
				next.set(filePath, [...(current.get(filePath) ?? []), turn]);
				return next;
			});

			const promptInstruction =
				selectedText !== "" && marks.length === 0
					? `${trimmed}\n\nSelected text in editor:\n"""\n${selectedText.slice(0, 2000)}\n"""`
					: trimmed;

			const rect = reg.captureRect();
			const capture = rect === undefined ? undefined : { rect };

			try {
				const outcome = await api.aiStart(runId, { path: filePath, instruction: promptInstruction, marks }, capture);
				if (outcome.changed) {
					reg.clearMarks();
					await reg.reloadAfterAi();
				}
			} catch (error: unknown) {
				updateTurn(filePath, runId, (curr) => ({
					...curr,
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		},
		[updateTurn],
	);

	const cancelRun = useCallback(async (filePath: string) => {
		const api = window.autorag?.documentEditor;
		if (api === undefined) return;
		const running = (turnsByFile.get(filePath) ?? []).find((turn) => turn.status === "running");
		if (running !== undefined) {
			await api.aiCancel(running.id);
		}
	}, [turnsByFile]);

	const undoTurn = useCallback(async (filePath: string, runId: string) => {
		const api = window.autorag?.documentEditor;
		const reg = tabsRef.current.get(filePath);
		if (api === undefined) return;
		const undone = await api.aiUndo(runId);
		if (undone && reg !== undefined) {
			await reg.reloadAfterAi();
		}
	}, []);

	const value = useMemo<DocumentEditorSidebarValue>(
		() => ({
			registerTab,
			unregisterTab,
			getTab,
			turnsFor,
			isRunning,
			clearTurns,
			sendInstruction,
			cancelRun,
			undoTurn,
			openRightSidebar,
		}),
		[registerTab, unregisterTab, getTab, turnsFor, isRunning, clearTurns, sendInstruction, cancelRun, undoTurn, openRightSidebar],
	);

	return <DocumentEditorSidebarContext value={value}>{children}</DocumentEditorSidebarContext>;
}
