import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_BYTE_CAP, readHead, readPreviewFile } from "../src/preview/node/read-file";
import { t } from "../src/shared/i18n/core";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fs>();
	return { ...actual, open: vi.fn(actual.open) };
});

const { open: realOpen } = await vi.importActual<typeof fs>("node:fs/promises");
let dir: string;
let path: string;
const docx = zipSync({
	"[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
	"word/document.xml": strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>출시일 11월 20일</w:t></w:r></w:p></w:body></w:document>'),
});

beforeEach(async () => {
	dir = await fs.mkdtemp(join(tmpdir(), "dazzi-preview-read-"));
	path = join(dir, "회의 자료 '한글'.docx");
	await fs.writeFile(path, docx);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await fs.rm(dir, { recursive: true, force: true });
});

/** Fail only Node's read; the real Foundation coordinator still reads the real binary document. */
function refusePosix(error: Error): void {
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await realOpen(...args);
		if (args[0] === path) vi.spyOn(handle, "read").mockRejectedValue(error);
		return handle;
	});
}

describe("preview file reads", () => {
	it.skipIf(process.platform !== "darwin").each([
		{ code: "Unknown system error -11", errno: -11, limit: PREVIEW_BYTE_CAP },
		{ code: "EDEADLK", errno: -11, limit: 17 },
	])("coordinates a refused macOS read ($code, limit $limit)", async ({ code, errno, limit }) => {
		refusePosix(Object.assign(new Error("Resource deadlock avoided"), { code, errno }));
		const result = await readPreviewFile(path, limit);
		expect(result.ext).toBe("docx");
		expect(result.truncated).toBe(docx.length > limit);
		expect(Buffer.from(result.bytes!)).toEqual(Buffer.from(docx.subarray(0, limit)));
	});

	it("does not mistake a short read for end of file", async () => {
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			const read = handle.read.bind(handle);
			vi.spyOn(handle, "read").mockImplementation(async (...readArgs: Parameters<typeof handle.read>) => {
				const [buffer, offset, length, position] = readArgs as unknown as [Uint8Array, number, number, number];
				return read(buffer, offset, Math.min(length, 7), position);
			});
			return handle;
		});
		expect(Buffer.from(await readHead(path, docx.length + 10))).toEqual(Buffer.from(docx));
	});

	it("delivers a localized preview error, preserving the cause, when the file cannot be read", async () => {
		const cause = Object.assign(new Error("permission denied"), { code: "EACCES", errno: -13 });
		refusePosix(cause);
		await expect(readPreviewFile(path, PREVIEW_BYTE_CAP)).rejects.toMatchObject({
			name: "PreviewReadError", code: "unreadable", message: t("quickLook.documents.readFailed"), cause,
		});
	});

	it.skipIf(process.platform !== "darwin")("reports a failed coordinated read rather than returning an empty document", async () => {
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await realOpen(...args);
			await fs.unlink(path);
			vi.spyOn(handle, "read").mockRejectedValue(Object.assign(new Error("deadlock"), { errno: -11 }));
			return handle;
		});
		await expect(readPreviewFile(path, PREVIEW_BYTE_CAP)).rejects.toMatchObject({
			name: "PreviewReadError", code: "unreadable", message: t("quickLook.documents.readFailed"),
		});
	});
});
