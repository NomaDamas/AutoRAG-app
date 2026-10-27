import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewCertificate, previewCertificateBytes } from "../src/preview/node/certificate";
import {
	CERTIFICATE_BYTE_CAP,
	CERTIFICATE_EXTENSIONS,
	detectCertificateFormat,
	readKeyUsage,
	scanPemBlocks,
} from "../src/preview/shared/certificate";
import { isCertificatePreview, type CertificateList, type CertificatePreview } from "../src/preview/shared/contract";
import { byteNeed, describeExtension, viewerForExtension } from "../src/preview/shared/registry";
import { CERT_ONLY_P12_BASE64, EC_EXPIRED, EC_EXPIRED_PEM, RSA_CA, RSA_CA_PEM } from "./support/certificate-fixture";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const derOf = (pem: string): Buffer => new X509Certificate(pem).raw;
const NOW = new Date("2026-10-26T12:00:00Z");

describe("certificate files in the registry", () => {
	it("routes every certificate and key container to the certificate viewer, which sends no file bytes", () => {
		for (const ext of ["pem", "crt", "cer", "der", "p12", "pfx", "keychain", "keychain-db"]) {
			expect(viewerForExtension(ext), ext).toBe("certificate");
			expect(CERTIFICATE_EXTENSIONS).toContain(ext);
		}
		expect(viewerForExtension("PEM")).toBe("certificate");
		expect(byteNeed("certificate")).toBe("query");
		expect(describeExtension("p12")).toBe("PKCS #12 bundle");
		expect(describeExtension("keychain-db")).toBe("Keychain");
		expect(describeExtension("crt")).toBe("Certificate");
	});
});

describe("detectCertificateFormat", () => {
	it("recognises PEM by its armour, with text before it and in a bundle", () => {
		expect(detectCertificateFormat(enc(RSA_CA_PEM))).toBe("pem");
		expect(detectCertificateFormat(enc(`Bag Attributes\n    friendlyName: x\n${RSA_CA_PEM}${EC_EXPIRED_PEM}`))).toBe("pem");
	});

	it("recognises a DER certificate by its SEQUENCE header", () => {
		expect(detectCertificateFormat(derOf(RSA_CA_PEM))).toBe("der");
		expect(detectCertificateFormat(derOf(EC_EXPIRED_PEM))).toBe("der");
	});

	it("tells a PKCS#12 bundle from a DER certificate by the version INTEGER", () => {
		expect(detectCertificateFormat(Buffer.from(CERT_ONLY_P12_BASE64, "base64"))).toBe("pkcs12");
	});

	it("recognises an Apple keychain by its magic", () => {
		expect(detectCertificateFormat(Buffer.concat([Buffer.from("kych"), Buffer.alloc(60)]))).toBe("keychain");
	});

	it("does not mistake a text file that starts with a zero for DER", () => {
		expect(detectCertificateFormat(enc("0 notes\nnothing here"))).toBe("unknown");
		expect(detectCertificateFormat(enc(""))).toBe("unknown");
		expect(detectCertificateFormat(new Uint8Array([0x30]))).toBe("unknown");
	});
});

describe("scanPemBlocks", () => {
	it("returns each block's label and body in file order, ignoring text between them", () => {
		const blocks = scanPemBlocks(`noise\n${RSA_CA_PEM}more noise\n${EC_EXPIRED_PEM}`);
		expect(blocks.map((block) => block.label)).toEqual(["CERTIFICATE", "CERTIFICATE"]);
		expect(blocks[0]?.body.replace(/\s+/g, "")).toBe(RSA_CA_PEM.split("\n").filter((line) => !line.startsWith("-----")).join(""));
	});

	it("drops a block whose END line is missing (a cut-off file) and one with a different END label", () => {
		expect(scanPemBlocks(RSA_CA_PEM.slice(0, RSA_CA_PEM.length - 40))).toEqual([]);
		expect(scanPemBlocks("-----BEGIN CERTIFICATE-----\nAAAA\n-----END PRIVATE KEY-----\n")).toEqual([]);
	});
});

describe("readKeyUsage", () => {
	it("reads the keyUsage bits out of the certificate", () => {
		expect(readKeyUsage(derOf(RSA_CA_PEM))).toEqual(["digitalSignature", "keyEncipherment"]);
		expect(readKeyUsage(derOf(EC_EXPIRED_PEM))).toEqual(["keyCertSign", "cRLSign"]);
	});

	it("returns nothing for bytes that are not a certificate", () => {
		expect(readKeyUsage(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]))).toEqual([]);
		expect(readKeyUsage(new Uint8Array())).toEqual([]);
		expect(readKeyUsage(derOf(RSA_CA_PEM).subarray(0, 120))).toEqual([]);
	});
});

