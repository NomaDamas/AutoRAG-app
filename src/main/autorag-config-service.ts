import { randomUUID } from "node:crypto";
import { access, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerDazziProvider } from "@autorag/librarian";
import { autoragFirst } from "../shared/account-contract";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import {
	buildAgentOptions,
	readRawConfigObject,
	resolveConfigPath,
	resolveConfigReadOnly,
	writeConfigObject,
	type CliConfig,
} from "@autorag/librarian/core";
import type {
	AutoRagConfigSnapshot,
	AutoRagConfigUpdate,
	JsonObject,
	JsonValue,
	ModelCatalogEntry,
	ModelCatalogProvider,
	ModelCatalogSnapshot,
} from "../shared/settings-contract";
import { isJsonObject } from "../shared/settings-contract";
import { CALENDAR_MCP_EXPOSURES, syncCalendarMcpConfig } from "./calendar-mcp";

const REDACTED_SECRET = "__AUTORAG_SECRET_REDACTED__";
/**
 * Secret-looking keys. Word-bounded and allowlisted so `maxTokens`,
 * `contextWindow`, `timeoutMs`, `*Env`/`*Name` are never redacted.
 */
const SECRET_KEY = /(?:api[-_]?key|access[-_]?key|token|password|passwd|secret|cookie|authorization|private[-_]?key)/iu;
const NON_SECRET_KEY: Record<string, true> = {
	maxtokens: true,
	maxoutputtokens: true,
	maxinputtokens: true,
	contextwindow: true,
	tokenlimit: true,
	tokenbudget: true,
	timeoutms: true,
	timeoutseconds: true,
	maxbodybytes: true,
	maxfilebytes: true,
};

export function isSecretKey(key: string): boolean {
	if (/(?:env|name)$/iu.test(key)) return false;
	if (NON_SECRET_KEY[key.toLowerCase()] === true) return false;
	return SECRET_KEY.test(key);
}

/** Config roots the app never lets the renderer replace (librarian/CLI owned). */
const FORBIDDEN_ROOTS: Record<string, true> = { workspacePath: true, memoryPath: true };
/** Keys that would enable prototype pollution on the raw config object. */
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_PATH_SEGMENT = /^(?!__proto__$|prototype$|constructor$)[^/]+$/u;

function redact(value: unknown, key?: string): JsonValue {
	if (key !== undefined && isSecretKey(key)) return REDACTED_SECRET;
	if (Array.isArray(value)) return value.map((item) => redact(item));
	if (isJsonObject(value)) {
		const result: Record<string, JsonValue> = {};
		for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redact(childValue, childKey);
		return result as JsonObject;
	}
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
	return null;
}

/** Put back the original secret wherever the renderer echoed the redaction sentinel. */
function restoreSecrets(previous: unknown, next: unknown): unknown {
	if (next === REDACTED_SECRET) return previous;
	if (Array.isArray(next)) {
		return next.map((value, index) => restoreSecrets(Array.isArray(previous) ? previous[index] : undefined, value));
	}
	if (isJsonObject(next)) {
		const oldRecord = isJsonObject(previous) ? previous : {};
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(next)) result[key] = restoreSecrets(oldRecord[key], value);
		return result;
	}
	return next;
}

/** True when the value is JSON-serializable, cycle-free, and free of pollution keys. */
export function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		const ok = value.every((item) => isJsonValue(item, seen));
		seen.delete(value);
		return ok;
	}
	if (isJsonObject(value)) {
		if (seen.has(value)) return false;
		seen.add(value);
		const ok = Object.entries(value).every(([key, item]) => !FORBIDDEN_KEYS.has(key) && isJsonValue(item, seen));
		seen.delete(value);
		return ok;
	}
	return false;
}

function assertSafePath(path: readonly string[]): void {
	if (path.length === 0) throw new Error("AutoRAG config path must not be empty");
	if (path.some((segment) => typeof segment !== "string" || !SAFE_PATH_SEGMENT.test(segment))) {
		throw new Error(`Invalid AutoRAG config path: ${path.join(".")}`);
	}
	if (FORBIDDEN_ROOTS[path[0] as string] === true) {
		throw new Error(`AutoRAG config path "${path[0]}" is managed by AutoRAG and cannot be edited here`);
	}
}

