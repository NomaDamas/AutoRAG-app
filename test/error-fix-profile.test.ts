import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorFixToolkit, errorFixProfile, type ErrorFixToolkit, type ErrorFixToolkitDeps } from "../src/main/agents/profiles/error-fix";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";
import type { ErrorFixStep } from "../src/shared/error-fix-contract";

let root: string;
let configPath: string;
let backupPath: string;
let steps: ErrorFixStep[];

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function readConfig(): Promise<unknown> {
	return JSON.parse(await readFile(configPath, "utf8"));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "error-fix-"));
	configPath = join(root, "config.json");
	backupPath = `${configPath}.bak-20261026101112-before-error-fix`;
	steps = [];
	await mkdir(join(root, "Docs"), { recursive: true });
	await mkdir(join(root, "Documents"), { recursive: true });
	await writeFile(join(root, "Documents", "a.md"), "x");
	await writeFile(join(root, "note.txt"), "x");
	await writeConfig({ searchPaths: [join(root, "Docs")], workspacePath: join(root, "ws"), memoryPath: join(root, "memory.json") });
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const REFRESHED: ConfigRefreshResult = { ok: true, methods: ["parsed"], scanned: 4, written: 4, deleted: 0, skipped: 0, diagnostics: [], error: null };

function toolkit(overrides: Partial<ErrorFixToolkitDeps> = {}): ErrorFixToolkit {
	return createErrorFixToolkit({
		config: createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root }),
		diagnostics: async () => ({ model: { provider: "faux", id: "m" } }),
		refreshIndex: async () => REFRESHED,
		onStep: (step) => steps.push(step),
		now: () => new Date("2026-10-26T10:11:12Z"),
		...overrides,
	});
}

/** Runs one tool the way the agent would and returns the text it gets back. */
async function call(kit: ErrorFixToolkit, name: string, params: object): Promise<string> {
	const tool = kit.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`no tool ${name}`);
	const result = await tool.execute("call", params, undefined, undefined, undefined as never);
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