function certificates(preview: CertificatePreview): CertificateList {
	if (preview.kind !== "certificates") throw new Error(`expected certificates, got ${preview.kind}`);
	return preview;
}

describe("previewCertificateBytes: certificates", () => {
	it("shows subject, issuer, serial, validity, algorithms, SAN, usages and both fingerprints", () => {
		const { entries, source } = certificates(previewCertificateBytes(enc(RSA_CA_PEM), { ext: "pem", truncated: false, now: NOW }));
		expect(source).toBe("pem");
		expect(entries).toHaveLength(1);
		const entry = entries[0];
		if (entry?.kind !== "certificate") throw new Error("expected a certificate");
		const cert = entry.certificate;
		expect(cert.subject).toBe("C=KR, O=Dazzi QA, CN=dazzi.test");
		expect(cert.commonName).toBe("dazzi.test");
		expect(cert.issuer).toBe("C=KR, O=Dazzi QA, CN=dazzi.test");
		expect(cert.serial).toBe(RSA_CA.serial);
		expect(cert.notBefore).toBe(RSA_CA.notBefore);
		expect(cert.notAfter).toBe(RSA_CA.notAfter);
		expect(cert.status).toBe("valid");
		expect(cert.signatureAlgorithm).toBe("sha256WithRSAEncryption");
		expect(cert.keyAlgorithm).toBe("RSA");
		expect(cert.keyBits).toBe(2048);
		expect(cert.curve).toBeNull();
		expect(cert.subjectAltNames).toEqual(["DNS:dazzi.test", "DNS:*.dazzi.test", "IP Address:10.0.0.7", "email:qa@dazzi.test"]);
		expect(cert.keyUsage).toEqual(["digitalSignature", "keyEncipherment"]);
		expect(cert.extendedKeyUsage).toEqual(["1.3.6.1.5.5.7.3.1", "1.3.6.1.5.5.7.3.2"]);
		// basicConstraints says CA:TRUE, but keyUsage lacks keyCertSign, so OpenSSL does not accept it as a CA.
		expect(cert.ca).toBe(false);
		expect(cert.sha256).toBe(RSA_CA.sha256);
		expect(cert.sha1).toBe(RSA_CA.sha1);
	});

	it("marks a certificate past its end date as expired, and one not yet started as not yet valid", () => {
		const expired = certificates(previewCertificateBytes(enc(EC_EXPIRED_PEM), { ext: "crt", truncated: false, now: NOW }));
		const only = expired.entries[0];
		if (only?.kind !== "certificate") throw new Error("expected a certificate");
		expect(only.certificate.status).toBe("expired");
		expect(only.certificate.notAfter).toBe(EC_EXPIRED.notAfter);
		expect(only.certificate.ca).toBe(true);
		expect(only.certificate.keyAlgorithm).toBe("EC");
		expect(only.certificate.curve).toBe("prime256v1");
		expect(only.certificate.keyBits).toBeNull();
		expect(only.certificate.subjectAltNames).toEqual([]);

		const early = certificates(previewCertificateBytes(enc(RSA_CA_PEM), { ext: "pem", truncated: false, now: new Date("2020-01-01T00:00:00Z") }));
		const first = early.entries[0];
		if (first?.kind !== "certificate") throw new Error("expected a certificate");
		expect(first.certificate.status).toBe("notYetValid");
	});

	it("reads a DER certificate the same as its PEM form", () => {
		const fromDer = certificates(previewCertificateBytes(derOf(RSA_CA_PEM), { ext: "cer", truncated: false, now: NOW }));
		const fromPem = certificates(previewCertificateBytes(enc(RSA_CA_PEM), { ext: "cer", truncated: false, now: NOW }));
		expect(fromDer.source).toBe("der");
		expect(fromDer.entries).toEqual(fromPem.entries);
	});

	it("lists every certificate of a bundle in order and counts what it leaves out", () => {
		const bundle = certificates(previewCertificateBytes(enc(`${RSA_CA_PEM}${EC_EXPIRED_PEM}${RSA_CA_PEM}`), { ext: "pem", truncated: false, now: NOW, maxEntries: 2 }));
		expect(bundle.entries.map((entry) => (entry.kind === "certificate" ? entry.certificate.sha256 : entry.kind))).toEqual([RSA_CA.sha256, EC_EXPIRED.sha256]);
		expect(bundle.omitted).toBe(1);
		const all = certificates(previewCertificateBytes(enc(`${RSA_CA_PEM}${EC_EXPIRED_PEM}`), { ext: "pem", truncated: false, now: NOW }));
		expect(all.entries).toHaveLength(2);
		expect(all.omitted).toBe(0);
	});

	it("keeps a block that is not a certificate or key as a label only, and an undecodable certificate as invalid", () => {
		const publicKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
		const broken = "-----BEGIN CERTIFICATE-----\nAAAAAAAA\n-----END CERTIFICATE-----\n";
		const { entries } = certificates(previewCertificateBytes(enc(`${publicKey}${broken}${RSA_CA_PEM}`), { ext: "pem", truncated: false, now: NOW }));
		expect(entries.map((entry) => entry.kind)).toEqual(["other", "invalid", "certificate"]);
		expect(entries[0]).toEqual({ kind: "other", label: "PUBLIC KEY" });
		expect(entries[1]).toEqual({ kind: "invalid", label: "CERTIFICATE" });
	});

	it("reports that a file larger than what was read is cut", () => {
		expect(certificates(previewCertificateBytes(enc(RSA_CA_PEM), { ext: "pem", truncated: true, now: NOW })).truncated).toBe(true);
		expect(certificates(previewCertificateBytes(enc(RSA_CA_PEM), { ext: "pem", truncated: false, now: NOW })).truncated).toBe(false);
	});
});

