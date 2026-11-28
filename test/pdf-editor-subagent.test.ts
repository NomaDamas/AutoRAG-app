import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSubagentsPrompt, createSubagentTool, normalizeSubagents, type SubagentDefinition } from "@autorag/librarian";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDocumentEditService, type DocumentEditIo } from "../src/main/document-edit-service";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";
import { createOriginalCopier, originalCopyName } from "../src/main/pdf-original-copy";
import {
	createPdfEditorSubagent,
	PDF_EDITOR_SUBAGENT_DESCRIPTION,
	PDF_EDITOR_SUBAGENT_GUIDANCE,
	PDF_EDITOR_SUBAGENT_NAME,
	pdfTargets,
} from "../src/main/pdf-editor-subagent";
import type { DocumentEditEvent, DocumentEditRequest } from "../src/preview/shared/annotation";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pdf-subagent-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

type ToolText = { content: Array<{ type: string; text?: string }>; details: { results: Array<{ agent: string; isError: boolean; changedFiles: string[] }> } };
async function delegate(definition: SubagentDefinition, params: Record<string, unknown>, signal?: AbortSignal): Promise<ToolText> {
	const tool = createSubagentTool(normalizeSubagents([definition]));
	return (await tool.execute("call-1", params as never, signal)) as unknown as ToolText;
}

/** A copier stand-in: names the copy without touching disk. */
const fakeCopy = async (path: string): Promise<string> => `${path}.original-copy`;

/** A DocumentEditService stand-in that replays `events` for each run and reports `changed`. */
function fakeService(script: (runId: string, request: DocumentEditRequest, io: DocumentEditIo) => Promise<{ changed: boolean }>) {
	const starts: DocumentEditRequest[] = [];
	const cancels: string[] = [];
	return {
		starts,
		cancels,
		service: {
			start: async (runId: string, request: DocumentEditRequest, io: DocumentEditIo) => {
				starts.push(request);
				return script(runId, request, io);
			},
			cancel: async (runId: string) => {
				cancels.push(runId);
			},
		},
	};
}

describe("pdf-editor subagent definition", () => {
	it("finds the PDF in files first, else absolute .pdf paths written in the task", () => {
		expect(pdfTargets("x", ["/a/b.pdf", "/a/notes.txt", "relative.pdf"])).toEqual(["/a/b.pdf"]);
		// Quoted paths keep their spaces (macOS folders like "Mobile Documents"); bare paths end at whitespace or punctuation.
		expect(pdfTargets('stamp "/Users/me/Docs/계약서 v2.pdf" and /tmp/other.PDF, please', [])).toEqual(["/Users/me/Docs/계약서 v2.pdf", "/tmp/other.PDF"]);
		expect(pdfTargets("stamp /tmp/a.pdf, then /tmp/a.pdf", [])).toEqual(["/tmp/a.pdf"]);
		expect(pdfTargets("no file here", [])).toEqual([]);
	});

	it("is a static, file-changing definition so the main agent's prompt stays cache-stable", () => {
		const a = createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: fakeService(async () => ({ changed: false })).service });
		const b = createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: fakeService(async () => ({ changed: true })).service });
		expect(a.name).toBe(PDF_EDITOR_SUBAGENT_NAME);
		expect(a.mutatesFiles).toBe(true);
		expect(a.description).toBe(PDF_EDITOR_SUBAGENT_DESCRIPTION);
		expect(a.guidance).toBe(PDF_EDITOR_SUBAGENT_GUIDANCE);
		// Two separately built definitions give byte-identical prompt sections (no timestamps, ids, or per-run data).
		expect(buildSubagentsPrompt(normalizeSubagents([a]))).toBe(buildSubagentsPrompt(normalizeSubagents([b])));
		expect(buildSubagentsPrompt(normalizeSubagents([a]))).toContain("Delegate every change to a PDF");
	});

	it("streams the edit agent's progress, returns its reply, and reports the changed file", async () => {
		const updates: string[] = [];
		const fake = fakeService(async (runId, request, io) => {
			io.send({ type: "progress", runId, text: "Finding the text" });
			io.send({ type: "progress", runId: "someone-else", text: "ignored" });
			io.send({ type: "done", runId, path: request.path, changed: true, reply: "Stamped page 1 and verified it visually." });
			return { changed: true };
		});
		const definition = createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: fake.service });
		const result = await definition.run({ task: "stamp page 1", files: ["/tmp/a.pdf"] }, { onUpdate: (text) => updates.push(text) });
		expect(fake.starts).toEqual([{ path: "/tmp/a.pdf", instruction: "stamp page 1", marks: [] }]);
		expect(updates).toEqual(["Original saved as /tmp/a.pdf.original-copy", "Finding the text"]);
		expect(result).toMatchObject({ isError: false, changedFiles: ["/tmp/a.pdf"] });
		expect(result.output).toBe("/tmp/a.pdf: edited.\nOriginal (before this edit) saved as: /tmp/a.pdf.original-copy\nStamped page 1 and verified it visually.");
	});

	it("reports a missing PDF and a failed edit as errors, and cancels the edit run when the main agent aborts", async () => {
		const none = createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: fakeService(async () => ({ changed: false })).service });
		expect(await none.run({ task: "stamp it", files: [] }, {})).toMatchObject({ isError: true, output: expect.stringMatching(/absolute path/) });

		const failing = createPdfEditorSubagent({
			saveOriginalCopy: fakeCopy,
			service: fakeService(async (runId, _request, io) => {
				io.send({ type: "error", runId, message: "quota exceeded" });
				return { changed: false };
			}).service,
		});
		expect(await failing.run({ task: "x", files: ["/tmp/a.pdf"] }, {})).toMatchObject({
			isError: true,
			output: "/tmp/a.pdf: failed — quota exceeded\nOriginal (before this edit) saved as: /tmp/a.pdf.original-copy",
		});

		const controller = new AbortController();
		const slow = fakeService(async (runId, _request, io) => {
			controller.abort();
			io.send({ type: "cancelled", runId });
			return { changed: false };
		});
		const cancelled = await createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: slow.service }).run({ task: "x", files: ["/tmp/a.pdf"] }, { signal: controller.signal });
		expect(slow.cancels).toHaveLength(1);
		expect(cancelled.output).toMatch(/cancelled/);
	});

	it("passes the editor renderer through, tagged with the edit run", async () => {
		const renderAsset = vi.fn(async () => ({ kind: "png" as const, dataUrl: "data:image/png;base64,AAAA", aspect: 1 }));
		const fake = fakeService(async (runId, _request, io) => {
			await io.renderAsset?.({ kind: "stamp", preset: "approved", withDate: true });
			io.send({ type: "done", runId, path: "/tmp/a.pdf", changed: true, reply: "ok" });
			return { changed: true };
		});
		await createPdfEditorSubagent({ saveOriginalCopy: fakeCopy, service: fake.service, renderAsset, makeRunId: () => "subagent-pdf-1" }).run({ task: "x", files: ["/tmp/a.pdf"] }, {});
		expect(renderAsset).toHaveBeenCalledWith({ kind: "stamp", preset: "approved", withDate: true }, "subagent-pdf-1");
	});
});

