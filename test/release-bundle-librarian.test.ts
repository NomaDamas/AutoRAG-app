import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectExternalClosure, isForeignPlatformPackage } from "../scripts/release/bundle-librarian.mjs";

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("standalone librarian bundler helpers", () => {
	it("filters foreign OS and architecture packages out of optional dependency closures", () => {
		const macArm64 = { os: "darwin", arch: "arm64" };
		expect(isForeignPlatformPackage("@parcel/watcher-darwin-arm64", macArm64)).toBe(false);
		expect(isForeignPlatformPackage("@parcel/watcher-darwin-x64", macArm64)).toBe(true);
		expect(isForeignPlatformPackage("@parcel/watcher-linux-arm64-gnu", macArm64)).toBe(true);
		expect(isForeignPlatformPackage("@parcel/watcher-win32-x64", macArm64)).toBe(true);
		expect(isForeignPlatformPackage("@img/sharp-libvips-darwin-arm64", macArm64)).toBe(false);
		expect(isForeignPlatformPackage("@img/sharp-libvips-linuxmusl-arm64", macArm64)).toBe(true);

		const winX64 = { os: "win32", arch: "x64" };
		expect(isForeignPlatformPackage("@parcel/watcher-win32-x64", winX64)).toBe(false);
		expect(isForeignPlatformPackage("@parcel/watcher-win32-arm64", winX64)).toBe(true);
		expect(isForeignPlatformPackage("fsevents", winX64)).toBe(true);
	});

	it("collects only reachable platform-matched packages from node_modules", () => {
		const root = mkdtempSync(join(tmpdir(), "dazzi-bundle-closure-"));
		tempDirs.push(root);
		const writePkg = (name: string, manifest: Record<string, unknown>) => {
			const dir = join(root, name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...manifest }));
		};
		writePkg("@parcel/watcher", {
			dependencies: { "node-addon-api": "^7.0.0" },
			optionalDependencies: {
				"@parcel/watcher-darwin-arm64": "2.6.0",
				"@parcel/watcher-linux-x64-gnu": "2.6.0",
			},
		});
		writePkg("node-addon-api", {});
		writePkg("@parcel/watcher-darwin-arm64", {});
		writePkg("@parcel/watcher-linux-x64-gnu", {});
		writePkg("unrelated-pkg", {});

		const closure = collectExternalClosure(root, ["@parcel/watcher"], { os: "darwin", arch: "arm64" });
		expect(closure).toEqual(["@parcel/watcher", "@parcel/watcher-darwin-arm64", "node-addon-api"]);
		expect(existsSync(join(root, "unrelated-pkg"))).toBe(true);
	});
});
