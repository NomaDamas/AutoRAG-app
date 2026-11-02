import { describe, expect, it, vi } from "vitest";
import {
	completePath,
	type PathCompletionEntry,
} from "../src/renderer/src/state/paths";

const context = { current: "/Users/jeffrey/Documents", home: "/Users/jeffrey" };
const entries: readonly PathCompletionEntry[] = [
	{ name: "notes.md", path: "/Users/jeffrey/Documents/notes.md", kind: "file" },
	{ name: "Finance", path: "/Users/jeffrey/Documents/Finance", kind: "folder" },
	{ name: "family", path: "/Users/jeffrey/Documents/family", kind: "folder" },
];

describe("completePath", () => {
	it("matches direct child folders case-insensitively and preserves alphabetical order", async () => {
		const list = vi.fn(async () => entries);
		await expect(
			completePath("/Users/jeffrey/Documents/f", context, list),
		).resolves.toEqual([
			{
				name: "Finance",
				path: "/Users/jeffrey/Documents/Finance",
				text: "/Users/jeffrey/Documents/Finance",
			},
			{
				name: "family",
				path: "/Users/jeffrey/Documents/family",
				text: "/Users/jeffrey/Documents/family",
			},
		]);
		expect(list).toHaveBeenCalledWith("/Users/jeffrey/Documents");
	});

	it("keeps home and relative spelling in the accepted input while returning an absolute target", async () => {
		const list = vi.fn(async (dir: string) => {
			if (dir === "/Users/jeffrey")
				return [
					{
						name: "Documents",
						path: "/Users/jeffrey/Documents",
						kind: "folder" as const,
					},
				];
			return entries;
		});
		await expect(completePath("~/Doc", context, list)).resolves.toEqual([
			{
				name: "Documents",
				path: "/Users/jeffrey/Documents",
				text: "~/Documents",
			},
		]);
		await expect(completePath("Fin", context, list)).resolves.toEqual([
			{
				name: "Finance",
				path: "/Users/jeffrey/Documents/Finance",
				text: "Finance",
			},
		]);
	});

	it("completes Windows paths with the native separator", async () => {
		const windows = { current: "C:\\Users\\me", home: "C:\\Users\\me" };
		const list = vi.fn(async () => [
			{
				name: "Documents",
				path: "C:\\Users\\me\\Documents",
				kind: "folder" as const,
			},
		]);
		await expect(
			completePath("C:\\Users\\me\\Doc", windows, list),
		).resolves.toEqual([
			{
				name: "Documents",
				path: "C:\\Users\\me\\Documents",
				text: "C:\\Users\\me\\Documents",
			},
		]);
	});

	it("does not list a directory for URLs, quoted paths, or an unknown home", async () => {
		const list = vi.fn(async () => entries);
		await expect(
			completePath("file:///Users/jeffrey/Doc", context, list),
		).resolves.toEqual([]);
		await expect(
			completePath('"/Users/jeffrey/Doc', context, list),
		).resolves.toEqual([]);
		await expect(
			completePath("~/Doc", { ...context, home: null }, list),
		).resolves.toEqual([]);
		expect(list).not.toHaveBeenCalled();
	});
});
