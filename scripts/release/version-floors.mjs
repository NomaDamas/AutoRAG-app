/**
 * Hard version floors for the tools the installer bundles. A resolved version below
 * its floor fails the stage instead of shipping a tool that lacks what the app relies on.
 *
 *  - `minsync` 0.7.6: librarian 2.14.2 refuses an older `minsync` outright (`MINSYNC_MIN_VERSION`). 0.7.5+ shares the
 *    `im-not-llm` daemon and weight cache root (`~/.cache/im-not-llm/{models,serve}`), and 0.7.6 carries the matching
 *    `inl-server` 0.3.4 protocol. Beneath it: batch-visible first sync (0.7.1), SPLADE sparse retrieval (`--mode sparse`,
 *    0.6.0), sparse-only indexes (`init --embedder none`), durable stage protocol v2, `--progress jsonl`, and preflight
 *    exit codes.
 *  - `dupey` 0.2.0: librarian 2.13.7 refuses an older one. 0.1.2 misreads HWP 5.x record lengths, so an HWP hashes
 *    incomplete or empty text, and its `fingerprint` hashes empty text where `scan` hashes the file bytes: the
 *    hashes AutoRAG stores for cloud files would disagree with the ones it computes.
 *  - `@nomadamas/mailcrawl` 0.3.0: librarian 2.13.2 requires mailcrawl 0.3.0's `--source files`
 *    (`--path`) local archive indexing (which retires `mail-export`), on top of the daemon's
 *    OpenAI embedding route.
 *  - `lazykatok` 0.3.3 gains the OpenAI-compatible embedder, the same route.
 *  - `wombat-sessions` (the `wombat` CLI) 0.1.3: AI Sessions. It follows MinSync's own embedder and chunker defaults and
 *    requires minsync 0.7.3, which the bundle already carries; 0.1.2 and older pin a chunker and an embedder
 *    themselves, so an index they build would not match the one the librarian's MinSync reads.
 */
export const VERSION_FLOORS = {
	minsync: "0.7.6",
	dupey: "0.2.0",
	"@nomadamas/mailcrawl": "0.3.0",
	lazykatok: "0.3.3",
	wombat: "0.1.3",
};

/** What each floor guarantees, for the error a build prints when it resolves something older. */
const FLOOR_REASONS = {
	minsync: "librarian 2.14.2 refuses an older minsync: 0.7.6 shares the im-not-llm daemon/cache root (`~/.cache/im-not-llm`) and links inl-server 0.3.4 on top of batch-visible first sync and SPLADE sparse retrieval",
	dupey: "librarian 2.13.7 refuses an older dupey: 0.1.2 hashes an HWP's text incompletely and hashes `fingerprint` and `scan` inconsistently, so the hashes it stores would disagree with the ones it computes",
	"@nomadamas/mailcrawl": "librarian 2.13.2 requires mailcrawl 0.3.0's `--source files` local archive support on top of the `minsync serve` daemon's OpenAI route",
	lazykatok: "it is the first release that can embed through the `minsync serve` daemon's OpenAI route",
	wombat: "0.1.3 is the first release that follows MinSync's own embedder and chunker defaults on minsync 0.7.3; an older one builds an index the librarian's MinSync does not read",
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
