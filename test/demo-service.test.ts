import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoService } from "../src/main/demo-service";
import { DEFAULT_SETTINGS, type AppSettings } from "../src/shared/settings-contract";
import type { AutomationsSnapshot } from "../src/shared/automation-contract";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function snapshot(running: boolean): AutomationsSnapshot {
	return { ready: true, rules: [], daemon: { platform: "darwin", installed: running, running }, configPath: "", configError: null, error: null };
}

async function fixture(options: { readonly daemonRunning?: boolean; readonly installFails?: boolean } = {}) {
	const root = await mkdtemp(join(tmpdir(), "demo-service-"));
	directories.push(root);
	const home = join(root, "home");
	const source = join(root, "source.jpg");
	await writeFile(source, "not really a jpeg");
	let settings: AppSettings = DEFAULT_SETTINGS;
	let running = options.daemonRunning === true;
	const installs: boolean[] = [];
	const demo = createDemoService({
		home,
		downloads: join(home, "Downloads"),
		platform: "darwin",
		photoSource: source,
		automations: {
			snapshot: async () => snapshot(running),
			setDaemon: async (enabled) => {
				installs.push(enabled);
				if (options.installFails === true) throw new Error("no launchd");
				running = enabled;
				return snapshot(running);
			},
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
		installs,
		settings: () => settings,
		seed: (contextMenu: AppSettings["contextMenu"]) => {
			settings = { ...settings, contextMenu };
		},
	};
}

describe("createDemoService photo", () => {
	it("puts the sample photo under a meaningless placeholder name and points at the real Downloads folder", async () => {
		const { demo, home } = await fixture();
		const ready = await demo.preparePhoto();
		expect(ready.photo.endsWith("IMG_0001.jpg")).toBe(true);
		expect(readFileSync(ready.photo, "utf8")).toBe("not really a jpeg");
		expect(ready.downloads).toBe(join(home, "Downloads"));
		expect(ready.photo.startsWith(home)).toBe(true);
	});

	it("puts the photo back when it was moved away, and leaves one already there alone", async () => {
		const { demo } = await fixture();
		const first = await demo.preparePhoto();
		await writeFile(first.photo, "edited");
		await demo.preparePhoto();
		expect(readFileSync(first.photo, "utf8")).toBe("edited");
		await rm(first.photo);
		const again = await demo.preparePhoto();
		expect(readFileSync(again.photo, "utf8")).toBe("not really a jpeg");
	});
});

describe("createDemoService daemon", () => {
	it("installs the background service only when it is not already running", async () => {
		const idle = await fixture();
		expect(await idle.demo.ensureDaemon()).toBe(true);
		expect(idle.installs).toEqual([true]);
		const up = await fixture({ daemonRunning: true });
		expect(await up.demo.ensureDaemon()).toBe(true);
		expect(up.installs).toEqual([]);
	});

	it("reports false, not an error, when the service cannot be installed", async () => {
		const { demo } = await fixture({ installFails: true });
		expect(await demo.ensureDaemon()).toBe(false);
	});
});

describe("createDemoService practice file", () => {
	it("prepareSample writes the sample text file and adds no right-click action", async () => {
		const { demo, settings } = await fixture();
		const before = settings().contextMenu.magicActions.length;
		const { sample } = await demo.prepareSample();
		expect(existsSync(sample)).toBe(true);
		expect(settings().contextMenu.magicActions).toHaveLength(before);
	});
});
