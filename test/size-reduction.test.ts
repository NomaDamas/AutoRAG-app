import { describe, expect, it } from "vitest";
import { extensionOfName, formatByteSize, reducedCopyName, REDUCTION_LEVELS, reductionKindOf } from "../src/shared/size-reduction";

describe("reductionKindOf", () => {
	it("maps a file name to its engine family, case-insensitively", () => {
		expect(reductionKindOf("Report.PDF")).toBe("pdf");
		expect(reductionKindOf("a.b.jpeg")).toBe("image");
		expect(reductionKindOf("clip.MOV")).toBe("video");
		expect(reductionKindOf("song.m4a")).toBe("audio");
	});

	it("is null for types that cannot shrink without changing format", () => {
		expect(reductionKindOf("notes.txt")).toBeNull();
		expect(reductionKindOf("archive.zip")).toBeNull();
		expect(reductionKindOf("pdf")).toBeNull();
		expect(reductionKindOf(".pdf")).toBeNull();
		expect(reductionKindOf("trailing.")).toBeNull();
	});

	it("extensionOfName ignores dotfiles", () => {
		expect(extensionOfName(".gitignore")).toBe("");
		expect(extensionOfName("x.TAR")).toBe("tar");
	});
});

describe("formatByteSize", () => {
	it("uses binary units with one decimal below ten", () => {
		expect(formatByteSize(812)).toBe("812 B");
		expect(formatByteSize(2048)).toBe("2.0 KB");
		expect(formatByteSize(8_648_661)).toBe("8.2 MB");
		expect(formatByteSize(25 * 1024 * 1024)).toBe("25 MB");
	});
});

describe("reducedCopyName & REDUCTION_LEVELS", () => {
	it("offers three ordered compression levels", () => {
		expect(REDUCTION_LEVELS).toEqual(["light", "balanced", "max"]);
	});

	it("builds a single -reduced name and never stacks -reduced-reduced or numbered suffixes", () => {
		expect(reducedCopyName("k-skill-ai-rookie.mp4")).toBe("k-skill-ai-rookie-reduced.mp4");
		expect(reducedCopyName("k-skill-ai-rookie-reduced.mp4")).toBe("k-skill-ai-rookie-reduced.mp4");
		expect(reducedCopyName("k-skill-ai-rookie-reduced 8.mp4")).toBe("k-skill-ai-rookie-reduced.mp4");
		expect(reducedCopyName("scan.final.pdf")).toBe("scan.final-reduced.pdf");
	});
});
