import { defineConfig } from "vitest/config";

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: { exclude: ["**/.upstream/**", "**/node_modules/**"] },
});