function setAt(root: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let current: Record<string, unknown> = root;
	for (const segment of path.slice(0, -1)) {
		const child: unknown = current[segment];
		// A disabled section (`false`) becomes an object that stays disabled, so
		// editing one leaf never silently re-enables the whole section.
		if (child === false) current[segment] = { enabled: false };
		else if (!isJsonObject(child)) current[segment] = {};
		current = current[segment] as Record<string, unknown>;
	}
	current[path[path.length - 1] as string] = value;
}

function deleteAt(root: Record<string, unknown>, path: readonly string[]): void {
	let current: Record<string, unknown> = root;
	for (const segment of path.slice(0, -1)) {
		const child: unknown = current[segment];
		if (!isJsonObject(child)) return;
		current = child;
	}
	delete current[path[path.length - 1] as string];
}

type ConnectorFieldKind = "string" | "number" | "boolean" | "semantic" | "mcpExposure" | "stringList" | "env" | "feeds" | "kordocOcr";

/**
 * Connector option kinds the Settings datasource forms expose, keyed by the
 * field path relative to `datasources.<id>.connector`. Only these fields are
 * type-checked; every other connector option stays untouched because the
 * connector surface is trusted/CLI-owned and validating by bare field name on
 * unrelated nested objects would reject valid vendor data.
 */
const CONNECTOR_FIELD_KINDS: Readonly<Record<string, ConnectorFieldKind>> = {
	binaryPath: "string",
	databasePath: "string",
	sourcePath: "string",
	configPath: "string",
	syncSource: "string",
	workspace: "string",
	workspacePath: "string",
	root: "string",
	source: "string",
	configDir: "string",
	path: "string",
	account: "string",
	mailbox: "string",
	dataDir: "string",
	backend: "string",
	fixture: "string",
	himalayaConfig: "string",
	vaultPath: "string",
	provider: "string",
	remote: "string",
	exportFormats: "string",
	bandwidthLimit: "string",
	onlyIn: "string",
	guildId: "string",
	embeddingProvider: "string",
	embeddingModel: "string",
	defaultMode: "string",
	vdrBackend: "string",
	embedderBaseUrl: "string",
	baseUrl: "string",
	tokenEnv: "string",
	statePath: "string",
	command: "string",
	exposure: "mcpExposure",
	timeoutMs: "number",
	indexTimeoutMs: "number",
	maxBufferBytes: "number",
	embedLimit: "number",
	maxPages: "number",
	maxDocuments: "number",
	maxGists: "number",
	maxItemsPerFeed: "number",
	maxContentChars: "number",
	maxBytesPerFile: "number",
	maxResultsPerQuery: "number",
	concurrency: "number",
	syncVisual: "boolean",
	dryRun: "boolean",
	ghCliFallback: "boolean",
	semantic: "semantic",
	requireWriteConfirmation: "boolean",
	repos: "stringList",
	extensions: "stringList",
	include: "stringList",
	exclude: "stringList",
	queries: "stringList",
	paths: "stringList",
	args: "stringList",
	feeds: "feeds",
	env: "env",
};

