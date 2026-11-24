// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/shared/i18n";
import { setAppLanguage } from "../src/shared/i18n";
import type { DocumentEditEvent } from "../src/preview/shared/annotation";
import type {
	DocumentEditorBridge,
	DocumentEditorLoad,
	DocumentEditorSaveRequest,
	DocumentEditorSaveResult,
} from "../src/shared/document-editor-contract";
import { DocumentEditorTab } from "../src/renderer/src/components/DocumentEditorTab";
import { plainTextToHtml } from "../src/renderer/src/components/WysiwygDocumentEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MockEditorHost {
	readonly bridge: DocumentEditorBridge;
	readonly saves: DocumentEditorSaveRequest[];
	readonly aiStarts: Array<{ readonly runId: string; readonly instruction: string; readonly marksCount: number }>;
	readonly emit: (event: DocumentEditEvent) => void;
	setLoad(next: DocumentEditorLoad): void;
	setSaveResult(result: DocumentEditorSaveResult): void;
}

function createMockHost(initial: DocumentEditorLoad): MockEditorHost {
	let currentLoad = initial;
	let nextSaveResult: DocumentEditorSaveResult = {
		ok: true,
		size: 100,
		modifiedAt: new Date().toISOString(),
		mtimeMs: initial.mtimeMs + 10,
	};
	const listeners = new Set<(event: DocumentEditEvent) => void>();
	const saves: DocumentEditorSaveRequest[] = [];
	const aiStarts: Array<{ readonly runId: string; readonly instruction: string; readonly marksCount: number }> = [];

	const bridge: DocumentEditorBridge = {
		open: vi.fn(async () => currentLoad),
		save: vi.fn(async (request) => {
			saves.push(request);
			return nextSaveResult;
		}),
		aiStart: vi.fn(async (runId, request) => {
			aiStarts.push({ runId, instruction: request.instruction, marksCount: request.marks.length });
			return { changed: true };
		}),
		aiCancel: vi.fn(async () => {}),
		aiUndo: vi.fn(async () => true),
		onAiEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};

	return {
		bridge,
		saves,
		aiStarts,
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		setLoad: (next) => {
			currentLoad = next;
		},
		setSaveResult: (result) => {
			nextSaveResult = result;
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(async () => {
	await setAppLanguage("en");
	window.localStorage.clear();
});

afterEach(() => {
	if (root !== null) {
		act(() => root!.unmount());
		root = null;
	}
	if (container !== null) {
		container.remove();
		container = null;
	}
	vi.useRealTimers();
});

function mountEditor(host: MockEditorHost, filePath: string): HTMLDivElement {
	(window as unknown as { autorag: { documentEditor: DocumentEditorBridge } }).autorag = {
		documentEditor: host.bridge,
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(<DocumentEditorTab filePath={filePath} />);
	});
	return container;
}

describe("DocumentEditorTab UI", () => {
	it("converts plain text to escaped paragraph HTML cleanly", () => {
		expect(plainTextToHtml("hello <world>\n\nline 2")).toBe("<p>hello &lt;world&gt;</p><p></p><p>line 2</p>");
	});

	it("renders WYSIWYG markdown editor, switches to Source mode, and autosaves edits", async () => {
		vi.useFakeTimers();
		const mdLoad: DocumentEditorLoad = {
			kind: "text",
			surface: "wysiwyg",
			wysiwygFormat: "markdown",
			path: "/tmp/plan.md",
			name: "plan.md",
			ext: "md",
			text: "# Launch Plan\n\nDate: Nov 15\n",
			encoding: "UTF-8",
			ending: "LF",
			size: 28,
			modifiedAt: "2026-11-24T00:00:00.000Z",
			mtimeMs: 1000,
			truncated: false,
		};
		const host = createMockHost(mdLoad);
		const el = mountEditor(host, "/tmp/plan.md");

		await act(async () => {
			await Promise.resolve();
		});

		// Rich mode toolbar is shown by default for markdown
		expect(el.querySelector(".doc-editor__format-bar")).not.toBeNull();
		expect(el.querySelector(".tiptap")).not.toBeNull();
		// Opening an unmodified markdown file with a trailing newline must stay saved (never spuriously unsaved)
		expect(el.querySelector('[data-save-state="saved"]')).not.toBeNull();

		// Switch to Source mode and edit text directly
		const sourceBtn = Array.from(el.querySelectorAll("button")).find((btn) => btn.textContent === "Source");
		expect(sourceBtn).toBeDefined();
		act(() => {
			sourceBtn!.click();
		});

		const textarea = el.querySelector<HTMLTextAreaElement>("textarea.doc-editor__source");
		expect(textarea).not.toBeNull();
		expect(textarea!.value).toContain("Launch Plan");

		// Trigger a React-compatible change on the textarea
		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		act(() => {
			nativeSetter.call(textarea, "# Launch Plan\n\nDate: Nov 20");
			textarea!.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(el.querySelector('[data-save-state="unsaved"]')).not.toBeNull();

		// Advance past autosave debounce (1000ms)
		await act(async () => {
			vi.advanceTimersByTime(1100);
			await Promise.resolve();
		});

		expect(host.saves).toHaveLength(1);
		expect(host.saves[0]).toMatchObject({
			path: "/tmp/plan.md",
			text: "# Launch Plan\n\nDate: Nov 20",
			ending: "LF",
			expectedMtimeMs: 1000,
		});
		expect(el.querySelector('[data-save-state="saved"]')).not.toBeNull();
	});

	it("handles external conflict banner with Overwrite action", async () => {
		const codeLoad: DocumentEditorLoad = {
			kind: "text",
			surface: "code",
			wysiwygFormat: null,
			path: "/tmp/app.ts",
			name: "app.ts",
			ext: "ts",
			text: "export const n = 1;\n",
			encoding: "UTF-8",
			ending: "LF",
			size: 20,
			modifiedAt: "2026-11-24T00:00:00.000Z",
			mtimeMs: 2000,
			truncated: false,
		};
		const host = createMockHost(codeLoad);
		host.setSaveResult({ ok: false, reason: "conflict", diskMtimeMs: 3000 });
		const el = mountEditor(host, "/tmp/app.ts");

		await act(async () => {
			await Promise.resolve();
		});

		// Code files open directly in source textarea without rich formatting bar
		expect(el.querySelector(".doc-editor__format-bar")).toBeNull();
		const textarea = el.querySelector<HTMLTextAreaElement>("textarea.doc-editor__source");
		expect(textarea).not.toBeNull();

		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		act(() => {
			nativeSetter.call(textarea, "export const n = 2;\n");
			textarea!.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const saveBtn = Array.from(el.querySelectorAll("button")).find((btn) => btn.textContent?.includes("Save"));
		expect(saveBtn).toBeDefined();
		await act(async () => {
			saveBtn!.click();
			await Promise.resolve();
		});

		expect(el.textContent).toContain("changed on disk outside Dazzi");

		host.setSaveResult({ ok: true, size: 20, modifiedAt: "2026-11-24T00:01:00.000Z", mtimeMs: 4000 });
		const overwriteBtn = Array.from(el.querySelectorAll("button")).find((btn) => btn.textContent === "Overwrite");
		expect(overwriteBtn).toBeDefined();
		await act(async () => {
			overwriteBtn!.click();
			await Promise.resolve();
		});

		expect(host.saves.at(-1)?.force).toBe(true);
		expect(el.querySelector('[data-save-state="saved"]')).not.toBeNull();
	});

	it("runs AI edit, reloads updated text, and supports Undo AI edit", async () => {
		const mdLoad: DocumentEditorLoad = {
			kind: "text",
			surface: "wysiwyg",
			wysiwygFormat: "markdown",
			path: "/tmp/plan.md",
			name: "plan.md",
			ext: "md",
			text: "# Plan\n\nDate: Nov 15",
			encoding: "UTF-8",
			ending: "LF",
			size: 20,
			modifiedAt: "2026-11-24T00:00:00.000Z",
			mtimeMs: 1000,
			truncated: false,
		};
		const host = createMockHost(mdLoad);
		const el = mountEditor(host, "/tmp/plan.md");

		await act(async () => {
			await Promise.resolve();
		});

		const aiInput = el.querySelector<HTMLInputElement>('.doc-editor__ai input[type="text"]');
		expect(aiInput).not.toBeNull();

		// Prepare updated disk payload before AI resolves
		host.setLoad({ ...mdLoad, text: "# Plan\n\nDate: Nov 20", mtimeMs: 2000 });

		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		act(() => {
			nativeSetter.call(aiInput, "Change date to Nov 20");
			aiInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const applyBtn = Array.from(el.querySelectorAll<HTMLButtonElement>(".doc-editor__ai button")).find((b) => b.textContent === "Apply");
		expect(applyBtn).toBeDefined();
		await act(async () => {
			applyBtn!.click();
			await Promise.resolve();
		});

		expect(host.aiStarts).toHaveLength(1);
		const runId = host.aiStarts[0]!.runId;
		act(() => {
			host.emit({ type: "done", runId, path: "/tmp/plan.md", changed: true, reply: "Updated date to Nov 20." });
		});

		expect(el.querySelector('[data-edit-state="changed"]')).not.toBeNull();
		expect(el.textContent).toContain("Updated date to Nov 20.");

		// Trigger Undo AI edit
		const undoBtn = Array.from(el.querySelectorAll<HTMLButtonElement>(".doc-editor__ai button")).find((b) => b.textContent?.includes("Undo AI edit"));
		expect(undoBtn).toBeDefined();
		await act(async () => {
			undoBtn!.click();
			await Promise.resolve();
		});
		act(() => {
			host.emit({ type: "undone", runId, path: "/tmp/plan.md" });
		});
		expect(host.bridge.aiUndo).toHaveBeenCalledWith(runId);
		expect(el.querySelector('[data-edit-state="undone"]')).not.toBeNull();
	});
});
