/**
 * Reads a certificate file for the Quick Look panel, in the main process only
 * (never the preview page), with `node:crypto`'s `X509Certificate`: no
 * dependency, no network (no OCSP or CRL fetch), and no file read past
 * {@link CERTIFICATE_BYTE_CAP}.
 *
 * A private key found in a PEM is reduced to its label and whether it is
 * passphrase-protected before anything is returned; its base64 body is never
 * copied into the result. PKCS#12 bundles and Apple keychains are encrypted
 * stores: they are named and nothing more, not parsed or decrypted.
 */

import { X509Certificate } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import {
	CERTIFICATE_BYTE_CAP,
	detectCertificateFormat,
	isCertificateLabel,
	isPrivateKeyLabel,
	privateKeyEncrypted,
	readKeyUsage,
	scanPemBlocks,
} from "../shared/certificate";
import type { CertificateEntry, CertificateInfo, CertificatePreview, CertificateStatus } from "../shared/contract";
import { readHead } from "./read-file";

/** The most certificates one panel lists; a longer bundle says how many it left out. */
export const CERTIFICATE_ENTRY_LIMIT = 20;

export interface CertificateBytesOptions {
	/** The file's extension, lowercase: `p12`, `pfx`, `keychain`, and `keychain-db` name their container whatever the bytes are. */
	readonly ext: string;
	/** The file was longer than the bytes given. */
	readonly truncated: boolean;
	/** The instant "expired" is judged against. */
	readonly now: Date;
	readonly maxEntries?: number;
}

export interface CertificateFileOptions {
	readonly now?: Date;
	readonly byteCap?: number;
	readonly maxEntries?: number;
}

const KEY_ALGORITHMS: Readonly<Record<string, string>> = {
	rsa: "RSA",
	"rsa-pss": "RSA-PSS",
	dsa: "DSA",
	ec: "EC",
	ed25519: "Ed25519",
	ed448: "Ed448",
	x25519: "X25519",
	x448: "X448",
	dh: "DH",
};

function statusAt(notBefore: Date, notAfter: Date, now: Date): CertificateStatus {
	if (now < notBefore) return "notYetValid";
	return now > notAfter ? "expired" : "valid";
}

/** `C=KR\nO=Acme\nCN=a.test` as `C=KR, O=Acme, CN=a.test`. */
function dn(value: string): string {
	return value.split("\n").join(", ");
}

function commonName(subject: string): string {
	const found = subject.split("\n").find((part) => part.startsWith("CN="));
	return found === undefined ? dn(subject) : found.slice(3);
}

function describe(cert: X509Certificate, now: Date): CertificateInfo {
	const notBefore = cert.validFromDate;
	const notAfter = cert.validToDate;
	const key = cert.publicKey;
	const type = key.asymmetricKeyType;
	const details = key.asymmetricKeyDetails;
	return {
		subject: dn(cert.subject),
		commonName: commonName(cert.subject),
		issuer: dn(cert.issuer),
		serial: cert.serialNumber,
		notBefore: notBefore.toISOString(),
		notAfter: notAfter.toISOString(),
		status: statusAt(notBefore, notAfter, now),
		signatureAlgorithm: cert.signatureAlgorithm ?? cert.signatureAlgorithmOid ?? "",
		keyAlgorithm: type === undefined ? "" : (KEY_ALGORITHMS[type] ?? type),
		keyBits: details?.modulusLength ?? null,
		curve: details?.namedCurve ?? null,
		subjectAltNames: cert.subjectAltName === undefined ? [] : cert.subjectAltName.split(", "),
		keyUsage: readKeyUsage(cert.raw),
		extendedKeyUsage: cert.keyUsage ?? [],
		ca: cert.ca,
		sha256: cert.fingerprint256,
		sha1: cert.fingerprint,
	};
}

function parse(der: Uint8Array, now: Date): CertificateInfo | null {
	try {
		return describe(new X509Certificate(der), now);
	} catch {
		return null;
	}
}

function pemEntries(text: string, now: Date): readonly CertificateEntry[] {
	return scanPemBlocks(text).map((block): CertificateEntry => {
		if (isCertificateLabel(block.label)) {
			const certificate = parse(Buffer.from(block.body, "base64"), now);
			return certificate === null ? { kind: "invalid", label: block.label } : { kind: "certificate", certificate };
		}
		// The key body is dropped here: only the label and the protection survive.
		if (isPrivateKeyLabel(block.label)) return { kind: "privateKey", label: block.label, encrypted: privateKeyEncrypted(block) };
		return { kind: "other", label: block.label };
	});
}

/** What a certificate file's first bytes hold. Pure: nothing is read from disk or the network. */
export function previewCertificateBytes(bytes: Uint8Array, options: CertificateBytesOptions): CertificatePreview {
	const format = detectCertificateFormat(bytes);
	const container = options.ext === "p12" || options.ext === "pfx" ? "pkcs12" : options.ext === "keychain" || options.ext === "keychain-db" ? "keychain" : null;
	if (container !== null) return { kind: "container", container, recognized: format === container };
	if (format === "pkcs12" || format === "keychain") return { kind: "container", container: format, recognized: true };
	if (bytes.length === 0) return { kind: "unreadable", reason: "empty" };
	const limit = options.maxEntries ?? CERTIFICATE_ENTRY_LIMIT;
	let entries: readonly CertificateEntry[];
	if (format === "pem") entries = pemEntries(new TextDecoder().decode(bytes), options.now);
	else if (format === "der") {
		const certificate = parse(bytes, options.now);
		entries = certificate === null ? [] : [{ kind: "certificate", certificate }];
	} else entries = [];
	if (entries.length === 0) return { kind: "unreadable", reason: "notCertificate" };
	return {
		kind: "certificates",
		source: format === "der" ? "der" : "pem",
		entries: entries.slice(0, limit),
		omitted: Math.max(0, entries.length - limit),
		truncated: options.truncated,
	};
}

/** Reads the head of a certificate file (never more than the byte cap) and describes it. */
export async function previewCertificate(path: string, options: CertificateFileOptions = {}): Promise<CertificatePreview> {
	const cap = options.byteCap ?? CERTIFICATE_BYTE_CAP;
	const { size } = await stat(path);
	const bytes = await readHead(path, Math.min(size, cap));
	return previewCertificateBytes(bytes, {
		ext: extname(path).slice(1).toLowerCase(),
		truncated: size > cap,
		now: options.now ?? new Date(),
		...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
	});
}