describe("original copy before a main-agent edit", () => {
	it("names copies by language and time, copies byte for byte under the PDF's lock, and never overwrites", async () => {
		const at = new Date(2026, 10, 28, 9, 5, 7);
		expect(originalCopyName("/d/계약서.pdf", "원본", at)).toBe("계약서 (원본 2026-11-28 09.05.07).pdf");
		expect(originalCopyName("/d/report.pdf", "original", at, 2)).toBe("report (original 2026-11-28 09.05.07 2).pdf");
		expect(originalCopyName("/d/a.pdf", "a/b:c", at)).toBe("a (abc 2026-11-28 09.05.07).pdf");

		const pdf = join(root, "견적서.pdf");
		await writeFile(pdf, Buffer.from("%PDF-1.7 original bytes"));
		const locked: string[] = [];
		const copier = createOriginalCopier({
			withLock: async (path, fn) => {
				locked.push(path);
				return fn();
			},
			label: () => "オリジナル",
			now: () => at,
		});
		const first = await copier(pdf);
		const second = await copier(pdf);
		expect(first).toBe(join(root, "견적서 (オリジナル 2026-11-28 09.05.07).pdf"));
		expect(second).toBe(join(root, "견적서 (オリジナル 2026-11-28 09.05.07 2).pdf"));
		expect(await readFile(first, "utf8")).toBe("%PDF-1.7 original bytes");
		expect(locked).toEqual([pdf, pdf]);
	});

	it("saves the copy before the edit starts, keeps it when the PDF changed, and reports where it is", async () => {
		const order: string[] = [];
		const fake = fakeService(async (runId, request, io) => {
			order.push("edit");
			io.send({ type: "done", runId, path: request.path, changed: true, reply: "Stamped." });
			return { changed: true };
		});
		const definition = createPdfEditorSubagent({
			service: fake.service,
			saveOriginalCopy: async (path) => {
				order.push("copy");
				return `${path}.original-copy`;
			},
		});
		const updates: string[] = [];
		const result = await definition.run({ task: "stamp", files: ["/tmp/a.pdf"] }, { onUpdate: (text) => updates.push(text) });
		expect(order).toEqual(["copy", "edit"]);
		expect(updates[0]).toBe("Original saved as /tmp/a.pdf.original-copy");
		expect(result.output).toBe("/tmp/a.pdf: edited.\nOriginal (before this edit) saved as: /tmp/a.pdf.original-copy\nStamped.");
	});

	it("does not edit at all when the copy cannot be saved", async () => {
		const fake = fakeService(async () => ({ changed: true }));
		const result = await createPdfEditorSubagent({
			service: fake.service,
			saveOriginalCopy: async () => {
				throw new Error("EACCES: permission denied");
			},
		}).run({ task: "stamp", files: ["/tmp/a.pdf"] }, {});
		expect(fake.starts).toHaveLength(0);
		expect(result).toMatchObject({ isError: true, output: "/tmp/a.pdf: not edited — the original copy could not be saved first (EACCES: permission denied)." });
	});

	it("removes a copy that is byte-identical to an unchanged PDF, but keeps it after a failed or partial edit", async () => {
		const pdf = join(root, "same.pdf");
		await writeFile(pdf, Buffer.from("%PDF same"));
		const copier = createOriginalCopier({ withLock: (_p, fn) => fn(), label: () => "원본" });
		const unchanged = await createPdfEditorSubagent({
			service: fakeService(async (runId, request, io) => {
				io.send({ type: "done", runId, path: request.path, changed: false, reply: "Nothing to change." });
				return { changed: false };
			}).service,
			saveOriginalCopy: copier,
		}).run({ task: "x", files: [pdf] }, {});
		expect(unchanged.output).toBe(`${pdf}: not changed.\nNothing to change.`);
		expect((await readdir(root)).filter((name) => name.includes("원본"))).toEqual([]);

		const failing = await createPdfEditorSubagent({
			service: fakeService(async (runId, request, io) => {
				await writeFile(request.path, Buffer.from("%PDF half written"));
				io.send({ type: "error", runId, message: "model quota" });
				return { changed: false };
			}).service,
			saveOriginalCopy: copier,
		}).run({ task: "x", files: [pdf] }, {});
		const kept = (await readdir(root)).filter((name) => name.includes("원본"));
		expect(kept).toHaveLength(1);
		expect(await readFile(join(root, kept[0]!), "utf8")).toBe("%PDF same");
		expect(failing.output).toContain(`Original (before this edit) saved as: ${join(root, kept[0]!)}`);
	});
});

