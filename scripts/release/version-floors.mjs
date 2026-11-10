/**
 * Hard version floors for the tools the installer bundles. A resolved version below
 * its floor fails the stage instead of shipping a tool that lacks what the app relies on.
 *
 *  - `minsync` 0.7.1: librarian 2.13.7 refuses an older `minsync` outright (`MINSYNC_MIN_VERSION`). 0.7.1 makes every
 *    committed batch searchable, also during the first sync, which the librarian's refresh now relies on when it
 *    syncs alongside parsing. Beneath it: SPLADE sparse retrieval (`--mode sparse`, 0.6.0, which replaced BM25),
 *    sparse-only indexes (`init --embedder none`), the durable stage protocol v2, `--progress jsonl`, and preflight
 *    exit codes.
 *  - `dupey` 0.2.0: librarian 2.13.7 refuses an older one. 0.1.2 misreads HWP 5.x record lengths, so an HWP hashes
 *    incomplete or empty text, and its `fingerprint` hashes empty text where `scan` hashes the file bytes: the
 *    hashes AutoRAG stores for cloud files would disagree with the ones it computes.
 *  - `@nomadamas/mailcrawl` 0.3.0: librarian 2.13.2 requires mailcrawl 0.3.0's `--source files`
 *    (`--path`) local archive indexing (which retires `mail-export`), on top of the daemon's
 *    OpenAI embedding route.
 *  - `lazykatok` 0.3.3 gains the OpenAI-compatible embedder, the same route.
 */
export const VERSION_FLOORS = {
	minsync: "0.7.1",
	dupey: "0.2.0",
	"@nomadamas/mailcrawl": "0.3.0",
	lazykatok: "0.3.3",
};

/** What each floor guarantees, for the error a build prints when it resolves something older. */
const FLOOR_REASONS = {
	minsync: "librarian 2.13.7 refuses an older minsync: it syncs alongside parsing and relies on 0.7.1 making every committed batch searchable during the first sync, on top of 0.6.0's SPLADE sparse retrieval and sparse-only indexes",
	dupey: "librarian 2.13.7 refuses an older dupey: 0.1.2 hashes an HWP's text incompletely and hashes `fingerprint` and `scan` inconsistently, so the hashes it stores would disagree with the ones it computes",
	"@nomadamas/mailcrawl": "librarian 2.13.2 requires mailcrawl 0.3.0's `--source files` local archive support on top of the `minsync serve` daemon's OpenAI route",
	lazykatok: "it is the first release that can embed through the `minsync serve` daemon's OpenAI route",
};

/** Compare dotted numeric versions: `a > b` -> positive, `a < b` -> negative, equal -> 0. */
export function compareVersions(a, b) {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Fail the stage when a resolved tool is older than its floor. */
export function assertVersionFloor(name, version, floor) {
	if (compareVersions(version, floor) < 0) {
		const reason = FLOOR_REASONS[name] ?? "it is the first release this build supports";
		throw new Error(`${name} ${version} is below the required ${floor}: ${reason}. Pin a newer ${name} or wait for its release.`);
	}
}
