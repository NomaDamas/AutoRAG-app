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
	it("accepts bare, level, replaceOriginal, and id fields, and rejects bad values or optimizeImage", () => {
		expect(isActionRequest({ kind: "reduceSize" })).toBe(true);
		expect(isActionRequest({ kind: "reduceSize", id: "job-1" })).toBe(true);
		expect(isActionRequest({ kind: "reduceSize", level: "light", replaceOriginal: true, id: "job-2" })).toBe(true);
		expect(isActionRequest({ kind: "reduceSize", level: "balanced", replaceOriginal: false })).toBe(true);
		expect(isActionRequest({ kind: "reduceSize", level: "max" })).toBe(true);
		expect(isActionRequest({ kind: "reduceSize", level: "extreme" })).toBe(false);
		expect(isActionRequest({ kind: "reduceSize", replaceOriginal: "yes" })).toBe(false);
		expect(isActionRequest({ kind: "reduceSize", id: "" })).toBe(false);
		expect(isActionRequest({ kind: "reduceSize", id: 7 })).toBe(false);
		expect(isActionRequest({ kind: "optimizeImage" })).toBe(false);
	});
});
