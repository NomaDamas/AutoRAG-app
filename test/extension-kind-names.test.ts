import { describe, expect, it } from "vitest";
import { RASTER_EXTENSIONS } from "../src/preview/shared/raster-formats";
import { extensionKindName, hasExtensionKindName } from "../src/shared/extension-kind-names";

describe("extension kind names", () => {
	it("names every picture format the Finder and Quick Look now draw, so no row falls back to a generic 'Document'", () => {
		for (const ext of [...RASTER_EXTENSIONS, "ai", "jxl", "xcf"]) {
			expect(hasExtensionKindName(ext), ext).toBe(true);
			expect(extensionKindName(ext), ext).not.toBeNull();
		}
	});

	it("is case-insensitive and ignores a leading dot", () => {
		expect(hasExtensionKindName("XCF")).toBe(true);
		expect(hasExtensionKindName(".Sketch")).toBe(true);
	});

	it("names no extension it was not asked about", () => {
		expect(hasExtensionKindName("txt")).toBe(false);
		expect(hasExtensionKindName("")).toBe(false);
		expect(extensionKindName("weird")).toBeNull();
	});

	it("carries the camera maker for a RAW so the label can say whose", () => {
		expect(extensionKindName("cr3")).toEqual({ key: "raw", maker: "Canon" });
		expect(extensionKindName("nef")).toEqual({ key: "raw", maker: "Nikon" });
		expect(extensionKindName("dng")).toEqual({ key: "raw", maker: "Adobe" });
		// A bare .raw belongs to several makers (Panasonic, Leica), so it stays generic
		expect(extensionKindName("raw")).toEqual({ key: "rawGeneric" });
	});
});
