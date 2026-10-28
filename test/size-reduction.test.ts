import { describe, expect, it } from "vitest";
import { extensionOfName, formatByteSize, parseMediaHeader, reducedCopyName, REDUCTION_LEVELS, reductionKindOf } from "../src/shared/size-reduction";

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

describe("parseMediaHeader", () => {
	it("extracts duration and stream bitrates from ffmpeg header stderr", () => {
		const stderr = [
			"  Duration: 00:02:33.52, start: 0.000000, bitrate: 10572 kb/s",
			"  Stream #0:0[0x1](und): Video: h264 (High), yuv420p, 1920x1080, 10498 kb/s, 60 fps",
			"  Stream #0:1[0x2](und): Audio: aac (LC), 16000 Hz, mono, fltp, 70 kb/s",
		].join("\n");
		const parsed = parseMediaHeader(stderr, 194 * 1024 * 1024);
		expect(parsed.durationSec).toBeCloseTo(153.52, 2);
		expect(parsed.videoKbps).toBe(10498);
		expect(parsed.audioKbps).toBe(70);
	});

	it("derives total kbps from file size and duration when stream bitrates are absent (WebM/MKV)", () => {
		const parsed = parseMediaHeader("  Duration: 00:00:10.00, start: 0.000000, bitrate: N/A\n", 2_500_000);
		expect(parsed.durationSec).toBe(10);
		expect(parsed.totalKbps).toBe(2000);
	});
});
