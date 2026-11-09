import { describe, expect, it } from "vitest";
import { windowsSignatureProblems, windowsSigning } from "../scripts/release/windows-signing.mjs";

// The release workflow passes every Azure value, set or not; GitHub turns a missing secret or variable into "".
const AZURE = {
	AZURE_TENANT_ID: "tenant",
	AZURE_CLIENT_ID: "client",
	AZURE_CLIENT_SECRET: "secret",
	AZURE_CODESIGN_ENDPOINT: "https://krc.codesigning.azure.net",
	AZURE_CODESIGN_ACCOUNT: "dazzi",
	AZURE_CODESIGN_PROFILE: "dazzi-public",
	AZURE_CODESIGN_PUBLISHER: "노마다마스",
};

describe("windowsSigning", () => {
	it("is off when nothing is configured, including GitHub's empty strings for missing values", () => {
		expect(windowsSigning({})).toBeNull();
		expect(windowsSigning(Object.fromEntries(Object.keys(AZURE).map((name) => [name, ""])))).toBeNull();
	});

	it("maps a complete configuration to Artifact Signing options that carry the publisher", () => {
		expect(windowsSigning(AZURE)).toEqual({
			endpoint: "https://krc.codesigning.azure.net",
			codeSigningAccountName: "dazzi",
			certificateProfileName: "dazzi-public",
			publisherName: "노마다마스",
		});
	});

	it("refuses a partial configuration instead of silently building an unsigned installer", () => {
		const { AZURE_CODESIGN_PUBLISHER: _publisher, ...withoutPublisher } = AZURE;
		expect(() => windowsSigning(withoutPublisher)).toThrow(/AZURE_CODESIGN_PUBLISHER/);
		const { AZURE_CLIENT_SECRET: _secret, AZURE_TENANT_ID: _tenant, ...withoutSecrets } = AZURE;
		expect(() => windowsSigning(withoutSecrets)).toThrow(/AZURE_TENANT_ID.*AZURE_CLIENT_SECRET|AZURE_CLIENT_SECRET.*AZURE_TENANT_ID/);
	});
});

describe("windowsSignatureProblems", () => {
	const signed = (path: string, subject: string) => ({ path, status: "Valid", subject });

	it("accepts files validly signed by the publisher, matched on the certificate's CN like electron-updater", () => {
		const files = [
			signed("Dazzi-Setup-1.0.0-x64.exe", "CN=노마다마스, O=노마다마스, L=Gwangju, C=KR"),
			signed("Dazzi.exe", 'CN="Nomadamas, Inc.", O="Nomadamas, Inc.", C=KR'),
		];
		expect(windowsSignatureProblems(files.slice(0, 1), "노마다마스")).toEqual([]);
		expect(windowsSignatureProblems(files.slice(1), "Nomadamas, Inc.")).toEqual([]);
	});

	it("names every file that is unsigned, invalid, or signed by someone else", () => {
		const problems = windowsSignatureProblems(
			[
				{ path: "Dazzi.exe", status: "NotSigned", subject: "" },
				{ path: "tools/bin/minsync.exe", status: "HashMismatch", subject: "CN=노마다마스" },
				signed("Uninstall Dazzi.exe", "CN=Someone Else, C=US"),
				signed("tools/bin/rhwp.exe", "CN=노마다마스, C=KR"),
			],
			"노마다마스",
		);
		expect(problems).toEqual([
			"Dazzi.exe: NotSigned",
			"tools/bin/minsync.exe: HashMismatch",
			"Uninstall Dazzi.exe: signed by CN=Someone Else, not 노마다마스",
		]);
	});

	it("without a publisher, checks only that each signature is valid (bundled tools may keep their vendors' signatures)", () => {
		const problems = windowsSignatureProblems(
			[signed("tools/node/node.exe", "CN=OpenJS Foundation, O=OpenJS Foundation, C=US"), { path: "tools/bin/dupey.exe", status: "NotSigned", subject: "" }],
			null,
		);
		expect(problems).toEqual(["tools/bin/dupey.exe: NotSigned"]);
	});
});
