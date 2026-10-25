import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CliConfig } from "@autorag/librarian/core";
import { desktopAppInstalled } from "../src/main/desktop-apps";
import { withIndexingPoliciesApplied } from "../src/main/indexing-policy";
import {
	ensureDiscrawlConfig,
	ensureMessengerConfigsFor,
	ensureSlacrawlConfig,
	fillSlackDesktopPath,
	slacrawlConfigText,
} from "../src/main/messenger-config";
import { detectSources } from "../src/main/onboarding-sources";
import { datasourceSupported, kakaoSupported } from "../src/shared/messenger-platform";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function home(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "autorag-messenger-"));
	directories.push(directory);
	return directory;
}

describe("KakaoTalk is a macOS-only source", () => {
	it("is offered on macOS and nowhere else", () => {
		expect(kakaoSupported("darwin")).toBe(true);
		expect(kakaoSupported("win32")).toBe(false);
		expect(kakaoSupported("linux")).toBe(false);
		expect(datasourceSupported("kakao", "win32")).toBe(false);
		expect(datasourceSupported("slack", "win32")).toBe(true);
	});

	it("drops a kakao row inherited from a Mac config before the librarian sees it, and keeps every other row", () => {
		const config = { datasources: { kakao: { instanceId: "default" }, slack: { type: "slack" }, "kakao-work": { type: "kakao" } } } as unknown as CliConfig;

		expect(Object.keys(withIndexingPoliciesApplied(config, "win32").datasources ?? {})).toEqual(["slack"]);
		expect(Object.keys(withIndexingPoliciesApplied(config, "darwin").datasources ?? {})).toEqual(["kakao", "slack", "kakao-work"]);
	});

	it("is never probed on Windows, even when a lazykatok binary happens to be on PATH", async () => {
		const probed: string[] = [];
		// Detecting on win32 writes discrawl's default config under the home, so the home must be a real temp directory:
		// a Windows-style path is only a relative path on the machine running the test, and the file lands in the checkout.
		const root = await home();
		const result = await detectSources({
			platform: "win32",
			home: root,
			env: { LOCALAPPDATA: join(root, "AppData", "Local"), APPDATA: join(root, "AppData", "Roaming") },
			run: async (command) => {
				probed.push(command);
				throw new Error("not found");
			},
			pathExists: async () => false,
			readDirNames: async () => [],
			readFileText: async () => {
				throw new Error("none");
			},
		});

		expect(probed).not.toContain("lazykatok");
		expect(result.sources.some((source) => source.id === "kakao")).toBe(false);
	});
});

describe("desktop app locator on Windows", () => {
	it("finds a per-user Squirrel install of Discord and Slack", async () => {
		const root = await home();
		const local = join(root, "AppData", "Local");
		await mkdir(join(local, "Discord", "app-1.0.9262"), { recursive: true });
		await writeFile(join(local, "Discord", "Update.exe"), "");
		await mkdir(join(local, "slack", "app-4.50.143"), { recursive: true });
		await writeFile(join(local, "slack", "slack.exe"), "");
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: local }, home: root };

		expect(await desktopAppInstalled("Discord", host)).toBe(true);
		expect(await desktopAppInstalled("Slack", host)).toBe(true);
	});

	it("says an app is missing only where its folder is really absent, and unknown for apps it has no location for", async () => {
		const root = await home();
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: join(root, "AppData", "Local") }, home: root };

		expect(await desktopAppInstalled("Discord", host)).toBe(false);
		expect(await desktopAppInstalled("Obsidian", host)).toBeNull();
		expect(await desktopAppInstalled("Discord", { ...host, platform: "linux" })).toBeNull();
	});

	it("recognises a Microsoft Store package of Slack", async () => {
		const root = await home();
		const local = join(root, "AppData", "Local");
		await mkdir(join(local, "Packages", "91750D7E.Slack_8she8kybcnzg4"), { recursive: true });

		expect(await desktopAppInstalled("Slack", { platform: "win32", env: { LOCALAPPDATA: local }, home: root })).toBe(true);
	});
});