describe("the error-fix profile", () => {
	it("gives the agent only the app's own tools: pi's file and shell tools reach the whole machine", () => {
		const kit = toolkit();
		const profile = errorFixProfile({ message: "boom", surface: "ai-search", language: "ko", toolkit: kit });

		expect(profile.id).toBe("error-fix");
		expect(profile.tools).toEqual([]);
		expect(kit.tools.map((tool) => tool.name).sort()).toEqual(["check_path", "diagnose", "refresh_index", "report_result", "update_config"]);
		expect(profile.customTools).toBe(kit.tools);
	});

	it("tells the agent the error as the person saw it, the reply language and that the model is not its to change", () => {
		const prompt = errorFixProfile({ message: "Search root /Users/me/Docs does not exist", surface: "ai-search", language: "ja", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toContain("Search root /Users/me/Docs does not exist");
		expect(prompt).toContain("AI Search");
		expect(prompt).toContain("Japanese");
		expect(prompt).toContain("report_result");
		expect(prompt).toMatch(/never (?:change|touch|edit)[^.]*model/iu);
	});

	it("cuts a very long error before it reaches the prompt", () => {
		const prompt = errorFixProfile({ message: `start ${"x".repeat(20_000)} end`, surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toContain("start ");
		expect(prompt).not.toContain(" end");
		expect(prompt.length).toBeLessThan(12_000);
	});
});

describe("diagnose", () => {
	it("reports the config with secrets redacted and says which absolute paths in it exist", async () => {
		await writeConfig({
			searchPaths: [join(root, "Docs"), join(root, "gone")],
			workspacePath: join(root, "ws"),
			memoryPath: join(root, "memory.json"),
			datasources: { demo: { connector: { token: "s3cret-value", dataDir: join(root, "missing-dir") } } },
		});
		const kit = toolkit({ diagnostics: async () => ({ model: { provider: "dazzi", id: "deepseek" }, index: { state: "idle" } }) });

		const text = await call(kit, "diagnose", {});

		expect(text).not.toContain("s3cret-value");
		expect(JSON.parse(text)).toMatchObject({
			configPath,
			configError: null,
			app: { model: { provider: "dazzi", id: "deepseek" }, index: { state: "idle" } },
			paths: expect.arrayContaining([
				{ at: "searchPaths[0]", path: join(root, "Docs"), exists: true },
				{ at: "searchPaths[1]", path: join(root, "gone"), exists: false },
				{ at: "datasources.demo.connector.dataDir", path: join(root, "missing-dir"), exists: false },
			]),
		});
		expect(steps).toEqual([{ tool: "diagnose", detail: null }]);
	});

	it("passes on why the config cannot be read instead of failing", async () => {
		await writeFile(configPath, "{ not json");

		expect(JSON.parse(await call(toolkit(), "diagnose", {}))).toMatchObject({ configError: expect.stringMatching(/\S/u) });
	});

	it("reports a failing diagnostics probe as text so one broken probe never hides the rest", async () => {
		const text = await call(toolkit({ diagnostics: async () => Promise.reject(new Error("probe broke")) }), "diagnose", {});

		expect(JSON.parse(text)).toMatchObject({ configPath, app: { error: "probe broke" } });
	});
});

describe("check_path", () => {
	it("lists the names in a folder, marking sub-folders, and never opens a file", async () => {
		const parsed = JSON.parse(await call(toolkit(), "check_path", { path: root }));

		expect(parsed).toMatchObject({ exists: true, type: "directory", entries: expect.arrayContaining(["Docs/", "Documents/", "note.txt"]) });
		expect(steps).toEqual([{ tool: "check_path", detail: root }]);
	});

	it("says what a file is without reading it", async () => {
		const parsed = JSON.parse(await call(toolkit(), "check_path", { path: join(root, "note.txt") }));

		expect(parsed).toMatchObject({ exists: true, type: "file" });
		expect(parsed).not.toHaveProperty("entries");
	});

	it("shows the closest folder that does exist when the path is gone, so a renamed folder can be found", async () => {
		const parsed = JSON.parse(await call(toolkit(), "check_path", { path: join(root, "Docs", "old", "deep") }));

		expect(parsed).toMatchObject({ exists: false, nearestExisting: { path: join(root, "Docs"), entries: [] } });
	});

	it("refuses a relative path and says why", async () => {
		expect(await call(toolkit(), "check_path", { path: "Docs" })).toContain("absolute");
	});

	it("caps a huge folder listing", async () => {
		const many = join(root, "many");
		await mkdir(many);
		await Promise.all(Array.from({ length: 300 }, (_, index) => writeFile(join(many, `f${index}.txt`), "")));

		const parsed = JSON.parse(await call(toolkit(), "check_path", { path: many }));

		expect(parsed).toHaveProperty("entries.length", 100);
		expect(parsed).toMatchObject({ more: 200 });
	});

	it("allows a bounded number of looks per run and then tells the agent to report, so a missing folder is never searched for across the whole machine", async () => {
		const kit = toolkit();
		const answers: string[] = [];

		for (let index = 0; index < 8; index += 1) answers.push(await call(kit, "check_path", { path: join(root, `nowhere-${index}`) }));

		expect(answers.slice(0, 6).every((text) => !text.startsWith("Refused"))).toBe(true);
		expect(answers[6]).toMatch(/^Refused.*report_result/su);
		expect(answers[7]).toMatch(/^Refused/u);
		// Only the looks that were allowed are announced to the person.
		expect(steps.filter((step) => step.tool === "check_path")).toHaveLength(6);
	});

	it("does not count a refused relative path as a look", async () => {
		const kit = toolkit();

		for (let index = 0; index < 10; index += 1) await call(kit, "check_path", { path: "relative" });

		expect(await call(kit, "check_path", { path: root })).not.toMatch(/^Refused/u);
	});
});

describe("update_config", () => {
	it("writes the change, keeps a copy of the old config first and records before and after", async () => {
		const kit = toolkit();

		const text = await call(kit, "update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] });
		await call(kit, "report_result", { status: "fixed", summary: "Pointed the search folder at Documents." });

		expect(text).toContain("Changed searchPaths");
		expect(await readConfig()).toMatchObject({ searchPaths: [join(root, "Documents")] });
		expect(kit.result()).toMatchObject({
			changes: [{ path: "searchPaths", before: JSON.stringify([join(root, "Docs")]), after: JSON.stringify([join(root, "Documents")]) }],
			backupPath,
		});
		expect(JSON.parse(await readFile(backupPath, "utf8"))).toMatchObject({ searchPaths: [join(root, "Docs")] });
		expect(steps).toContainEqual({ tool: "update_config", detail: "searchPaths" });
	});

	it("removes a key when asked to", async () => {
		await writeConfig({ searchPaths: [root], workspacePath: join(root, "ws"), memoryPath: join(root, "memory.json"), webSearch: { enabled: true, order: ["nowhere"] } });

		const text = await call(toolkit(), "update_config", { updates: [{ path: ["webSearch", "order"], remove: true }] });

		expect(text).toContain("Changed webSearch.order");
		const written = await readConfig();
		expect(written).toHaveProperty("webSearch.enabled", true);
		expect(written).not.toHaveProperty("webSearch.order");
	});

	it("refuses what is the person's to decide or can never be edited here, and writes nothing", async () => {
		const before = await readFile(configPath, "utf8");
		const kit = toolkit();

		expect(await call(kit, "update_config", { updates: [{ path: ["model", "id"], value: "other" }] })).toMatch(/^Refused.*model/su);
		expect(await call(kit, "update_config", { updates: [{ path: ["datasources", "x", "connector", "apiKey"], value: "abc" }] })).toMatch(/^Refused.*secret/su);
		expect(await call(kit, "update_config", { updates: [{ path: ["workspacePath"], value: "/tmp/elsewhere" }] })).toMatch(/^Refused/u);
		expect(await call(kit, "update_config", { updates: [{ path: [], value: 1 }] })).toMatch(/^Refused/u);
		expect(await call(kit, "update_config", { updates: [{ path: ["searchPaths"] }] })).toMatch(/^Refused/u);
		expect(await call(kit, "update_config", { updates: [] })).toMatch(/^Refused/u);

		expect(await readFile(configPath, "utf8")).toBe(before);
		await expect(readFile(backupPath, "utf8")).rejects.toThrow();
	});

	it("refuses to reach into a list by position: the list is set whole, or an index key would turn it into an object", async () => {
		const before = await readFile(configPath, "utf8");

		const text = await call(toolkit(), "update_config", { updates: [{ path: ["searchPaths", "0"], value: join(root, "Documents") }] });

		expect(text).toMatch(/^Refused.*list/su);
		expect(await readFile(configPath, "utf8")).toBe(before);
		await expect(readFile(backupPath, "utf8")).rejects.toThrow();
	});

	it("lets the agent name an environment variable for a key, which is not itself a secret", async () => {
		const text = await call(toolkit(), "update_config", { updates: [{ path: ["datasources", "x", "connector", "tokenEnv"], value: "MY_TOKEN" }] });

		expect(text).not.toMatch(/^Refused/u);
	});

	it("hands the validator's complaint back to the agent and leaves the file and the backup alone", async () => {
		const before = await readFile(configPath, "utf8");

		const text = await call(toolkit(), "update_config", { updates: [{ path: ["searchPaths"], value: 5 }] });

		expect(text).toMatch(/^Refused/u);
		expect(await readFile(configPath, "utf8")).toBe(before);
		await expect(readFile(backupPath, "utf8")).rejects.toThrow();
	});

	it("takes the backup once per run, however many changes follow", async () => {
		const kit = toolkit();

		await call(kit, "update_config", { updates: [{ path: ["searchPaths"], value: [join(root, "Documents")] }] });
		await call(kit, "update_config", { updates: [{ path: ["excludeExactDuplicates"], value: false }] });
		await call(kit, "report_result", { status: "fixed", summary: "Done." });

		expect(kit.result()?.changes.map((change) => change.path)).toEqual(["searchPaths", "excludeExactDuplicates"]);
		expect(kit.result()?.backupPath).toBe(backupPath);
		expect(JSON.parse(await readFile(backupPath, "utf8"))).toMatchObject({ searchPaths: [join(root, "Docs")] });
	});
});

describe("refresh_index", () => {
	it("runs the index and reports what it did", async () => {
		const refreshIndex = vi.fn(async () => REFRESHED);

		const text = await call(toolkit({ refreshIndex }), "refresh_index", {});

		expect(refreshIndex).toHaveBeenCalledOnce();
		expect(text).toContain("scanned 4");
		expect(steps).toEqual([{ tool: "refresh_index", detail: null }]);
	});

	it("does not wait for a long index run: it tells the agent the run goes on in the background, and that is not yet a repair", async () => {
		let finish: (result: ConfigRefreshResult) => void = () => undefined;
		const slow = new Promise<ConfigRefreshResult>((resolve) => {
			finish = resolve;
		});
		const kit = toolkit({ refreshIndex: () => slow, refreshWaitMs: 20 });

		const text = await call(kit, "refresh_index", {});

		expect(text).toMatch(/background/iu);
		expect(await call(kit, "report_result", { status: "fixed", summary: "Rebuilt." })).toMatch(/^Refused/u);
		finish(REFRESHED);
	});

	it("passes a failed run's diagnostics to the agent", async () => {
		const failed: ConfigRefreshResult = { ...REFRESHED, ok: false, error: "search root is gone", diagnostics: [{ code: "search-root-unavailable", severity: "error", message: "search root is gone" }] };

		const text = await call(toolkit({ refreshIndex: async () => failed }), "refresh_index", {});

		expect(text).toContain("search root is gone");
		expect(text).toContain("search-root-unavailable");
	});

	it("reports a run that throws as text", async () => {
		expect(await call(toolkit({ refreshIndex: async () => Promise.reject(new Error("locked")) }), "refresh_index", {})).toContain("locked");
	});
});

describe("report_result", () => {
	it("is the agent's answer: status, summary in its own words, next steps and the buttons it chose", async () => {
		const kit = toolkit();

		const text = await call(kit, "report_result", { status: "needs-user", summary: "  The folder was moved.  ", nextSteps: ["Pick the new folder", " "], actions: [{ kind: "settings", target: "scope", label: "Pick the folder" }] });

		expect(text).toContain("Recorded");
		expect(kit.result()).toEqual({
			status: "needs-user",
			summary: "The folder was moved.",
			nextSteps: ["Pick the new folder"],
			actions: [{ kind: "settings", target: "scope", label: "Pick the folder" }],
			changes: [],
			backupPath: null,
		});
	});

	it("lets the agent send the person to a Settings page, a data source's own page, or a folder, each with its own label", async () => {
		await writeConfig({
			searchPaths: [join(root, "Docs")],
			workspacePath: join(root, "ws"),
			memoryPath: join(root, "memory.json"),
			datasources: { kakao: { connector: { configPath: join(root, "Docs") } } },
		});
		const kit = toolkit();

		await call(kit, "report_result", {
			status: "needs-user",
			summary: "Two things need you.",
			actions: [
				{ kind: "source", target: "kakao", label: "Open the KakaoTalk connection" },
				{ kind: "folder", target: join(root, "Documents"), label: "Look at the Documents folder" },
				{ kind: "settings", target: "indexing", label: "See indexing" },
			],
		});

		expect(kit.result()?.actions).toEqual([
			{ kind: "source", target: "kakao", label: "Open the KakaoTalk connection" },
			{ kind: "folder", target: join(root, "Documents"), label: "Look at the Documents folder" },
			{ kind: "settings", target: "indexing", label: "See indexing" },
		]);
	});

	it("drops a destination the app cannot take the person to, and says so, so the agent can correct it", async () => {
		const kit = toolkit();

		const text = await call(kit, "report_result", {
			status: "needs-user",
			summary: "Go there.",
			actions: [
				{ kind: "settings", target: "../../etc", label: "Bad page" },
				{ kind: "source", target: "no-such-source", label: "Bad source" },
				{ kind: "folder", target: join(root, "missing"), label: "Missing folder" },
				{ kind: "folder", target: join(root, "note.txt"), label: "A file, not a folder" },
				{ kind: "folder", target: "Documents", label: "Relative" },
				{ kind: "shell", target: "rm -rf /", label: "Not a kind" },
				{ kind: "settings", target: "scope", label: "Good" },
			],
		});

		expect(kit.result()?.actions).toEqual([{ kind: "settings", target: "scope", label: "Good" }]);
		for (const bad of ["../../etc", "no-such-source", "missing", "note.txt", "Documents", "shell"]) expect(text).toContain(bad);
		expect(text).toMatch(/dropped/iu);
	});

	it("keeps at most three buttons, trims and shortens a label, and gives a button without one no empty name", async () => {
		const kit = toolkit();

		await call(kit, "report_result", {
			status: "needs-user",
			summary: "Many.",
			actions: [
				{ kind: "settings", target: "scope", label: `  ${"x".repeat(200)}  ` },
				{ kind: "settings", target: "ai", label: "   " },
				{ kind: "settings", target: "plan", label: "Plan" },
				{ kind: "settings", target: "web", label: "Fourth" },
			],
		});

		const actions = kit.result()?.actions ?? [];
		expect(actions.map((action) => action.target)).toEqual(["scope", "ai", "plan"]);
		expect(actions[0]?.label.length).toBeLessThanOrEqual(60);
		expect(actions[1]?.label).toBe("");
	});

	it("lets the same destination appear once", async () => {
		const kit = toolkit();

		await call(kit, "report_result", { status: "needs-user", summary: "Twice.", actions: [{ kind: "settings", target: "scope", label: "A" }, { kind: "settings", target: "scope", label: "B" }] });

		expect(kit.result()?.actions).toEqual([{ kind: "settings", target: "scope", label: "A" }]);
	});

	it("refuses 'fixed' when nothing was changed, since an explanation is not a repair", async () => {
		const kit = toolkit();

		const text = await call(kit, "report_result", { status: "fixed", summary: "All good now." });

		expect(text).toMatch(/^Refused/u);
		expect(kit.result()).toBeNull();
	});

	it("counts a successful index run as a change, and a failed one as none", async () => {
		const failing = toolkit({ refreshIndex: async () => ({ ...REFRESHED, ok: false, error: "still broken" }) });
		await call(failing, "refresh_index", {});
		expect(await call(failing, "report_result", { status: "fixed", summary: "ok" })).toMatch(/^Refused/u);

		const working = toolkit();
		await call(working, "refresh_index", {});
		expect(await call(working, "report_result", { status: "fixed", summary: "Rebuilt the index." })).toContain("Recorded");
		expect(working.result()).toMatchObject({ status: "fixed", changes: [], backupPath: null });
	});

	it("refuses an empty summary", async () => {
		const kit = toolkit();

		expect(await call(kit, "report_result", { status: "cannot-fix", summary: "   " })).toMatch(/^Refused/u);
		expect(kit.result()).toBeNull();
	});

	it("keeps the last accepted answer when the agent corrects itself", async () => {
		const kit = toolkit();

		await call(kit, "report_result", { status: "cannot-fix", summary: "First." });
		await call(kit, "report_result", { status: "needs-user", summary: "Second." });

		expect(kit.result()?.summary).toBe("Second.");
	});
});
