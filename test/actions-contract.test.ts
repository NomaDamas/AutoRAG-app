import { describe, expect, it } from "vitest";
import { isActionRequest } from "../src/shared/actions-contract";

describe("isActionRequest compress", () => {
	it("accepts a bare compress and the two writable formats", () => {
		expect(isActionRequest({ kind: "compress" })).toBe(true);
		expect(isActionRequest({ kind: "compress", format: "zip" })).toBe(true);
		expect(isActionRequest({ kind: "compress", format: "7z" })).toBe(true);
	});

	it("rejects a format the writer cannot produce, notably rar", () => {
		expect(isActionRequest({ kind: "compress", format: "rar" })).toBe(false);
		expect(isActionRequest({ kind: "compress", format: 7 })).toBe(false);
		expect(isActionRequest({ kind: "compress", format: undefined })).toBe(false);
	});
});

describe("isActionRequest reduceSize", () => {
	it("accepts the bare request and no longer knows the image-only optimize", () => {
		expect(isActionRequest({ kind: "reduceSize" })).toBe(true);
		expect(isActionRequest({ kind: "optimizeImage" })).toBe(false);
	});
});
