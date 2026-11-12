import { sep } from "node:path";

/** Credential and private-key file names a file-touching helper agent never opens. */
export const CREDENTIAL_NAME =
	/^(?:\.env(?:\..*)?|id_[a-z0-9]+(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keychain-db)|(?:auth|models|mcp|mcp-auth|accounts)\.json|credentials(?:\..*)?|\.netrc|\.npmrc|\.pypirc)$/iu;

/** Windows paths compare case-insensitively with one separator. */
export function normalizeFencePath(value: string, platform: NodeJS.Platform): string {
	return platform === "win32" ? value.replace(/\//g, "\\").toLowerCase() : value;
}

/** True when `child` is `root` or below it. */
export function inside(child: string, root: string, platform: NodeJS.Platform = process.platform): boolean {
	const normChild = normalizeFencePath(child, platform);
	const normRoot = normalizeFencePath(root, platform);
	const boundary = platform === "win32" ? "\\" : sep;
	return normChild === normRoot || normChild.startsWith(`${normRoot}${boundary}`);
}
