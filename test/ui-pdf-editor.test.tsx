// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/shared/i18n";
import { setAppLanguage } from "../src/shared/i18n";
import type {
	DocumentEditorBridge,
	DocumentEditorPdfPayload,
	PdfApplyRequest,
	PdfChangedEvent,
	PdfFormSaveRequest,
	PdfSplitRequest,
} from "../src/shared/document-editor-contract";
import {
	isPdfApplyRequest,
	isPdfChangedEvent,
	isPdfEditOperation,
	isPdfFormSaveRequest,
	isPdfSplitRequest,
} from "../src/shared/document-editor-contract";
import { PdfDocumentEditor } from "../src/renderer/src/components/PdfDocumentEditor";
import { findPageTextMatches } from "../src/renderer/src/lib/pdf-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mock pdfjs-dist so happy-dom doesn't need a real PDF worker.
vi.mock("pdfjs-dist", () => ({
	GlobalWorkerOptions: { workerSrc: "" },
	getDocument: vi.fn(() => {
		const fakePage = {
			getViewport: () => ({ width: 595, height: 842, transform: [1, 0, 0, -1, 0, 842] }),
			render: () => ({ cancel: vi.fn(), promise: Promise.resolve() }),
			getTextContent: async () => ({
				items: [
					{ str: "Quarterly Revenue Report 2026", transform: [14, 0, 0, 14, 48, 700], width: 210, height: 14 },
					{ str: "Revenue target exceeded", transform: [12, 0, 0, 12, 48, 660], width: 160, height: 12 },
				],
			}),
		};
		const fakeDoc = {
			numPages: 3,
			getPage: vi.fn(async () => fakePage),
		};
		return {
			promise: Promise.resolve(fakeDoc),
			destroy: vi.fn(async () => undefined),
		};
	}),
}));

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "mock-worker.mjs" }));

const MOCK_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function createMockBridge() {
	const applied: PdfApplyRequest[] = [];
	const splits: PdfSplitRequest[] = [];
	const savedForms: PdfFormSaveRequest[] = [];
	const changedListeners = new Set<(ev: PdfChangedEvent) => void>();
	const bridge: DocumentEditorBridge = {
		open: vi.fn(),
		save: vi.fn(),
		pdfApply: vi.fn(async (req) => {
			applied.push(req);
			return {
				ok: true as const,
				size: 1200,
				modifiedAt: new Date().toISOString(),
				mtimeMs: Date.now(),
				pageCount: 3,
				snapshotId: `snap-${applied.length}`,
			};
		}),
		pdfExtract: vi.fn(async () => ({ outputPath: "/tmp/out.pdf", name: "out.pdf", pageCount: 1 })),
		pdfSplit: vi.fn(async (req) => {
			splits.push(req);
			return {
				outputs: [
					{ outputPath: "/tmp/part1.pdf", name: "part1.pdf", pageCount: 2 },
					{ outputPath: "/tmp/part2.pdf", name: "part2.pdf", pageCount: 1 },
				],
			};
		}),
		pdfPickMergeFiles: vi.fn(async () => ["/tmp/extra.pdf"]),
		pdfRestore: vi.fn(async () => ({ ok: true, size: 1000, modifiedAt: new Date().toISOString(), mtimeMs: Date.now(), pageCount: 3 })),
		pdfReadMetadata: vi.fn(async () => ({ title: "Old Title", author: "Alice", subject: "", keywords: "" })),
		pdfReadFormFields: vi.fn(async () => [
			{ name: "full_name", kind: "text" as const, value: "Alice", readOnly: false },
			{ name: "approved", kind: "checkbox" as const, value: false, readOnly: false },
		]),
		pdfSaveFormFields: vi.fn(async (req) => {
			savedForms.push(req);
			return {
				ok: true as const,
				size: 1300,
				modifiedAt: new Date().toISOString(),
				mtimeMs: Date.now(),
				pageCount: 3,
				snapshotId: "snap-form",
			};
		}),
		onPdfChanged: (listener) => {
			changedListeners.add(listener);
			return () => changedListeners.delete(listener);
		},
		aiStart: vi.fn(async () => ({ changed: false })),
		aiCancel: vi.fn(async () => undefined),
		aiUndo: vi.fn(async () => false),
		onAiEvent: () => () => undefined,
	};
	const fsMock = {
		locations: vi.fn(async () => [{ name: "Documents", path: "/tmp", section: "favorites", icon: "documents", available: true, ejectable: false }]),
		listDir: vi.fn(async (dir: string) => ({
			path: dir,
			entries: [
				{ name: "extra.pdf", path: "/tmp/extra.pdf", kind: "file", ext: "pdf", size: 500, mtimeMs: 1, flags: 0 },
				{ name: "logo.png", path: "/tmp/logo.png", kind: "file", ext: "png", size: 300, mtimeMs: 1, flags: 0 },
			],
		})),
		search: vi.fn(async (query: string) => {
			const all = [
				{ entry: { name: "found-banner.png", path: "/tmp/sub/found-banner.png", kind: "file", ext: "png", size: 420, mtimeMs: 2, flags: 0 }, score: 1 },
				{ entry: { name: "extra.pdf", path: "/tmp/extra.pdf", kind: "file", ext: "pdf", size: 500, mtimeMs: 1, flags: 0 }, score: 1 },
			];
			return all.filter((h) => h.entry.name.toLowerCase().includes(query.toLowerCase()));
		}),
		enrichEntries: vi.fn(async () => []),
	};
	(window as unknown as { autorag: { documentEditor: DocumentEditorBridge; fs: typeof fsMock } }).autorag = {
		documentEditor: bridge,
		fs: fsMock,
	};
	return {
		bridge,
		fsMock,
		applied,
		splits,
		savedForms,
		emitPdfChanged: (ev: PdfChangedEvent) => {
			for (const l of changedListeners) l(ev);
		},
	};
}