/** Every PEM line of a body, so a test can assert none of them reaches the page. */
function bodyLines(pem: string): string[] {
	return pem
		.split("\n")
		.filter((line) => line !== "" && !line.startsWith("-----") && !line.includes(":"))
		.map((line) => line.trim())
		.filter((line) => line.length >= 16);
}

/** An unencrypted OpenSSH ed25519 private key in the real `openssh-key-v1` layout. */
function opensshPrivateKey(cipher: string): string {
	const string = (data: Buffer | string): Buffer => {
		const bytes = typeof data === "string" ? Buffer.from(data) : data;
		const length = Buffer.alloc(4);
		length.writeUInt32BE(bytes.length);
		return Buffer.concat([length, bytes]);
	};
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const rawPublic = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const rawSeed = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" })).subarray(-32);
	const publicBlob = Buffer.concat([string("ssh-ed25519"), string(rawPublic)]);
	const privateBlob = Buffer.concat([Buffer.alloc(8), string("ssh-ed25519"), string(rawPublic), string(Buffer.concat([rawSeed, rawPublic])), string("comment"), Buffer.from([1, 2, 3, 4, 5])]);
	const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), string(cipher), string(cipher === "none" ? "none" : "bcrypt"), string(""), Buffer.from([0, 0, 0, 1]), string(publicBlob), string(privateBlob)]);
	const lines = body.toString("base64").match(/.{1,70}/g) ?? [];
	return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

describe("previewCertificateBytes: private keys are never shown", () => {
	const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const keys: Readonly<Record<string, { readonly pem: string; readonly label: string; readonly encrypted: boolean | null }>> = {
		pkcs8: { pem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), label: "PRIVATE KEY", encrypted: false },
		pkcs1: { pem: rsa.privateKey.export({ type: "pkcs1", format: "pem" }).toString(), label: "RSA PRIVATE KEY", encrypted: false },
		sec1: { pem: ec.privateKey.export({ type: "sec1", format: "pem" }).toString(), label: "EC PRIVATE KEY", encrypted: false },
		encryptedPkcs8: {
			pem: rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }).toString(),
			label: "ENCRYPTED PRIVATE KEY",
			encrypted: true,
		},
		encryptedPkcs1: {
			pem: rsa.privateKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }).toString(),
			label: "RSA PRIVATE KEY",
			encrypted: true,
		},
		openssh: { pem: opensshPrivateKey("none"), label: "OPENSSH PRIVATE KEY", encrypted: false },
		opensshEncrypted: { pem: opensshPrivateKey("aes256-ctr"), label: "OPENSSH PRIVATE KEY", encrypted: true },
	};

	for (const [name, key] of Object.entries(keys)) {
		it(`names the ${name} key and its protection without a single line of its body`, () => {
			const lines = bodyLines(key.pem);
			expect(lines.length).toBeGreaterThan(0);
			const preview = previewCertificateBytes(enc(key.pem), { ext: "pem", truncated: false, now: NOW });
			const { entries } = certificates(preview);
			expect(entries).toEqual([{ kind: "privateKey", label: key.label, encrypted: key.encrypted }]);
			const serialised = JSON.stringify(preview);
			for (const line of lines) expect(serialised).not.toContain(line);
			expect(serialised).not.toContain(lines[0]?.slice(0, 12) ?? "");
		});
	}

	it("keeps the certificate and drops the key body when a PEM holds both (a bundle with its key)", () => {
		const key = keys.pkcs8?.pem ?? "";
		const preview = previewCertificateBytes(enc(`${RSA_CA_PEM}${key}`), { ext: "pem", truncated: false, now: NOW });
		const { entries } = certificates(preview);
		expect(entries.map((entry) => entry.kind)).toEqual(["certificate", "privateKey"]);
		const serialised = JSON.stringify(preview);
		for (const line of bodyLines(key)) expect(serialised).not.toContain(line);
	});
});

