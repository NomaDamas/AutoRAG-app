import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";

export default defineConfig({
	main: {
		build: {
			rollupOptions: {
				// The fs worker is a second Node entry: an Electron utility process
				// the main process forks (`src/main/fs-worker-host.ts`). The archive
				// worker is a Node worker_thread the extractor spawns for the wasm
				// engine; it keeps the `.mjs` name so the source and the build share
				// one spawn URL. The refresh job is the entry an OS-scheduled task runs
				// in plain Node (`ELECTRON_RUN_AS_NODE`), so it must never import electron.
				input: {
					index: resolve(import.meta.dirname, "src/main/index.ts"),
					"refresh-job": resolve(import.meta.dirname, "src/main/refresh-job.ts"),
					"fs-worker": resolve(import.meta.dirname, "src/fs-worker/index.ts"),
					"archive-worker": resolve(import.meta.dirname, "src/main/archive-worker.mjs"),
				},
				output: {
					entryFileNames: (chunk) => (chunk.name === "archive-worker" ? "archive-worker.mjs" : "[name].js"),
				},
			},
		},
	},
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
		optimizeDeps: {
			// The automatic JSX transform injects this import, so Vite's scanner never
			// sees it: a cold dev start then re-optimizes and force-reloads every
			// window, and the pre-warmed Quick Look window comes back blank.
			include: ["react/jsx-dev-runtime"],
			// rhwp is plain ESM with no imports, so the dev server serves it as-is.
			// Optimizing it would stamp it with a `?v=` hash that a later
			// re-optimize invalidates under the long-lived Quick Look window.
			exclude: ["@rhwp/core"],
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
