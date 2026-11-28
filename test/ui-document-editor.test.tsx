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
	PdfAssetRequest,
} from "../src/shared/document-editor-contract";
import { DocumentEditorTab } from "../src/renderer/src/components/DocumentEditorTab";
import { DocumentEditorAiSidebar } from "../src/renderer/src/components/DocumentEditorAiSidebar";
import { DocumentEditorSidebarProvider } from "../src/renderer/src/components/DocumentEditorSidebarContext";
import { plainTextToHtml } from "../src/renderer/src/components/WysiwygDocumentEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MockEditorHost {
	readonly bridge: DocumentEditorBridge;
	readonly saves: DocumentEditorSaveRequest[];
	readonly aiStarts: Array<{ readonly runId: string; readonly instruction: string; readonly marksCount: number }>;
	readonly emit: (event: DocumentEditEvent) => void;
	readonly requestAsset: (id: string, request: PdfAssetRequest) => void;
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
	const assetListeners = new Set<(id: string, request: PdfAssetRequest) => void>();
	const saves: DocumentEditorSaveRequest[] = [];
	const aiStarts: Array<{ readonly runId: string; readonly instruction: string; readonly marksCount: number }> = [];

	const bridge: DocumentEditorBridge = {
		open: vi.fn(async () => currentLoad),
		save: vi.fn(async (request) => {
			saves.push(request);
			return nextSaveResult;
		}),
		pdfApply: vi.fn(async () => ({ ok: true as const, size: 100, modifiedAt: new Date().toISOString(), mtimeMs: initial.mtimeMs + 20, pageCount: 1, snapshotId: "snap-1" })),
		pdfExtract: vi.fn(async () => ({ outputPath: "/tmp/out.pdf", name: "out.pdf", pageCount: 1 })),
		pdfSplit: vi.fn(async () => ({ outputs: [{ outputPath: "/tmp/out-p1.pdf", name: "out-p1.pdf", pageCount: 1 }] })),
		pdfPickMergeFiles: vi.fn(async () => []),
		pdfRestore: vi.fn(async () => ({ ok: true })),
		pdfReadMetadata: vi.fn(async () => ({ title: "", author: "", subject: "", keywords: "" })),
		pdfDecodeImage: vi.fn(async () => ({ mime: "image/png" as const, bytes: new Uint8Array() })),
		onPdfAssetRequest: (listener) => {
			assetListeners.add(listener);
			return () => assetListeners.delete(listener);
		},
		pdfAssetReply: vi.fn(async () => undefined),
		pdfReadFormFields: vi.fn(async () => []),
		pdfSaveFormFields: vi.fn(async () => ({ ok: true as const, size: 100, modifiedAt: new Date().toISOString(), mtimeMs: initial.mtimeMs + 25, pageCount: 1, snapshotId: "snap-form-1" })),
		onPdfChanged: () => () => undefined,
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
		requestAsset: (id: string, request: PdfAssetRequest) => {
			for (const listener of assetListeners) listener(id, request);
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
		root!.render(
			<DocumentEditorSidebarProvider onOpenRightSidebar={() => {}}>
				<DocumentEditorTab filePath={filePath} />
				<DocumentEditorAiSidebar filePath={filePath} />
			</DocumentEditorSidebarProvider>,
		);
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
		// Autosave is always on with no checkbox toggle cluttering the header
		expect(el.querySelector('.doc-editor__header input[type="checkbox"]')).toBeNull();

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

		const sidebarEl = el.querySelector<HTMLElement>("[data-document-editor-sidebar]");
		expect(sidebarEl).not.toBeNull();
		const aiInput = sidebarEl!.querySelector<HTMLTextAreaElement>("textarea");
		expect(aiInput).not.toBeNull();

		// Prepare updated disk payload before AI resolves
		host.setLoad({ ...mdLoad, text: "# Plan\n\nDate: Nov 20", mtimeMs: 2000 });

		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		act(() => {
			nativeSetter.call(aiInput, "Change date to Nov 20");
			aiInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const applyBtn = sidebarEl!.querySelector<HTMLButtonElement>('button[aria-label="Apply"]');
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

		expect(sidebarEl!.querySelector('[data-edit-state="changed"]')).not.toBeNull();
		expect(sidebarEl!.textContent).toContain("Updated date to Nov 20.");

		// Trigger Undo AI edit from right sidebar
		const undoBtn = Array.from(sidebarEl!.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Undo AI edit"));
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

	it("enables right-sidebar AI chat composer and markup toggle for PDF tabs", async () => {
		const pdfLoad: DocumentEditorLoad = {
			kind: "pdf",
			surface: "pdf",
			path: "/tmp/contract.pdf",
			name: "contract.pdf",
			ext: "pdf",
			size: 1024,
			modifiedAt: "2026-11-27T00:00:00.000Z",
			mtimeMs: 1000,
			pageCount: 2,
			encrypted: false,
		};
		const host = createMockHost(pdfLoad);
		const el = mountEditor(host, "/tmp/contract.pdf");

		await act(async () => {
			await Promise.resolve();
		});

		// PDF tab omits the redundant DocumentEditorTab header bar and reuses the exact shared right-sidebar chat UI (.customizer-panel)
		expect(el.querySelector(".doc-editor__header")).toBeNull();
		const sidebarEl = el.querySelector<HTMLElement>("[data-document-editor-sidebar]");
		expect(sidebarEl).not.toBeNull();
		expect(sidebarEl!.classList.contains("customizer-panel")).toBe(true);
		expect(sidebarEl!.querySelector(".customizer-panel__empty-logo")).not.toBeNull();
		expect(sidebarEl!.querySelector(".customizer-composer")).not.toBeNull();
		expect(sidebarEl!.textContent).toContain("Mark up for AI");
		const aiInput = sidebarEl!.querySelector<HTMLTextAreaElement>("textarea.customizer-composer__input");
		expect(aiInput).not.toBeNull();

		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
		act(() => {
			nativeSetter.call(aiInput, "Add CONFIDENTIAL watermark and rotate page 2");
			aiInput!.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const applyBtn = sidebarEl!.querySelector<HTMLButtonElement>('button[aria-label="Apply"]');
		expect(applyBtn).not.toBeNull();
		await act(async () => {
			applyBtn!.click();
			await Promise.resolve();
		});

		expect(host.aiStarts).toHaveLength(1);
		expect(host.aiStarts[0]!.instruction).toBe("Add CONFIDENTIAL watermark and rotate page 2");
		expect(sidebarEl!.querySelector(".customizer-turn__user-bubble")?.textContent).toBe("Add CONFIDENTIAL watermark and rotate page 2");
	});

	it("answers the PDF agent's render requests from the open editor and reports failures back", async () => {
		const host = createMockHost({
			kind: "pdf", surface: "pdf", path: "/tmp/contract.pdf", name: "contract.pdf", ext: "pdf",
			size: 1024, modifiedAt: "2026-11-27T00:00:00.000Z", mtimeMs: 1000, pageCount: 2, encrypted: false,
		});
		mountEditor(host, "/tmp/contract.pdf");
		await act(async () => {
			await Promise.resolve();
		});
		const rendered = new Promise<unknown[]>((resolve) => {
			(host.bridge.pdfAssetReply as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => resolve(args));
		});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			scale: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 40 })), beginPath: vi.fn(), roundRect: vi.fn(),
			fill: vi.fn(), stroke: vi.fn(), font: "", fillStyle: "", strokeStyle: "", lineWidth: 1, textAlign: "left", textBaseline: "top",
		} as unknown as CanvasRenderingContext2D);
		vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AAAA");
		await act(async () => {
			host.requestAsset("a-1", { kind: "note", text: "확인 필요", widthPt: 180, fontSizePt: 13, noteColor: "pink" });
		});
		const [id, reply] = await rendered;
		expect(id).toBe("a-1");
		expect(reply).toMatchObject({ ok: true, result: { kind: "png", dataUrl: "data:image/png;base64,AAAA", widthPt: 180 } });

		const failed = new Promise<unknown[]>((resolve) => {
			(host.bridge.pdfAssetReply as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => resolve(args));
		});
		await act(async () => {
			host.requestAsset("a-2", { kind: "stamp", withDate: false });
		});
		expect(await failed).toEqual(["a-2", { ok: false, error: "A stamp needs a preset or a label." }]);
		vi.restoreAllMocks();
	});
});
