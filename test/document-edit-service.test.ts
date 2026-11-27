import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentEditProfile } from "../src/main/agents/profiles/document-edit";
import { createDocumentEditService } from "../src/main/document-edit-service";
import { createPdfEditorIo } from "../src/main/pdf-editor-io";
import { encodePng } from "../src/preview/node/png-encode";
import type { DocumentEditEvent, DocumentEditRequest } from "../src/preview/shared/annotation";

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
});
