import { describe, expect, it } from "vitest";
import { autoragFirst, shouldAdoptManagedModel } from "../src/shared/account-contract";

describe("autoragFirst", () => {
	const rows = [{ id: "anthropic" }, { id: "openrouter" }, { id: "autorag" }, { id: "openai" }];

	it("puts the AutoRAG provider first and keeps every other provider's order", () => {
		expect(autoragFirst(rows).map((row) => row.id)).toEqual(["autorag", "anthropic", "openrouter", "openai"]);
	});

	it("leaves a list without AutoRAG untouched and never mutates its input", () => {
		const withoutAutorag = rows.filter((row) => row.id !== "autorag");
		expect(autoragFirst(withoutAutorag)).toEqual(withoutAutorag);
		const before = rows.map((row) => row.id);
		autoragFirst(rows);
		expect(rows.map((row) => row.id)).toEqual(before);
	});

	it("orders model entries by their provider key too", () => {
		const models = [{ provider: "openai", id: "a" }, { provider: "autorag", id: "b" }, { provider: "anthropic", id: "c" }, { provider: "autorag", id: "d" }];
		expect(autoragFirst(models, (model) => model.provider).map((model) => model.id)).toEqual(["b", "d", "a", "c"]);
	});
});

describe("shouldAdoptManagedModel", () => {
	it("adopts the account's models when no model is configured", () => {
		expect(shouldAdoptManagedModel({})).toBe(true);
		expect(shouldAdoptManagedModel({ model: undefined })).toBe(true);
	});

	it("re-adopts when the configured model is already an AutoRAG one", () => {
		expect(shouldAdoptManagedModel({ model: { provider: "autorag", id: "x" } })).toBe(true);
	});

	it("never overrides a model the user picked from another provider", () => {
		expect(shouldAdoptManagedModel({ model: { provider: "anthropic", id: "claude-haiku-5.5" } })).toBe(false);
		expect(shouldAdoptManagedModel({ model: { provider: "openai-compatible", id: "m", baseUrl: "http://127.0.0.1:1/v1" } })).toBe(false);
	});

	it("treats a malformed model value as the user's, not as unset", () => {
		expect(shouldAdoptManagedModel({ model: "oops" })).toBe(false);
		expect(shouldAdoptManagedModel({ model: null })).toBe(false);
	});
});
