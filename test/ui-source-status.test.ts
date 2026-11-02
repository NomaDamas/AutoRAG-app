import { describe, expect, it } from "vitest";
import { mapSourceStatus } from "../src/renderer/src/state/source-status";
import type { DataSourceRow, DataSourcesSnapshot, DataSourceStatus } from "../src/shared/settings-contract";

function source(id: string, status: DataSourceStatus, type = id): DataSourceRow {
	return { id, type, status } as unknown as DataSourceRow;
}

function snapshot(...sources: DataSourceRow[]): DataSourcesSnapshot {
	return { sources } as unknown as DataSourcesSnapshot;
}

describe("mapSourceStatus", () => {
	it("marks a cloud glyph while its datasource syncs or needs attention, and nothing for a ready one", () => {
		expect(mapSourceStatus(snapshot(source("icloud-drive", "syncing", "cloud-drive"), source("dropbox", "attention")))).toEqual({
			icloud: "syncing",
			dropbox: "error",
		});
		expect(mapSourceStatus(snapshot(source("dropbox", "ready"), source("onedrive", "paused")))).toEqual({});
	});

	it("matches a Discord datasource by its template, whatever the connection is named", () => {
		expect(mapSourceStatus(snapshot(source("nomadamas", "syncing", "discord")))).toEqual({ discord: "syncing" });
		expect(mapSourceStatus(snapshot(source("discord", "attention")))).toEqual({ discord: "error" });
	});

	it("shows the worst state when several Discord connections differ", () => {
		const rows = [source("a", "syncing", "discord"), source("b", "attention", "discord"), source("c", "ready", "discord")];
		expect(mapSourceStatus(snapshot(...rows))).toEqual({ discord: "error" });
		expect(mapSourceStatus(snapshot(source("a", "ready", "discord"), source("b", "syncing", "discord")))).toEqual({ discord: "syncing" });
	});

	it("does not mistake another datasource for Discord", () => {
		expect(mapSourceStatus(snapshot(source("slack", "attention"), source("my-discordant-notes", "attention", "obsidian")))).toEqual({});
	});
});
