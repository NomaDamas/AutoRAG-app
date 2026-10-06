import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "../src/shared/search-contract";
import { SUMMARY_PROMPTS, summaryPrompt, summaryRequest } from "../src/renderer/src/state/ai-summary";

const NOTES: ChatAttachment = { kind: "file", id: "/a/notes.txt", name: "notes.txt" };
const BUDGET: ChatAttachment = { kind: "file", id: "/a/budget.csv", name: "budget.csv" };
const LINK: ChatAttachment = { kind: "url", id: "https://example.com", name: "example.com" };
const PHOTOS: ChatAttachment = { kind: "folder", id: "/a/photos", name: "photos" };
const DOCS: ChatAttachment = { kind: "folder", id: "/a/docs", name: "docs" };

describe("summaryPrompt", () => {
	it("uses the file wording for a file, a link, a mixed set, and an empty set", () => {
		expect(summaryPrompt("ko", [NOTES])).toBe(SUMMARY_PROMPTS.ko.file);
		expect(summaryPrompt("ko", [LINK])).toBe(SUMMARY_PROMPTS.ko.file);
		expect(summaryPrompt("ko", [NOTES, PHOTOS])).toBe(SUMMARY_PROMPTS.ko.file);
		expect(summaryPrompt("ko", [])).toBe(SUMMARY_PROMPTS.ko.file);
	});

	it("uses the folder wording only when every attachment is a folder", () => {
		expect(summaryPrompt("ko", [PHOTOS])).toBe(SUMMARY_PROMPTS.ko.folder);
		expect(summaryPrompt("ko", [PHOTOS, DOCS])).toBe(SUMMARY_PROMPTS.ko.folder);
	});

	it("follows the UI's Interface language setting", () => {
		expect(summaryPrompt("en", [NOTES])).toBe(SUMMARY_PROMPTS.en.file);
		expect(summaryPrompt("ja", [PHOTOS])).toBe(SUMMARY_PROMPTS.ja.folder);
		expect(summaryPrompt("zh", [NOTES])).toBe(SUMMARY_PROMPTS.zh.file);
		// No language shares wording with another, so a wrong lookup cannot pass.
		expect(new Set(Object.values(SUMMARY_PROMPTS).map((w) => w.file)).size).toBe(4);
		expect(new Set(Object.values(SUMMARY_PROMPTS).map((w) => w.folder)).size).toBe(4);
	});
});

describe("summaryRequest", () => {
	it("merges the summary target into the dock's drafts and dedupes by id", () => {
		const request = summaryRequest("ko", [NOTES], [NOTES]);

		expect(request.attachments.map((att) => att.id)).toEqual([NOTES.id]);
		expect(request.prompt).toBe(SUMMARY_PROMPTS.ko.file);
	});

	it("keeps existing drafts alongside the summary target, in order", () => {
		const request = summaryRequest("ko", [BUDGET], [NOTES]);

		expect(request.attachments.map((att) => att.id)).toEqual([BUDGET.id, NOTES.id]);
	});

	it("switches to the folder wording when drafts and target are all folders", () => {
		const request = summaryRequest("ko", [PHOTOS], [DOCS]);

		expect(request.attachments.map((att) => att.id)).toEqual([PHOTOS.id, DOCS.id]);
		expect(request.prompt).toBe(SUMMARY_PROMPTS.ko.folder);
	});

	it("keeps the file wording when a folder target joins a file draft", () => {
		const request = summaryRequest("ko", [NOTES], [PHOTOS]);

		expect(request.prompt).toBe(SUMMARY_PROMPTS.ko.file);
	});

	it("prompts in the UI's language", () => {
		expect(summaryRequest("en", [], [NOTES]).prompt).toBe(SUMMARY_PROMPTS.en.file);
	});
});
