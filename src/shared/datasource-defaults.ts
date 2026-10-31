import type { JsonValue } from "./settings-contract";

/**
 * Connector settings a new connection starts with, per datasource type. One table for every place that creates a
 * connection (onboarding's first index, Settings → 연결된 앱 → 연결), so a connection reads the same data no matter
 * which door it came through.
 *
 * Slack: slacrawl's default sync is its API source, which exits nonzero ("SLACK_BOT_TOKEN or SLACK_USER_TOKEN is
 * required for api sync") unless a bot/user token is configured, and the refresh then fails with an opaque
 * `nonzero-exit`. `--source wiretap` reads Slack Desktop's local cache and needs no token (NomaDamas/AutoRAG-app#396).
 */
const CONNECTOR_DEFAULTS: Readonly<Record<string, Readonly<Record<string, JsonValue>>>> = {
	slack: { syncSource: "wiretap" },
};

/** The preset `connector` block for a datasource type, or null when it starts empty. A fresh object every call. */
export function connectorDefaultsFor(type: string): Record<string, JsonValue> | null {
	const preset = CONNECTOR_DEFAULTS[type];
	return preset === undefined ? null : { ...preset };
}

/**
 * The config entry for a new connection named `alias` of kind `type`. The `type` key is only written when the alias
 * differs from it (the librarian reads the alias as the type otherwise).
 */
export function newDatasourceEntry(type: string, alias: string): Record<string, JsonValue> {
	const connector = connectorDefaultsFor(type);
	return {
		...(alias === type ? {} : { type }),
		...(connector === null ? {} : { connector }),
	};
}
