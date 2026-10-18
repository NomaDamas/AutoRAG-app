import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/main/agents/agent-factory";
import { createFolderStats } from "../src/main/agents/profiles/folder-stats";
import { createProposalCollector, smartIndexingProfile } from "../src/main/agents/profiles/smart-indexing";
import { SMART_INDEXING_CRITERIA } from "../src/shared/smart-indexing-criteria";

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
	function profileFor(extensions: readonly string[] = [".md"], roots: readonly string[] = [root], language: "ko" | "en" | "ja" | "zh" = "ko"): AgentProfile {
		return smartIndexingProfile({ roots, language, extensions, collector: createProposalCollector(roots), stats: createFolderStats(roots, { supportedExtensions: new Set(extensions), maxSourceBytes: 1000 }) });
	}

	it("lets the agent look around and count but never write, answering only through the proposal tool", () => {
		const profile = profileFor();

		expect([...profile.tools].sort()).toEqual(["find", "ls", "read"]);
		expect(profile.customTools?.map((tool) => tool.name)).toEqual(["folder_stats", "propose_exclusions"]);
		expect(profile.thinking).toBe("low");
		expect(profile.context).toBeUndefined();
	});

	it("tells the model the folders to look at, the language to answer in, and what the app skips on its own", () => {
		const prompt = profileFor([".pdf", ".hwp", ".md"], [root, other], "ja").systemPrompt;

		expect(prompt).toContain(root);
		expect(prompt).toContain(other);
		expect(prompt).toContain("Japanese");
		expect(prompt).toContain("node_modules");
		expect(prompt).toContain("propose_exclusions");
	});

	it("names the file types the index reads", () => {
		expect(profileFor([".pdf", ".hwp", ".md"], [root], "en").systemPrompt).toContain(".hwp, .md, .pdf");
	});

	it("states every criterion with the exact numbers the verdicts are computed from", () => {
		const prompt = profileFor().systemPrompt;
		const { minIndexedFiles, series, sparse, appData } = SMART_INDEXING_CRITERIA;

		expect(prompt).toContain(`fewer than ${minIndexedFiles} indexed files`);
		expect(prompt).toContain(`at least ${series.minIndexedFiles} indexed files`);
		expect(prompt).toContain(`${series.minTopExtensionShare * 100}% or more`);
		expect(prompt).toContain(`${series.maxStemRatio * 100}% or fewer`);
		expect(prompt).toContain(series.extensions.join(", "));
		expect(prompt).toContain(`at least ${sparse.minTotalFiles} files`);
		expect(prompt).toContain(`below ${sparse.maxIndexedShare * 100}%`);
		for (const name of appData.names) expect(prompt).toContain(name);
	});

	it("requires counting a folder before proposing it and forbids proposing from file names alone", () => {
		const prompt = profileFor().systemPrompt;

		expect(prompt).toContain("folder_stats");
		expect(prompt).toMatch(/only propose a folder .*folder_stats/isu);
		expect(prompt).toMatch(/never .*file names/isu);
	});
});

describe("proposal collector with measured folders", () => {
	it("refuses a folder the agent never counted, and says to count it first", async () => {
		const stats = createFolderStats([root], { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
		const collector = createProposalCollector([root], stats);

		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "chat" }]);

		expect(outcome.accepted).toEqual([]);
		expect(outcome.rejected).toEqual([{ path: join(root, "Telegram Desktop"), why: expect.stringContaining("folder_stats") }]);
	});

	it("takes a folder once it was counted, and lets a counted folder cover the ones inside it", async () => {
		const stats = createFolderStats([root], { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
		const collector = createProposalCollector([root], stats);
		await stats.report(join(root, "Telegram Desktop"), new AbortController().signal);

		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "chat" }]);

		expect(outcome.rejected).toEqual([]);
		expect(collector.proposals().map((proposal) => proposal.path)).toEqual([join(root, "Telegram Desktop")]);
	});
});
