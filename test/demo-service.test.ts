import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAutomationService } from "../src/main/automation-service";
import { createDemoService } from "../src/main/demo-service";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";
import { DEMO_AUTOMATION_ID, DEMO_MAGIC_ACTION_ID } from "../src/shared/demo-contract";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(daemonRunning: boolean) {
	const root = await mkdtemp(join(tmpdir(), "demo-service-"));
	directories.push(root);
	const home = join(root, "home");
	const autoragHome = join(root, "autorag");
	await mkdir(home, { recursive: true });
	const calls: string[][] = [];
	let settings: AppSettings = DEFAULT_SETTINGS;
	// The real automation service over a real rules file; only the librarian CLI is faked.
	const automations = createAutomationService({
		home: () => autoragHome,
		run: async (args) => {
			calls.push([...args]);
			const rules = JSON.parse(readFileSync(join(autoragHome, "automations.json"), "utf8")) as { automations: Record<string, unknown>[] };
			const report = {
				ok: true,
				service: { platform: "darwin", installed: daemonRunning, running: daemonRunning },
				configPath: join(autoragHome, "automations.json"),
				automations: rules.automations,
			};
			return { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
		},
	});
	const demo = createDemoService({
		home,
		autoragHome,
		platform: "darwin",
		automations,
		run: async (args) => {
			calls.push([...args]);
			return { code: 0, stdout: "", stderr: "" };
		},
		settings: {
			get: async () => settings,
			set: async (patch) => {
				settings = { ...settings, ...patch };
				return settings;
			},
		},
	});
	return {
		demo,
		home,
		autoragHome,
		calls,
		automations,
		settings: () => settings,
		seed: async (contextMenu: AppSettings["contextMenu"]) => {
			settings = { ...settings, contextMenu };
		},
	};
}

describe("createDemoService automation", () => {
	it("writes a rule watching the inbox, installs the daemon, and reuses everything on a second run", async () => {
		const { demo, automations, calls } = await fixture(true);
		const first = await demo.prepareAutomation();
		expect(first.daemon).toBe(true);
		expect(existsSync(first.inbox)).toBe(true);
		const rule = (await automations.snapshot()).rules.find((candidate) => candidate.id === DEMO_AUTOMATION_ID);
		expect(rule?.paths).toEqual([first.inbox]);
		expect(rule?.events).toEqual(["create"]);
		expect(calls.some((call) => call.join(" ") === "automate install --json")).toBe(true);

		const second = await demo.prepareAutomation();
		expect(second.inbox).toBe(first.inbox);
		expect((await automations.snapshot()).rules.filter((candidate) => candidate.id === DEMO_AUTOMATION_ID)).toHaveLength(1);
	});

	it("keeps rules the person already had", async () => {
		const { demo, automations, autoragHome } = await fixture(true);
		await mkdir(autoragHome, { recursive: true });
		await writeFile(join(autoragHome, "automations.json"), JSON.stringify({ automations: [{ id: "mine", paths: ["/tmp/x"], run: ["true"] }] }));
		await demo.prepareAutomation();
		expect((await automations.snapshot()).rules.map((rule) => rule.id).sort()).toEqual([DEMO_AUTOMATION_ID, "mine"]);
	});

	it("lets the running daemon handle the dropped file, and runs the rule itself only without one", async () => {
		const withDaemon = await fixture(true);
		await withDaemon.demo.prepareAutomation();
		const dropped = await withDaemon.demo.triggerAutomation();
		expect(existsSync(dropped.dropped)).toBe(true);
		expect(withDaemon.calls.some((call) => call[1] === "run")).toBe(false);

		const without = await fixture(false);
		await without.demo.prepareAutomation();
		const manual = await without.demo.triggerAutomation();
		expect(without.calls.filter((call) => call[1] === "run")).toEqual([["automate", "run", DEMO_AUTOMATION_ID, "--event", `create:${manual.dropped}`]]);
	});

	it("the rule's command really sorts a dropped file by kind", async () => {
		const { demo, automations } = await fixture(true);
		const { inbox } = await demo.prepareAutomation();
		const rule = (await automations.snapshot()).rules.find((candidate) => candidate.id === DEMO_AUTOMATION_ID);
		const [, script, sortedRoot, kinds] = rule?.run ?? [];
		const note = join(inbox, "notes.txt");
		const photo = join(inbox, "photo.png");
		const clash = join(inbox, "archive.zip");
		await writeFile(note, "hello");
		await writeFile(photo, "x");
		await writeFile(clash, "y");
		execFileSync(process.execPath, [script as string, sortedRoot as string, kinds as string, note, photo, clash]);
		const names = JSON.parse(kinds as string) as { documents: string; images: string; other: string };
		expect(existsSync(join(sortedRoot as string, names.documents, "notes.txt"))).toBe(true);
		expect(existsSync(join(sortedRoot as string, names.images, "photo.png"))).toBe(true);
		expect(existsSync(join(sortedRoot as string, names.other, "archive.zip"))).toBe(true);
		expect(await readdir(inbox)).toEqual([]);
	});
});

describe("createDemoService magic action", () => {
	it("adds one script action for text files, keeps the person's own, and does not duplicate on a rerun", async () => {
		const { demo, settings, seed } = await fixture(true);
		await demo.prepareMagicAction();
		// The person's own action sits beside the demo one when the tutorial runs again.
		const current = settings();
		await seed({ ...current.contextMenu, magicActions: [...current.contextMenu.magicActions, { id: "mine", label: "Mine", enabled: true, selection: "any", targetKind: "any", extensions: [], execution: { kind: "script", command: "true" } }] });
		const { sample } = await demo.prepareMagicAction();
		const actions = settings().contextMenu.magicActions;
		expect(actions.filter((action) => action.id === DEMO_MAGIC_ACTION_ID)).toHaveLength(1);
		expect(actions.some((action) => action.id === "mine")).toBe(true);
		expect(existsSync(sample)).toBe(true);
		const demoAction = actions.find((action) => action.id === DEMO_MAGIC_ACTION_ID);
		expect(demoAction?.execution.kind).toBe("script");
		expect(demoAction?.extensions).toContain("txt");
	});

	it("the action's script prints the size and first lines of the file", async () => {
		const { demo, settings } = await fixture(true);
		const { sample } = await demo.prepareMagicAction();
		const action = settings().contextMenu.magicActions.find((candidate) => candidate.id === DEMO_MAGIC_ACTION_ID);
		if (action?.execution.kind !== "script") throw new Error("expected a script action");
		const output = execFileSync("/bin/sh", ["-c", action.execution.command, "dazzi-magic-action", sample], { encoding: "utf8" });
		expect(output).toContain("bytes");
		expect(output.split("\n").length).toBeGreaterThan(3);
	});
});

describe("automation upsert", () => {
	it("replaces a rule in place and leaves the other entries as written", async () => {
		const { automations, autoragHome } = await fixture(true);
		await mkdir(autoragHome, { recursive: true });
		const first = { id: "a", paths: ["/tmp/a"], run: ["true"], extra: 1 };
		await writeFile(join(autoragHome, "automations.json"), JSON.stringify({ automations: [first, { id: "b", paths: ["/tmp/b"], run: ["true"] }] }));
		await automations.upsert({ id: "b", paths: ["/tmp/c"], run: ["false"] });
		const saved = JSON.parse(readFileSync(join(autoragHome, "automations.json"), "utf8")) as { automations: Record<string, unknown>[] };
		expect(saved.automations).toEqual([first, { id: "b", paths: ["/tmp/c"], run: ["false"] }]);
	});
});

