import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		exclude: ["**/.upstream/**", "**/node_modules/**"],
		// Process spawns (bash, git, PowerShell) and NTFS directory walks run several times slower on Windows,
		// and 230 files share the machine: the 5 s default flakes there.
		...(process.platform === "win32" ? { testTimeout: 20_000, hookTimeout: 20_000 } : {}),
	},
});