describe("slacrawl and discrawl config on Windows", () => {
	it("writes a TOML path that survives Windows backslashes", () => {
		const text = slacrawlConfigText("C:\\Users\\me\\AppData\\Roaming\\Slack");

		expect(text).toContain('path = "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\Slack"');
		expect(text).toContain("[slack.desktop]\nenabled = true");
	});

	it("fills the blank desktop path that `slacrawl init` writes, and touches nothing else", () => {
		const init = "version = 1\n\n[slack.desktop]\nenabled = true\npath = ''\ndesktop_refresh_every = '5m'\n\n[slack.bot]\nenabled = true\n";
		const filled = fillSlackDesktopPath(init, "C:\\Slack");

		expect(filled).toBe("version = 1\n\n[slack.desktop]\nenabled = true\npath = \"C:\\\\Slack\"\ndesktop_refresh_every = '5m'\n\n[slack.bot]\nenabled = true\n");
	});

	it("leaves a path the user set, a turned-off desktop source and a file with no desktop table alone", () => {
		expect(fillSlackDesktopPath("[slack.desktop]\nenabled = true\npath = 'D:\\\\mine'\n", "C:\\Slack")).toBeNull();
		expect(fillSlackDesktopPath("[slack.desktop]\nenabled = false\npath = ''\n", "C:\\Slack")).toBeNull();
		expect(fillSlackDesktopPath("version = 1\n", "C:\\Slack")).toBeNull();
	});

	it("creates the default config files on Windows only, once, and never overwrites the user's", async () => {
		const root = await home();
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: join(root, "AppData", "Local"), APPDATA: join(root, "AppData", "Roaming") }, home: root };

		await ensureDiscrawlConfig(host);
		await ensureSlacrawlConfig(host);
		const discrawl = join(root, "AppData", "Local", "discrawl", "config.toml");
		const slacrawl = join(root, ".slacrawl", "config.toml");
		expect(await readFile(discrawl, "utf8")).toContain("Written by Dazzi");
		expect(await readFile(slacrawl, "utf8")).toContain(`Slack`);

		await writeFile(discrawl, "[search.embeddings]\nenabled = true\n");
		await writeFile(slacrawl, "version = 1\n[slack.desktop]\nenabled = true\npath = 'D:\\\\mine'\n");
		await ensureDiscrawlConfig(host);
		await ensureSlacrawlConfig(host);
		expect(await readFile(discrawl, "utf8")).toBe("[search.embeddings]\nenabled = true\n");
		expect(await readFile(slacrawl, "utf8")).toContain("D:\\\\mine");
	});

	it("does nothing on macOS or Linux, where the CLIs find their own data, and respects an explicit config env", async () => {
		const root = await home();
		for (const platform of ["darwin", "linux"] as const) {
			await ensureDiscrawlConfig({ platform, env: {}, home: root });
			await ensureSlacrawlConfig({ platform, env: {}, home: root });
		}
		await ensureSlacrawlConfig({ platform: "win32", env: { SLACRAWL_CONFIG: "X:\\mine.toml" }, home: root });

		await expect(readFile(join(root, ".slacrawl", "config.toml"), "utf8")).rejects.toThrow();
	});

	it("prepares only the CLIs of the datasources a run actually has", async () => {
		const root = await home();
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: join(root, "AppData", "Local") }, home: root };

		await ensureMessengerConfigsFor({ slack: { type: "slack" } }, host);

		expect(await readFile(join(root, ".slacrawl", "config.toml"), "utf8")).toContain("[slack.desktop]");
		await expect(readFile(join(root, "AppData", "Local", "discrawl", "config.toml"), "utf8")).rejects.toThrow();
	});
});

describe("messenger detection on Windows", () => {
	const winDeps = (root: string, run: (command: string, args: readonly string[]) => Promise<string>) => ({
		platform: "win32" as const,
		home: root,
		env: { LOCALAPPDATA: join(root, "AppData", "Local"), APPDATA: join(root, "AppData", "Roaming") } as NodeJS.ProcessEnv,
		run,
		pathExists: async () => false,
		readDirNames: async () => [],
		readFileText: async () => {
			throw new Error("none");
		},
	});

	it("finds Discord once its config exists, where `doctor` used to stop at a missing config", async () => {
		const root = await home();
		const configPath = join(root, "AppData", "Local", "discrawl", "config.toml");
		const result = await detectSources(
			winDeps(root, async (command, args) => {
				if (command !== "discrawl") throw new Error(`${command}: not found`);
				const exists = await readFile(configPath, "utf8").then(() => true, () => false);
				if (args.includes("doctor")) return JSON.stringify(exists ? { config: "ok", database: "ok" } : { config: "open config.toml: cannot find the path" });
				return JSON.stringify({ messages: 16, dry_run: true });
			}),
		);

		expect(result.sources).toEqual([{ id: "discord", facts: { messages: 16 } }]);
	});

	it("finds Slack from the desktop app itself when nothing is archived yet", async () => {
		const root = await home();
		const result = await detectSources(
			winDeps(root, async (command, args) => {
				if (command === "where") return "slacrawl.exe";
				if (command !== "slacrawl") throw new Error(`${command}: not found`);
				if (args.includes("sql")) return JSON.stringify([{ n: 0 }]);
				return JSON.stringify({ desktop_source: { available: true, summary: { workspace_count: 2 } } });
			}),
		);

		expect(result.sources).toEqual([{ id: "slack", facts: { workspaces: 2 } }]);
		expect(await readFile(join(root, ".slacrawl", "config.toml"), "utf8")).toContain("[slack.desktop]");
	});

	it("does not offer Slack when the desktop app has no signed-in workspace", async () => {
		const root = await home();
		const result = await detectSources(
			winDeps(root, async (command, args) => {
				if (command === "where") return "slacrawl.exe";
				if (command !== "slacrawl") throw new Error(`${command}: not found`);
				if (args.includes("sql")) return JSON.stringify([{ n: 0 }]);
				return JSON.stringify({ desktop_source: { available: false } });
			}),
		);

		expect(result.sources).toEqual([]);
	});
});
