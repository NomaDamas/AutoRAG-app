import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createChatSessionIndex } from "../src/main/chat-sessions";

let directory: string;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "dazzi-chat-sessions-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

async function sessionFile(name: string): Promise<string> {
	const path = join(directory, name);
	await writeFile(path, "{}\n");
	return path;
}

describe("chat session index", () => {
	it("remembers which session file holds a chat's conversation, across restarts", async () => {
		const file = await sessionFile("2026-10-25_abc.jsonl");
		await createChatSessionIndex({ directory }).remember("chat-1", file);

		// A new process reads the same index.
		expect(await createChatSessionIndex({ directory }).fileFor("chat-1")).toBe(file);
	});

	it("knows nothing about a chat that never had a conversation", async () => {
		expect(await createChatSessionIndex({ directory }).fileFor("chat-unknown")).toBeNull();
	});

	it("does not hand out a file that is gone: the chat then starts a new conversation", async () => {
		const file = await sessionFile("gone.jsonl");
		const index = createChatSessionIndex({ directory });
		await index.remember("chat-1", file);
		await rm(file);

		expect(await index.fileFor("chat-1")).toBeNull();
	});

	it("keeps chats apart, and the latest file wins when a chat moves to a new one", async () => {
		const first = await sessionFile("a.jsonl");
		const second = await sessionFile("b.jsonl");
		const third = await sessionFile("c.jsonl");
		const index = createChatSessionIndex({ directory });
		await index.remember("chat-1", first);
		await index.remember("chat-2", second);
		await index.remember("chat-1", third);

		expect(await index.fileFor("chat-1")).toBe(third);
		expect(await index.fileFor("chat-2")).toBe(second);
	});

	it("survives quick successive writes without losing one", async () => {
		const files = await Promise.all(["a", "b", "c", "d"].map((name) => sessionFile(`${name}.jsonl`)));
		const index = createChatSessionIndex({ directory });
		await Promise.all(files.map((file, position) => index.remember(`chat-${position}`, file)));

		const reopened = createChatSessionIndex({ directory });
		for (const [position, file] of files.entries()) expect(await reopened.fileFor(`chat-${position}`)).toBe(file);
	});

	it("starts empty from an index it cannot read, instead of failing every chat", async () => {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "index.json"), "{ not json");
		const file = await sessionFile("a.jsonl");
		const index = createChatSessionIndex({ directory });

		expect(await index.fileFor("chat-1")).toBeNull();
		await index.remember("chat-1", file);
		expect(await index.fileFor("chat-1")).toBe(file);
	});

	it("forgets every conversation, files included, when the history is cleared", async () => {
		const file = await sessionFile("a.jsonl");
		const index = createChatSessionIndex({ directory });
		await index.remember("chat-1", file);

		await index.clear();

		expect(await index.fileFor("chat-1")).toBeNull();
		expect(await readdir(directory).catch(() => [])).toEqual([]);
		// And it is usable afterwards (pi recreates its folder when it writes the next session).
		await mkdir(directory, { recursive: true });
		const again = await sessionFile("b.jsonl");
		await index.remember("chat-2", again);
		expect(await index.fileFor("chat-2")).toBe(again);
	});
});