describe("main agent delegating to the real PDF edit agent", () => {
	it("edits the PDF through the librarian's subagent tool and returns the edit agent's summary", async () => {
		const docs = join(root, "docs");
		const agentDir = join(root, "agent");
		await mkdir(docs, { recursive: true });
		await mkdir(agentDir, { recursive: true });
		const pdfPath = join(docs, "contract.pdf");
		const doc = await PDFDocument.create();
		doc.addPage([600, 800]);
		doc.addPage([600, 800]);
		await writeFile(pdfPath, await doc.save());

		const registration = registerFauxProvider({
			api: `faux-subagent-${Math.random().toString(36).slice(2)}`,
			provider: "faux-subagent",
			models: [{ id: "pdf-sub", reasoning: true, input: ["text", "image"] }],
		});
		cleanups.push(() => registration.unregister());
		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const service = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "en",
			backupDir: join(root, "backups"),
			pdfIo,
		});
		cleanups.push(() => service.dispose());
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("pdf_apply_ops", { i: "Rotate page 2", operations: [{ kind: "rotatePage", pageIndex: 1, deltaDegrees: 90 }] })),
			fauxAssistantMessage(fauxToolCall("pdf_render_page", { i: "Visual QA", pages: [2] })),
			fauxAssistantMessage("Rotated page 2 and checked it visually."),
		]);

		const events: DocumentEditEvent[] = [];
		const originalBytes = await readFile(pdfPath);
		const saveOriginalCopy = createOriginalCopier({ withLock: pdfIo.withLock, label: () => "원본", now: () => new Date(2026, 10, 28, 15, 4, 12) });
		const result = await delegate(createPdfEditorSubagent({ saveOriginalCopy, service: { start: (id, req, io) => service.start(id, req, { ...io, send: (e) => (events.push(e), io.send(e)) }), cancel: service.cancel } }), {
			agent: "pdf-editor",
			task: "Rotate page 2 clockwise",
			files: [pdfPath],
		});
		expect(result.content[0]!.text).toContain(`${pdfPath}: edited.`);
		expect(result.content[0]!.text).toContain("Rotated page 2 and checked it visually.");
		expect(result.content[0]!.text).toContain(`Changed files:\n- ${pdfPath}`);
		expect(result.details.results[0]).toMatchObject({ agent: "pdf-editor", isError: false, changedFiles: [pdfPath] });
		expect((await PDFDocument.load(await readFile(pdfPath))).getPage(1).getRotation().angle).toBe(90);
		// The untouched original sits next to the edited PDF, byte for byte, and the main agent is told where.
		const copyPath = join(docs, "contract (원본 2026-11-28 15.04.12).pdf");
		expect((await readFile(copyPath)).equals(originalBytes)).toBe(true);
		expect((await PDFDocument.load(await readFile(copyPath))).getPage(1).getRotation().angle).toBe(0);
		expect(result.content[0]!.text).toContain(`Original (before this edit) saved as: ${copyPath}`);
		expect(events.some((event) => event.type === "done")).toBe(true);
	});
});