describe("previewCertificateBytes: containers and non-certificates", () => {
	it("labels a PKCS#12 bundle and an Apple keychain without reading into them", () => {
		expect(previewCertificateBytes(Buffer.from(CERT_ONLY_P12_BASE64, "base64"), { ext: "p12", truncated: false, now: NOW })).toEqual({ kind: "container", container: "pkcs12", recognized: true });
		expect(previewCertificateBytes(Buffer.from(CERT_ONLY_P12_BASE64, "base64"), { ext: "pfx", truncated: false, now: NOW })).toEqual({ kind: "container", container: "pkcs12", recognized: true });
		const keychain = Buffer.concat([Buffer.from("kych"), Buffer.alloc(60, 7)]);
		expect(previewCertificateBytes(keychain, { ext: "keychain-db", truncated: true, now: NOW })).toEqual({ kind: "container", container: "keychain", recognized: true });
	});

	it("still says what a p12 or keychain is when its bytes are not that format", () => {
		expect(previewCertificateBytes(enc("hello"), { ext: "p12", truncated: false, now: NOW })).toEqual({ kind: "container", container: "pkcs12", recognized: false });
		expect(previewCertificateBytes(enc("hello"), { ext: "keychain", truncated: false, now: NOW })).toEqual({ kind: "container", container: "keychain", recognized: false });
	});

	it("says there is no certificate in a .pem, .cer or .der that holds none", () => {
		expect(previewCertificateBytes(enc("just words"), { ext: "pem", truncated: false, now: NOW })).toEqual({ kind: "unreadable", reason: "notCertificate" });
		expect(previewCertificateBytes(new Uint8Array(), { ext: "cer", truncated: false, now: NOW })).toEqual({ kind: "unreadable", reason: "empty" });
		expect(previewCertificateBytes(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]), { ext: "der", truncated: false, now: NOW })).toEqual({ kind: "unreadable", reason: "notCertificate" });
	});

	it("produces only values the contract guard accepts", () => {
		const samples = [
			previewCertificateBytes(enc(RSA_CA_PEM), { ext: "pem", truncated: false, now: NOW }),
			previewCertificateBytes(enc(EC_EXPIRED_PEM), { ext: "pem", truncated: true, now: NOW }),
			previewCertificateBytes(Buffer.from(CERT_ONLY_P12_BASE64, "base64"), { ext: "p12", truncated: false, now: NOW }),
			previewCertificateBytes(enc("x"), { ext: "pem", truncated: false, now: NOW }),
		];
		for (const sample of samples) expect(isCertificatePreview(sample)).toBe(true);
		expect(isCertificatePreview({ kind: "certificates" })).toBe(false);
		expect(isCertificatePreview(null)).toBe(false);
	});
});

describe("previewCertificate (from disk)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "autorag-cert-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("reads a certificate file", async () => {
		const path = join(dir, "server.crt");
		await writeFile(path, RSA_CA_PEM);
		const preview = await previewCertificate(path, { now: NOW });
		expect(certificates(preview).entries).toHaveLength(1);
		expect(certificates(preview).truncated).toBe(false);
	});

	it("never reads past the byte cap: a certificate that starts after it is not found, and the file is marked cut", async () => {
		const path = join(dir, "padded.pem");
		const padding = `# ${"x".repeat(2000)}\n`;
		await writeFile(path, padding + RSA_CA_PEM);
		const capped = await previewCertificate(path, { now: NOW, byteCap: 1500 });
		expect(capped).toEqual({ kind: "unreadable", reason: "notCertificate" });
		const open = await previewCertificate(path, { now: NOW });
		expect(certificates(open).entries).toHaveLength(1);
	});

	it("marks a bundle larger than the cap as cut and keeps the certificates that fit whole", async () => {
		const path = join(dir, "bundle.pem");
		await writeFile(path, RSA_CA_PEM + EC_EXPIRED_PEM + RSA_CA_PEM);
		const preview = certificates(await previewCertificate(path, { now: NOW, byteCap: RSA_CA_PEM.length + EC_EXPIRED_PEM.length + 100 }));
		expect(preview.truncated).toBe(true);
		expect(preview.entries).toHaveLength(2);
	});

	it("has a cap of a few hundred kilobytes", () => {
		expect(CERTIFICATE_BYTE_CAP).toBeGreaterThanOrEqual(128 * 1024);
		expect(CERTIFICATE_BYTE_CAP).toBeLessThanOrEqual(512 * 1024);
	});
});
