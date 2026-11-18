import { describe, expect, it } from "vitest";
import type { SourceHit } from "../src/shared/source-search-contract";
import { searchGroups, startWholeSearch, withContent, withDatasources, withSourceAnswer } from "../src/renderer/src/state/whole-search";

const hit = (id: string): SourceHit => ({ id, title: "room", author: null, snippet: "s", content: "c", timestamp: null, url: null });

describe("whole search groups", () => {
	it("shows the file names at once and every other group as pending until it answers", () => {
		const groups = searchGroups(startWholeSearch("budget"), 4);
		expect(groups.map((group) => [group.key, group.status, group.count])).toEqual([
			["files", "ready", 4],
			["content", "pending", null],
		]);
	});

	it("keeps the tab order fixed while answers land out of order", () => {
		let state = withDatasources(startWholeSearch("budget"), [
			{ id: "kakao", type: "kakao" },
			{ id: "work", type: "slack" },
		]);
		state = withSourceAnswer(state, "work", { state: "ok", hits: [hit("a"), hit("b")], error: null });
		expect(searchGroups(state, 0).map((group) => [group.key, group.status, group.count])).toEqual([
			["files", "ready", 0],
			["content", "pending", null],
			["source:kakao", "pending", null],
			["source:work", "ready", 2],
		]);
		state = withContent(state, { state: "ok", hits: [] });
		state = withSourceAnswer(state, "kakao", { state: "ok", hits: [hit("c")], error: null });
		expect(searchGroups(state, 0).map((group) => [group.key, group.status, group.count])).toEqual([
			["files", "ready", 0],
			["content", "ready", 0],
			["source:kakao", "ready", 1],
			["source:work", "ready", 2],
		]);
	});

	it("says why the document index could not answer instead of showing zero hits", () => {
		const off = searchGroups(withContent(startWholeSearch("q"), { state: "off", hits: [] }), 0)[1];
		const missing = searchGroups(withContent(startWholeSearch("q"), { state: "unavailable", hits: [] }), 0)[1];
		const failed = searchGroups(withContent(startWholeSearch("q"), null), 0)[1];
		expect([off?.status, missing?.status, failed?.status]).toEqual(["off", "unavailable", "error"]);
		expect([off?.count, missing?.count, failed?.count]).toEqual([null, null, null]);
	});

	it("keeps a datasource's own failure text on its group without touching the others", () => {
		let state = withDatasources(startWholeSearch("q"), [
			{ id: "kakao", type: "kakao" },
			{ id: "mail", type: "mailcrawl" },
		]);
		state = withSourceAnswer(state, "kakao", { state: "error", hits: [], error: "katok is not installed" });
		const [, , kakao, mail] = searchGroups(state, 0);
		expect(kakao).toMatchObject({ status: "error", count: null, error: "katok is not installed" });
		expect(mail).toMatchObject({ status: "pending", error: null });
	});

	it("ignores an answer from a datasource the search never asked", () => {
		const state = withDatasources(startWholeSearch("q"), [{ id: "kakao", type: "kakao" }]);
		expect(withSourceAnswer(state, "removed", { state: "ok", hits: [hit("x")], error: null })).toBe(state);
	});

	it("adds no datasource group when the datasource list could not be read", () => {
		const state = withDatasources(startWholeSearch("q"), []);
		expect(searchGroups(state, 3).map((group) => group.key)).toEqual(["files", "content"]);
	});
});
