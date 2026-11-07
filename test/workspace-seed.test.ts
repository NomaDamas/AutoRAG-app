import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorkspacePath, isFilesystemRoot, seedFromLaunchFolder, withoutRootWorkspace } from "../src/main/workspace-seed";

const ROOT = "/";
const HOME = "/Users/tester";
const DEFAULT_WORKSPACE = join(HOME, ".autorag", "workspace");

describe("defaultWorkspacePath", () => {
	it("lives under the AutoRAG home, which AUTORAG_HOME moves", () => {
		expect(defaultWorkspacePath({}, HOME)).toBe(DEFAULT_WORKSPACE);
		expect(defaultWorkspacePath({ AUTORAG_HOME: "/data/rag" }, HOME)).toBe(join(resolve("/data/rag"), "workspace"));
	});
});

describe("isFilesystemRoot", () => {
	it("is true for the root only", () => {
		expect(isFilesystemRoot(ROOT)).toBe(true);
		expect(isFilesystemRoot(join(ROOT, "Users"))).toBe(false);
	});
});

describe("seedFromLaunchFolder", () => {
	it("starts a packaged app launched from / with a workspace under the AutoRAG home and no folder to scan", () => {
		expect(seedFromLaunchFolder(ROOT, {}, HOME)).toEqual({ searchPaths: [], workspacePath: DEFAULT_WORKSPACE });
	});

	it("keeps the launch folder for a dev run started inside a project", () => {
		expect(seedFromLaunchFolder("/Users/tester/project", {}, HOME)).toEqual({ searchPaths: ["/Users/tester/project"], workspacePath: "/Users/tester/project" });
	});
});

describe("withoutRootWorkspace", () => {
	it("replaces the workspace and the seeded search root of a config an earlier Dazzi wrote from /", () => {
		const raw = { workspacePath: ROOT, searchPaths: [ROOT], minSync: { enabled: true } };
		expect(withoutRootWorkspace(raw, {}, HOME)).toEqual({ ...raw, workspacePath: DEFAULT_WORKSPACE, searchPaths: [] });
	});

	it("keeps search folders the user chose", () => {
		const raw = { workspacePath: ROOT, searchPaths: ["/Users/tester/Documents", ROOT] };
		expect(withoutRootWorkspace(raw, {}, HOME)).toEqual({ ...raw, workspacePath: DEFAULT_WORKSPACE });
	});

	it("leaves a config alone when its workspace is a normal folder or absent", () => {
		expect(withoutRootWorkspace({ workspacePath: "/Users/tester/notes", searchPaths: [ROOT] }, {}, HOME)).toBeNull();
		expect(withoutRootWorkspace({ searchPaths: [ROOT] }, {}, HOME)).toBeNull();
	});
});
