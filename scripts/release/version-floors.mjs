/**
 * Hard version floors for the tools the installer bundles. A resolved version below
 * its floor fails the stage instead of shipping a tool that lacks what the app relies on.
 *
 *  - `minsync` 0.5.1: librarian 2.13.2 requires MinSync 0.5.1's durable stage protocol v2
 *    (`capabilities`/`plan`/`inspect`) for incremental parsed mirrors, JSONL sync progress
 *    streaming (`--progress jsonl`), and preflight exit codes 4/5 on top of `minsync serve`.
 *  - `@nomadamas/mailcrawl` 0.3.0: librarian 2.13.2 requires mailcrawl 0.3.0's `--source files`
 *    (`--path`) local archive indexing (which retires `mail-export`), on top of the daemon's
 *    OpenAI embedding route.
 *  - `lazykatok` 0.3.3 gains the OpenAI-compatible embedder, the same route.
 */
export const VERSION_FLOORS = {
	minsync: "0.5.1",
	"@nomadamas/mailcrawl": "0.3.0",
	lazykatok: "0.3.3",
};

/** What each floor guarantees, for the error a build prints when it resolves something older. */
const FLOOR_REASONS = {
	minsync: "librarian 2.13.2 requires MinSync 0.5.1's durable stage protocol v2 (`capabilities`/`plan`/`inspect`), `--progress jsonl`, and preflight exit codes on top of `minsync serve`",
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
