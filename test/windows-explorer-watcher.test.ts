import { describe, expect, it } from "vitest";
import { buildWindowsExplorerWatcherScript, parseWatcherLine } from "../src/main/windows-explorer-watcher";

describe("windows-explorer-watcher", () => {
	it("parses valid intercept JSON lines and rejects virtual paths or non-intercept events", () => {
		expect(parseWatcherLine('{"event":"ready"}')).toBeNull();
		expect(parseWatcherLine("")).toBeNull();
		expect(parseWatcherLine("not json")).toBeNull();
		expect(parseWatcherLine('{"event":"intercept","action":"reveal","path":"C:\\\\Users\\\\a\\\\doc.pdf"}')).toEqual({
			action: "reveal",
			path: "C:\\Users\\a\\doc.pdf",
		});
		expect(parseWatcherLine('{"event":"intercept","action":"open","path":"D:\\\\Projects"}')).toEqual({
			action: "open",
			path: "D:\\Projects",
		});
		expect(parseWatcherLine('{"event":"intercept","action":"open","path":"::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"}')).toBeNull();
		expect(parseWatcherLine('{"event":"intercept","action":"open","path":"shell:ControlPanelFolder"}')).toBeNull();
		expect(parseWatcherLine('{"event":"intercept","action":"ask","path":"C:\\\\Users\\\\a"}')).toBeNull();
	});

	it("builds a PowerShell watcher script that snapshots existing windows first and emits UTF-8 JSON", () => {
		const script = buildWindowsExplorerWatcherScript(120);
		expect(script).toContain("Snapshot-Existing");
		expect(script).toContain("Shell.Application");
		expect(script).toContain("Start-Sleep -Milliseconds 120");
		expect(script).toContain("ConvertTo-Json -Compress");
	});
});
