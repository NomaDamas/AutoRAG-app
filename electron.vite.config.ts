import { createRequire } from "node:module";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const PDFJS_ROOT = dirname(require.resolve("pdfjs-dist/package.json"));
const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"] as const;
const PDFJS_ASSET_CONTENT_TYPES: Readonly<Record<string, string>> = {
	".bcmap": "application/octet-stream",
	".pfb": "application/octet-stream",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".js": "text/javascript; charset=utf-8",
	".icc": "application/vnd.iccprofile",
};

/**
 * Expose pdf.js's runtime support directories (`cmaps`, `standard_fonts`,
 * `wasm`, `iccs`) at `pdfjs/<dir>/` in both the Vite dev server and the
 * production `out/renderer/` bundle. Without `cmaps/`, PDFs using predefined
 * CJK CMaps with unembedded CIDFonts (such as `UniKS-UTF16-H`) drop every
 * glyph; without `standard_fonts/`, standard-14 fallback fonts fail to load.
 */
const pdfjsSupportAssets: Plugin = {
	name: "autorag-pdfjs-support-assets",
	configureServer(server) {
		server.middlewares.use("/pdfjs/", (req, res, next) => {
			const pathname = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
			const parts = pathname.replace(/^\/+/, "").split("/");
			if (parts.length !== 2) return next();
			const [dir, file] = parts;
			if (!dir || !file || !(PDFJS_ASSET_DIRS as readonly string[]).includes(dir)) return next();
			if (file.includes("..") || file.includes("\0")) return next();
			const contentType = PDFJS_ASSET_CONTENT_TYPES[extname(file).toLowerCase()];
			if (contentType === undefined) return next();
			const full = join(PDFJS_ROOT, dir, file);
			try {
				const body = readFileSync(full);
				res.setHeader("Content-Type", contentType);
				res.end(body);
			} catch {
				next();
			}
		});
	},
	generateBundle() {
		for (const dir of PDFJS_ASSET_DIRS) {
			const folder = join(PDFJS_ROOT, dir);
			for (const entry of readdirSync(folder)) {
				if (PDFJS_ASSET_CONTENT_TYPES[extname(entry).toLowerCase()] === undefined) continue;
				const full = join(folder, entry);
				if (!statSync(full).isFile()) continue;
				this.emitFile({
					type: "asset",
					fileName: `pdfjs/${dir}/${entry}`,
					source: readFileSync(full),
				});
			}
		}
	},
};

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
		const macRevealHook = resolve(import.meta.dirname, "src/main/vendor/mac-reveal-hook.node");
		if (process.platform === "darwin" && existsSync(macRevealHook)) {
			this.emitFile({
				type: "asset",
				fileName: "vendor/mac-reveal-hook.node",
				source: readFileSync(macRevealHook),
			});
		}
		const dazziCore = resolve(import.meta.dirname, "src/main/vendor/dazzi-core.node");
		if (!existsSync(dazziCore)) {
			throw new Error(`Missing required Rust native core: ${dazziCore}. Run \`node scripts/build-dazzi-core.mjs\` first.`);
		}
		this.emitFile({
			type: "asset",
			fileName: "vendor/dazzi-core.node",
			source: readFileSync(dazziCore),
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
					"quick-search": resolve(import.meta.dirname, "src/preload/quick-search.ts"),
				},
			},
		},
	},
	renderer: {
		plugins: [tailwindcss(), pdfjsSupportAssets],
		oxc: {
			jsx: { runtime: "automatic" },
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
					"quick-search": resolve(import.meta.dirname, "src/renderer/quick-search.html"),
				},
			},
		},
	},
});
