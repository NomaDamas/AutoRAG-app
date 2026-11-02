import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { autoragConfigPath, autoragHome } from "../src/main/autorag-home";

describe("autoragHome", () => {
	it("resolves a trimmed AUTORAG_HOME and falls back to <home>/.autorag", () => {
		expect(autoragHome({ AUTORAG_HOME: "  /tmp/custom-home \n" }, "/Users/tester")).toBe(resolve("/tmp/custom-home"));
		expect(autoragHome({ AUTORAG_HOME: "" }, "/Users/tester")).toBe(join("/Users/tester", ".autorag"));
		expect(autoragHome({}, "/Users/tester")).toBe(join("/Users/tester", ".autorag"));
		expect(autoragHome({ AUTORAG_HOME: "relative/state" }, "/Users/tester")).toBe(join(process.cwd(), "relative/state"));
	});
});

describe("autoragConfigPath", () => {
	it("uses AUTORAG_CONFIG as written, else config.json in the AutoRAG home", () => {
		expect(autoragConfigPath({ AUTORAG_CONFIG: "/etc/autorag/work.json" }, "/Users/tester")).toBe("/etc/autorag/work.json");
		expect(autoragConfigPath({ AUTORAG_HOME: "/data/rag" }, "/Users/tester")).toBe(join(resolve("/data/rag"), "config.json"));
		expect(autoragConfigPath({ AUTORAG_CONFIG: "" }, "/Users/tester")).toBe(join("/Users/tester", ".autorag", "config.json"));
	});
});
