import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { PDFDocument, PDFName } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentEditProfile } from "../src/main/agents/profiles/document-edit";
import { createDocumentEditService } from "../src/main/document-edit-service";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";
import { encodePng } from "../src/preview/node/png-encode";
import type { DocumentEditEvent, DocumentEditRequest } from "../src/preview/shared/annotation";
import type { PdfAssetRequest, PdfAssetResult } from "../src/shared/document-editor-contract";

const cleanups: Array<() => Promise<void> | void> = [];
let root: string;
let agentDir: string;
let docsDir: string;
let backupDir: string;
let events: DocumentEditEvent[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "document-edit-root-"));
	agentDir = join(root, "agent");
	docsDir = join(root, "docs");
	backupDir = join(root, "backups");
	events = [];
	await mkdir(agentDir, { recursive: true });
	await mkdir(docsDir, { recursive: true });
	cleanups.push(() => rm(root, { recursive: true, force: true }));
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function register(input: Array<"text" | "image"> = ["text"]): FauxProviderRegistration {
	const registration = registerFauxProvider({
		api: `faux-docedit-${Math.random().toString(36).slice(2)}`,
		provider: "faux-docedit",
		models: [{ id: "doc-editor", reasoning: true, input }],
	});
	cleanups.push(() => registration.unregister());
	return registration;
}

function service(registration: FauxProviderRegistration) {
	const svc = createDocumentEditService({
		resolveModel: async () => ({ model: registration.getModel() }),
		agentDir,
		env: { ...process.env },
		language: () => "ko",
		backupDir,
	});
	cleanups.push(() => svc.dispose());
	return svc;
}

const PNG = Buffer.from(encodePng(new Uint8Array(4 * 4 * 4).fill(255), 4, 4));

function io(screenshot: Buffer | null = PNG) {
	return { send: (event: DocumentEditEvent) => events.push(event), screenshot: async () => screenshot };
}

function request(path: string, instruction = "밑줄 친 날짜를 11월 20일로 바꿔줘"): DocumentEditRequest {
	return {
		path,
		instruction,
		marks: [{ tool: "underline", page: null, points: [{ x: 0.1, y: 0.4 }, { x: 0.5, y: 0.4 }], text: "출시일: 11월 15일" }],
	};
}

