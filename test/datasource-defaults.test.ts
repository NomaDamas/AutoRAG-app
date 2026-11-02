import { describe, expect, it } from "vitest";
import { connectorDefaultsFor, newDatasourceEntry } from "../src/shared/datasource-defaults";

describe("connectorDefaultsFor", () => {
	it("makes Slack read Slack Desktop's cache: slacrawl's own default sync needs an API token", () => {
		expect(connectorDefaultsFor("slack")).toEqual({ syncSource: "wiretap" });
	});

	it("leaves every other connection type with no preset connector", () => {
		for (const type of ["discord", "telegram", "whatsapp", "obsidian", "mailcrawl", "github", "unknown-type"]) {
			expect(connectorDefaultsFor(type)).toBeNull();
		}
	});
});

describe("newDatasourceEntry", () => {
	it("a connection named after its type carries no `type` key, only the preset connector", () => {
		expect(newDatasourceEntry("slack", "slack")).toEqual({ connector: { syncSource: "wiretap" } });
	});

	it("a second connection of the same kind records its type next to the preset connector", () => {
		expect(newDatasourceEntry("slack", "slack-work")).toEqual({ type: "slack", connector: { syncSource: "wiretap" } });
	});

	it("a type without presets stays an empty entry (or just its type)", () => {
		expect(newDatasourceEntry("discord", "discord")).toEqual({});
		expect(newDatasourceEntry("discord", "discord-2")).toEqual({ type: "discord" });
	});

	it("hands out a fresh connector object each time, so one entry can never edit another", () => {
		const first = newDatasourceEntry("slack", "slack");
		const second = newDatasourceEntry("slack", "slack-2");
		expect(first.connector).not.toBe(second.connector);
	});
});
