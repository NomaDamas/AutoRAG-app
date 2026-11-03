/**
 * Windows code signing (Azure Artifact Signing) for the release: which options electron-builder gets,
 * and the check that every shipped executable carries the publisher's signature.
 *
 * The publisher name matters beyond the signature itself. electron-builder writes it into
 * `resources/app-update.yml` as `publisherName`, and electron-updater then refuses an update installer
 * whose certificate CN differs (NsisUpdater.verifySignature). Artifact Signing cannot report its
 * certificate subject at build time, so without `AZURE_CODESIGN_PUBLISHER` a signed build ships an
 * updater that accepts any installer, signed or not.
 */

import { spawnSync } from "node:child_process";
import { parseDn } from "builder-util-runtime";

const CREDENTIALS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const ACCOUNT = ["AZURE_CODESIGN_ENDPOINT", "AZURE_CODESIGN_ACCOUNT", "AZURE_CODESIGN_PROFILE", "AZURE_CODESIGN_PUBLISHER"];

/**
 * electron-builder's `win.azureSignOptions` from the environment, or null when signing is not configured.
 * A partial configuration throws: an installer that silently ships unsigned is the bug this guards against.
 * GitHub passes a missing secret or variable as "", so an empty value counts as unset.
 */
export function windowsSigning(env) {
	const names = [...CREDENTIALS, ...ACCOUNT];
	const missing = names.filter((name) => !env[name]);
	if (missing.length === names.length) return null;
	if (missing.length > 0) {
		throw new Error(`Windows signing is half configured; set ${missing.join(", ")} as well (docs/release.md → "Windows: code signing")`);
	}
	return {
		endpoint: env.AZURE_CODESIGN_ENDPOINT,
		codeSigningAccountName: env.AZURE_CODESIGN_ACCOUNT,
		certificateProfileName: env.AZURE_CODESIGN_PROFILE,
		publisherName: env.AZURE_CODESIGN_PUBLISHER,
	};
}

/**
 * Problems with a set of Authenticode results (`Get-AuthenticodeSignature`: `path`, `status`, `subject`),
 * one line per file that is not validly signed. With a `publisher`, a valid signature must also be its:
 * the certificate's CN is compared, which is what electron-updater compares a plain `publisherName` with.
 * With `publisher` null only validity is checked (bundled tools may keep their own vendors' signatures).
 */
export function windowsSignatureProblems(files, publisher) {
	const problems = [];
	for (const file of files) {
		if (file.status !== "Valid") {
			problems.push(`${file.path}: ${file.status}`);
			continue;
		}
		if (publisher === null) continue;
		const cn = parseDn(file.subject).get("CN");
		if (cn !== publisher) problems.push(`${file.path}: signed by CN=${cn ?? ""}, not ${publisher}`);
	}
	return problems;
}

/**
 * `Get-AuthenticodeSignature` for each path (Windows only): `{ path, status, subject }`, status being the
 * SignatureStatus name (`Valid`, `NotSigned`, `HashMismatch`, `UnknownError`, ...). Paths travel in an
 * environment variable and the answer as UTF-8 JSON, so non-ASCII paths and publisher names survive.
 *
 * PSModulePath is cleared like electron-updater does (its issue #7127): GitHub's Windows steps run under
 * pwsh 7, whose module path leaks into Windows PowerShell 5.1 and breaks the cmdlet for every file. That
 * failure dropped every row and answered `[]` with exit 0, so the result must hold one row per path.
 */
export function readAuthenticode(paths) {
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
		"$paths = ConvertFrom-Json $env:DAZZI_SIGNATURE_PATHS",
		"$rows = @(foreach ($p in $paths) { $s = Get-AuthenticodeSignature -LiteralPath $p; [pscustomobject]@{ path = $p; status = $s.Status.ToString(); subject = [string]$s.SignerCertificate.Subject } })",
		"ConvertTo-Json -InputObject $rows -Compress",
	].join("; ");
	const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
		env: { ...process.env, PSModulePath: "", DAZZI_SIGNATURE_PATHS: JSON.stringify(paths) },
		maxBuffer: 64 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature failed (exit ${result.status}): ${result.stderr || result.error?.message}`);
	const rows = JSON.parse(result.stdout);
	if (!Array.isArray(rows) || rows.length !== paths.length) throw new Error(`Get-AuthenticodeSignature answered ${Array.isArray(rows) ? rows.length : "no"} result(s) for ${paths.length} file(s): ${result.stderr}`);
	return rows;
}
