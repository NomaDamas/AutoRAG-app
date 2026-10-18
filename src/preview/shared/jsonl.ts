/** A record line longer than this is spread over indented lines. */
const COMPACT_LIMIT = 80;
/** Integers with this many digits may not survive `JSON.parse`, so their line stays as written. */
const UNSAFE_INTEGER = /\d{16,}/;

export interface JsonLines {
	readonly text: string;
	/** More records follow the ones shown. */
	readonly cut: boolean;
}

function prettyLine(line: string): string {
	if (line.length <= COMPACT_LIMIT || UNSAFE_INTEGER.test(line)) return line;
	try {
		return JSON.stringify(JSON.parse(line), null, 2);
	} catch (error) {
		if (error instanceof SyntaxError) return line;
		throw error;
	}
}

/**
 * The first `limit` records of a JSON Lines text: short records stay on one
 * line, long ones are indented, and a line that is not valid JSON (a prefix
 * cut mid-record, a stray comment) is kept as written. Blank lines are dropped.
 */
export function prettyJsonLines(text: string, limit: number): JsonLines {
	const out: string[] = [];
	let cut = false;
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (out.length >= limit) {
			cut = true;
			break;
		}
		out.push(prettyLine(line));
	}
	return { text: out.join("\n"), cut };
}
