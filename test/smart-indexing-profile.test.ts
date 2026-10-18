import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProfile } from "../src/main/agents/agent-factory";
import { createFolderSurvey } from "../src/main/agents/profiles/folder-stats";
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
	function profileFor(extensions: readonly string[] = [".md"], roots: readonly string[] = [root], language: "ko" | "en" | "ja" | "zh" = "ko"): AgentProfile {
		const survey = createFolderSurvey(roots, { supportedExtensions: new Set(extensions), maxSourceBytes: 1000 });
		return smartIndexingProfile({ roots, language, extensions, collector: createProposalCollector(roots, survey), survey });
	}

	it("confines the agent to the chosen folders: no pi file tools, only the survey, the listing and the proposal", () => {
		const profile = profileFor();

		// pi's own read/ls/find/grep open any path on the machine; the agent gets none of them.
		expect([...profile.tools]).toEqual([]);
		expect(profile.customTools?.map((tool) => tool.name)).toEqual(["folder_survey", "list_folder", "propose_exclusions"]);
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

	it("leaves the judgment to the model: principles in words, no thresholds, no file contents", () => {
		const prompt = profileFor().systemPrompt;

		// What makes a folder worth keeping or leaving out is described, never counted.
		expect(prompt).toMatch(/written or collected by a person/iu);
		expect(prompt).toMatch(/generated by a program/iu);
		expect(prompt).toMatch(/when in doubt, leave it in/iu);
		expect(prompt).not.toMatch(/\d+%/u);
		expect(prompt).not.toMatch(/at least \d+|fewer than \d+|below \d+/iu);
		// Only names are available; the agent is told so and told to judge from them.
		expect(prompt).toMatch(/file names/iu);
		expect(prompt).toMatch(/cannot open files/iu);
	});

	it("asks for a reason that says what the names showed, and for one call with every folder", () => {
		const prompt = profileFor().systemPrompt;

		expect(prompt).toMatch(/reason/iu);
		expect(prompt).toMatch(/names? .*showed|what you saw/iu);
		expect(prompt).toMatch(/once/iu);
		expect(prompt).toContain("folder_survey");
		expect(prompt).toContain("list_folder");
	});
});

describe("proposal collector with surveyed folders", () => {
	it("refuses a folder the agent never surveyed, and says to survey it first", async () => {
		const survey = createFolderSurvey([root], { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
		const collector = createProposalCollector([root], survey);

		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "chat" }]);

		expect(outcome.accepted).toEqual([]);
		expect(outcome.rejected).toEqual([{ path: join(root, "Telegram Desktop"), why: expect.stringContaining("folder_survey") }]);
	});

	it("takes a folder once it was surveyed", async () => {
		const survey = createFolderSurvey([root], { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
		const collector = createProposalCollector([root], survey);
		await survey.report(join(root, "Telegram Desktop"), new AbortController().signal);

		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "chat" }]);

		expect(outcome.rejected).toEqual([]);
		expect(collector.proposals().map((proposal) => proposal.path)).toEqual([join(root, "Telegram Desktop")]);
	});

	it("counts a folder as surveyed when a survey of the folder above it covered it", async () => {
		const survey = createFolderSurvey([root], { supportedExtensions: new Set([".md"]), maxSourceBytes: 1000 });
		const collector = createProposalCollector([root], survey);
		await survey.report(root, new AbortController().signal);

		// A survey of the chosen folder describes each subfolder (counts, dates, names), so a subfolder it listed may be proposed.
		const outcome = await collector.propose([{ path: join(root, "Telegram Desktop"), reason: "chat" }]);

		expect(outcome.rejected).toEqual([]);
	});
});