const BASE_PAYLOAD: DocumentEditorPdfPayload = {
	kind: "pdf",
	surface: "pdf",
	path: "/tmp/sample.pdf",
	name: "sample.pdf",
	ext: "pdf",
	size: 1024,
	modifiedAt: "2026-11-27T00:00:00.000Z",
	mtimeMs: 1764201600000,
	pageCount: 3,
	encrypted: false,
};

beforeEach(async () => {
	await setAppLanguage("en");
	window.localStorage.clear();
	// Stub canvas 2d context in happy-dom for watermark/stamp PNG generators
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		scale: vi.fn(),
		translate: vi.fn(),
		rotate: vi.fn(),
		clearRect: vi.fn(),
		fillText: vi.fn(),
		measureText: vi.fn(() => ({ width: 80 })),
		beginPath: vi.fn(),
		roundRect: vi.fn(),
		fill: vi.fn(),
		stroke: vi.fn(),
		setTransform: vi.fn(),
		drawImage: vi.fn(),
		font: "",
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 1,
		textAlign: "left",
		textBaseline: "top",
	} as unknown as CanvasRenderingContext2D);
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(MOCK_PNG);
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
	vi.restoreAllMocks();
});

async function mountEditor(onPayloadChange = vi.fn()) {
	const mock = createMockBridge();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root!.render(<PdfDocumentEditor payload={BASE_PAYLOAD} onPayloadChange={onPayloadChange} />);
	});
	// Flush microtasks for getDocument().promise
	await act(async () => {
		await Promise.resolve();
	});
	return { ...mock, onPayloadChange };
}

