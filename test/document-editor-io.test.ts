import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDocumentForEditor, saveDocumentText } from "../src/main/document-editor-io";

const tempDirs: string[] = [];

function makeWorkDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "dazzi-doc-editor-io-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("document editor file I/O", () => {
	it("opens markdown and code files as decoded text with line ending metadata", async () => {
		const dir = makeWorkDir();
		const mdPath = join(dir, "plan.md");
		writeFileSync(mdPath, "# Title\r\n\r\nHello world\r\n", "utf8");

		const loaded = await openDocumentForEditor(mdPath);
		expect(loaded.kind).toBe("text");
		if (loaded.kind !== "text") return;
		expect(loaded.surface).toBe("wysiwyg");
		expect(loaded.wysiwygFormat).toBe("markdown");
		expect(loaded.ending).toBe("CRLF");
		expect(loaded.text).toBe("# Title\n\nHello world\n");
		expect(loaded.truncated).toBe(false);
	});

	it("saves text preserving line endings and detects external modification conflicts", async () => {
		const dir = makeWorkDir();
		const txtPath = join(dir, "notes.txt");
		writeFileSync(txtPath, "line 1\r\nline 2\r\n", "utf8");

		const loaded = await openDocumentForEditor(txtPath);
		expect(loaded.kind).toBe("text");
		if (loaded.kind !== "text") return;

		const saved = await saveDocumentText({
			path: txtPath,
			text: "line 1\nline 2 updated\n",
			ending: loaded.ending,
			expectedMtimeMs: loaded.mtimeMs,
		});
		expect(saved.ok).toBe(true);
		expect(readFileSync(txtPath, "utf8")).toBe("line 1\r\nline 2 updated\r\n");

		// Simulate an external edit changing mtime
		const staleMtime = loaded.mtimeMs - 5000;
		const conflict = await saveDocumentText({
			path: txtPath,
			text: "stale overwrite",
			ending: "LF",
			expectedMtimeMs: staleMtime,
		});
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.reason).toBe("conflict");
		expect(readFileSync(txtPath, "utf8")).toBe("line 1\r\nline 2 updated\r\n");

		// Force save succeeds even with stale expectedMtimeMs
		const forced = await saveDocumentText({
			path: txtPath,
			text: "forced update\n",
			ending: "LF",
			expectedMtimeMs: staleMtime,
			force: true,
		});
		expect(forced.ok).toBe(true);
		expect(readFileSync(txtPath, "utf8")).toBe("forced update\n");
	});

	it("opens package documents (docx) with preview bytes for mark-up editing", async () => {
		const dir = makeWorkDir();
		const docxPath = join(dir, "sample.docx");
		writeFileSync(docxPath, Buffer.from("PK\x03\x04dummy-zip-bytes"));

		const loaded = await openDocumentForEditor(docxPath);
		expect(loaded.kind).toBe("package");
		if (loaded.kind !== "package") return;
		expect(loaded.surface).toBe("package");
		expect(loaded.document.ext).toBe("docx");
		expect(loaded.document.bytes).not.toBeNull();
	});

	it("refuses unsupported file extensions and relative paths", async () => {
		const dir = makeWorkDir();
		const pdfPath = join(dir, "report.pdf");
		writeFileSync(pdfPath, "%PDF-1.4\n");

		await expect(openDocumentForEditor(pdfPath)).rejects.toThrow();
		await expect(openDocumentForEditor("relative/plan.md")).rejects.toThrow();
		await expect(saveDocumentText({ path: pdfPath, text: "nope" })).rejects.toThrow();
	});
});
