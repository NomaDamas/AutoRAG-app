import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sanitizeIdSegment as librarianSanitizeIdSegment } from "@autorag/librarian";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	configuredDiscordConnections,
	discordAttachmentFolders,
	discordAttachmentsRoot,
	isDiscordAttachmentMeta,
	sanitizeIdSegment,
} from "../src/main/discord-attachments";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "autorag-discord-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writeConfig(path: string, datasources: unknown): Promise<void> {
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, JSON.stringify({ datasources }));
}

/** A connection folder the way the librarian lays it out, with one saved attachment. */
async function saveAttachment(folder: string, name = "report.pdf"): Promise<void> {
	await mkdir(join(folder, "Guild", "general"), { recursive: true });
	await writeFile(join(folder, "Guild", "general", name), "pdf");
}

/** What a sync that downloaded nothing still leaves behind. */
async function writeMetadataOnly(folder: string): Promise<void> {
	await mkdir(join(folder, ".discrawl", "logs"), { recursive: true });
	await mkdir(join(folder, ".lock"), { recursive: true });
	await writeFile(join(folder, "download-status.json"), "{}");
}

describe("sanitizeIdSegment", () => {
	it("names the connection folder exactly as the librarian does", () => {
		const names = [
			"nomadamas",
			"discord",
			"My Server!",
			".hidden-name.",
			"한국어 서버",
			"a/b\\c",
			"x".repeat(120),
			"---",
			"with.dots_and-dashes",
		];
		for (const name of names) expect(sanitizeIdSegment(name)).toBe(librarianSanitizeIdSegment(name));
	});
});

describe("discordAttachmentsRoot", () => {
	it("is <AUTORAG_HOME>/attachments/discord/<connection>", () => {
		expect(discordAttachmentsRoot("nomadamas", {}, "/Users/tester")).toBe(
			join("/Users/tester", ".autorag", "attachments", "discord", "nomadamas"),
		);
		expect(discordAttachmentsRoot("My Server!", { AUTORAG_HOME: "/data/rag" }, "/Users/tester")).toBe(
			join(resolve("/data/rag"), "attachments", "discord", librarianSanitizeIdSegment("My Server!")),
		);
	});
});

describe("configuredDiscordConnections", () => {
	it("lists the enabled datasources whose template is discord", () => {
		const names = configuredDiscordConnections({
			datasources: {
				discord: true,
				nomadamas: { type: "discord", instanceId: "nomadamas", enabled: true },
				implicit: { type: "discord" },
				off: { type: "discord", enabled: false },
				disabled: false,
				slack: { type: "slack" },
				// The key is the template when `type` is absent.
				telegram: {},
			},
		});
		expect(names).toEqual(["discord", "nomadamas", "implicit"]);
	});

	it("is empty for a config without datasources or with a malformed block", () => {
		expect(configuredDiscordConnections({})).toEqual([]);
		expect(configuredDiscordConnections({ datasources: [] })).toEqual([]);
		expect(configuredDiscordConnections({ datasources: { discord: "yes", other: 3 } })).toEqual([]);
		expect(configuredDiscordConnections(null)).toEqual([]);
	});
});

describe("isDiscordAttachmentMeta", () => {
	it("marks the status file and every dot entry, but not attachments", () => {
		expect(isDiscordAttachmentMeta("download-status.json")).toBe(true);
		expect(isDiscordAttachmentMeta(".discrawl")).toBe(true);
		expect(isDiscordAttachmentMeta(".lock")).toBe(true);
		expect(isDiscordAttachmentMeta("Guild")).toBe(false);
		expect(isDiscordAttachmentMeta("download-status.json.bak")).toBe(false);
		expect(isDiscordAttachmentMeta("Download-Status.json")).toBe(false);
	});
});