describe("PDF editor contract validators", () => {
	it("accepts all new Acrobat operations and rejects invalid inputs", () => {
		expect(isPdfEditOperation({ kind: "duplicatePage", pageIndex: 0 })).toBe(true);
		expect(isPdfEditOperation({ kind: "insertBlankPage", insertAtIndex: 1, size: "a4" })).toBe(true);
		expect(isPdfEditOperation({ kind: "mergePdfs", sourcePaths: ["/tmp/a.pdf"] })).toBe(true);
		expect(isPdfEditOperation({ kind: "mergePdfs", sourcePaths: [] })).toBe(false);
		expect(isPdfEditOperation({ kind: "highlightRect", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, color: "#FDE047" })).toBe(true);
		expect(isPdfEditOperation({ kind: "highlightRect", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, color: "yellow" })).toBe(false);
		expect(isPdfEditOperation({ kind: "redactRect", pageIndex: 0, x: 0.1, y: 0.1, width: 0.2, height: 0.05, color: "#000000" })).toBe(true);
		expect(isPdfEditOperation({ kind: "drawShape", pageIndex: 0, shape: "arrow", x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.5, strokeColor: "#DC2626", strokeWidthPt: 2 })).toBe(true);
		expect(isPdfEditOperation({ kind: "freehandPath", pageIndex: 0, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }], strokeColor: "#111827", strokeWidthPt: 2 })).toBe(true);
		expect(isPdfEditOperation({ kind: "freehandPath", pageIndex: 0, points: [{ x: 0.1, y: 0.1 }], strokeColor: "#111827", strokeWidthPt: 2 })).toBe(false);
		expect(isPdfEditOperation({ kind: "addWatermark", pngDataUrl: MOCK_PNG, opacity: 0.2, scale: 0.6 })).toBe(true);
		expect(isPdfEditOperation({ kind: "addPageNumbers", position: "bottom-center", format: "ofTotal", startNumber: 1, fontSize: 10, color: "#334155" })).toBe(true);
		expect(isPdfEditOperation({ kind: "setMetadata", metadata: { title: "T", author: "A", subject: "S", keywords: "K" } })).toBe(true);
		expect(isPdfEditOperation({ kind: "flattenForm" })).toBe(true);
		expect(isPdfApplyRequest({ path: "/tmp/a.pdf", operations: [{ kind: "duplicatePage", pageIndex: 0 }] })).toBe(true);
		expect(isPdfSplitRequest({ path: "/tmp/a.pdf", mode: "everyN", chunkSize: 2 })).toBe(true);
		expect(isPdfSplitRequest({ path: "/tmp/a.pdf", mode: "everyN", chunkSize: 0 })).toBe(false);
		expect(isPdfEditOperation({ kind: "addText", pageIndex: 0, text: "Approved 2026", x: 0.1, y: 0.2 })).toBe(true);
		expect(isPdfEditOperation({ kind: "addTextWatermark", text: "CONFIDENTIAL", opacity: 0.25, angleDegrees: 35 })).toBe(true);
		expect(isPdfChangedEvent({ path: "/tmp/a.pdf", size: 500, modifiedAt: "2026-11-27T00:00:00Z", mtimeMs: 123, pageCount: 2, source: "ai", snapshotId: "s1" })).toBe(true);
		expect(isPdfFormSaveRequest({ path: "/tmp/a.pdf", values: { name: "Bob", agree: true }, flatten: true })).toBe(true);
	});
});

describe("PdfDocumentEditor live AI co-editing sync", () => {
	it("live-updates payload and undo stack when onPdfChanged fires from concurrent AI edits", async () => {
		const { emitPdfChanged, onPayloadChange } = await mountEditor();
		await act(async () => {
			emitPdfChanged({
				path: "/tmp/sample.pdf",
				size: 2048,
				modifiedAt: "2026-11-27T01:00:00.000Z",
				mtimeMs: 1764205200000,
				pageCount: 4,
				source: "ai",
				snapshotId: "snap-ai-1",
			});
		});
		expect(onPayloadChange).toHaveBeenCalledWith(
			expect.objectContaining({
				path: "/tmp/sample.pdf",
				size: 2048,
				pageCount: 4,
				mtimeMs: 1764205200000,
			}),
		);
	});
});

