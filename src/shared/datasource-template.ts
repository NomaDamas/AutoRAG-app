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
 * What a new connection is called when the person does not choose. Browser history starts as `browser`, not as the
 * program's name: the id shows up in the assistant's tool names and in the shared config, and the person knows this
 * source as their browser history.
 */
const DEFAULT_CONNECTION_ALIASES: Readonly<Record<string, string>> = { nogon: "browser" };

/** Ids that only restate what a template is. A connection under one of them is shown by its kind alone. */
const IMPLIED_CONNECTION_ALIASES: Readonly<Record<string, readonly string[]>> = { nogon: ["browser", "browser-history"] };

/** The id a new connection of `template` starts with. */
export function defaultConnectionAlias(template: string): string {
	const canonical = canonicalDatasourceTemplate(template);
	return Object.hasOwn(DEFAULT_CONNECTION_ALIASES, canonical) ? (DEFAULT_CONNECTION_ALIASES[canonical] as string) : template;
}

/**
 * Whether the connection id `alias` adds nothing a person needs to see next to the name of its template `type`: it is
 * the template's own id (`slack`), its pre-rename id (`hister` for Nogon), or an id that only says what the source is
 * (`browser`). A second connection of the same kind keeps its distinguishing name (`work`).
 */
export function isImpliedConnectionAlias(type: string, alias: string): boolean {
	const template = canonicalDatasourceTemplate(type);
	return (
		alias === type ||
		canonicalDatasourceTemplate(alias) === template ||
		(IMPLIED_CONNECTION_ALIASES[template] ?? []).includes(alias)
	);
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
