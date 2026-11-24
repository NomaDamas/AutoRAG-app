/**
 * The public MCP registry (https://registry.modelcontextprotocol.io), read so the Connections assistant can find a server
 * and offer to install it.
 *
 * Registry text is untrusted DATA: it is fetched, trimmed and handed to the model in a `data`-shaped list — never executed
 * and never used as an instruction. Only two transports are advertised as installable: a `streamable-http` remote and an
 * `npm`/`pypi` package that runs over stdio (`npx -y <id>@<version>` / `uvx <id>==<version>`). Everything else is listed
 * with `installable: false` and why, so the model can tell the person it cannot be installed here.
 */

import { isJsonObject } from "../shared/settings-contract";
import { isSecretKey } from "./autorag-config-service";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_REGISTRY_LIMIT = 8;
const MAX_REGISTRY_LIMIT = 20;
const MAX_DESCRIPTION = 200;
const REMOTE_KIND = "streamable-http";
const STDIO_TRANSPORT = "stdio";
const PACKAGE_REGISTRIES: readonly string[] = ["npm", "pypi"];

export type McpRegistryKind = "remote" | "npm" | "pypi";

/** A variable the person must supply for one install option: an environment variable (npm/pypi) or a header (remote). */
export interface McpRegistryVariable {
	readonly name: string;
	/** True when the registry marks it as a credential (or its name looks like one and it is required). */
	readonly secret: boolean;
	readonly required: boolean;
	readonly description: string;
}

/** One header of a remote, with the registry's value template (e.g. `Bearer {api_key}`) when it has one. */
export interface McpRegistryHeader extends McpRegistryVariable {
	readonly template: string | null;
}

/** One install option of a server, with everything needed to build an `mcp.json` entry. */
export interface McpRegistryCandidate {
	readonly index: number;
	readonly kind: McpRegistryKind;
	readonly url: string | null;
	readonly identifier: string | null;
	readonly version: string | null;
	readonly description: string;
	readonly env: readonly McpRegistryVariable[];
	readonly headers: readonly McpRegistryHeader[];
	/** Names of the credentials the person must type into the masked field. */
	readonly secrets: readonly string[];
	/** Names of the non-secret values the person/model must supply another way. */
	readonly needs: readonly string[];
}

/** A server as handed to the model: short, deduped by name (newest version), and never larger than the registry allows. */
export interface McpRegistryEntry {
	readonly id: string;
	readonly description: string;
	readonly version: string;
	readonly repository: string | null;
	readonly installable: boolean;
	readonly reason?: string;
	readonly install: readonly {
		readonly index: number;
		readonly kind: McpRegistryKind;
		readonly location: string;
		readonly secrets: readonly string[];
		readonly needs: readonly string[];
	}[];
}

/** A server with every install option, used by the install tool to build the entry (and never trusting model-supplied data). */
export interface McpRegistryServer {
	readonly id: string;
	readonly description: string;
	readonly version: string;
	readonly repository: string | null;
	readonly installable: boolean;
	readonly reason?: string;
	readonly candidates: readonly McpRegistryCandidate[];
}

export type McpRegistrySearchResult =
	| { readonly ok: true; readonly servers: readonly McpRegistryEntry[] }
	| { readonly ok: false; readonly error: string };

export interface McpRegistryOptions {
	/** Injectable for tests; defaults to the platform `fetch`. */
	readonly fetch?: typeof globalThis.fetch;
	readonly signal?: AbortSignal;
}

