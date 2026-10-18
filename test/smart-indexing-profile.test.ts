import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProposalCollector, smartIndexingProfile } from "../src/main/agents/profiles/smart-indexing";

let root: string;
let other: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "smart-root-"));
	other = await mkdtemp(join(tmpdir(), "smart-other-"));
	await mkdir(join(root, "Telegram Desktop", "chats"), { recursive: true });
	await mkdir(join(root, "Zoom"), { recursive: true });
	await mkdir(join(root, "Docs"), { recursive: true });
	await writeFile(join(root, "note.md"), "a file, not a folder");
	await symlink(other, join(root, "link-out"));
});

afterEach(async () => {
	await Promise.all([root, other].map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("proposal collector", () => {
	it("records a folder under a selected root with the model's reason", async () => {
		const collector = createProposalCollector([root]);

		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "Chat app downloads" }]);

		expect(outcome.rejected).toEqual([]);
		expect(collector.proposals()).toEqual([{ path: join(root, "Telegram Desktop"), root, reason: "Chat app downloads" }]);
	});

	it("rejects what is not a folder inside a root, and says why so the model can correct itself", async () => {
		const collector = createProposalCollector([root]);

		const outcome = await collector.propose([
			{ path: root, reason: "everything" },
			{ path: other, reason: "outside" },
			{ path: join(root, "missing"), reason: "gone" },
			{ path: join(root, "note.md"), reason: "a file" },
			{ path: join(root, "link-out"), reason: "a link out of the root" },
			{ path: "Docs", reason: "relative" },
			{ path: join(root, "Zoom"), reason: "  " },
		]);

		expect(outcome.accepted).toEqual([]);
		expect(outcome.rejected.map((entry) => entry.path)).toEqual([
			root,
			other,
			join(root, "missing"),
			join(root, "note.md"),
			join(root, "link-out"),
			"Docs",
			join(root, "Zoom"),
		]);
		expect(outcome.rejected.every((entry) => entry.why.length > 0)).toBe(true);
		expect(collector.proposals()).toEqual([]);
	});

	it("keeps the outermost folder when a folder and one inside it are both proposed, in either order", async () => {
		const first = createProposalCollector([root]);
		await first.propose([{ path: join(root, "Telegram Desktop", "chats"), reason: "inner" }]);
		await first.propose([{ path: join(root, "Telegram Desktop"), reason: "outer" }]);
		expect(first.proposals().map((proposal) => proposal.path)).toEqual([join(root, "Telegram Desktop")]);

		const second = createProposalCollector([root]);
		await second.propose([{ path: join(root, "Telegram Desktop"), reason: "outer" }]);
		const outcome = await second.propose([{ path: join(root, "Telegram Desktop", "chats"), reason: "inner" }]);
		expect(second.proposals().map((proposal) => proposal.path)).toEqual([join(root, "Telegram Desktop")]);
		expect(outcome.accepted).toEqual([]);
		expect(outcome.rejected).toEqual([{ path: join(root, "Telegram Desktop", "chats"), why: expect.stringContaining("already") }]);
	});

	it("takes a folder once however often it is proposed, and accepts an empty list", async () => {
		const collector = createProposalCollector([root]);

		await collector.propose([{ path: join(root, "Zoom"), reason: "recordings" }]);
		await collector.propose([{ path: join(root, "Zoom"), reason: "recordings again" }]);
		await collector.propose([]);

		expect(collector.proposals()).toEqual([{ path: join(root, "Zoom"), root, reason: "recordings" }]);
	});

	it("attributes a proposal to the root it lies under when several roots are selected", async () => {
		await mkdir(join(other, "Cache"));
		const collector = createProposalCollector([root, other]);

		await collector.propose([{ path: join(other, "Cache"), reason: "cache" }]);

		expect(collector.proposals()).toEqual([{ path: join(other, "Cache"), root: other, reason: "cache" }]);
	});
});

describe("smart indexing profile", () => {
	it("lets the agent explore and read but never write, with the proposal tool as its only way to answer", () => {
		const profile = smartIndexingProfile({ roots: [root], language: "ko", extensions: [".md"], collector: createProposalCollector([root]) });

		expect([...profile.tools].sort()).toEqual(["find", "grep", "ls", "read"]);
		expect(profile.customTools?.map((tool) => tool.name)).toEqual(["propose_exclusions"]);
		expect(profile.thinking).toBe("low");
		expect(profile.context).toBeUndefined();
	});

	it("tells the model the folders to look at, the language to answer in, and what the app skips on its own", () => {
		const profile = smartIndexingProfile({ roots: [root, other], language: "ja", extensions: [".pdf", ".hwp", ".md"], collector: createProposalCollector([root, other]) });

		expect(profile.systemPrompt).toContain(root);
		expect(profile.systemPrompt).toContain(other);
		expect(profile.systemPrompt).toContain("Japanese");
		expect(profile.systemPrompt).toContain("node_modules");
		expect(profile.systemPrompt).toContain("propose_exclusions");
	});

	it("names the file types the index reads, so the agent only spends effort on folders that hold some", () => {
		const profile = smartIndexingProfile({ roots: [root], language: "en", extensions: [".pdf", ".hwp", ".md"], collector: createProposalCollector([root]) });

		expect(profile.systemPrompt).toContain(".hwp, .md, .pdf");
	});
});
