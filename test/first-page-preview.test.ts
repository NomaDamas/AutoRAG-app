import { describe, expect, it, vi } from "vitest";
import { previewLoaderFor } from "../src/renderer/src/lib/preview-loader";

const OS = "autorag-thumb://local/?path=generic-icon";
const PAGE = "data:image/png;base64,PAGE";

function deps(platform: string) {
	return {
		platform,
		os: vi.fn(async () => OS as string | null),
		page: vi.fn(async () => PAGE as string | null),
		hwp: vi.fn(async () => "data:image/svg+xml,HWP" as string | null),
	};
}

describe("previewLoaderFor", () => {
	it("draws the PDF's first page instead of the OS answer on Windows, where the OS answers with a generic icon", async () => {
		const d = deps("win32");
		expect(await previewLoaderFor("C:\\a\\b.pdf", d)("C:\\a\\b.pdf", 5)).toBe(PAGE);
		expect(d.os).not.toHaveBeenCalled();
	});

	it("falls back to the OS answer when the page cannot be drawn", async () => {
		const d = deps("win32");
		d.page.mockResolvedValueOnce(null);
		expect(await previewLoaderFor("C:\\a\\b.pdf", d)("C:\\a\\b.pdf", 5)).toBe(OS);
	});

	it("keeps the OS preview for a PDF on macOS", async () => {
		const d = deps("darwin");
		expect(await previewLoaderFor("/a/b.PDF", d)("/a/b.PDF", 5)).toBe(OS);
		expect(d.page).not.toHaveBeenCalled();
	});

	it("draws HWP and HWPX with rhwp on every platform, and sends other files to the OS", async () => {
		for (const platform of ["darwin", "win32"]) {
			const d = deps(platform);
			expect(await previewLoaderFor("/a/b.hwpx", d)("/a/b.hwpx", 5)).toBe("data:image/svg+xml,HWP");
			expect(await previewLoaderFor("/a/b.png", d)("/a/b.png", 5)).toBe(OS);
		}
	});
});
