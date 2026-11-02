/**
 * The targets `filee formats <format>` lists: the ones filee-cli converts to
 * directly and the ones it reaches by downloading an engine first. Both count
 * as supported; a target in neither list can never succeed.
 *
 *   DOCX (docx) converts to:
 *     png, jpg, ...
 *   With engines filee-cli downloads when a conversion needs them ('filee engines list'):
 *     svg, eps, ...
 *
 * Returns null when the text has no target lines at all, so a format change in
 * a future filee-cli is not mistaken for "supports nothing".
 */
export function parseFormatTargets(text: string): ReadonlySet<string> | null {
	const targets = new Set<string>();
	for (const line of text.split(/\r?\n/)) {
		if (!/^\s{2}\S/.test(line)) continue;
		for (const target of line.split(",")) {
			const id = target.trim().toLowerCase();
			if (id !== "") targets.add(id);
		}
	}
	return targets.size === 0 ? null : targets;
}
