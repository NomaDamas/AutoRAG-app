import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {},
	preload: {
		build: {
			rollupOptions: {
				input: {
					index: resolve(import.meta.dirname, "src/preload/index.ts"),
					"quick-look": resolve(import.meta.dirname, "src/preload/quick-look.ts"),
				},
			},
		},
	},
	renderer: {
		plugins: [tailwindcss()],
		esbuild: {
			jsx: "automatic",
		},
		server: {
			port: Number(process.env.PORT) || 5173,
		},
		build: {
			rollupOptions: {
				input: {
					index: resolve(import.meta.dirname, "src/renderer/index.html"),
					"quick-look": resolve(import.meta.dirname, "src/renderer/quick-look.html"),
				},
			},
		},
	},
});
