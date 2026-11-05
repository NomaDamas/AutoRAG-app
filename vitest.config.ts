import { defineConfig } from "vitest/config";

export default defineConfig({
	oxc: { jsx: { runtime: "automatic" } },
	test: {
		// `integrations/*` are separate npm projects (the Raycast extension) with their own test runs.
		exclude: ["**/.upstream/**", "**/node_modules/**", "integrations/**"],
		// Process spawns (bash, git, PowerShell) and NTFS directory walks run several times slower on Windows,
		// and 230 files share the machine: the 5 s default flakes there.
		testTimeout: process.platform === "win32" ? 20_000 : 15_000,
		...(process.platform === "win32" ? { hookTimeout: 20_000 } : {}),
	},
});
