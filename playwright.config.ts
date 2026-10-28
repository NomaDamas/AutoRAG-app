import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "scripts/manual-qa",
	testMatch: "*.e2e.ts",
	timeout: 180_000,
	workers: 1,
	retries: 0,
	outputDir: "/tmp/autorag-quicklook-qa/playwright",
});
