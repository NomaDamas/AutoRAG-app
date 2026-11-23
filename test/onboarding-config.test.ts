import { describe, expect, it } from "vitest";
import { applyIndexingConfig } from "../src/main/onboarding-config";
import { isJsonObject } from "../src/shared/settings-contract";

describe("applyIndexingConfig keyword-only switch", () => {
	const base = { folders: ["/a"], workspacePath: null };

	it("writes appIndexing.semanticSearch=false and keeps the block's other settings", () => {
		const next = applyIndexingConfig({ ...base, raw: { appIndexing: { excludeCodeFolders: false } }, semanticSearch: false });
		expect(next.appIndexing).toEqual({ excludeCodeFolders: false, semanticSearch: false });
	});

	it("removes the switch when semantic search is on, and the block with it when nothing else is in it", () => {
		expect(applyIndexingConfig({ ...base, raw: { appIndexing: { semanticSearch: false } }, semanticSearch: true }).appIndexing).toBeUndefined();
		expect(applyIndexingConfig({ ...base, raw: { appIndexing: { semanticSearch: false, fileTimeoutMs: 5 } }, semanticSearch: true }).appIndexing).toEqual({ fileTimeoutMs: 5 });
	});
});

describe("applyIndexingConfig excludePaths", () => {
	const base = { folders: ["/a"], workspacePath: null };

	it("adds the chosen folders after the user's own exclusions, without repeating one", () => {
		const next = applyIndexingConfig({ ...base, raw: { excludePaths: ["/keep", "/a/Zoom"] }, excludePaths: ["/a/Zoom", "/a/Telegram"] });
		expect(next.excludePaths).toEqual(["/keep", "/a/Zoom", "/a/Telegram"]);
	});

	it("creates the list when the config has none, and leaves the config alone when nothing is excluded", () => {
		expect(applyIndexingConfig({ ...base, raw: {}, excludePaths: ["/a/Zoom"] }).excludePaths).toEqual(["/a/Zoom"]);
		expect(applyIndexingConfig({ ...base, raw: {}, excludePaths: [] }).excludePaths).toBeUndefined();
		expect(applyIndexingConfig({ ...base, raw: { excludePaths: ["/keep"] } }).excludePaths).toEqual(["/keep"]);
	});
});

describe("applyIndexingConfig", () => {
	it("replaces searchPaths and never writes an embedder block (the first index is keyword-only)", () => {
		const raw = { searchPaths: ["/old"], minSync: { embedder: { profile: "keep", dimension: 1 }, other: true } };
		const next = applyIndexingConfig({ raw, folders: ["/a", "/b"], workspacePath: null, semanticSearch: false });
		expect(next.searchPaths).toEqual(["/a", "/b"]);
		expect(isJsonObject(next.minSync) && next.minSync.embedder).toEqual({ profile: "keep", dimension: 1 });
		expect(isJsonObject(next.minSync) && next.minSync.other).toBe(true);
	});

	it("replaces workspacePath only when one is given", () => {
		const base = { raw: { workspacePath: "/keep" }, folders: ["/a"] };
		expect(applyIndexingConfig({ ...base, workspacePath: null }).workspacePath).toBe("/keep");
		expect(applyIndexingConfig({ ...base, workspacePath: "/home/.autorag/workspace" }).workspacePath).toBe("/home/.autorag/workspace");
	});

	it("never touches the model or datasource blocks: Settings owns those", () => {
		const next = applyIndexingConfig({
			raw: { model: { provider: "old", id: "old" }, datasources: { slack: { type: "slack" } } },
			folders: ["/a"],
			workspacePath: null,
		});
		expect(next.model).toEqual({ provider: "old", id: "old" });
		expect(next.datasources).toEqual({ slack: { type: "slack" } });
	});
});
