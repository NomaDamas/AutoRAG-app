import { describe, expect, it } from "vitest";
import { detectSources } from "../src/main/onboarding-sources";

function deps(run: (command: string, args: readonly string[]) => Promise<string>) {
	return {
		platform: "linux" as const,
		home: "/home/test",
		env: { GITHUB_TOKEN: "test-token" },
		run,
		pathExists: async () => false,
		readDirNames: async () => [],
		readFileText: async () => {
			throw new Error("not configured");
		},
	};
}

describe("onboarding datasource detection", () => {
	it.each([
		["empty repository list", "[]"],
		["malformed discovery output", "not-json"],
		["failed discovery command", null],
	])("does not offer authenticated GitHub after %s", async (_name, output) => {
		const result = await detectSources(
			deps(async (command, args) => {
				if (command === "gh" && args[0] === "repo" && output !== null) return output;
				throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
			}),
		);

		expect(result.sources.some((source) => source.id === "github")).toBe(false);
	});

	it("bounds repository discovery to five indexing targets", async () => {
		const repos = Array.from({ length: 7 }, (_, index) => `me/repo-${index}`);
		const result = await detectSources(
			deps(async (command, args) => {
				if (command === "gh" && args[0] === "repo") return JSON.stringify(repos.map((nameWithOwner) => ({ nameWithOwner })));
				throw new Error(`unexpected probe: ${command} ${args.join(" ")}`);
			}),
		);
		const github = result.sources.find((source) => source.id === "github");

		expect(github?.facts.repos).toEqual(repos.slice(0, 5));
	});
});