describe("document-edit profile", () => {
	it("offers edit/write but no shell for a text document, and a shell for a package document", () => {
		const base = { language: "ko" as const, agentDir, env: {}, scratchDir: join(root, "scratch") };
		const text = documentEditProfile({ ...base, path: join(docsDir, "a.md"), mode: "text" });
		expect(text.id).toBe("document-edit");
		expect(text.tools).toEqual([]);
		expect(text.customTools?.map((tool: { name: string }) => tool.name).sort()).toEqual(["edit", "find", "grep", "ls", "read", "write"]);
		const pkg = documentEditProfile({ ...base, path: join(docsDir, "a.docx"), mode: "package" });
		expect(pkg.customTools?.map((tool: { name: string }) => tool.name).sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(pkg.systemPrompt).toContain(join(docsDir, "a.docx"));

		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const pdf = documentEditProfile({ ...base, path: join(docsDir, "a.pdf"), mode: "pdf", pdfIo });
		const pdfTools = pdf.customTools?.map((tool: { name: string }) => tool.name) ?? [];
		expect(pdfTools).toEqual(
			expect.arrayContaining([
				"pdf_inspect",
				"pdf_apply_ops",
				"pdf_fill_form",
				"pdf_extract_pages",
				"pdf_split",
				"pdf_set_metadata",
				"pdf_add_page_numbers",
				"bash",
			]),
		);
		expect(pdfTools).not.toContain("edit");
		expect(pdfTools).not.toContain("write");
	});
});

describe("document-edit service", () => {
	it("edits the marked passage of the shown file, streams progress, and sends the marks and the screenshot to the model", async () => {
		const registration = register(["text", "image"]);
		const notePath = join(docsDir, "release.md");
		await writeFile(notePath, "# 릴리스\n출시일: 11월 15일\n", "utf8");
		const seen: string[] = [];
		registration.setResponses([
			(ctx) => {
				seen.push(JSON.stringify(ctx.messages));
				return fauxAssistantMessage(fauxToolCall("edit", { i: "날짜를 고치는 중", path: notePath, edits: [{ oldText: "11월 15일", newText: "11월 20일" }] }));
			},
			fauxAssistantMessage("출시일을 11월 20일로 바꿨습니다."),
		]);

		const outcome = await service(registration).start("run-1", request(notePath), io());

		expect(outcome.changed).toBe(true);
		expect(await readFile(notePath, "utf8")).toBe("# 릴리스\n출시일: 11월 20일\n");
		expect(events.filter((e) => e.type === "progress").map((e) => (e.type === "progress" ? e.text : ""))).toContain("날짜를 고치는 중");
		expect(events.at(-1)).toEqual({ type: "done", runId: "run-1", path: notePath, changed: true, reply: "출시일을 11월 20일로 바꿨습니다." });
		const prompt = seen[0] ?? "";
		expect(prompt).toContain(notePath);
		expect(prompt).toContain("밑줄 친 날짜를 11월 20일로 바꿔줘");
		expect(prompt).toContain('underline under \\"출시일: 11월 15일\\"');
		expect(prompt).toContain('"type":"image"');
	});

	it("does not attach the screenshot for a text-only model", async () => {
		const registration = register(["text"]);
		const notePath = join(docsDir, "a.md");
		await writeFile(notePath, "hello\n", "utf8");
		const seen: string[] = [];
		registration.setResponses([
			(ctx) => {
				seen.push(JSON.stringify(ctx.messages));
				return fauxAssistantMessage("바꿀 것이 없습니다.");
			},
		]);
		const outcome = await service(registration).start("run-2", request(notePath), io());
		expect(outcome.changed).toBe(false);
		expect(seen[0]).not.toContain('"type":"image"');
		expect(events.at(-1)).toMatchObject({ type: "done", changed: false });
	});

	it("refuses to write any file but the shown one, and keeps the credential store out of reach", async () => {
		const registration = register();
		const notePath = join(docsDir, "a.md");
		const other = join(docsDir, "other.md");
		const auth = join(agentDir, "auth.json");
		await writeFile(notePath, "keep\n", "utf8");
		await writeFile(other, "other\n", "utf8");
		await writeFile(auth, '{"dazzi":{"access":"secret-token"}}', "utf8");
		const results: string[] = [];
		registration.setResponses([
			fauxAssistantMessage([
				fauxToolCall("write", { i: "다른 파일 쓰기 시도", path: other, content: "tampered" }),
				fauxToolCall("read", { i: "인증 파일 읽기 시도", path: auth }),
			]),
			(ctx) => {
				for (const message of ctx.messages) if (message.role === "toolResult") results.push(JSON.stringify(message.content));
				return fauxAssistantMessage("끝");
			},
		]);
		await service(registration).start("run-3", request(notePath), io());
		expect(await readFile(other, "utf8")).toBe("other\n");
		expect(results.join("\n")).not.toContain("secret-token");
		expect(results.join("\n")).toContain("Refused");
	});

	it("fences package-mode bash writes strictly to the target file and scratchDir", async () => {
		const registration = register();
		const docxPath = join(docsDir, "budget.docx");
		const other = join(docsDir, "other.txt");
		await writeFile(docxPath, "dummy-docx-bytes");
		await writeFile(other, "untouched\n", "utf8");
		const results: string[] = [];
		registration.setResponses([
			fauxAssistantMessage([
				fauxToolCall("bash", { i: "다른 파일 덮어쓰기 시도", command: `echo hacked > "${other}"` }),
				fauxToolCall("bash", { i: "다른 파일 삭제 시도", command: `rm -f "${other}"` }),
			]),
			(ctx) => {
				for (const message of ctx.messages) if (message.role === "toolResult") results.push(JSON.stringify(message.content));
				return fauxAssistantMessage("거부됨");
			},
		]);
		await service(registration).start("run-pkg-fence", request(docxPath, "수정해줘"), io());
		expect(await readFile(other, "utf8")).toBe("untouched\n");
		expect(results.join("\n")).toMatch(/Refused|unavailable/i);
	});

	it("allows package-mode bash writes inside scratchDir and target when writeJudge approves", async () => {
		const registration = register();
		const docxPath = join(docsDir, "budget.docx");
		await writeFile(docxPath, "before-bytes");
		const svc = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			backupDir,
			writeJudge: async (_state, questions) => ({
				verdicts: questions.map((q) => ({ id: q.id ?? "", type: "noul", answer: 0.01, confidence: 0.99, escalate: false }) as never),
			}),
		});
		cleanups.push(() => svc.dispose());
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("bash", { i: "임시 파일 생성 후 대상 교체", command: `printf 'after-bytes' > out.bin && cp out.bin "${docxPath}"` })),
			fauxAssistantMessage("완료"),
		]);
		const outcome = await svc.start("run-pkg-ok", request(docxPath, "업데이트"), io());
		expect(outcome.changed).toBe(true);
		expect(await readFile(docxPath, "utf8")).toBe("after-bytes");
	});

	it("undoes an edit by putting the original bytes back, once", async () => {
		const registration = register();
		const notePath = join(docsDir, "a.md");
		await writeFile(notePath, "before\n", "utf8");
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { i: "쓰는 중", path: notePath, content: "after\n" })),
			fauxAssistantMessage("바꿨습니다"),
		]);
		const svc = service(registration);
		await svc.start("run-4", request(notePath), io());
		expect(await readFile(notePath, "utf8")).toBe("after\n");

		expect(await svc.undo("run-4", io().send)).toBe(true);
		expect(await readFile(notePath, "utf8")).toBe("before\n");
		expect(events.at(-1)).toEqual({ type: "undone", runId: "run-4", path: notePath });
		expect(await svc.undo("run-4", io().send)).toBe(false);
	});

	it("reports a missing file without starting the model", async () => {
		const registration = register();
		const outcome = await service(registration).start("run-5", request(join(docsDir, "gone.md")), io());
		expect(outcome.changed).toBe(false);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("lets the AI agent edit a PDF via pdf_apply_ops while a human concurrently edits via PdfEditorIo without losing either edit", async () => {
		const registration = register(["text", "image"]);
		const pdfPath = join(docsDir, "contract.pdf");
		const initialDoc = await PDFDocument.create();
		initialDoc.addPage([600, 800]);
		initialDoc.addPage([600, 800]);
		await writeFile(pdfPath, await initialDoc.save());

		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const changedEvents: Array<{ source: string; pageCount: number }> = [];
		pdfIo.onChanged((ev) => changedEvents.push({ source: ev.source, pageCount: ev.pageCount }));

		const svc = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			backupDir,
			pdfIo,
		});
		cleanups.push(() => svc.dispose());

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("pdf_inspect", { i: "PDF 구조 확인 중" })),
			fauxAssistantMessage(
				fauxToolCall("pdf_apply_ops", {
					i: "워터마크와 페이지 번호 추가 및 메타데이터 설정",
					operations: [
						{ kind: "addTextWatermark", text: "CONFIDENTIAL", opacity: 0.25, angleDegrees: 35 },
						{ kind: "addPageNumbers", position: "bottom-center", format: "ofTotal", startNumber: 1, fontSize: 10, color: "#334155" },
						{ kind: "setMetadata", metadata: { title: "AI Reviewed Contract", author: "Dazzi AI", subject: "", keywords: "" } },
					],
				}),
			),
			fauxAssistantMessage("워터마크와 페이지 번호를 추가했습니다."),
		]);

		// Fire AI run and concurrent human rotation + blank page insertion simultaneously!
		const [aiOutcome, humanRes] = await Promise.all([
			svc.start("run-pdf-collab", { path: pdfPath, instruction: "CONFIDENTIAL 워터마크와 페이지 번호 넣어줘", marks: [] }, io()),
			pdfIo.apply(
				{
					path: pdfPath,
					operations: [
						{ kind: "rotatePage", pageIndex: 0, deltaDegrees: 90 },
						{ kind: "insertBlankPage", insertAtIndex: 2, size: "a4" },
					],
					force: true,
				},
				"human",
			),
		]);

		expect(aiOutcome.changed).toBe(true);
		expect(humanRes.ok).toBe(true);

		// Both the human's edits (rotation=90, 3rd page added) AND the AI's edits (title metadata) survived!
		const finalDoc = await PDFDocument.load(await readFile(pdfPath));
		expect(finalDoc.getPageCount()).toBe(3);
		expect(finalDoc.getPage(0).getRotation().angle).toBe(90);
		expect(finalDoc.getTitle()).toBe("AI Reviewed Contract");
		expect(finalDoc.getAuthor()).toBe("Dazzi AI");
		expect(changedEvents.map((e) => e.source).sort()).toEqual(["ai", "human"]);

		// Undoing the AI turn must revert ONLY the AI's edits while preserving the concurrent human edits!
		const undone = await svc.undo("run-pdf-collab", io().send);
		expect(undone).toBe(true);
		const afterUndo = await PDFDocument.load(await readFile(pdfPath));
		expect(afterUndo.getPageCount()).toBe(3); // Human's blank page survived!
		expect(afterUndo.getPage(0).getRotation().angle).toBe(90); // Human's rotation survived!
		expect(afterUndo.getTitle() ?? "").toBe(""); // AI's metadata reverted!
	});

	it("does not let a concurrent human PDF edit mask an AI turn that made no AI tool edits", async () => {
		const registration = register(["text"]);
		const pdfPath = join(docsDir, "noop.pdf");
		const initialDoc = await PDFDocument.create();
		initialDoc.addPage([600, 800]);
		await writeFile(pdfPath, await initialDoc.save());

		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const svc = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "ko",
			backupDir,
			pdfIo,
		});
		cleanups.push(() => svc.dispose());

		registration.setResponses([fauxAssistantMessage("아무 작업도 하지 않았습니다.")]);

		const [aiOutcome, humanRes] = await Promise.all([
			svc.start("run-pdf-noop", { path: pdfPath, instruction: "그냥 확인만 해줘", marks: [] }, io()),
			pdfIo.apply({ path: pdfPath, operations: [{ kind: "rotatePage", pageIndex: 0, deltaDegrees: 90 }], force: true }, "human"),
		]);

		expect(humanRes.ok).toBe(true);
		expect(aiOutcome.changed).toBe(false);
		expect((await PDFDocument.load(await readFile(pdfPath))).getPage(0).getRotation().angle).toBe(90);
	});

	it("provides pdf_render_page returning inline PNG image blocks and prompts Visual QA after edits", async () => {
		const registration = register(["text", "image"]);
		const pdfPath = join(docsDir, "visual-qa-agent.pdf");
		const initialDoc = await PDFDocument.create();
		initialDoc.addPage([600, 800]);
		initialDoc.addPage([800, 500]);
		await writeFile(pdfPath, await initialDoc.save());

		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());

		// Verify profile prompt explicitly guides pre-edit visual reading & post-edit Visual QA
		const { documentEditProfile } = await import("../src/main/agents/profiles/document-edit");
		const profile = documentEditProfile({
			language: "en",
			path: pdfPath,
			mode: "pdf",
			scratchDir: root,
			agentDir,
			env: { ...process.env },
			pdfIo,
			supportsImage: true,
		});
		expect(profile.systemPrompt).toContain("pdf_render_page");
		expect(profile.systemPrompt).toContain("Visual QA");
		const renderTool = profile.customTools?.find((t) => t.name === "pdf_render_page");
		expect(renderTool).toBeDefined();

		// Execute pdf_render_page directly and confirm inline PNG image blocks are attached
		const toolResult = await (
			renderTool!.execute as unknown as (callId: string, params: Record<string, unknown>) => Promise<{
				content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			}>
		)("call-render-1", { i: "Render pages 1 and 2 visually", pages: [1, 2], dpi: 100 });
		expect(toolResult.content[0]?.type).toBe("text");
		expect(toolResult.content[0]?.text).toContain('"imagesAttached": true');
		const images = toolResult.content.filter((c) => c.type === "image");
		expect(images).toHaveLength(2);
		expect(images[0]?.mimeType).toBe("image/png");
		expect(Buffer.from(images[0]!.data!, "base64").subarray(0, 4).toString("hex")).toBe("89504e47");

		// Verify full edit + Visual QA tool loop runs end-to-end inside DocumentEditService
		const svc = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "en",
			backupDir,
			pdfIo,
		});
		cleanups.push(() => svc.dispose());

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("pdf_render_page", { i: "Inspect page 1 before editing", pages: [1] })),
			fauxAssistantMessage(
				fauxToolCall("pdf_apply_ops", {
					i: "Add title note to page 1",
					operations: [{ kind: "addText", pageIndex: 0, text: "Verified QA", x: 0.1, y: 0.1, fontSize: 16, color: "#1D1D1F" }],
				}),
			),
			fauxAssistantMessage(fauxToolCall("pdf_render_page", { i: "Run Visual QA on modified page 1", pages: [1] })),
			fauxAssistantMessage("Added the note and visually verified page 1 with zero overlap."),
		]);

		const events: DocumentEditEvent[] = [];
		const outcome = await svc.start(
			"run-pdf-visual-qa",
			{ path: pdfPath, instruction: "Add 'Verified QA' at top-left and verify visually", marks: [] },
			{ send: (e) => events.push(e), screenshot: async () => null },
		);
		expect(outcome.changed).toBe(true);
		const done = events.find((e) => e.type === "done");
		expect(done && done.type === "done" ? done.reply : "").toContain("visually verified");
	});

	it("gives the PDF agent every toolbar capability: find text, text boxes, notes, stamps, images, Korean watermarks", async () => {
		const registration = register(["text", "image"]);
		const pdfPath = join(docsDir, "parity.pdf");
		const initialDoc = await PDFDocument.create();
		initialDoc.addPage([600, 800]);
		initialDoc.addPage([800, 600]);
		await writeFile(pdfPath, await initialDoc.save());
		const imagePath = join(docsDir, "logo.png");
		await writeFile(imagePath, PNG);

		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());

		// Without an open editor the content tools are absent (nothing to render them with).
		const bare = documentEditProfile({ language: "en", path: pdfPath, mode: "pdf", scratchDir: root, agentDir, env: { ...process.env }, pdfIo });
		expect(bare.customTools?.some((tool) => tool.name === "pdf_add_note")).toBe(false);

		const assetCalls: PdfAssetRequest[] = [];
		const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;
		const renderAsset = async (asset: PdfAssetRequest): Promise<PdfAssetResult> => {
			assetCalls.push(asset);
			if (asset.kind === "findText") {
				return { kind: "textHits", hits: [{ pageNumber: 1, pageIndex: 0, rects: [{ x: 0.2, y: 0.3, width: 0.25, height: 0.02 }] }] };
			}
			if (asset.kind === "textBox" || asset.kind === "note") return { kind: "png", dataUrl: pngUrl, aspect: 4, widthPt: asset.widthPt, heightPt: asset.widthPt / 4 };
			return { kind: "png", dataUrl: pngUrl, aspect: 2 };
		};
		const withAssets = documentEditProfile({
			language: "en", path: pdfPath, mode: "pdf", scratchDir: root, agentDir, env: { ...process.env }, pdfIo, renderAsset,
		});
		const names = withAssets.customTools?.map((tool) => tool.name) ?? [];
		for (const name of ["pdf_find_text", "pdf_add_text_box", "pdf_add_note", "pdf_add_stamp", "pdf_insert_image", "pdf_add_watermark"]) {
			expect(names).toContain(name);
		}
		expect(withAssets.systemPrompt).toContain("pdf_find_text");
		const find = withAssets.customTools!.find((tool) => tool.name === "pdf_find_text")!;
		const found = (await (find.execute as unknown as (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text?: string }> }>)(
			"find-1",
			{ i: "find", query: "Account SSN" },
		)) as { content: Array<{ text?: string }> };
		const hit = JSON.parse(found.content[0]!.text!).hits[0];
		const { x1, y1, x2, y2 } = hit.ellipse;
		const [cx, cy, rx, ry] = [(x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2];
		for (const [px, py] of [[hit.box.x, hit.box.y], [hit.box.x + hit.box.width, hit.box.y], [hit.box.x, hit.box.y + hit.box.height], [hit.box.x + hit.box.width, hit.box.y + hit.box.height]]) {
			// Every corner of the text box lies strictly inside the ellipse, so the outline never crosses the text.
			expect(((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2).toBeLessThan(1);
		}
		assetCalls.length = 0;

		const svc = createDocumentEditService({
			resolveModel: async () => ({ model: registration.getModel() }),
			agentDir,
			env: { ...process.env },
			language: () => "en",
			backupDir,
			pdfIo,
		});
		cleanups.push(() => svc.dispose());

		registration.setResponses([
			fauxAssistantMessage(fauxToolCall("pdf_find_text", { i: "Locate the SSN line", query: "Account SSN" })),
			fauxAssistantMessage(
				fauxToolCall("pdf_apply_ops", {
					i: "Circle it and point an arrow",
					operations: [
						{ kind: "drawShape", pageIndex: 0, shape: "ellipse", x1: 0.18, y1: 0.28, x2: 0.47, y2: 0.34, strokeColor: "#DC2626", strokeWidthPt: 2 },
						{ kind: "drawShape", pageIndex: 0, shape: "arrow", x1: 0.7, y1: 0.45, x2: 0.49, y2: 0.33, strokeColor: "#DC2626", strokeWidthPt: 2 },
					],
				}),
			),
			fauxAssistantMessage(fauxToolCall("pdf_add_note", { i: "Add a note", pageIndex: 0, x: 0.62, y: 0.46, text: "확인 필요", color: "pink" })),
			fauxAssistantMessage(fauxToolCall("pdf_add_stamp", { i: "Stamp", pageIndex: 0, x: 0.65, y: 0.05, preset: "reviewed" })),
			fauxAssistantMessage(fauxToolCall("pdf_add_text_box", { i: "Caption", pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, text: "검토 의견: 3조 수정" })),
			fauxAssistantMessage(fauxToolCall("pdf_insert_image", { i: "Logo", path: imagePath, pageIndex: 1, x: 0.7, y: 0.7, width: 0.2 })),
			fauxAssistantMessage(fauxToolCall("pdf_add_watermark", { i: "Watermark", text: "대외비" })),
			fauxAssistantMessage(fauxToolCall("pdf_render_page", { i: "Visual QA", pages: [1, 2] })),
			fauxAssistantMessage("Done and visually verified both pages."),
		]);

		const outcome = await svc.start(
			"run-parity",
			{ path: pdfPath, instruction: "Circle the SSN, point at it, add a note, stamp, caption, logo and watermark", marks: [] },
			{ ...io(null), renderAsset },
		);
		expect(outcome.changed).toBe(true);
		expect(assetCalls.map((call) => call.kind)).toEqual(["findText", "note", "stamp", "textBox", "image", "watermark"]);
		// Widths are handed to the renderer in points of the page as viewed: 0.3 x 600pt and 0.5 x 800pt.
		const note = assetCalls.find((call) => call.kind === "note");
		expect(note?.kind === "note" ? note.widthPt : 0).toBeCloseTo(180, 5);
		const box = assetCalls.find((call) => call.kind === "textBox");
		expect(box?.kind === "textBox" ? box.widthPt : 0).toBeCloseTo(400, 5);
		const stamp = assetCalls.find((call) => call.kind === "stamp");
		expect(stamp).toMatchObject({ kind: "stamp", preset: "reviewed", withDate: true });

		const saved = await PDFDocument.load(await readFile(pdfPath));
		expect(saved.getPageCount()).toBe(2);
		expect(events.some((event) => event.type === "done" && event.reply.includes("visually verified"))).toBe(true);
	});

	it("refuses to insert credential files or non-images through pdf_insert_image", async () => {
		const pdfPath = join(docsDir, "guard.pdf");
		const doc = await PDFDocument.create();
		doc.addPage([600, 800]);
		await writeFile(pdfPath, await doc.save());
		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const profile = documentEditProfile({
			language: "en", path: pdfPath, mode: "pdf", scratchDir: root, agentDir, env: { ...process.env }, pdfIo,
			renderAsset: async () => ({ kind: "png", dataUrl: `data:image/png;base64,${PNG.toString("base64")}`, aspect: 1 }),
		});
		const insert = profile.customTools!.find((tool) => tool.name === "pdf_insert_image")!;
		const run = insert.execute as unknown as (id: string, params: Record<string, unknown>) => Promise<unknown>;
		await expect(run("c1", { i: "x", path: join(docsDir, "notes.txt"), pageIndex: 0, x: 0.1, y: 0.1 })).rejects.toThrow(/Unsupported image type/);
		await expect(run("c2", { i: "x", path: "relative.png", pageIndex: 0, x: 0.1, y: 0.1 })).rejects.toThrow(/absolute path/);
		await expect(run("c3", { i: "x", path: join(agentDir, "auth.png"), pageIndex: 0, x: 0.1, y: 0.1 })).rejects.toThrow(/Refused/);
	});

	it("renders non-Latin page-number headers through the editor and forwards localized watermark presets", async () => {
		const pdfPath = join(docsDir, "locale.pdf");
		const doc = await PDFDocument.create();
		doc.addPage([600, 800]);
		await writeFile(pdfPath, await doc.save());
		const pdfIo = createPdfEditorIo(join(root, "pdf-backups"));
		cleanups.push(() => pdfIo.dispose());
		const pngUrl = `data:image/png;base64,${PNG.toString("base64")}`;
		const calls: PdfAssetRequest[] = [];
		const renderAsset = async (asset: PdfAssetRequest): Promise<PdfAssetResult> => {
			calls.push(asset);
			return asset.kind === "textLine" ? { kind: "png", dataUrl: pngUrl, aspect: 6, widthPt: 60, heightPt: 10 } : { kind: "png", dataUrl: pngUrl, aspect: 1 };
		};
		const tools = (renderAssetFn?: typeof renderAsset) =>
			documentEditProfile({
				language: "ko", path: pdfPath, mode: "pdf", scratchDir: root, agentDir, env: { ...process.env }, pdfIo,
				...(renderAssetFn === undefined ? {} : { renderAsset: renderAssetFn }),
			}).customTools!;
		const exec = (list: ReturnType<typeof tools>, name: string, params: Record<string, unknown>) =>
			(list.find((tool) => tool.name === name)!.execute as unknown as (id: string, p: Record<string, unknown>) => Promise<unknown>)("c", { i: "x", ...params });

		await exec(tools(renderAsset), "pdf_add_page_numbers", { headerText: "대외비 문서", footerText: "Page footer" });
		// Only the Korean line needs rendering; the Latin footer keeps the standard-font path.
		expect(calls).toEqual([{ kind: "textLine", text: "대외비 문서", fontSizePt: 10, color: "#334155" }]);
		const images = (await PDFDocument.load(await readFile(pdfPath))).context
			.enumerateIndirectObjects()
			.filter(([, obj]) => (obj as { dict?: { get(name: unknown): unknown } }).dict?.get(PDFName.of("Subtype")) === PDFName.of("Image"));
		expect(images.length).toBeGreaterThanOrEqual(1);

		// Raw pdf_apply_ops gets the same treatment, so the agent cannot silently lose a Korean header either.
		calls.length = 0;
		await exec(tools(renderAsset), "pdf_apply_ops", {
			operations: [{ kind: "addPageNumbers", position: "top-right", format: "number", startNumber: 1, fontSize: 9, color: "#111111", footerText: "機密" }],
		});
		expect(calls).toEqual([{ kind: "textLine", text: "機密", fontSizePt: 9, color: "#111111" }]);

		calls.length = 0;
		await exec(tools(renderAsset), "pdf_add_watermark", { preset: "confidential" });
		expect(calls).toEqual([{ kind: "watermark", preset: "confidential", color: "#64748B", angleDeg: 35 }]);
		await expect(exec(tools(renderAsset), "pdf_add_watermark", {})).rejects.toThrow(/preset or text/);

		// No editor to render with: a Korean header fails loudly instead of disappearing from the page.
		await expect(exec(tools(), "pdf_add_page_numbers", { headerText: "대외비" })).rejects.toThrow(/needs the open Dazzi PDF editor/);
	});
});
