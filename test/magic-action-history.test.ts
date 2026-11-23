import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChatStore } from "../src/main/chat-store";
import { saveMagicActionToHistory } from "../src/main/magic-action-history";
import { isMagicActionSaveRequest } from "../src/shared/magic-actions-contract";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("saving a magic action to the chat history", () => {
	it("adds a chat whose question is the action, with its files attached and its output as the answer", async () => {
		const dir = await mkdtemp(join(tmpdir(), "magic-history-"));
		dirs.push(dir);
		const store = createChatStore({ directory: join(dir, "chat-history") });
		const id = await saveMagicActionToHistory(
			store,
			{ actionLabel: "PDF 3줄 요약", paths: [dir, join(dir, "missing.pdf")], output: "- 하나\n- 둘" },
			() => new Date("2026-11-17T10:00:00.000Z"),
		);

		const record = await store.get(id);
		expect(record?.title).toBe("PDF 3줄 요약");
		expect(record?.messages[0]).toMatchObject({
			role: "user",
			text: "PDF 3줄 요약",
			attachments: [
				{ kind: "folder", id: dir },
				{ kind: "file", id: join(dir, "missing.pdf"), name: "missing.pdf" },
			],
		});
		expect(record?.messages[1]).toMatchObject({ role: "assistant", quick: { answer: "- 하나\n- 둘", evidence: [] }, deep: null, stopped: false });
		expect((await store.list()).map((chat) => chat.id)).toContain(id);
	});

	it("accepts only a labelled request with paths and an output", () => {
		expect(isMagicActionSaveRequest({ actionLabel: "A", paths: ["/a"], output: "x" })).toBe(true);
		expect(isMagicActionSaveRequest({ actionLabel: " ", paths: [], output: "x" })).toBe(false);
		expect(isMagicActionSaveRequest({ actionLabel: "A", paths: "/a", output: "x" })).toBe(false);
		expect(isMagicActionSaveRequest(null)).toBe(false);
	});
});