interface ServerShape {
	readonly id: string;
	readonly description: string;
	readonly version: string;
	readonly repository: string | null;
	readonly remotes: readonly Record<string, unknown>[];
	readonly packages: readonly Record<string, unknown>[];
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Registry prose goes to a model: strip control characters and keep it short. */
function cleanText(value: unknown): string {
	const stripped = text(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
	return stripped.length > MAX_DESCRIPTION ? `${stripped.slice(0, MAX_DESCRIPTION - 1)}…` : stripped;
}

function variableOf(raw: unknown): McpRegistryVariable | null {
	if (!isJsonObject(raw)) return null;
	const name = text(raw.name).trim();
	if (name.length === 0) return null;
	const required = raw.isRequired === true;
	const secret = raw.isSecret === true || (required && isSecretKey(name));
	return { name, secret, required, description: cleanText(raw.description) };
}

function headerOf(raw: unknown): McpRegistryHeader | null {
	const variable = variableOf(raw);
	if (variable === null) return null;
	const template = isJsonObject(raw) && typeof raw.value === "string" && raw.value.trim().length > 0 ? raw.value : null;
	return { ...variable, template };
}

/** Names the person must type into the masked field, and names that must come as plain values. */
function splitVariables(variables: readonly McpRegistryVariable[]): { readonly secrets: string[]; readonly needs: string[] } {
	return {
		secrets: variables.filter((entry) => entry.secret).map((entry) => entry.name),
		needs: variables.filter((entry) => !entry.secret && entry.required).map((entry) => entry.name),
	};
}

function remoteCandidate(index: number, remote: Record<string, unknown>): McpRegistryCandidate | null {
	const url = text(remote.url).trim();
	if (remote.type !== REMOTE_KIND || url.length === 0) return null;
	const headers = (Array.isArray(remote.headers) ? remote.headers : []).map(headerOf).filter((entry): entry is McpRegistryHeader => entry !== null);
	const { secrets, needs } = splitVariables(headers);
	return { index, kind: "remote", url, identifier: null, version: null, description: "", env: [], headers, secrets, needs };
}

function packageCandidate(index: number, pkg: Record<string, unknown>): McpRegistryCandidate | null {
	const registryType = text(pkg.registryType);
	const identifier = text(pkg.identifier).trim();
	const version = text(pkg.version).trim();
	const transport = isJsonObject(pkg.transport) ? text(pkg.transport.type) : "";
	if (!PACKAGE_REGISTRIES.includes(registryType) || transport !== STDIO_TRANSPORT || identifier.length === 0) return null;
	const env = (Array.isArray(pkg.environmentVariables) ? pkg.environmentVariables : []).map(variableOf).filter((entry): entry is McpRegistryVariable => entry !== null);
	const { secrets, needs } = splitVariables(env);
	return {
		index,
		kind: registryType === "npm" ? "npm" : "pypi",
		url: null,
		identifier,
		version: version.length > 0 ? version : null,
		description: "",
		env,
		headers: [],
		secrets,
		needs,
	};
}

/** Every offered transport of a server that this app cannot install, named so the model can explain it. */
function offeredOf(server: ServerShape): string[] {
	const offered: string[] = [];
	for (const remote of server.remotes) offered.push(`${text(remote.type) || "unknown"} remote`);
	for (const pkg of server.packages) {
		const transport = isJsonObject(pkg.transport) ? text(pkg.transport.type) : "unknown";
		offered.push(`${text(pkg.registryType) || "unknown"} package (${transport || "unknown"} transport)`);
	}
	return offered;
}

function reasonFor(server: ServerShape): string {
	const offered = offeredOf(server);
	const found = offered.length > 0 ? offered.join(", ") : "no transport information";
	return `Not installable here: offers ${found}; this app installs '${REMOTE_KIND}' remotes and npm/pypi packages that run over stdio.`;
}

/** Build every install option of one registry entry, in registry order, with installable ones keeping their index. */
function candidatesOf(server: ServerShape): readonly McpRegistryCandidate[] {
	const candidates: McpRegistryCandidate[] = [];
	for (const remote of server.remotes) {
		const candidate = remoteCandidate(candidates.length, remote);
		if (candidate !== null) candidates.push(candidate);
	}
	for (const pkg of server.packages) {
		const candidate = packageCandidate(candidates.length, pkg);
		if (candidate !== null) candidates.push(candidate);
	}
	return candidates;
}

function parseServer(raw: Record<string, unknown>): ServerShape | null {
	const id = text(raw.name).trim();
	if (id.length === 0) return null;
	const repository = isJsonObject(raw.repository) ? text(raw.repository.url).trim() : "";
	return {
		id,
		description: cleanText(raw.description),
		version: text(raw.version).trim(),
		repository: repository.length > 0 ? repository : null,
		remotes: (Array.isArray(raw.remotes) ? raw.remotes : []).filter(isJsonObject),
		packages: (Array.isArray(raw.packages) ? raw.packages : []).filter(isJsonObject),
	};
}

function parseServers(raw: unknown): ServerShape[] {
	if (!isJsonObject(raw) || !Array.isArray(raw.servers)) return [];
	return raw.servers
		.map((entry) => (isJsonObject(entry) && isJsonObject(entry.server) ? parseServer(entry.server) : null))
		.filter((entry): entry is ServerShape => entry !== null);
}

/** Numeric dot-version comparison; anything unparseable falls back to a plain string compare so order stays stable. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(/[.+-]/u);
	const right = b.split(/[.+-]/u);
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const l = left[index];
		const r = right[index];
		if (l === undefined) return -1;
		if (r === undefined) return 1;
		const ln = Number(l);
		const rn = Number(r);
		if (Number.isFinite(ln) && Number.isFinite(rn)) {
			if (ln !== rn) return ln - rn;
		} else if (l !== r) {
			return l < r ? -1 : 1;
		}
	}
	return 0;
}

/** Dedupe by name keeping the newest version; servers without a usable version keep the first seen. */
function newestByName(servers: readonly ServerShape[]): ServerShape[] {
	const ordered: ServerShape[] = [];
	const index = new Map<string, number>();
	for (const server of servers) {
		const at = index.get(server.id);
		if (at === undefined) {
			index.set(server.id, ordered.length);
			ordered.push(server);
			continue;
		}
		const existing = ordered[at];
		if (existing !== undefined && compareVersions(server.version, existing.version) > 0) ordered[at] = server;
	}
	return ordered;
}

function entryOf(server: ServerShape): McpRegistryEntry {
	const candidates = candidatesOf(server);
	const base = { id: server.id, description: server.description, version: server.version, repository: server.repository };
	if (candidates.length === 0) return { ...base, installable: false, reason: reasonFor(server), install: [] };
	return {
		...base,
		installable: true,
		install: candidates.map((candidate) => ({
			index: candidate.index,
			kind: candidate.kind,
			location: locationOf(candidate),
			secrets: candidate.secrets,
			needs: candidate.needs,
		})),
	};
}

function serverOf(server: ServerShape): McpRegistryServer {
	const candidates = candidatesOf(server);
	const base = { id: server.id, description: server.description, version: server.version, repository: server.repository, candidates };
	if (candidates.length === 0) return { ...base, installable: false, reason: reasonFor(server) };
	return { ...base, installable: true };
}

/** How one install option is described to the model: a URL, or `id@version` / `id==version`. */
function locationOf(candidate: McpRegistryCandidate): string {
	if (candidate.kind === "remote") return candidate.url ?? "";
	const version = candidate.version ?? "latest";
	return candidate.kind === "npm" ? `${candidate.identifier}@${version}` : `${candidate.identifier}==${version}`;
}

function clampLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return DEFAULT_REGISTRY_LIMIT;
	return Math.min(Math.floor(limit), MAX_REGISTRY_LIMIT);
}

async function fetchJson(url: string, options: McpRegistryOptions): Promise<unknown> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
	const response = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
	if (!response.ok) throw new Error(`the MCP registry responded ${response.status}`);
	return await response.json();
}

