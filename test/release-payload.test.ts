import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nonAsciiRoots, pruneToLoose, tarExcludeArgs } from "../scripts/release/lib.mjs";

// Windows' bsdtar (3.8.9 on the windows-2022 runner) dies with an access violation while archiving a file whose
// name is not ASCII (kordoc ships Korean-named templates), and cannot extract such a name either. The payload
// tar therefore carries only ASCII paths; a directory holding a non-ASCII name stays loose in the installer.
const KOREAN = "\uAC04\uC774\uAE30\uC548\uBB38_\uC11C\uC2DD.hwpx";

let root = "";
afterEach(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
	root = "";
});

function resources(): string {
	root = mkdtempSync(join(tmpdir(), "autorag-payload-"));
	const files = [
		"app/node_modules/kordoc/dist/index.js",
		`app/node_modules/kordoc/templates/${KOREAN}`,
		"app/node_modules/kordoc/templates/plain.json",
		"app/node_modules/left-pad/index.js",
		"tools/node/node.exe",
		`tools/npm/node_modules/@scope/pkg/${KOREAN}`,
	];
	for (const file of files) {
		mkdirSync(join(root, file, ".."), { recursive: true });
		writeFileSync(join(root, file), "x");
	}
	return root;
}

const TREES = ["app/node_modules", "tools/npm", "tools/node"];

describe("nonAsciiRoots", () => {
	it("names the highest directory that directly holds a non-ASCII entry, as an ASCII path", () => {
		expect(nonAsciiRoots(resources(), TREES)).toEqual(["app/node_modules/kordoc/templates", "tools/npm/node_modules/@scope/pkg"]);
	});

	it("finds nothing in a tree whose names are all ASCII", () => {
		expect(nonAsciiRoots(resources(), ["tools/node"])).toEqual([]);
	});

	it("keeps a directory whose own name is non-ASCII loose through its parent, so every returned path is ASCII", () => {
		root = mkdtempSync(join(tmpdir(), "autorag-payload-"));
		mkdirSync(join(root, "app", `\uD55C\uAE00`, "deep"), { recursive: true });
		writeFileSync(join(root, "app", `\uD55C\uAE00`, "deep", "a.txt"), "x");

		expect(nonAsciiRoots(root, ["app"])).toEqual(["app"]);
	});
});

describe("tarExcludeArgs", () => {
	it("excludes each loose directory by its archive path and escapes the characters a pattern would read as a glob", () => {
		expect(tarExcludeArgs(["app/node_modules/kordoc/templates", "tools/npm/node_modules/a[b]"])).toEqual([
			"--exclude=app/node_modules/kordoc/templates",
			"--exclude=tools/npm/node_modules/a\\[b\\]",
		]);
	});
});

describe("pruneToLoose", () => {
	it("removes a whole tree that has no loose directory", () => {
		const base = resources();

		pruneToLoose(base, TREES, nonAsciiRoots(base, TREES));

		expect(existsSync(join(base, "tools/node"))).toBe(false);
	});

	it("leaves the loose directories and the way down to them, and removes everything the tar carries", () => {
		const base = resources();

		pruneToLoose(base, TREES, nonAsciiRoots(base, TREES));

		expect(readdirSync(join(base, "app/node_modules/kordoc/templates")).sort()).toEqual([KOREAN, "plain.json"].sort());
		expect(existsSync(join(base, "app/node_modules/kordoc/dist"))).toBe(false);
		expect(existsSync(join(base, "app/node_modules/left-pad"))).toBe(false);
		expect(readdirSync(join(base, "tools/npm/node_modules/@scope/pkg"))).toEqual([KOREAN]);
		expect(readdirSync(join(base, "app/node_modules")).sort()).toEqual(["kordoc"]);
	});
});
