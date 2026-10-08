import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderCredentialStatus } from "../shared/settings-contract";
import { hasErrorCode } from "./fs-entry";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Provider API keys are stored once, encrypted at rest, and loaded into
 * `process.env` at startup so the librarian's LLM/embedding/reranker resolution
 * sees the same key. The plaintext value never leaves the main process.
 */

/** The slice of Electron's `safeStorage` this service needs (injected for tests). */
export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	/** Linux only: `"basic_text"` means no real keyring; the key would be recoverable. */
	getSelectedStorageBackend?(): string;
}

export interface ProviderCredentialServiceDeps {
	/** `userData/credentials.enc.json`. */
	readonly filePath: string;
	readonly safeStorage: SafeStorageLike;
	/** The live environment the agent resolves against (normally `process.env`). */
	readonly env: NodeJS.ProcessEnv;
}

export interface ProviderCredentialService {
	list(envNames?: readonly string[]): Promise<readonly ProviderCredentialStatus[]>;
	set(envName: string, secret: string): Promise<readonly ProviderCredentialStatus[]>;
	remove(envName: string): Promise<readonly ProviderCredentialStatus[]>;
	/** Apply stored values into the environment; returns the env names applied. */
	load(): Promise<readonly string[]>;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const STORE_VERSION = 1;

interface CredentialStore {
	version: number;
	entries: Record<string, string>;
}

export function createProviderCredentialService(deps: ProviderCredentialServiceDeps): ProviderCredentialService {
	/** Environment variables this instance populated, with the value they had before. */
	const originals = new Map<string, string | undefined>();
	/**
	 * Env names this instance actually populated from the encrypted store.
	 * `source: "stored"` is only truthful for these: a stored value that load()
	 * skipped (ambient env already set, insecure backend, undecryptable) is not
	 * what the agent resolves, so status must report env/none instead.
	 */
	const appliedFromStore = new Set<string>();

	/** False when the OS has no real keyring (Electron Linux `basic_text`) or encryption is off. */
	function encryptionAvailable(): boolean {
		if (!deps.safeStorage.isEncryptionAvailable()) return false;
		try {
			return deps.safeStorage.getSelectedStorageBackend?.() !== "basic_text";
		} catch {
			return true;
		}
	}

	/** A malformed store throws instead of being silently replaced (which would destroy keys). */
	async function readStore(): Promise<CredentialStore> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(deps.filePath, "utf8"));
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return { version: STORE_VERSION, entries: {} };
			throw new Error(`Credential store is unreadable; refusing to overwrite it (${String(error)})`);
		}
		if (!isJsonObject(parsed) || parsed.version !== STORE_VERSION) {
			throw new Error("Credential store version is not supported; refusing to overwrite it");
		}
		const entries = isJsonObject(parsed.entries) ? parsed.entries : undefined;
		if (entries === undefined) throw new Error("Credential store is malformed; refusing to overwrite it");
		const cleaned: Record<string, string> = {};
		for (const [envName, value] of Object.entries(entries)) {
			if (typeof value !== "string") throw new Error("Credential store has a malformed entry; refusing to overwrite it");
			cleaned[envName] = value;
		}
		return { version: STORE_VERSION, entries: cleaned };
	}

	async function writeStore(store: CredentialStore): Promise<void> {
		await mkdir(dirname(deps.filePath), { recursive: true });
		const temporary = join(dirname(deps.filePath), `.${process.pid}.${randomUUID()}.credentials.tmp`);
		await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, deps.filePath);
	}

	/** Read-modify-write runs one at a time, so two saves never drop each other's key. */
	let queue: Promise<unknown> = Promise.resolve();
	function serialized<T>(operation: () => Promise<T>): Promise<T> {
		const result = queue.then(operation, operation);
		queue = result.catch(() => undefined);
		return result;
	}

	function status(store: CredentialStore, envNames?: readonly string[]): readonly ProviderCredentialStatus[] {
		const names = [...new Set([...(envNames ?? []), ...Object.keys(store.entries)])].sort((a, b) => a.localeCompare(b));
		return names.map((envName) => {
			const stored = store.entries[envName] !== undefined;
			if (appliedFromStore.has(envName)) return { envName, stored, source: "stored" as const };
			const external = deps.env[envName];
			return {
				envName,
				stored,
				source: typeof external === "string" && external.length > 0 ? ("env" as const) : ("none" as const),
			};
		});
	}

	return {
		list: async (envNames) => status(await readStore(), envNames),
		set: (envName, secret) => {
			if (!ENV_NAME.test(envName)) return Promise.reject(new Error(`Invalid environment variable name: ${envName}`));
			if (typeof secret !== "string" || secret.length === 0) return Promise.reject(new Error("API key must not be empty"));
			if (!encryptionAvailable()) {
				return Promise.reject(new Error("OS encryption is unavailable (no secure keyring), so the API key cannot be stored securely"));
			}
			return serialized(async () => {
				const store = await readStore();
				store.entries[envName] = deps.safeStorage.encryptString(secret).toString("base64");
				await writeStore(store);
				if (!originals.has(envName)) originals.set(envName, deps.env[envName]);
				deps.env[envName] = secret;
				appliedFromStore.add(envName);
				return status(store, [envName]);
			});
		},
		remove: (envName) => {
			if (!ENV_NAME.test(envName)) return Promise.reject(new Error(`Invalid environment variable name: ${envName}`));
			return serialized(async () => {
				const store = await readStore();
				delete store.entries[envName];
				await writeStore(store);
				appliedFromStore.delete(envName);
				if (originals.has(envName)) {
					const previous = originals.get(envName);
					if (previous === undefined || previous.length === 0) delete deps.env[envName];
					else deps.env[envName] = previous;
					originals.delete(envName);
				}
				return status(store, [envName]);
			});
		},
		load: async () => {
			const store = await readStore();
			const loaded: string[] = [];
			const skipped: string[] = [];
			for (const [envName, encrypted] of Object.entries(store.entries)) {
				if (!ENV_NAME.test(envName) || !encryptionAvailable()) {
					skipped.push(envName);
					continue;
				}
				const external = deps.env[envName];
				// Never clobber an ambient environment value at startup; an explicit
				// save (set) is the only thing that overrides.
				if (typeof external === "string" && external.length > 0) {
					skipped.push(envName);
					continue;
				}
				try {
					const secret = deps.safeStorage.decryptString(Buffer.from(encrypted, "base64"));
					if (!originals.has(envName)) originals.set(envName, undefined);
					deps.env[envName] = secret;
					appliedFromStore.add(envName);
					loaded.push(envName);
				} catch {
					// A corrupt entry stays on disk (never wiped) and is reported.
					skipped.push(envName);
				}
			}
			if (skipped.length > 0) console.warn(`[credentials] stored credential(s) not loaded: ${skipped.join(", ")}`);
			return loaded;
		},
	};
}
