/**
 * Refresh pinned dependency versions and checksums in `src/shared/tool-pins.json`.
 *
 *   node scripts/release/refresh-pins.mjs [--check] [--summary-md <path>]
 *
 * Queries GitHub Releases, crates.io, npm, and nodejs.org for the newest stable
 * versions and verifies that:
 *   1. Publisher sha256/checksum/integrity metadata is present for every platform asset.
 *   2. Every resolved version satisfies the floors derived from the pinned `@autorag/librarian`.
 *
 * `--check` exits 0 when pins are already up to date, or 1 when updates are available
 * (without modifying `src/shared/tool-pins.json`). Without `--check`, writes the
 * updated pin file in place.
 */

import { writeFileSync } from "node:fs";
import { PLATFORMS, fetchText, latestCrateInfo, latestNode24, latestNpmInfo, latestRelease, log } from "./lib.mjs";
import {
	GITHUB_ASSET_PATTERNS,
	TOOL_PINS_PATH,
	assertPinsMeetFloors,
	deriveVersionFloors,
	loadToolPins,
} from "./pins.mjs";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const option = (name) => {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
};
const summaryMdPath = option("--summary-md");

/** Resolve the latest version + checksums for one tool entry, given injectable resolvers for testing. */
export async function resolveUpdatedPins(current, resolvers) {
	const next = structuredClone(current);
	const changes = [];

	// Node 24 LTS
	const nodeTag = await resolvers.latestNode24();
	const nodeVersion = nodeTag.replace(/^v/u, "");
	const nodeSums = await resolvers.fetchText(`https://nodejs.org/dist/${nodeTag}/SHASUMS256.txt`);
	const nodeSha = {};
	for (const [platformId, target] of Object.entries(PLATFORMS)) {
		const archive = `node-${nodeTag}-${target.nodeSuffix}`;
		const line = nodeSums.split("\n").find((entry) => entry.endsWith(`  ${archive}`));
		if (line === undefined) throw new Error(`Node ${nodeTag}: SHASUMS256.txt has no ${archive}`);
		nodeSha[platformId] = line.split(/\s+/u)[0];
	}
	if (current.node.version !== nodeVersion) {
		changes.push({ name: "node", from: current.node.version, to: nodeVersion, affectsVectorSpace: false });
	}
	next.node = { version: nodeVersion, tag: nodeTag, sha256: nodeSha };

	for (const [name, entry] of Object.entries(current.tools)) {
		if (entry.source === "github" || entry.source === "github-or-go") {
			const release = await resolvers.latestRelease(entry.repo);
			const tag = release.tag_name;
			const version = tag.replace(/^v/u, "");
			const patterns = GITHUB_ASSET_PATTERNS[name] ?? {};
			const assets = {};
			for (const [platformId, pattern] of Object.entries(patterns)) {
				const asset = release.assets.find((candidate) => pattern.test(candidate.name));
				if (asset === undefined) throw new Error(`${name} ${tag}: no asset matches ${pattern} for ${platformId}`);
				const sha256 = typeof asset.digest === "string" && asset.digest.startsWith("sha256:") ? asset.digest.slice("sha256:".length) : null;
				if (sha256 === null) throw new Error(`${name} ${tag} (${asset.name}): publisher digest is missing`);
				assets[platformId] = { name: asset.name, sha256 };
			}
			if (entry.version !== version) {
				changes.push({ name, from: entry.version, to: version, affectsVectorSpace: entry.affectsVectorSpace === true });
			}
			next.tools[name] = { ...entry, version, tag, assets };
		} else if (entry.source === "cargo") {
			const crate = entry.crate ?? name;
			const info = await resolvers.latestCrateInfo(crate);
			if (!info.checksum) throw new Error(`${name} (${crate}@${info.version}): crates.io checksum is missing`);
			if (entry.version !== info.version) {
				changes.push({ name, from: entry.version, to: info.version, affectsVectorSpace: entry.affectsVectorSpace === true });
			}
			next.tools[name] = { ...entry, version: info.version, checksum: info.checksum };
		} else if (entry.source === "npm") {
			const info = await resolvers.latestNpmInfo(name);
			if (!info.integrity) throw new Error(`${name}@${info.version}: npm dist.integrity is missing`);
			if (entry.version !== info.version) {
				changes.push({ name, from: entry.version, to: info.version, affectsVectorSpace: entry.affectsVectorSpace === true });
			}
			next.tools[name] = { ...entry, version: info.version, integrity: info.integrity };
		}
	}

	return { next, changes };
}

export function formatChangesMarkdown(changes) {
	if (changes.length === 0) return "No tool pin updates.\n";
	const lines = [
		"## Proposed tool pin updates",
		"",
		"| Tool | Previous | New | Notes |",
		"| --- | --- | --- | --- |",
		...changes.map((c) => `| \`${c.name}\` | \`${c.from}\` | \`${c.to}\` | ${c.affectsVectorSpace ? "Check embedding vector space compatibility" : ""} |`),
	];
	const vectorBumps = changes.filter((c) => c.affectsVectorSpace);
	if (vectorBumps.length > 0) {
		lines.push(
			"",
			"> **Vector-space notice:** " +
				vectorBumps.map((c) => `\`${c.name}\``).join(", ") +
				" bumped. Verify whether this changes the embedding vector space or embedded `inl` server version (`daemon.engineVersion` in `src/shared/tool-pins.json`). Dazzi never reindexes automatically.",
		);
	}
	return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const current = loadToolPins();
	const { next, changes } = await resolveUpdatedPins(current, {
		latestNode24,
		fetchText,
		latestRelease,
		latestCrateInfo,
		latestNpmInfo,
	});
	// Must still satisfy every floor derived from the pinned @autorag/librarian.
	const floors = deriveVersionFloors(next);
	assertPinsMeetFloors(next, floors);

	const summary = formatChangesMarkdown(changes);
	if (summaryMdPath !== undefined) writeFileSync(summaryMdPath, summary);

	if (changes.length === 0) {
		log("src/shared/tool-pins.json is up to date.");
		process.exit(0);
	}
	process.stdout.write(summary);
	if (checkOnly) {
		log(`${changes.length} pin update(s) available (--check).`);
		process.exit(1);
	}
	writeFileSync(TOOL_PINS_PATH, `${JSON.stringify(next, null, 2)}\n`);
	log(`updated ${TOOL_PINS_PATH} (${changes.length} change(s)).`);
}