function assertConnectorField(label: string, kind: ConnectorFieldKind, value: unknown, fail: (message: string) => never): void {
	switch (kind) {
		case "string":
			if (typeof value !== "string") fail(`${label} must be a string`);
			break;
		case "number":
			if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} must be a number`);
			break;
		case "boolean":
			if (typeof value !== "boolean") fail(`${label} must be a boolean`);
			break;
		case "semantic":
			if (
				typeof value !== "boolean" &&
				(!isJsonObject(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean"))
			) {
				fail(`${label} must be a boolean`);
			}
			break;
		case "mcpExposure":
			if (typeof value !== "string" || !(CALENDAR_MCP_EXPOSURES as readonly string[]).includes(value)) {
				fail(`${label} must be one of: ${CALENDAR_MCP_EXPOSURES.join(", ")}`);
			}
			break;
		case "stringList":
			if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
				fail(`${label} must be a non-empty string array`);
			}
			break;
		case "env":
			if (!isJsonObject(value) || Object.values(value).some((item) => typeof item !== "string")) {
				fail(`${label} must be an object of string values`);
			}
			break;
		case "feeds":
			if (
				!Array.isArray(value) ||
				value.some(
					(feed) =>
						!isJsonObject(feed) ||
						typeof feed.url !== "string" ||
						(feed.category !== undefined && typeof feed.category !== "string"),
				)
			) {
				fail(`${label} must be an array of { url, category? } entries`);
			}
			break;
		case "kordocOcr":
			if (typeof value !== "boolean" && typeof value !== "string") fail(`${label} must be a boolean or a provider name`);
			break;
	}
}

/** Type-check the connector fields the datasource forms render, including the Cloud Drive parser block. */
function assertConnectorOptions(id: string, connector: Record<string, unknown>, fail: (message: string) => never): void {
	const root = `datasources.${id}.connector`;
	for (const [key, value] of Object.entries(connector)) {
		const kind = CONNECTOR_FIELD_KINDS[key];
		if (kind !== undefined) assertConnectorField(`${root}.${key}`, kind, value, fail);
	}
	const parserOptions = connector.parserOptions;
	if (parserOptions === undefined) return;
	if (!isJsonObject(parserOptions)) return fail(`${root}.parserOptions must be an object`);
	if (parserOptions.languages !== undefined) assertConnectorField(`${root}.parserOptions.languages`, "stringList", parserOptions.languages, fail);
	const ocr = parserOptions.ocr;
	if (ocr !== undefined) {
		if (!isJsonObject(ocr)) fail(`${root}.parserOptions.ocr must be an object`);
		if (ocr.enabled !== undefined) assertConnectorField(`${root}.parserOptions.ocr.enabled`, "boolean", ocr.enabled, fail);
		if (ocr.languages !== undefined) assertConnectorField(`${root}.parserOptions.ocr.languages`, "stringList", ocr.languages, fail);
		if (ocr.timeoutMs !== undefined) assertConnectorField(`${root}.parserOptions.ocr.timeoutMs`, "number", ocr.timeoutMs, fail);
		if (ocr.maxBytes !== undefined) assertConnectorField(`${root}.parserOptions.ocr.maxBytes`, "number", ocr.maxBytes, fail);
	}
	const kordoc = parserOptions.kordoc;
	if (kordoc !== undefined) {
		if (!isJsonObject(kordoc)) fail(`${root}.parserOptions.kordoc must be an object`);
		if (kordoc.ocr !== undefined) assertConnectorField(`${root}.parserOptions.kordoc.ocr`, "kordocOcr", kordoc.ocr, fail);
	}
}

function checkKnownBlock(path: string, value: unknown): void {
	if (value === undefined) return;
	const fail = (message: string): never => {
		throw new Error(`AutoRAG config ${message}`);
	};
	if (path === "jikji") {
		if (value === false) return;
		if (!isJsonObject(value)) return fail("jikji must be an object or false");
		if (value.binaryPath !== undefined && typeof value.binaryPath !== "string") fail("jikji.binaryPath must be a string");
		for (const key of ["autoInstall", "includeHidden", "includeSensitive", "writeAgentRules"] as const) {
			if (value[key] !== undefined && typeof value[key] !== "boolean") fail(`jikji.${key} must be a boolean`);
		}
		// JikjiOptions types these as plain `number` with no positivity guard;
		// zero is a valid "no cap"/"disable" value (e.g. maxFiles is only
		// forwarded when `> 0`). Reject only non-integer/negative values so a
		// real limit of 0 is not mistaken for a malformed field.
		for (const key of [
			"timeoutMs",
			"maxBufferBytes",
			"parseTimeout",
			"maxFiles",
			"maxHashBytes",
			"docTextMaxChars",
			"docTextChunkChars",
		] as const) {
			const size = value[key];
			if (size !== undefined && !(typeof size === "number" && Number.isInteger(size) && size >= 0)) {
				fail(`jikji.${key} must be a non-negative integer`);
			}
		}
		if (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.some((p) => typeof p !== "string" || p.length === 0))) {
			fail("jikji.exclude must be a non-empty string array");
		}
		return;
	}
	if (path === "parserOptions") {
		// Upstream types `parserOptions` as an object and silently ignores a
		// `false` marker, so accepting it here would imply support that does not
		// exist. Clear the block with `remove` instead.
		if (!isJsonObject(value)) return fail("parserOptions must be an object");
		if (value.languages !== undefined && (!Array.isArray(value.languages) || value.languages.some((tag) => typeof tag !== "string"))) {
			fail("parserOptions.languages must be a string array");
		}
		if (value.ocr !== undefined) {
			const ocrValue: unknown = value.ocr;
			if (!isJsonObject(ocrValue)) return fail("parserOptions.ocr must be an object");
			if (ocrValue.enabled !== undefined && typeof ocrValue.enabled !== "boolean") fail("parserOptions.ocr.enabled must be a boolean");
			const ocrTimeout = ocrValue.timeoutMs;
			if (ocrTimeout !== undefined && !(typeof ocrTimeout === "number" && Number.isInteger(ocrTimeout) && ocrTimeout > 0)) {
				fail("parserOptions.ocr.timeoutMs must be a positive integer");
			}
		}
		if (value.kordoc !== undefined && !isJsonObject(value.kordoc)) fail("parserOptions.kordoc must be an object");
		return;
	}
	if (path === "appIndexing") {
		if (!isJsonObject(value)) return fail("appIndexing must be an object");
		if (value.excludeCodeFolders !== undefined && typeof value.excludeCodeFolders !== "boolean") {
			fail("appIndexing.excludeCodeFolders must be a boolean");
		}
		if (value.semanticSearch !== undefined && typeof value.semanticSearch !== "boolean") {
			fail("appIndexing.semanticSearch must be a boolean");
		}
		if (
			value.refreshIntervalMs !== undefined &&
			!(typeof value.refreshIntervalMs === "number" && Number.isInteger(value.refreshIntervalMs) && value.refreshIntervalMs >= 0)
		) {
			fail("appIndexing.refreshIntervalMs must be a non-negative integer");
		}
		if (
			value.fileTimeoutMs !== undefined &&
			!(typeof value.fileTimeoutMs === "number" && Number.isInteger(value.fileTimeoutMs) && value.fileTimeoutMs > 0)
		) {
			fail("appIndexing.fileTimeoutMs must be a positive integer");
		}
		if (
			value.codeFolderNames !== undefined &&
			(!Array.isArray(value.codeFolderNames) || value.codeFolderNames.some((name) => typeof name !== "string" || name.length === 0))
		) {
			fail("appIndexing.codeFolderNames must be a non-empty string array");
		}
		return;
	}
	if (path === "everything" || path === "fsearch") {
		if (value === false) return;
		if (!isJsonObject(value)) return fail(`${path} must be an object or false`);
		if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail(`${path}.enabled must be a boolean`);
		for (const key of ["timeoutMs", "startupTimeoutMs", "indexTimeoutMs"] as const) {
			const timeout = value[key];
			if (timeout !== undefined && !(typeof timeout === "number" && Number.isInteger(timeout) && timeout > 0)) fail(`${path}.${key} must be a positive integer`);
		}
		if (path === "fsearch") {
			if (value.binaryPath !== undefined && typeof value.binaryPath !== "string") fail("fsearch.binaryPath must be a string");
			if (value.watch !== undefined && typeof value.watch !== "boolean") fail("fsearch.watch must be a boolean");
		}
		return;
	}
	if (path === "dupey") {
		if (value === false) return;
		if (!isJsonObject(value)) return fail("dupey must be an object or false");
		if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail("dupey.enabled must be a boolean");
		if (value.binaryPath !== undefined && typeof value.binaryPath !== "string") fail("dupey.binaryPath must be a string");
		if (value.timeoutMs !== undefined && !(typeof value.timeoutMs === "number" && Number.isInteger(value.timeoutMs) && value.timeoutMs > 0)) fail("dupey.timeoutMs must be a positive integer");
		return;
	}
	if (path === "thinking") {
		// App-owned extension key: upstream config ignores `thinking`, so the app
		// validates it and hands it to the agent's per-phase options.
		if (!isJsonObject(value)) return fail("thinking must be an object");
		const levels: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const key of Object.keys(value)) {
			if (key !== "fast" && key !== "final") fail(`thinking.${key} is not a recognized field`);
			const level = value[key];
			if (typeof level !== "string" || !levels.includes(level)) fail(`thinking.${key} must be one of: ${levels.join(", ")}`);
		}
		return;
	}
	if (path === "minSync") {
		if (value === false) return fail("MinSync is required and cannot be disabled");
		if (!isJsonObject(value)) return fail("minSync must be an object");
		if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail("minSync.enabled must be a boolean");
		if (value.enabled === false) fail("MinSync is required and cannot be disabled");
		if (value.workspacePath !== undefined && typeof value.workspacePath !== "string") fail("minSync.workspacePath must be a string");
		if (value.binaryPath !== undefined && typeof value.binaryPath !== "string") fail("minSync.binaryPath must be a string");
		if (value.autoInstall !== undefined && typeof value.autoInstall !== "boolean") fail("minSync.autoInstall must be a boolean");
		if (value.maxChunkSize !== undefined && !(typeof value.maxChunkSize === "number" && Number.isInteger(value.maxChunkSize) && value.maxChunkSize > 0)) {
			fail("minSync.maxChunkSize must be a positive integer");
		}
		if (value.embedder !== undefined) {
			const embedder = value.embedder;
			if (!isJsonObject(embedder)) return fail("minSync.embedder must be an object");
			if (embedder.profile !== undefined) fail("minSync.embedder.profile was removed; use id (native:Qwen/Qwen3-Embedding-0.6B)");
			for (const key of ["id", "baseUrl"] as const) {
				if (embedder[key] !== undefined && !(typeof embedder[key] === "string" && (embedder[key] as string).length > 0)) {
					fail(`minSync.embedder.${key} must be a non-empty string`);
				}
			}
			if (embedder.apiKeyEnv !== undefined && !(typeof embedder.apiKeyEnv === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(embedder.apiKeyEnv))) {
				fail("minSync.embedder.apiKeyEnv must be a valid environment variable name");
			}
			for (const key of ["queryPrefix", "passagePrefix"] as const) {
				if (embedder[key] !== undefined && typeof embedder[key] !== "string") fail(`minSync.embedder.${key} must be a string`);
			}
			if (embedder.dimension !== undefined && !(typeof embedder.dimension === "number" && Number.isInteger(embedder.dimension) && embedder.dimension > 0)) {
				fail("minSync.embedder.dimension must be a positive integer");
			}
			for (const key of ["timeoutMs", "batchSize", "maxRetries", "maxConcurrent"] as const) {
				if (embedder[key] !== undefined && !(typeof embedder[key] === "number" && Number.isInteger(embedder[key]) && embedder[key] > 0)) {
					fail(`minSync.embedder.${key} must be a positive integer`);
				}
			}
		}
		return;
	}
	if (path === "datasources") {
		if (!isJsonObject(value)) return fail("datasources must be an object");
		for (const [id, entry] of Object.entries(value)) {
			if (typeof entry === "boolean") continue;
			if (!isJsonObject(entry)) return fail(`datasources.${id} must be an object or boolean`);
			if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") fail(`datasources.${id}.enabled must be a boolean`);
			if (entry.type !== undefined && typeof entry.type !== "string") fail(`datasources.${id}.type must be a string`);
			if (entry.description !== undefined && typeof entry.description !== "string") fail(`datasources.${id}.description must be a string`);
			if (entry.instanceId !== undefined && typeof entry.instanceId !== "string") fail(`datasources.${id}.instanceId must be a string`);
			// 0 is a valid "manual refresh only" interval (the librarian maps it to
			// `polling().mode = "none"`); only negatives and non-integers are invalid.
			if (entry.pollingIntervalMs !== undefined && !(typeof entry.pollingIntervalMs === "number" && Number.isInteger(entry.pollingIntervalMs) && entry.pollingIntervalMs >= 0)) {
				fail(`datasources.${id}.pollingIntervalMs must be a non-negative integer`);
			}
			if (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string" || tag.length === 0))) {
				fail(`datasources.${id}.tags must be a non-empty string array`);
			}
			if (entry.channels !== undefined) {
				const channels: unknown = entry.channels;
				if (!isJsonObject(channels)) return fail(`datasources.${id}.channels must be an object`);
				for (const key of ["ids", "names"] as const) {
					const list = channels[key];
					if (list !== undefined && (!Array.isArray(list) || list.some((item) => typeof item !== "string" || item.length === 0))) {
						fail(`datasources.${id}.channels.${key} must be a non-empty string array`);
					}
				}
			}
			if (entry.connector !== undefined && !isJsonObject(entry.connector)) fail(`datasources.${id}.connector must be an object`);
			if (isJsonObject(entry.connector)) assertConnectorOptions(id, entry.connector, fail);
			const template = typeof entry.type === "string" && entry.type.length > 0 ? entry.type : id;
			if (template === "hister" && isJsonObject(entry.connector) && entry.connector.baseUrl !== undefined) {
				const rawUrl = String(entry.connector.baseUrl).trim();
				let parsedUrl: URL;
				try {
					parsedUrl = new URL(rawUrl);
				} catch {
					return fail(`datasources.${id}.connector.baseUrl must be a valid http(s) URL`);
				}
				if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
					fail(`datasources.${id}.connector.baseUrl must be a valid http(s) URL`);
				}
				const tokenEnv = entry.connector.tokenEnv;
				if (
					typeof tokenEnv === "string" &&
					tokenEnv.trim().length > 0 &&
					parsedUrl.protocol === "http:" &&
					LOOPBACK_HOSTS[parsedUrl.hostname.toLowerCase()] !== true
				) {
					fail(`datasources.${id}.connector.baseUrl must use https when tokenEnv is set and host is not loopback`);
				}
			}
		}
	}
}

/** Known config blocks librarian validates only shallowly, if at all. */
function validateKnownBlocks(candidate: Record<string, unknown>): void {
	for (const block of [
		"jikji",
		"parserOptions",
		"everything",
		"fsearch",
		"dupey",
		"minSync",
		"thinking",
		"datasources",
		"appIndexing",
	] as const) {
		checkKnownBlock(block, candidate[block]);
	}
}

/** Reject plaintext secrets in config writes; secrets live only in the credentials store. */
function assertNoNewPlaintextSecrets(value: unknown, key?: string): void {
	if (key !== undefined && isSecretKey(key) && typeof value === "string" && value.length > 0 && value !== REDACTED_SECRET) {
		throw new Error(`AutoRAG config field "${key}" holds a secret; store it through the credentials API instead`);
	}
	if (Array.isArray(value)) {
		for (const item of value) assertNoNewPlaintextSecrets(item);
		return;
	}
	if (isJsonObject(value)) {
		for (const [childKey, childValue] of Object.entries(value)) assertNoNewPlaintextSecrets(childValue, childKey);
	}
}

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };
const DAZZI_HOSTS: Record<string, true> = { "api.dazziapp.com": true };

/** Reject corpus embedding endpoints that are malformed, non-http, or off-device. */
function assertLoopback(
	value: string,
	label: string,
	options: { readonly allowDazzi?: boolean; readonly allowedHost?: string | undefined; readonly allowRemote?: boolean } = {},
): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`AutoRAG config ${label} must be a valid ${options.allowRemote === true ? "http(s)" : "loopback"} URL`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`AutoRAG config ${label} must use http or https`);
	}
	const host = url.hostname.toLowerCase();
	if (LOOPBACK_HOSTS[host] === true) return;
	if (options.allowRemote === true) return;
	if (options.allowDazzi === true && (DAZZI_HOSTS[host] === true || (options.allowedHost !== undefined && host === options.allowedHost))) return;
	throw new Error(`AutoRAG config ${label} must point at loopback (corpus never leaves this device)`);
}

/**
 * Corpus embedding endpoints must stay on-device, with two exceptions the user chooses in Settings: the Dazzi
 * cloud, and a server of their own. A remote server of their own must authenticate (`apiKeyEnv`, the name of the
 * variable that holds its key), so an unauthenticated address typed into the config cannot receive the corpus
 * by accident. Datasource connector URLs for embedding stay on-device.
 */
function assertNoRemoteEgress(candidate: Record<string, unknown>, env?: NodeJS.ProcessEnv): void {
	const minSync = isJsonObject(candidate.minSync) ? candidate.minSync : undefined;
	const embedder = minSync !== undefined && isJsonObject(minSync.embedder) ? minSync.embedder : undefined;
	if (embedder !== undefined && typeof embedder.baseUrl === "string") {
		let allowedHost: string | undefined;
		const configuredBase = env?.AUTORAG_BASE_URL?.trim();
		if (configuredBase !== undefined && configuredBase.length > 0) {
			try {
				const configuredUrl = new URL(configuredBase);
				if (configuredUrl.protocol === "http:" || configuredUrl.protocol === "https:") {
					allowedHost = configuredUrl.hostname.toLowerCase();
				}
			} catch {
				// Fall through to assertLoopback validation.
			}
		}
		const remoteWithKey = typeof embedder.apiKeyEnv === "string" && embedder.apiKeyEnv.length > 0;
		try {
			assertLoopback(embedder.baseUrl, "minSync.embedder.baseUrl", { allowDazzi: true, allowedHost, allowRemote: remoteWithKey });
		} catch (error) {
			// Say what a remote server needs, not only that it was refused.
			if (error instanceof Error && /loopback/u.test(error.message) && !remoteWithKey) {
				throw new Error(`${error.message}; a server off this computer must set minSync.embedder.apiKeyEnv`);
			}
			throw error;
		}
	}
	const datasources = isJsonObject(candidate.datasources) ? candidate.datasources : undefined;
	if (datasources === undefined) return;
	for (const [id, entry] of Object.entries(datasources)) {
		if (!isJsonObject(entry) || !isJsonObject(entry.connector)) continue;
		const connector = entry.connector;
		for (const [key, target] of Object.entries(connector)) {
			if (typeof target !== "string") continue;
			// Only corpus embedding/rerank endpoints must stay on-device. A
			// connector's normal remote API URL (GitHub REST, RSS feed hosts, the
			// Lark API itself) is not restricted here.
			const embeddingUrl = /(?:embedding|embedder|embed|rerank)/iu.test(key) && /(?:url|endpoint|server)/iu.test(key);
			if (embeddingUrl) assertLoopback(target, `datasources.${id}.connector.${key}`);
		}
	}
}

/** Validate the candidate exactly as the agent and AutoRAGLite will resolve it. */
async function validateCandidate(path: string, candidate: Record<string, unknown>, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		validateKnownBlocks(candidate);
		assertNoRemoteEgress(candidate, env);
		const resolved = resolveConfigReadOnly({ flags: { config: temporary }, env, cwd });
		// Drop `datasources` before buildAgentOptions: building skill instances is
		// side-effecting and its shape is the app's to validate (above).
		const { datasources: _datasources, ...withoutDatasources } = resolved;
		const effective =
			candidate.webSearch === undefined
				? withoutDatasources
				: { ...withoutDatasources, webSearch: candidate.webSearch as NonNullable<CliConfig["webSearch"]> };
		buildAgentOptions(effective as CliConfig);
	} finally {
		await rm(temporary, { force: true });
	}
}

export interface AutoRagConfigService {
	get(): Promise<AutoRagConfigSnapshot>;
	set(path: readonly string[], value: JsonValue): Promise<AutoRagConfigSnapshot>;
	remove(path: readonly string[]): Promise<AutoRagConfigSnapshot>;
	/** Apply many leaf sets/removals in one validate+write; all-or-nothing. */
	patch(updates: readonly AutoRagConfigUpdate[]): Promise<AutoRagConfigSnapshot>;
	/** Move the value at `from` to `to` in one write. */
	rename(from: readonly string[], to: readonly string[]): Promise<AutoRagConfigSnapshot>;
	modelsCatalog(): Promise<ModelCatalogSnapshot>;
}

export interface AutoRagConfigServiceDeps {
	readonly env: NodeJS.ProcessEnv;
	readonly cwd: string;
	/** The host OS; only Calendar's macOS-only MCP sync reads it. Defaults to this process. */
	readonly platform?: NodeJS.Platform;
}

export function createAutoRagConfigService(deps: AutoRagConfigServiceDeps): AutoRagConfigService {
	const currentPath = (): string => resolveConfigPath({ flags: {}, env: deps.env, cwd: deps.cwd }).configPath;

	async function snapshot(): Promise<AutoRagConfigSnapshot> {
		const path = currentPath();
		if (!(await access(path).then(() => true, () => false))) return { configPath: path, configExists: false, error: null, config: {} };
		let raw: Record<string, unknown>;
		try {
			raw = readRawConfigObject(path);
		} catch (error) {
			return { configPath: path, configExists: true, error: error instanceof Error ? error.message : String(error), config: {} };
		}
		const config = redact(raw) as JsonObject;
		try {
			resolveConfigReadOnly({ flags: {}, env: deps.env, cwd: deps.cwd });
			return { configPath: path, configExists: true, error: null, config };
		} catch (error) {
			return { configPath: path, configExists: true, error: error instanceof Error ? error.message : String(error), config };
		}
	}

	let writeQueue: Promise<void> = Promise.resolve();

	async function commitCandidate(
		apply: (candidate: Record<string, unknown>, previous: Record<string, unknown>) => void,
	): Promise<AutoRagConfigSnapshot> {
		const path = currentPath();
		const previous: Record<string, unknown> = (await access(path).then(() => true, () => false)) ? readRawConfigObject(path) : {};
		const candidate = structuredClone(previous);
		apply(candidate, previous);
		// Validation runs before the write: a rejected edit never touches disk.
		await validateCandidate(path, candidate, deps.env, deps.cwd);
		writeConfigObject(path, candidate);
		syncCalendarMcpConfig(candidate, previous, deps.env.PI_CODING_AGENT_DIR ?? getAgentDir(), deps.platform);
		return snapshot();
	}

	function commit(
		apply: (candidate: Record<string, unknown>, previous: Record<string, unknown>) => void,
	): Promise<AutoRagConfigSnapshot> {
		const run = writeQueue.then(() => commitCandidate(apply), () => commitCandidate(apply));
		writeQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	function readAt(root: Record<string, unknown>, path: readonly string[]): unknown {
		return path.reduce<unknown>((current, segment) => (isJsonObject(current) ? current[segment] : undefined), root);
	}

	function writeLeaf(
		candidate: Record<string, unknown>,
		previous: Record<string, unknown>,
		path: readonly string[],
		value: JsonValue,
	): void {
		assertSafePath(path);
		if (!isJsonValue(value)) throw new Error("AutoRAG config value must be JSON");
		// A plaintext secret must never reach the config file; only the sentinel
		// (unchanged secret) is permitted.
		assertNoNewPlaintextSecrets(value, path[path.length - 1]);
		setAt(candidate, path, restoreSecrets(readAt(previous, path), value));
	}

	return {
		get: snapshot,
		set: (path, value) => commit((candidate, previous) => writeLeaf(candidate, previous, path, value)),
		remove: (path) =>
			commit((candidate) => {
				assertSafePath(path);
				deleteAt(candidate, path);
			}),
		patch: (updates) =>
			commit((candidate, previous) => {
				for (const update of updates) {
					if ("remove" in update) {
						assertSafePath(update.path);
						deleteAt(candidate, update.path);
					} else {
						writeLeaf(candidate, previous, update.path, update.value);
					}
				}
			}),
		rename: (from, to) =>
			commit((candidate) => {
				assertSafePath(from);
				assertSafePath(to);
				if (from.length === to.length && from.every((segment, index) => segment === to[index])) {
					throw new Error("AutoRAG config rename source and destination are the same path");
				}
				if (to.length > from.length && from.every((segment, index) => segment === to[index])) {
					throw new Error(`AutoRAG config cannot move ${from.join(".")} into its own descendant`);
				}
				if (readAt(candidate, to) !== undefined) {
					throw new Error(`AutoRAG config destination ${to.join(".")} already exists`);
				}
				const value = readAt(candidate, from);
				if (value === undefined) throw new Error(`AutoRAG config value not found at ${from.join(".")}`);
				deleteAt(candidate, from);
				setAt(candidate, to, value);
			}),
		modelsCatalog: async () => {
			try {
				const agentDir = getAgentDir();
				const runtime = await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					allowModelNetwork: false,
				});
				await registerDazziProvider(runtime, deps.env);
				const available = new Set<string>();
				try {
					for (const model of await runtime.getAvailable()) available.add(`${model.provider}/${model.id}`);
				} catch {
					// Availability is best-effort; the catalog still lists models.
				}
				const providers: ModelCatalogProvider[] = runtime.getProviders().map((provider) => {
					let authConfigured = false;
					try {
						authConfigured = runtime.hasConfiguredAuth(provider.id);
					} catch {
						authConfigured = false;
					}
					// Pi's canonical env lookup handles aliases (azure, google, …)
					// the way the model runtime itself resolves credentials.
					const envKeys = findEnvKeys(provider.id);
					const models: ModelCatalogEntry[] = runtime.getModels(provider.id).map((model) => ({
						provider: model.provider,
						id: model.id,
						name: model.name,
						api: model.api,
						available: available.has(`${model.provider}/${model.id}`),
						baseUrl: model.baseUrl ?? provider.baseUrl ?? null,
						apiKeyEnv: envKeys?.[0] ?? null,
					}));
					return {
						id: provider.id,
						name: provider.name,
						baseUrl: provider.baseUrl ?? null,
						authConfigured,
						apiKeyEnv: envKeys?.[0] ?? null,
						models,
					};
				});
				return { error: null, providers: autoragFirst(providers) };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error), providers: [] };
			}
		},
	};
}
