/**
 * Hard version floors for the tools the installer bundles. A resolved version below
 * its floor fails the stage instead of shipping a tool that lacks what the app relies on.
 *
 *  - `minsync` 0.4.12: 0.4.11 is the first release with `minsync serve` (the shared
 *    loopback embedding server the app starts at launch), and 0.4.12 is the first with
 *    the two first-index fixes the app depends on: a failed chunk counts once toward the
 *    systemic-failure streak (three bad files in a row no longer abort a healthy sync), and
 *    inputs to a remote embedder are cut below the model's context instead of answering 400.
 *  - `@nomadamas/mailcrawl` 0.2.2 gains the openai/tei providers, so it can embed through
 *    the daemon's OpenAI route instead of loading its own model.
 *  - `lazykatok` 0.3.3 gains the OpenAI-compatible embedder, the same route.
 */
export const VERSION_FLOORS = {
	minsync: "0.4.12",
	"@nomadamas/mailcrawl": "0.2.2",
	lazykatok: "0.3.3",
};

/** What each floor guarantees, for the error a build prints when it resolves something older. */
const FLOOR_REASONS = {
	minsync: "it is the first release with the first-index fixes this app relies on (failed chunks counted once toward the abort streak, remote inputs cut below the model context) on top of the `minsync serve` embedding daemon",
	"@nomadamas/mailcrawl": "it is the first release that can embed through the `minsync serve` daemon's OpenAI route",
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
