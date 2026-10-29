import { describe, expect, it } from "vitest";
import { isErrorFixRequest } from "../src/shared/error-fix-contract";

describe("isErrorFixRequest", () => {
	it("accepts a message from a surface the app knows", () => {
		expect(isErrorFixRequest({ message: "Search root does not exist", surface: "ai-search" })).toBe(true);
		expect(isErrorFixRequest({ message: "", surface: "ai-search" })).toBe(true);
	});

	it("refuses whatever the renderer could send that is not that, so the main process never starts an agent from it", () => {
		for (const value of [null, undefined, "ai-search", 42, [], {}, { message: "x" }, { surface: "ai-search" }, { message: 5, surface: "ai-search" }, { message: "x", surface: "settings" }, { message: "x", surface: undefined }]) {
			expect(isErrorFixRequest(value)).toBe(false);
		}
	});
});
