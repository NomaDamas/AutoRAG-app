/**
 * Turn electron-builder's update feed files into the CDN's stable feed.
 *
 *   node scripts/release/update-feed.mjs <dist> <out>
 *
 * electron-builder writes `latest.yml` / `latest-mac.yml` (or `<channel>*.yml`
 * for a pre-release such as v1.2.3-rc.1) whose file entries are bare names,
 * valid only next to the installers in `v<version>/`. The app polls the fixed
 * `latest/` directory instead (AUTORAG_UPDATE_FEED_URL), so each `url:` and
 * `path:` is rewritten to `../v<version>/<name>`. The rewritten files go to
 * `<out>`; the release workflow uploads them to `latest/` (no-cache) and keeps
 * a copy in `v<version>/feed/` for rollback (docs/release.md → "Auto-update").
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Rewrite one feed file's text; throws when it is not an electron-updater feed for `version`. */
export function rewriteFeed(text, version) {
	const declared = /^version:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(text)?.[1];
	if (declared !== version) throw new Error(`feed declares version ${declared ?? "(none)"}, expected ${version}`);
	const prefix = `../v${version}/`;
	let rewritten = 0;
	const out = text.replace(/^(\s*(?:-\s+)?url:|path:)\s*(['"]?)([^'"\n]+)\2\s*$/gm, (_line, key, _quote, name) => {
		if (name.includes("/")) throw new Error(`feed entry "${name}" is not a bare file name`);
		rewritten += 1;
		return `${key} ${prefix}${name}`;
	});
	if (rewritten === 0) throw new Error("feed lists no files");
	return out;
}

function main() {
	const [dist, out] = process.argv.slice(2);
	if (dist === undefined || out === undefined) {
		process.stderr.write("usage: update-feed.mjs <dist> <out>\n");
		process.exit(2);
	}
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	// builder-debug.yml and builder-effective-config.yaml sit in dist/ too; only feeds declare `files:`.
	const feeds = readdirSync(dist).filter((name) => name.endsWith(".yml") && /^files:/m.test(readFileSync(join(dist, name), "utf8")));
	if (feeds.length === 0) throw new Error(`no update feed in ${dist}: was AUTORAG_UPDATE_FEED_URL set for the pack step?`);
	mkdirSync(out, { recursive: true });
	for (const name of feeds) {
		writeFileSync(join(out, name), rewriteFeed(readFileSync(join(dist, name), "utf8"), version));
		process.stdout.write(`[release] feed ${name} -> ../v${version}/\n`);
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main();
