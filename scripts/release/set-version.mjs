/**
 * Stamp the release version into the build from a git tag, in the working tree only.
 *
 *   node scripts/release/set-version.mjs v1.2.3
 *
 * `package.json` (installer file names, Info.plist, the Windows file version)
 * and `APP_VERSION` (window title, About) both carry the version; the tag is
 * the single source of truth for a release, so CI rewrites both from it
 * instead of relying on a commit that bumps them. The edit is never committed.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, log } from "./lib.mjs";

const tag = process.argv[2] ?? "";
const match = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (match === null) {
	process.stderr.write(`set-version: "${tag}" is not a version tag (expected v1.2.3 or v1.2.3-rc.1)\n`);
	process.exit(2);
}
const version = match[1];

const packagePath = join(ROOT, "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
manifest.version = version;
writeFileSync(packagePath, `${JSON.stringify(manifest, null, "\t")}\n`);

const infoPath = join(ROOT, "src", "shared", "app-info.ts");
const info = readFileSync(infoPath, "utf8");
const stamped = info.replace(/export const APP_VERSION = "[^"]*";/, `export const APP_VERSION = "${version}";`);
if (stamped === info && !info.includes(`APP_VERSION = "${version}"`)) {
	process.stderr.write("set-version: APP_VERSION declaration not found in src/shared/app-info.ts\n");
	process.exit(1);
}
writeFileSync(infoPath, stamped);
log(`version ${version}`);
