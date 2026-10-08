import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultParserRegistry, type CliConfig } from "@autorag/librarian";
import { afterEach, describe, expect, it } from "vitest";
import { applyAppIndexing } from "../src/main/app-indexing";
import { withConnectorOcrDisabled, withIndexingPoliciesApplied } from "../src/main/indexing-policy";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configWith(extra: Partial<CliConfig>): Promise<CliConfig> {
	const root = await mkdtemp(join(tmpdir(), "autorag-indexing-policy-"));
	directories.push(root);
	return { searchPaths: [root], workspacePath: root, memoryPath: join(root, "memory.json"), ...extra };
}

describe("Tesseract OCR is never run", () => {
	it("turns a config that enabled OCR into one that parses no images, keeping other parser options", async () => {
		const config = await configWith({ parserOptions: { maxTokens: 1234, ocr: { enabled: true, languages: ["kor"], timeoutMs: 5000 } } });

		const effective = withIndexingPoliciesApplied(config);

		expect(effective.parserOptions).toEqual({ maxTokens: 1234, ocr: { enabled: false, languages: ["kor"], timeoutMs: 5000 } });
		const registry = createDefaultParserRegistry(effective.parserOptions);
		expect(registry.getForVirtualPath("/photo.png")).toBeUndefined();
		expect(registry.getForVirtualPath("/scan.pdf")?.name).toBe("kordoc");
	});

	it("also pins OCR off when the config never mentioned it", async () => {
		const effective = withIndexingPoliciesApplied(await configWith({}));

		expect(effective.parserOptions).toEqual({ ocr: { enabled: false } });
	});

	it("does not touch the config it was given", async () => {
		const config = await configWith({ parserOptions: { ocr: { enabled: true } }, jikji: { enableMediaIndex: true } });

		withIndexingPoliciesApplied(config);

		expect(config.parserOptions).toEqual({ ocr: { enabled: true } });
		expect(config.jikji).toEqual({ enableMediaIndex: true });
	});

	it("disables OCR for a datasource connector that parses documents, and leaves the others alone", async () => {
		const config = await configWith({
			datasources: {
				drive: { type: "cloud-drive", connector: { remote: "drive:", parserOptions: { languages: ["ko"], ocr: { enabled: true } } } },
				slack: { type: "slack" },
				rss: { type: "rss", connector: { feeds: [] } },
			},
		});

		const effective = withIndexingPoliciesApplied(config);

		expect(effective.datasources?.drive).toEqual({
			type: "cloud-drive",
			connector: { remote: "drive:", parserOptions: { languages: ["ko"], ocr: { enabled: false } } },
		});
		expect(effective.datasources?.slack).toEqual({ type: "slack" });
		expect(effective.datasources?.rss).toEqual({ type: "rss", connector: { feeds: [] } });
		expect(withConnectorOcrDisabled(false)).toBe(false);
	});
});

describe("Jikji's media index is never run", () => {
	it("pins it off while keeping the rest of the Jikji block", async () => {
		const config = await configWith({ jikji: { enableMediaIndex: true, mediaIndexMaxMb: 50, includeHidden: false, exclude: ["**/x/**"] } });

		expect(withIndexingPoliciesApplied(config).jikji).toEqual({ enableMediaIndex: false, mediaIndexMaxMb: 50, includeHidden: false, exclude: ["**/x/**"] });
	});

	it("keeps Jikji off when it is disabled and absent when it was never configured", async () => {
		expect(withIndexingPoliciesApplied(await configWith({ jikji: false })).jikji).toBe(false);
		expect(withIndexingPoliciesApplied(await configWith({})).jikji).toBeUndefined();
	});

	it("survives the code-folder exclusion merge, so the final config still has it off", async () => {
		const config = await configWith({ jikji: { enableMediaIndex: true } });

		const effective = await applyAppIndexing(config, {});

		expect(effective.jikji).toMatchObject({ enableMediaIndex: false, exclude: expect.arrayContaining(["**/node_modules/**"]) });
		expect(effective.parserOptions).toEqual({ ocr: { enabled: false } });
	});
});
