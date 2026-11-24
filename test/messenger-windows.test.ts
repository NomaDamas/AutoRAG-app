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
});

describe("WhatsApp and Spotlight are macOS-only sources too", () => {
	it("is offered on macOS and nowhere else: wacrawl finds WhatsApp Desktop only in the macOS group container, mdfind is macOS's", () => {
		for (const type of ["whatsapp", "spotlight", "kakao", "calendar", "apple-events"]) {
			expect(datasourceSupported(type, "darwin"), `${type} on darwin`).toBe(true);
			expect(datasourceSupported(type, "win32"), `${type} on win32`).toBe(false);
		}
		for (const type of ["slack", "discord", "telegram", "notion", "obsidian", "mailcrawl", "cloud-drive", "hister", "lark", "rss", "github"]) {
			expect(datasourceSupported(type, "win32"), `${type} on win32`).toBe(true);
		}
	});

	it("drops WhatsApp and Spotlight rows inherited from a Mac config before the librarian sees them, under any alias", () => {
		const config = {
			datasources: { whatsapp: {}, "wa-work": { type: "whatsapp" }, spotlight: { type: "spotlight" }, slack: { type: "slack" } },
		} as unknown as CliConfig;

		expect(Object.keys(withIndexingPoliciesApplied(config, "win32").datasources ?? {})).toEqual(["slack"]);
		expect(Object.keys(withIndexingPoliciesApplied(config, "darwin").datasources ?? {})).toEqual(["whatsapp", "wa-work", "spotlight", "slack"]);
	});

	it("keeps a WhatsApp row off macOS when the user names the folder wacrawl should read, the one thing it cannot find itself", () => {
		const config = {
			datasources: {
				whatsapp: { connector: { sourcePath: "D:\\copied\\group.net.whatsapp.WhatsApp.shared" } },
				"wa-empty": { type: "whatsapp", connector: { sourcePath: " " } },
			},
		} as unknown as CliConfig;

		expect(Object.keys(withIndexingPoliciesApplied(config, "win32").datasources ?? {})).toEqual(["whatsapp"]);
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
		expect(await desktopAppInstalled("Obsidian", host)).toBe(false);
		expect(await desktopAppInstalled("Telegram", host)).toBe(false);
		expect(await desktopAppInstalled("Notion", host)).toBe(false);
		expect(await desktopAppInstalled("Figma", host)).toBeNull();
		expect(await desktopAppInstalled("Discord", { ...host, platform: "linux" })).toBeNull();
	});

	it("recognises a Microsoft Store package of Slack", async () => {
		const root = await home();
		const local = join(root, "AppData", "Local");
		await mkdir(join(local, "Packages", "91750D7E.Slack_8she8kybcnzg4"), { recursive: true });

		expect(await desktopAppInstalled("Slack", { platform: "win32", env: { LOCALAPPDATA: local }, home: root })).toBe(true);
	});

	it("finds the apps whose installers do not use the Squirrel layout: Notion and Obsidian under Programs, Telegram under Roaming", async () => {
		const root = await home();
		const local = join(root, "AppData", "Local");
		const roaming = join(root, "AppData", "Roaming");
		await mkdir(join(local, "Programs", "Notion"), { recursive: true });
		await writeFile(join(local, "Programs", "Notion", "Notion.exe"), "");
		await mkdir(join(local, "Programs", "Obsidian"), { recursive: true });
		await writeFile(join(local, "Programs", "Obsidian", "Obsidian.exe"), "");
		await mkdir(join(roaming, "Telegram Desktop"), { recursive: true });
		await writeFile(join(roaming, "Telegram Desktop", "Telegram.exe"), "");
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: local, APPDATA: roaming }, home: root };

		expect(await desktopAppInstalled("Notion", host)).toBe(true);
		expect(await desktopAppInstalled("Obsidian", host)).toBe(true);
		expect(await desktopAppInstalled("Telegram", host)).toBe(true);
	});

	it("finds a machine-wide install under Program Files and a Store package of Telegram", async () => {
		const root = await home();
		const programFiles = join(root, "Program Files");
		await mkdir(join(programFiles, "Obsidian"), { recursive: true });
		await writeFile(join(programFiles, "Obsidian", "Obsidian.exe"), "");
		const local = join(root, "AppData", "Local");
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: local, ProgramFiles: programFiles }, home: root };
		expect(await desktopAppInstalled("Obsidian", host)).toBe(true);

		await mkdir(join(local, "Packages", "TelegramMessengerLLP.TelegramDesktop_t4vj0pshhgkwm"), { recursive: true });
		expect(await desktopAppInstalled("Telegram", host)).toBe(true);
	});

	it("does not mistake the data folder an uninstalled app leaves behind for the app", async () => {
		const root = await home();
		const local = join(root, "AppData", "Local");
		const roaming = join(root, "AppData", "Roaming");
		await mkdir(join(roaming, "Telegram Desktop", "tdata"), { recursive: true });
		await mkdir(join(roaming, "Notion"), { recursive: true });
		await mkdir(join(local, "notion-updater"), { recursive: true });
		const host = { platform: "win32" as const, env: { LOCALAPPDATA: local, APPDATA: roaming }, home: root };

		expect(await desktopAppInstalled("Telegram", host)).toBe(false);
		expect(await desktopAppInstalled("Notion", host)).toBe(false);
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

