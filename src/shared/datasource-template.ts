/**
 * Datasource template ids that were renamed. A `config.json` the app wrote before the rename still says the old id,
 * and the same file is shared with the AutoRAG CLI, so every place that maps a stored `type` (or a bare alias) to a
 * template goes through here instead of comparing against a literal.
 *
 * `hister` -> `nogon`: the browser-history program was renamed after a trademark complaint (Nogon v0.22.0). The
 * connection's own id (`datasources.<id>`) is never rewritten, only the template it resolves to.
 */
const LEGACY_TEMPLATE_IDS: Readonly<Record<string, string>> = { hister: "nogon" };

/** The current template id for `id`; ids that were never renamed come back unchanged. */
export function canonicalDatasourceTemplate(id: string): string {
	return Object.hasOwn(LEGACY_TEMPLATE_IDS, id) ? (LEGACY_TEMPLATE_IDS[id] as string) : id;
}

/**
 * The template a stored datasource entry resolves to: its non-empty string `type`, else its alias, canonicalized.
 * `entry` is whatever `config.json` held, so anything that is not an object with a string `type` falls back to the alias.
 */
export function datasourceTemplateOf(alias: string, entry: unknown): string {
	const type =
		typeof entry === "object" && entry !== null && "type" in entry && typeof entry.type === "string" && entry.type.length > 0
			? entry.type
			: alias;
	return canonicalDatasourceTemplate(type);
}
