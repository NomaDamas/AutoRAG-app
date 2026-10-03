import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	ATTACHMENT_CHAR_LIMIT,
	ATTACHMENT_CONTEXT_CHAR_LIMIT,
	AttachmentContextAgent,
	buildAttachmentContext,
} from "../src/main/attachment-context";
import type { ChatAttachment } from "../src/shared/search-contract";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-attachment-context-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function file(path: string): ChatAttachment {
	return { kind: "file", id: path, name: path.split("/").at(-1) ?? path };
}

describe("buildAttachmentContext", () => {
	it("is empty without attachments", async () => {
		expect(await buildAttachmentContext([])).toBe("");
	});

	it("carries a text file's absolute path and its content", async () => {
		const directory = await tempDir();
		const path = join(directory, "brief.md");
		await writeFile(path, "# Brief\nThe project codename is BLUEHERON-4827.\n");

		const context = await buildAttachmentContext([file(path)]);

		expect(context).toContain(path);
		expect(context).toContain("The project codename is BLUEHERON-4827.");
	});

	it("reads text files the document parsers do not claim", async () => {
		const directory = await tempDir();
		const path = join(directory, "settings.json");
		await writeFile(path, JSON.stringify({ region: "ap-northeast-2", replicas: 3 }));

		const context = await buildAttachmentContext([file(path)]);

		expect(context).toContain(path);
		expect(context).toContain('"region":"ap-northeast-2"');
	});

	it("passes only the path of a binary file, never its bytes", async () => {
		const directory = await tempDir();
		const path = join(directory, "blob.bin");
		await writeFile(path, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x7a, 0x7a, 0x7a]));

		const context = await buildAttachmentContext([file(path)]);

		expect(context).toContain(path);
		expect(context).not.toContain("\u0000");
		expect(context).not.toContain("zzz");
	});

	it("lists a folder's children instead of reading it", async () => {
		const directory = await tempDir();
		const folder = join(directory, "quarterly");
		await mkdir(join(folder, "raw"), { recursive: true });
		await writeFile(join(folder, "q3-report.md"), "Q3 report body");

		const context = await buildAttachmentContext([{ kind: "folder", id: folder, name: "quarterly" }]);

		expect(context).toContain(folder);
		expect(context).toContain("q3-report.md");
		expect(context).toContain("raw/");
		expect(context).not.toContain("Q3 report body");
	});

	it("keeps a missing file's path and says it could not be read", async () => {
		const directory = await tempDir();
		const path = join(directory, "gone.txt");

		const context = await buildAttachmentContext([file(path)]);

		expect(context).toContain(path);
		expect(context).toMatch(/ENOENT|not found|could not/iu);
	});

	it("passes a URL as a reference the agent can open", async () => {
		const context = await buildAttachmentContext([
			{ kind: "url", id: "https://example.com/docs/refund-policy", name: "example.com/docs/refund-policy" },
		]);

		expect(context).toContain("https://example.com/docs/refund-policy");
	});

	it("caps each attachment and the whole context", async () => {
		const directory = await tempDir();
		const paths: string[] = [];
		for (const [index, marker] of ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"].entries()) {
			const path = join(directory, `part-${index}.txt`);
			// Each file alone is larger than the per-attachment cap.
			await writeFile(path, `${marker} `.repeat(ATTACHMENT_CHAR_LIMIT));
			paths.push(path);
		}

		const context = await buildAttachmentContext(paths.map(file));

		for (const path of paths) expect(context).toContain(path);
		const first = context.split("AAAA").length - 1;
		expect(first).toBeLessThanOrEqual(ATTACHMENT_CHAR_LIMIT / 5 + 1);
		expect(context.length).toBeLessThan(ATTACHMENT_CONTEXT_CHAR_LIMIT + 4_000);
		// The budget runs out before the last file's content.
		expect(context).not.toContain("EEEE");
	});
});

/**
 * pi-ai keeps its provider registry in module state, so the faux provider must
 * be registered on the exact pi-ai copy the librarian imports.
 */
function librarianDependency(packageName: string, subpath: string): string {
	let directory = dirname(createRequire(import.meta.url).resolve("@autorag/librarian"));
	for (;;) {
		const manifest = join(directory, "node_modules", packageName, "package.json");
		if (existsSync(manifest)) {
			const exports = JSON.parse(readFileSync(manifest, "utf8")).exports as Record<string, { import: string }>;
			const target = exports[subpath]?.import;
			if (target === undefined) throw new Error(`${packageName} does not export ${subpath}`);
			return pathToFileURL(join(dirname(manifest), target)).href;
		}
		const parent = dirname(directory);
		if (parent === directory) throw new Error(`${packageName} is not installed for @autorag/librarian`);
		directory = parent;
	}
}

interface FauxRegistration {
	getModel(): unknown;
	setResponses(responses: unknown[]): void;
	unregister(): void;
}

interface FauxModule {
	registerFauxProvider(options: { api: string; models: { id: string }[] }): FauxRegistration;
	fauxAssistantMessage(content: unknown, options?: { stopReason?: string }): unknown;
	fauxToolCall(name: string, args: Record<string, unknown>): unknown;
}

describe("AttachmentContextAgent", () => {
	it("puts the attachment context in front of the model while retrieval keeps the plain query", async () => {
		// Runtime-resolved: a static "@earendil-works/pi-ai/compat" import would load
		// the app's hoisted copy, whose provider registry the librarian never reads.
		const pi = (await import(librarianDependency("@earendil-works/pi-ai", "./compat"))) as FauxModule;
		const directory = await tempDir();
		const attached = join(directory, "outside", "secret-brief.md");
		await mkdir(dirname(attached), { recursive: true });
		await writeFile(attached, "Project codename: BLUEHERON-4827.");
		const corpus = join(directory, "corpus");
		await mkdir(corpus);
		await writeFile(join(corpus, "unrelated.txt"), "Lunch menu for Friday.");

		const requests: string[] = [];
		const registration = pi.registerFauxProvider({ api: `faux-${randomUUID()}`, models: [{ id: "attachments" }] });
		registration.setResponses([
			(context: { readonly messages: unknown }) => {
				requests.push(JSON.stringify(context.messages));
				return pi.fauxAssistantMessage("The codename is BLUEHERON-4827.");
			},
			(context: { readonly messages: unknown }) => {
				requests.push(JSON.stringify(context.messages));
				return pi.fauxAssistantMessage(
					[
						pi.fauxToolCall("emit_autorag_results", {
							answer: "The codename is BLUEHERON-4827 [1].",
							results: [
								{
									number: 1,
									title: "secret-brief.md",
									summary: "Project codename",
									evidence: [{ excerpt: "Project codename: BLUEHERON-4827." }],
									confidence: 1,
								},
							],
							mapping: [{ number: 1, source: attached, method: "attachment", content: "Project codename: BLUEHERON-4827." }],
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		try {
			const agent = new AttachmentContextAgent({
				model: registration.getModel() as never,
				searchPaths: [corpus],
				workspacePath: directory,
				memoryPath: join(directory, "memory.json"),
				jikji: false,
				minSync: false,
				webSearch: false,
				dupey: false,
			});
			agent.setAttachmentContext(await buildAttachmentContext([file(attached)]));

			const response = await agent.searchDocuments("What is the project codename?");

			expect(requests.length).toBeGreaterThan(0);
			expect(requests[0]).toContain(attached);
			expect(requests[0]).toContain("Project codename: BLUEHERON-4827.");
			expect(requests[0]).toContain("What is the project codename?");
			expect(response.query).toBe("What is the project codename?");
		} finally {
			registration.unregister();
		}
	});
});
