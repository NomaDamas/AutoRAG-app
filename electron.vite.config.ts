import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * Ship the rebuilt libarchive engine beside the bundled archive worker, which
 * reads `./vendor/libarchive.wasm` relative to itself (src/main/vendor/ in
 * dev and tests, out/main/vendor/ in a build). See scripts/libarchive-wasm/README.md.
 */
const vendoredLibarchiveWasm: Plugin = {
	name: "autorag-vendored-libarchive-wasm",
	generateBundle() {
		this.emitFile({
			type: "asset",
			fileName: "vendor/libarchive.wasm",
			source: readFileSync(resolve(import.meta.dirname, "src/main/vendor/libarchive.wasm")),
		});
	},
};

/** Node worker_thread entries: they keep the `.mjs` name so the source and the build share one spawn URL. */
const WORKER_ENTRIES: Readonly<Record<string, true>> = { "librarian-thread": true, "archive-worker": true, "archive-list-worker": true, "lzma-worker": true, "parse-worker": true };

export default defineConfig({
	main: {
		plugins: [vendoredLibarchiveWasm],
		build: {
			rollupOptions: {
				// The fs worker is a second Node entry: an Electron utility process
				// the main process forks (`src/main/fs-worker-host.ts`). The archive
				// worker is a Node worker_thread the extractor spawns for the wasm
				// engine; it keeps the `.mjs` name so the source and the build share
				// one spawn URL. The refresh job is the entry an OS-scheduled task runs in plain Node
				// (`ELECTRON_RUN_AS_NODE`), and the MCP server the one other agents start on a real Node,
				// so neither may ever import electron.
				input: {
					index: resolve(import.meta.dirname, "src/main/index.ts"),
					"refresh-job": resolve(import.meta.dirname, "src/main/refresh-job.ts"),
					"mcp-server": resolve(import.meta.dirname, "src/main/mcp-server.ts"),
					"fs-worker": resolve(import.meta.dirname, "src/fs-worker/index.ts"),
					// The fs worker's librarian thread: the one place that imports `@autorag/librarian` (see src/fs-worker/librarian-client.ts).
					"librarian-thread": resolve(import.meta.dirname, "src/fs-worker/librarian-thread.ts"),
					"archive-worker": resolve(import.meta.dirname, "src/main/archive-worker.mjs"),
					"archive-list-worker": resolve(import.meta.dirname, "src/main/archive-list-worker.mjs"),
					"parse-worker": resolve(import.meta.dirname, "src/main/parse-worker.mjs"),
					"lzma-worker": resolve(import.meta.dirname, "src/main/lzma-worker.mjs"),
				},
				output: {
					entryFileNames: (chunk) => (WORKER_ENTRIES[chunk.name] === true ? `${chunk.name}.mjs` : "[name].js"),
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
