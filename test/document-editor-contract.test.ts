import { describe, expect, it } from "vitest";
import {
	documentEditorSurface,
	isDocumentEditorAiCapture,
	isDocumentEditorSaveRequest,
	isPdfApplyRequest,
	isPdfExtractRequest,
	wysiwygFormatForExtension,
} from "../src/shared/document-editor-contract";
import {
	activeTab,
	createTabsState,
	documentEditorPath,
	editorFilePathOf,
	isDocumentEditorTabPath,
	isVirtualTabPath,
	openDocumentEditorTab,
	openTab,
	tabTitle,
} from "../src/renderer/src/state/tabs";
import {
	allTabs,
	createWorkspace,
	focusedPane,
	openOrSelectDocumentEditorInWorkspace,
	updatePaneTabs,
} from "../src/renderer/src/state/workspace";

describe("document editor contract classification", () => {
	it("routes markdown, html, and plain text to WYSIWYG", () => {
		expect(documentEditorSurface("md")).toBe("wysiwyg");
		expect(documentEditorSurface(".markdown")).toBe("wysiwyg");
		expect(documentEditorSurface("html")).toBe("wysiwyg");
		expect(documentEditorSurface("txt")).toBe("wysiwyg");
		expect(wysiwygFormatForExtension("md")).toBe("markdown");
		expect(wysiwygFormatForExtension("htm")).toBe("html");
		expect(wysiwygFormatForExtension("txt")).toBe("plain");
	});

	it("routes code and tabular text files to code editor", () => {
		expect(documentEditorSurface("ts")).toBe("code");
		expect(documentEditorSurface("json")).toBe("code");
		expect(documentEditorSurface("csv")).toBe("code");
		expect(documentEditorSurface("tsv")).toBe("code");
		expect(documentEditorSurface("py")).toBe("code");
	});
	it("routes Office/HWP/OpenDocument to package, PDF to pdf, and rejects media", () => {
		expect(documentEditorSurface("docx")).toBe("package");
		expect(documentEditorSurface("pptx")).toBe("package");
		expect(documentEditorSurface("xlsx")).toBe("package");
		expect(documentEditorSurface("hwpx")).toBe("package");
		expect(documentEditorSurface("hwp")).toBe("package");
		expect(documentEditorSurface("odt")).toBe("package");
		expect(documentEditorSurface("pdf")).toBe("pdf");
		expect(documentEditorSurface(".PDF")).toBe("pdf");
		expect(documentEditorSurface("png")).toBeNull();
		expect(documentEditorSurface("mp4")).toBeNull();
	});

	it("validates PDF apply and extract requests", () => {
		expect(
			isPdfApplyRequest({
				path: "/tmp/doc.pdf",
				operations: [
					{ kind: "stampImage", pageIndex: 0, pngDataUrl: "data:image/png;base64,iVBORw0KGgo=", x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
					{ kind: "rotatePage", pageIndex: 0, deltaDegrees: 90 },
					{ kind: "cropPage", pageIndex: 0, left: 0.1, top: 0.1, width: 0.5, height: 0.5 },
				],
			}),
		).toBe(true);
		expect(isPdfApplyRequest({ path: "/tmp/doc.pdf", operations: [] })).toBe(false);
		expect(isPdfApplyRequest({ path: "/tmp/doc.pdf", operations: [{ kind: "cropPage", pageIndex: 0, left: 0.8, top: 0.1, width: 0.5, height: 0.5 }] })).toBe(false);
		expect(isPdfExtractRequest({ path: "/tmp/doc.pdf", pages: [1, 3] })).toBe(true);
		expect(isPdfExtractRequest({ path: "/tmp/doc.pdf", pages: [0] })).toBe(false);
	});
	it("validates save requests and capture rects", () => {
		expect(isDocumentEditorSaveRequest({ path: "/tmp/a.md", text: "hi" })).toBe(true);
		expect(isDocumentEditorSaveRequest({ path: "/tmp/a.md", text: "hi", ending: "CRLF", expectedMtimeMs: 123, force: false })).toBe(true);
		expect(isDocumentEditorSaveRequest({ path: "", text: "hi" })).toBe(false);
		expect(isDocumentEditorSaveRequest({ path: "/tmp/a.md", text: 42 })).toBe(false);
		expect(isDocumentEditorSaveRequest({ path: "/tmp/a.md", text: "hi", ending: "BAD" })).toBe(false);

		expect(isDocumentEditorAiCapture({})).toBe(true);
		expect(isDocumentEditorAiCapture({ rect: { x: 10, y: 20, width: 400, height: 300 } })).toBe(true);
		expect(isDocumentEditorAiCapture({ rect: { x: 10, y: 20, width: 0, height: 300 } })).toBe(false);
	});
});

describe("document editor tabs and workspace routing", () => {
	it("encodes and decodes editor tab paths as virtual tabs", () => {
		const tabPath = documentEditorPath("/Users/me/Documents/plan.md");
		expect(isDocumentEditorTabPath(tabPath)).toBe(true);
		expect(isVirtualTabPath(tabPath)).toBe(true);
		expect(editorFilePathOf(tabPath)).toBe("/Users/me/Documents/plan.md");
		expect(editorFilePathOf("/Users/me/Documents")).toBeNull();
		expect(tabTitle({ path: tabPath }, { query: "" })).toBe("plan.md");
	});

	it("opens a new editor tab and keeps Cmd+T folder fallback intact", () => {
		const start = createTabsState("/Users/me/Documents");
		const opened = openDocumentEditorTab(start, "/Users/me/Documents/plan.md");
		expect(opened.tabs).toHaveLength(2);
		expect(activeTab(opened).path).toBe(documentEditorPath("/Users/me/Documents/plan.md"));
		const nextFolder = openTab(opened);
		expect(activeTab(nextFolder).path).toBe("/Users/me/Documents");
	});

	it("reuses an existing editor tab for the same file across the workspace", () => {
		let ws = createWorkspace("/Users/me/Documents");
		ws = openOrSelectDocumentEditorInWorkspace(ws, "/Users/me/Documents/plan.md");
		const firstTabId = focusedPane(ws).activeId;
		expect(allTabs(ws)).toHaveLength(2);

		// Switch back to the folder tab, then open the same file again -> focuses existing tab instead of duplicating
		const folderTabId = focusedPane(ws).tabs[0]!.id;
		ws = updatePaneTabs(ws, ws.focusedPaneId, (state) => ({ ...state, activeId: folderTabId }));
		ws = openOrSelectDocumentEditorInWorkspace(ws, "/Users/me/Documents/plan.md");
		expect(allTabs(ws)).toHaveLength(2);
		expect(focusedPane(ws).activeId).toBe(firstTabId);

		// Opening a different file creates a separate editor tab
		ws = openOrSelectDocumentEditorInWorkspace(ws, "/Users/me/Documents/notes.txt");
		expect(allTabs(ws)).toHaveLength(3);
	});
});
