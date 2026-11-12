import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, type FauxProviderRegistration } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentEditProfile } from "../src/main/agents/profiles/document-edit";
import { createDocumentEditService } from "../src/main/document-edit-service";
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
});