function registryUrl(query: string, limit: number): string {
	return `${REGISTRY_BASE}?${new URLSearchParams({ search: query, limit: String(limit) }).toString()}`;
}

/** Search the public registry; never throws to the model, and never asks for more than {@link MAX_REGISTRY_LIMIT} servers. */
export async function searchMcpRegistry(query: string, options: McpRegistryOptions & { readonly limit?: number } = {}): Promise<McpRegistrySearchResult> {
	const needle = query.trim();
	if (needle.length === 0) return { ok: false, error: "Give a search term, for example 'github' or 'postgres'." };
	try {
		const raw = await fetchJson(registryUrl(needle, clampLimit(options.limit)), options);
		return { ok: true, servers: newestByName(parseServers(raw)).map(entryOf) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Re-fetch one exact server by its registry name, so an install never trusts a URL, command or package the model supplied.
 * The registry is searched by name and only an exact {@link McpRegistryServer.id} match is accepted.
 */
export async function resolveMcpRegistryServer(
	id: string,
	options: McpRegistryOptions = {},
): Promise<{ readonly ok: true; readonly server: McpRegistryServer } | { readonly ok: false; readonly error: string }> {
	const name = id.trim();
	if (name.length === 0) return { ok: false, error: "Give the registry server id returned by search_mcp_registry." };
	try {
		const raw = await fetchJson(registryUrl(name, MAX_REGISTRY_LIMIT), options);
		const match = newestByName(parseServers(raw).filter((server) => server.id === name))[0];
		if (match === undefined) return { ok: false, error: `The MCP registry has no server named '${name}'. Search again with search_mcp_registry.` };
		return { ok: true, server: serverOf(match) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
