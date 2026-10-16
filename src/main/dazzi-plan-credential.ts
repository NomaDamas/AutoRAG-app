import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { AUTORAG_PROVIDER_ID } from "../shared/account-contract";
import { isJsonObject } from "../shared/settings-contract";

/**
 * Bridge between the app's account sign-in and the librarian's hosted-plan
 * credential.
 *
 * Librarian 2.10.2 renamed the hosted plan to the `dazzi` provider and made it
 * OAuth-only: chat requests, the model-catalog refresh, Jev, rerank, and
 * question decomposition all read one credential — the `/login` token stored
 * under the provider id in Pi's `auth.json` — and every environment-variable
 * path for it was removed. The app's account sign-in exchanges the very same
 * OAuth code (`POST /api/desktop/token`) for the very same long-lived key, so
 * the account service stores that key here as the plan's credential and the
 * whole librarian pipeline works from the app's single sign-in. The app owns
 * this slot's lifecycle: Pi's `/login` never offers the plan (the app routes
 * `dazzi` to the account service), so nothing else writes it.
 */

/** The shape `loginDazzi` persists through Pi's credential store. */
interface StoredPlanCredential {
	readonly type: "oauth";
	readonly access: string;
	readonly refresh: "";
	readonly expires: number;
}

const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

function planCredential(token: string): StoredPlanCredential {
	return { type: "oauth", access: token, refresh: "", expires: NEVER_EXPIRES };
}

async function readAuthObject(authPath: string): Promise<Record<string, unknown>> {
	if (!existsSync(authPath)) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
		return isJsonObject(parsed) ? { ...parsed } : {};
	} catch (error) {
		throw new Error(`auth.json is unreadable; refusing to overwrite it (${String(error)})`);
	}
}

async function writeAuthObject(authPath: string, raw: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(authPath), { recursive: true });
	const temporary = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(temporary, authPath);
}

/** Store the account's token as the hosted plan's credential in `auth.json`. */
export async function storeDazziPlanCredential(agentDir: string, token: string): Promise<void> {
	const authPath = join(agentDir, "auth.json");
	const raw = await readAuthObject(authPath);
	await writeAuthObject(authPath, { ...raw, [AUTORAG_PROVIDER_ID]: planCredential(token) });
}

/**
 * Remove the hosted plan's credential from `auth.json`, leaving every other
 * provider's entry untouched. A missing credential is not an error.
 */
export async function clearDazziPlanCredential(agentDir: string): Promise<void> {
	const authPath = join(agentDir, "auth.json");
	const raw = await readAuthObject(authPath);
	if (!(AUTORAG_PROVIDER_ID in raw)) return;
	const next = { ...raw };
	delete next[AUTORAG_PROVIDER_ID];
	await writeAuthObject(authPath, next);
}

/** Read the hosted plan's token from `auth.json`, or null when absent/unreadable. */
export async function readDazziPlanCredential(agentDir: string): Promise<string | null> {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return null;
	try {
		const parsed: unknown = JSON.parse(await readFile(authPath, "utf8"));
		if (!isJsonObject(parsed)) return null;
		const entry = parsed[AUTORAG_PROVIDER_ID];
		if (!isJsonObject(entry) || typeof entry.access !== "string" || entry.access.length === 0) return null;
		return entry.access;
	} catch {
		return null;
	}
}
