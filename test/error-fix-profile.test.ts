import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorFixToolkit, errorFixProfile, type ErrorFixToolkit, type ErrorFixToolkitDeps } from "../src/main/agents/profiles/error-fix";
import { createAutoRagConfigService } from "../src/main/autorag-config-service";
import type { ConfigRefreshResult } from "../src/shared/settings-contract";
import { ERROR_FIX_SETTINGS_PAGES } from "../src/shared/error-fix-contract";

let root: string;
let configPath: string;
let backupPath: string;

async function writeConfig(config: Record<string, unknown>): Promise<void> {
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "error-fix-"));
	configPath = join(root, "config.json");
	backupPath = `${configPath}.bak-20261026101112-before-error-fix`;
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
		cwd: root,
		agentDir: join(root, "agent"),
		env: {},
		config: createAutoRagConfigService({ env: { HOME: root, AUTORAG_CONFIG: configPath }, cwd: root }),
		diagnostics: async () => ({ model: { provider: "faux", id: "m" } }),
		refreshIndex: async () => REFRESHED,
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
	it("gives the agent pi's own file and shell tools beside the app's three", () => {
		const kit = toolkit();
		const profile = errorFixProfile({ message: "boom", surface: "ai-search", language: "ko", toolkit: kit });

		expect(profile.id).toBe("error-fix");
		expect(profile.tools).toEqual([]);
		expect(kit.tools.map((tool) => tool.name).sort()).toEqual(["bash", "diagnose", "edit", "find", "grep", "ls", "read", "refresh_index", "report_result", "write"]);
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

	it("tells the agent what each Settings page holds, so it can pick the page that really has the setting", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		for (const page of ERROR_FIX_SETTINGS_PAGES) expect(prompt, page).toMatch(new RegExp(`\\b${page}\\b`, "u"));
		expect(prompt).toMatch(/scope[^\n]*folders/iu);
		expect(prompt).toMatch(/indexing[^\n]*(?:progress|refresh)/iu);
		expect(prompt).toMatch(/plan[^\n]*(?:subscription|usage)/iu);
		expect(prompt).toMatch(/ai[^\n]*model/iu);
	});

	it("sends the agent to the page where a folder is chosen, not the page that only shows indexing progress", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toMatch(/choose[^\n]*folder[^\n]*scope|scope[^\n]*choose[^\n]*folder/iu);
	});

	it("sets the agent no budget: nothing about a few looks, a short search, being economical or not waiting", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).not.toMatch(/handful|a few looks|not a search of the computer|economical|costs the person time|do not wait for it|only a few requests/iu);
		expect(prompt).not.toMatch(/never run grep or find/iu);
	});

	it("lets the agent install a missing program and asks it to say what it installed", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toMatch(/missing program or library is yours to install with bash/iu);
		expect(prompt).toMatch(/say in the summary what you installed/iu);
	});

	it("sends the person to choose the folder when the agent cannot find it, instead of guessing", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toMatch(/do not guess: report needs-user, and give a button to the page where they choose the folders \(kind settings, target scope/iu);
	});

	it("names every tool the agent has", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		for (const name of ["read", "ls", "find", "grep", "edit", "write", "bash", "diagnose", "refresh_index", "report_result"]) expect(prompt, name).toContain(name);
		expect(prompt).not.toMatch(/check_path|update_config/u);
	});

	it("keeps the person's own documents out of what the agent may change, and the AI's own sign-in files out of what it may open", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toMatch(/person's own documents[^.]*(?:theirs|stay as they are)/iu);
		expect(prompt).toMatch(/sign-in and key files[^)]*never opened/iu);
	});

	it("says a button is optional, and that there is no button to a folder", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toMatch(/no button|without a button|only when/iu);
		expect(prompt).toMatch(/there is no button to a folder/iu);
		expect(prompt).not.toMatch(/kind \\?"folder\\?"/iu);
	});

	it("says a button must lead to a setting in the app that the person has to change, and that a cause outside the app, even one only the person can fix, gets none", () => {
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		// A button is for a setting in Dazzi itself that a Settings page holds.
		expect(prompt).toMatch(/give one only when the fix is a setting in Dazzi/iu);
		// A cause outside Dazzi gets none, even when only the person can fix it, and the example given is the operating system's own permission.
		expect(prompt).toMatch(/cause outside Dazzi does not need a button, even when only the person can fix it/iu);
		expect(prompt).toMatch(/operating system refused/iu);
		expect(prompt).toMatch(/leave `actions` out/iu);
		// A wrong page is worse than none.
		expect(prompt).toMatch(/does not hold the setting is worse than no button/iu);
	});

	it("requires every button label in the reply language, as a short natural phrase for what the button does", () => {
		for (const [language, name] of [["ko", "Korean"], ["en", "English"], ["ja", "Japanese"], ["zh", "Simplified Chinese"]] as const) {
			const prompt = errorFixProfile({ message: "x", surface: "ai-search", language, toolkit: toolkit() }).systemPrompt;

			expect(prompt, language).toMatch(new RegExp(`label[^\\n]*${name}`, "iu"));
		}
		const prompt = errorFixProfile({ message: "x", surface: "ai-search", language: "ko", toolkit: toolkit() }).systemPrompt;
		expect(prompt).toMatch(/not (?:a )?(?:word-for-word|literal)|natural/iu);
	});

	it("cuts a very long error before it reaches the prompt", () => {
		const prompt = errorFixProfile({ message: `start ${"x".repeat(20_000)} TAIL-MARKER-9f3a`, surface: "ai-search", language: "en", toolkit: toolkit() }).systemPrompt;

		expect(prompt).toContain("start ");
		expect(prompt).not.toContain("TAIL-MARKER-9f3a");
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

describe("refresh_index", () => {
	it("runs the index and reports what it did", async () => {
		const refreshIndex = vi.fn(async () => REFRESHED);

		const text = await call(toolkit({ refreshIndex }), "refresh_index", {});

		expect(refreshIndex).toHaveBeenCalledOnce();
		expect(text).toContain("scanned 4");
	});

	it("waits for the index run to end, however long it takes, and then tells the agent how it went", async () => {
		let finish: (result: ConfigRefreshResult) => void = () => undefined;
		let started: () => void = () => undefined;
		const hasStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const kit = toolkit({
			refreshIndex: () => {
				started();
				return new Promise<ConfigRefreshResult>((resolve) => {
					finish = resolve;
				});
			},
		});
		let answered = false;

		const pending = call(kit, "refresh_index", {}).then((text) => {
			answered = true;
			return text;
		});
		await hasStarted;
		// Let every already-queued continuation run: a tool that gave up waiting would have answered by now.
		for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
		expect(answered).toBe(false);
		finish(REFRESHED);

		expect(await pending).toContain("scanned 4");
		expect(await call(kit, "report_result", { status: "fixed", summary: "Rebuilt." })).toContain("Recorded");
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
			commands: [],
		});
	});

	it("lets the agent send the person to a Settings page or to a data source's own page, each with its own label", async () => {
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
				{ kind: "settings", target: "indexing", label: "See indexing" },
			],
		});

		expect(kit.result()?.actions).toEqual([
			{ kind: "source", target: "kakao", label: "Open the KakaoTalk connection" },
			{ kind: "settings", target: "indexing", label: "See indexing" },
		]);
	});

	it("has no button to a folder: nothing that goes wrong in the app is cured by looking inside one", async () => {
		const kit = toolkit();

		const text = await call(kit, "report_result", { status: "needs-user", summary: "Look there.", actions: [{ kind: "folder", target: join(root, "Documents"), label: "Open the folder" }] });

		expect(kit.result()?.actions).toEqual([]);
		expect(text).toMatch(/dropped/iu);
	});

	it("may give no button at all: an answer that only explains, or a cause that is nowhere in the app, has nowhere to send the person", async () => {
		const kit = toolkit();

		await call(kit, "report_result", { status: "cannot-fix", summary: "The provider is down. Try again later.", nextSteps: ["Try again in a few minutes."] });

		expect(kit.result()).toMatchObject({ status: "cannot-fix", actions: [] });
	});

	it("drops a destination the app cannot take the person to, and says so, so the agent can correct it", async () => {
		const kit = toolkit();

		const text = await call(kit, "report_result", {
			status: "needs-user",
			summary: "Go there.",
			actions: [
				{ kind: "settings", target: "../../etc", label: "Bad page" },
				{ kind: "source", target: "no-such-source", label: "Bad source" },
				{ kind: "folder", target: join(root, "Documents"), label: "A folder" },
				{ kind: "shell", target: "rm -rf /", label: "Not a kind" },
				{ kind: "settings", target: "scope", label: "Good" },
			],
		});

		expect(kit.result()?.actions).toEqual([{ kind: "settings", target: "scope", label: "Good" }]);
		for (const bad of ["../../etc", "no-such-source", "folder", "shell"]) expect(text).toContain(bad);
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

	it("counts a shell command as a change: what it did cannot be seen, so the person is shown it", async () => {
		const kit = toolkit();

		await call(kit, "bash", { command: "echo repaired" });

		expect(await call(kit, "report_result", { status: "fixed", summary: "Ran a repair." })).toContain("Recorded");
		expect(kit.result()).toMatchObject({ commands: ["echo repaired"] });
	});

	it("counts an edit of the config as a change and reports it with the answer", async () => {
		const kit = toolkit();

		await call(kit, "edit", { path: configPath, edits: [{ oldText: JSON.stringify(join(root, "Docs")), newText: JSON.stringify(join(root, "Documents")) }] });

		expect(await call(kit, "report_result", { status: "fixed", summary: "Repointed." })).toContain("Recorded");
		expect(kit.result()).toMatchObject({ changes: [{ path: "searchPaths" }], backupPath });
	});

	it("lists no commands when none ran", async () => {
		const kit = toolkit();
		await call(kit, "report_result", { status: "cannot-fix", summary: "Nothing to do." });

		expect(kit.result()?.commands).toEqual([]);
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