describe("discordAttachmentFolders", () => {
	const home = (): string => join(root, "home");
	const config = (): string => join(home(), ".autorag", "config.json");
	const folder = (connection: string): string => join(home(), ".autorag", "attachments", "discord", connection);

	it("lists a connected Discord source whose folder holds a saved attachment", async () => {
		// Given an enabled connection that has saved a file
		await writeConfig(config(), { nomadamas: { type: "discord", enabled: true } });
		await saveAttachment(folder("nomadamas"));
		await writeMetadataOnly(folder("nomadamas"));

		// When listing the folders
		const folders = await discordAttachmentFolders({}, home());

		// Then the connection's folder is returned
		expect(folders).toEqual([{ connection: "nomadamas", path: folder("nomadamas") }]);
	});

	it("skips a connection that only has the sync's own metadata", async () => {
		// Given a sync that ran but downloaded nothing
		await writeConfig(config(), { nomadamas: { type: "discord" } });
		await writeMetadataOnly(folder("nomadamas"));

		// Then there is nothing to show
		expect(await discordAttachmentFolders({}, home())).toEqual([]);
	});

	it("skips server and channel folders that hold no file, even with a Finder .DS_Store", async () => {
		await writeConfig(config(), { nomadamas: { type: "discord" } });
		await mkdir(join(folder("nomadamas"), "Guild", "general"), { recursive: true });
		await writeFile(join(folder("nomadamas"), "Guild", "general", ".DS_Store"), "x");
		await writeFile(join(folder("nomadamas"), "Guild", ".DS_Store"), "x");

		expect(await discordAttachmentFolders({}, home())).toEqual([]);
	});

	it("finds a file that sits directly in the connection folder", async () => {
		await writeConfig(config(), { discord: true });
		await mkdir(folder("discord"), { recursive: true });
		await writeFile(join(folder("discord"), "loose.txt"), "x");

		expect(await discordAttachmentFolders({}, home())).toEqual([{ connection: "discord", path: folder("discord") }]);
	});

	it("skips a disabled or removed connection even though its files are still on disk", async () => {
		await writeConfig(config(), { off: { type: "discord", enabled: false }, gone: false });
		await saveAttachment(folder("off"));
		await saveAttachment(folder("gone"));
		await saveAttachment(folder("unlisted"));

		expect(await discordAttachmentFolders({}, home())).toEqual([]);
	});

	it("returns every connection with attachments, in config order", async () => {
		await writeConfig(config(), { b: { type: "discord" }, empty: { type: "discord" }, a: { type: "discord" } });
		await saveAttachment(folder("a"));
		await saveAttachment(folder("b"));

		const folders = await discordAttachmentFolders({}, home());

		expect(folders.map((entry) => entry.connection)).toEqual(["b", "a"]);
	});

	it("follows AUTORAG_HOME and AUTORAG_CONFIG", async () => {
		// Given a moved AutoRAG home and a config kept elsewhere
		const moved = join(root, "moved");
		const elsewhere = join(root, "elsewhere", "work.json");
		await writeConfig(elsewhere, { nomadamas: { type: "discord" } });
		await saveAttachment(join(moved, "attachments", "discord", "nomadamas"));

		// When both variables are set
		const folders = await discordAttachmentFolders({ AUTORAG_HOME: moved, AUTORAG_CONFIG: elsewhere }, home());

		// Then the folder is under the moved home, the connection comes from the other config
		expect(folders).toEqual([{ connection: "nomadamas", path: join(moved, "attachments", "discord", "nomadamas") }]);
	});

	it("uses the sanitized connection name for the folder, as the librarian does", async () => {
		await writeConfig(config(), { "My Server!": { type: "discord" } });
		await saveAttachment(folder(librarianSanitizeIdSegment("My Server!")));

		const folders = await discordAttachmentFolders({}, home());

		expect(folders).toEqual([{ connection: "My Server!", path: folder(librarianSanitizeIdSegment("My Server!")) }]);
	});

	it("answers nothing when the config is missing or not valid JSON", async () => {
		expect(await discordAttachmentFolders({}, home())).toEqual([]);
		await mkdir(join(home(), ".autorag"), { recursive: true });
		await writeFile(config(), "{ not json");
		expect(await discordAttachmentFolders({}, home())).toEqual([]);
	});
});
