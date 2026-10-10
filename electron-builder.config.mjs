/**
 * electron-builder configuration for the AutoRAG installers.
 *
 *   macOS    AutoRAG-<version>-arm64.dmg      (Apple Silicon)
 *   Windows  AutoRAG-Setup-<version>-x64.exe  (NSIS, per-user, no admin prompt)
 *
 * What goes into the installer besides the app itself is produced by
 * `scripts/release/stage-tools.mjs` into `build/stage/<platform>/`:
 *   tools/  the dependency programs (Node + npm, minsync, jikji, discrawl, ...)
 *   seed/   the local embedding model and llama.cpp runtime
 * Both land in the app's `resources/` directory (see `extraResources`).
 *
 * Signing is optional at the config level so unsigned CI and local builds
 * work; docs/release.md lists the secrets that turn it on. Nothing here ever
 * contains a credential: electron-builder reads them from the environment.
 */

import { existsSync } from "node:fs";
import { pruneNativeForPlatform, PLATFORMS } from "./scripts/release/lib.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const platformId = process.env.AUTORAG_RELEASE_PLATFORM ?? `${process.platform}-${process.arch}`;
const stage = join(root, "build", "stage", platformId);

const hasMacSigning = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
const hasNotarization = Boolean(
	(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
		(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID),
);
const hasAzureSigning = Boolean(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET);

/** @type {import("electron-builder").Configuration} */
const config = {
	appId: "com.autorag.app",
	productName: "AutoRAG",
	copyright: "Copyright (c) NomaDamas / Marker Inc.",
	artifactName: "AutoRAG-${version}-${arch}.${ext}",
	directories: { output: "dist", buildResources: "build" },
	// No asar: the bundled `autorag` CLI runs under plain Node, which cannot read
	// inside an asar, and the app spawns native helpers that must be real files.
	asar: false,
	// Native modules of the app are N-API prebuilds or WASM; rebuilding for
	// Electron's ABI would only compile what is not used.
	npmRebuild: false,
	files: [
		"out/**",
		"package.json",
		"!**/*.map",
		"!**/{test,tests,__tests__,docs,example,examples,.github}/**",
		"!**/node_modules/**/{*.md,*.markdown,CHANGELOG*,README*,*.d.ts,*.ts.map,*.tsbuildinfo}",
		"!node_modules/@autorag/librarian/{src,test,legacy,docs,assets,scripts,skills-src}/**",
	],
	extraResources: [
		{ from: join(stage, "tools"), to: "tools", filter: ["**/*"] },
		{ from: join(stage, "seed"), to: "seed", filter: ["**/*"] },
	],

	mac: {
		category: "public.app-category.productivity",
		target: [{ target: "dmg", arch: ["arm64"] }],
		icon: "build/icon.png",
		hardenedRuntime: true,
		gatekeeperAssess: false,
		entitlements: "build/entitlements.mac.plist",
		entitlementsInherit: "build/entitlements.mac.plist",
		// The staged CLIs are separate Mach-O executables; each is signed with the
		// app's identity so notarization accepts the bundle as a whole.
		binaries: [],
		extendInfo: {
			NSDocumentsFolderUsageDescription: "AutoRAG indexes and searches the folders you choose.",
			NSDesktopFolderUsageDescription: "AutoRAG indexes and searches the folders you choose.",
			NSDownloadsFolderUsageDescription: "AutoRAG indexes and searches the folders you choose.",
		},
		// Without a Developer ID the bundle is ad-hoc signed ("-"): Apple Silicon refuses to run unsigned code.
		...(hasMacSigning ? {} : { identity: "-" }),
		notarize: hasMacSigning && hasNotarization,
	},
	dmg: {
		sign: false,
		writeUpdateInfo: false,
		contents: [
			{ x: 150, y: 190, type: "file" },
			{ x: 410, y: 190, type: "link", path: "/Applications" },
		],
	},

	win: {
		target: [{ target: "nsis", arch: ["x64"] }],
		icon: "build/icon.png",
		...(hasAzureSigning
			? {
					azureSignOptions: {
						endpoint: process.env.AZURE_CODESIGN_ENDPOINT,
						codeSigningAccountName: process.env.AZURE_CODESIGN_ACCOUNT,
						certificateProfileName: process.env.AZURE_CODESIGN_PROFILE,
					},
				}
			: {}),
	},
	nsis: {
		oneClick: true,
		perMachine: false,
		runAfterFinish: true,
		deleteAppDataOnUninstall: false,
		artifactName: "AutoRAG-Setup-${version}-${arch}.${ext}",
		// Windows long paths: node_modules trees under resources/ nest deeply.
		warningsAsErrors: false,
	},

	// The app's own node_modules (librarian + its dependency tree) carries every platform's native add-ons.
	afterPack: async (context) => {
		const resources = context.electronPlatformName === "darwin" ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources") : join(context.appOutDir, "resources");
		pruneNativeForPlatform(join(resources, "app", "node_modules"), PLATFORMS[platformId]);
	},

	publish: null,
};

if (!existsSync(join(stage, "tools"))) {
	throw new Error(`Missing ${join(stage, "tools")}. Run \`bun run release:stage\` before electron-builder.`);
}
if (!existsSync(join(stage, "seed"))) {
	throw new Error(`Missing ${join(stage, "seed")}. Run \`bun run release:stage\` before electron-builder.`);
}

export default config;