describe("PdfDocumentEditor UI (Acrobat tools)", () => {
	it("places the thumbnail rail on the right, never renders native file inputs, and exposes all Acrobat tools + in-app Dazzi file picker", async () => {
		const { applied, splits, savedForms } = await mountEditor();

		// 0. Right-side thumbnail rail (unified with Quick Look) & zero OS native file inputs
		expect(container!.querySelector('[data-pdf-thumbnail-rail="right"]')).not.toBeNull();
		expect(container!.querySelector('input[type="file"]')).toBeNull();

		// 1. Toggle Highlight, Draw, Shapes, Redact (with Black/Whiteout contextual switcher)
		for (const toolId of ["highlight", "draw", "shape", "redact"]) {
			const btn = container!.querySelector(`button[data-pdf-tool="${toolId}"]`) as HTMLButtonElement | null;
			expect(btn).not.toBeNull();
			await act(async () => {
				btn!.click();
			});
			expect(btn!.getAttribute("aria-pressed")).toBe("true");
		}
		const whiteoutToggle = container!.querySelector('button[data-pdf-redact-mode="white"]') as HTMLButtonElement | null;
		expect(whiteoutToggle).not.toBeNull();
		await act(async () => whiteoutToggle!.click());
		expect(whiteoutToggle!.getAttribute("aria-pressed")).toBe("true");

		// 1b. Clicking Image opens real Dazzi Finder modal in List mode (2nd view mode) with SidebarSearch
		const imgBtn = container!.querySelector('button[data-pdf-action="insert-image"]') as HTMLButtonElement;
		expect(imgBtn).not.toBeNull();
		await act(async () => imgBtn.click());
		await act(async () => {
			await Promise.resolve();
		});
		const picker = container!.querySelector('[data-dazzi-file-picker="image"]');
		expect(picker).not.toBeNull();
		expect(picker!.getAttribute("data-picker-view-mode")).toBe("list");
		expect(picker!.querySelector('[role="row"][data-path="/tmp/logo.png"]')).not.toBeNull();
		expect(picker!.querySelector(".sidebar-search input")).not.toBeNull();
		await act(async () => (picker!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click());

		// 2. Preset stamp placement & apply
		const stampMenuBtn = container!.querySelector('button[data-pdf-stamp-menu="true"]') as HTMLButtonElement;
		await act(async () => stampMenuBtn.click());
		const approvedBtn = container!.querySelector('button[data-pdf-preset-stamp="approved"]') as HTMLButtonElement;
		expect(approvedBtn).not.toBeNull();
		await act(async () => approvedBtn.click());
		const commitStamp = container!.querySelector('button[data-pdf-commit-stamp="true"]') as HTMLButtonElement;
		expect(commitStamp).not.toBeNull();
		await act(async () => commitStamp.click());
		expect(applied.at(-1)?.operations[0]?.kind).toBe("stampImage");

		// 3. Document Tools menu -> Duplicate page, Insert blank page, Merge PDFs via real Dazzi Finder picker
		const openMore = async (): Promise<void> => {
			const btn = container!.querySelector('button[data-pdf-more-tools="true"]') as HTMLButtonElement;
			await act(async () => btn.click());
		};

		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="duplicate"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]).toEqual({ kind: "duplicatePage", pageIndex: 0 });

		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="insert-blank"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]).toMatchObject({ kind: "insertBlankPage", size: "match" });

		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="merge"]') as HTMLButtonElement).click());
		await act(async () => {
			await Promise.resolve();
		});
		const pdfPicker = container!.querySelector('[data-dazzi-file-picker="pdf"]');
		expect(pdfPicker).not.toBeNull();
		expect(pdfPicker!.getAttribute("data-picker-view-mode")).toBe("list");
		await act(async () => (pdfPicker!.querySelector('[role="row"][data-path="/tmp/extra.pdf"]') as HTMLDivElement).click());
		await act(async () => (pdfPicker!.querySelector('button[data-dazzi-picker-confirm="true"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]).toEqual({ kind: "mergePdfs", sourcePaths: ["/tmp/extra.pdf"] });

		// 4. Watermark modal
		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="watermark"]') as HTMLButtonElement).click());
		await act(async () => (container!.querySelector('button[data-pdf-watermark-apply="true"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]?.kind).toBe("addWatermark");

		// 5. Page numbers modal
		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="page-numbers"]') as HTMLButtonElement).click());
		await act(async () => (container!.querySelector('button[data-pdf-page-numbers-apply="true"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]?.kind).toBe("addPageNumbers");

		// 6. Split modal
		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="split"]') as HTMLButtonElement).click());
		await act(async () => (container!.querySelector('button[data-pdf-split-run="true"]') as HTMLButtonElement).click());
		expect(splits).toHaveLength(1);
		expect(splits[0]?.mode).toBe("everyN");

		// 7. Properties modal
		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="properties"]') as HTMLButtonElement).click());
		await act(async () => {
			await Promise.resolve();
		});
		await act(async () => (container!.querySelector('button[data-pdf-prop-save="true"]') as HTMLButtonElement).click());
		expect(applied.at(-1)?.operations[0]?.kind).toBe("setMetadata");

		// 8. Forms modal
		await openMore();
		await act(async () => (container!.querySelector('button[data-pdf-action="forms"]') as HTMLButtonElement).click());
		await act(async () => {
			await Promise.resolve();
		});
		const flattenCheck = container!.querySelector('input[data-pdf-form-flatten="true"]') as HTMLInputElement;
		expect(flattenCheck).not.toBeNull();
		await act(async () => flattenCheck.click());
		await act(async () => (container!.querySelector('button[data-pdf-form-save="true"]') as HTMLButtonElement).click());
		expect(savedForms).toHaveLength(1);
		expect(savedForms[0]?.flatten).toBe(true);
	});

	it("supports Cmd/Ctrl+Z keyboard undo and renders exact Find-in-PDF highlight boxes on canvas", async () => {
		vi.useFakeTimers();
		try {
			const { bridge } = await mountEditor();

			// Trigger one PDF edit so undo stack has snap-1
			const moreBtn = container!.querySelector('button[data-pdf-more-tools="true"]') as HTMLButtonElement;
			await act(async () => moreBtn.click());
			await act(async () => (container!.querySelector('button[data-pdf-action="duplicate"]') as HTMLButtonElement).click());

			// Press Cmd+Z on window -> invokes pdfRestore("snap-1")
			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true }));
				await Promise.resolve();
			});
			expect(bridge.pdfRestore).toHaveBeenCalledWith("snap-1");

			// Press Cmd+F -> opens Find bar and highlights matching text boxes on page 1
			await act(async () => {
				window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, bubbles: true, cancelable: true }));
			});
			const findInput = container!.querySelector('input[data-pdf-find-input="true"]') as HTMLInputElement;
			expect(findInput).not.toBeNull();
			const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			await act(async () => {
				nativeSetter.call(findInput, "Revenue");
				findInput.dispatchEvent(new Event("input", { bubbles: true }));
			});
			await act(async () => {
				vi.advanceTimersByTime(200);
				await Promise.resolve();
				await Promise.resolve();
			});
			// 2 occurrences on page 1 across 3 identical mocked pages = 6 total hits; page 1 renders 2 highlight boxes (1 current + 1 match)
			expect(container!.querySelector('[data-pdf-find-count="true"]')?.textContent).toBe("1 / 6");
			expect(container!.querySelectorAll('[data-pdf-find-highlight="current"]')).toHaveLength(1);
			expect(container!.querySelectorAll('[data-pdf-find-highlight="match"]')).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs real SidebarSearch inside DazziFilePickerModal to find images across folders", async () => {
		const { fsMock } = await mountEditor();
		const imgBtn = container!.querySelector('button[data-pdf-action="insert-image"]') as HTMLButtonElement;
		await act(async () => imgBtn.click());
		await act(async () => {
			await Promise.resolve();
		});
		const picker = container!.querySelector('[data-dazzi-file-picker="image"]')!;
		const searchInput = picker.querySelector<HTMLInputElement>(".sidebar-search input")!;
		const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
		await act(async () => {
			nativeSetter.call(searchInput, "banner");
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
			await Promise.resolve();
		});
		expect(fsMock.search).toHaveBeenCalledWith("banner");
		expect(picker.querySelector('[role="row"][data-path="/tmp/sub/found-banner.png"]')).not.toBeNull();
	});
});

describe("findPageTextMatches", () => {
	it("computes merged highlight rectangles across adjacent runs and multiple hits per page", () => {
		const runs = [
			{ text: "Invoice ", x: 40, y: 100, width: 60, height: 14 },
			{ text: "Clause 2026", x: 100, y: 100, width: 88, height: 14 },
			{ text: "Second Invoice Clause", x: 40, y: 140, width: 168, height: 14 },
		];
		const hits = findPageTextMatches(1, runs, "invoice clause");
		expect(hits).toHaveLength(2);
		expect(hits[0]!.pageIndex).toBe(1);
		expect(hits[0]!.rects).toHaveLength(1); // adjacent runs merged cleanly
		expect(hits[0]!.rects[0]!.x).toBeCloseTo(40, 1);
		expect(hits[0]!.rects[0]!.width).toBeGreaterThan(80);
		expect(hits[1]!.rects[0]!.y).toBeCloseTo(140, 1);
	});
});
