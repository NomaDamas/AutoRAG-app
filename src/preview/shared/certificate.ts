/**
 * Certificates and key containers: what a file is (by its bytes, not its
 * extension), the PEM blocks inside it, and the keyUsage bits of a DER
 * certificate. Pure and dependency-free so the page and the main process can
 * share it; the certificate itself is decoded in the main process
 * (`node/certificate.ts`) with `node:crypto`.
 */

export const CERTIFICATE_EXTENSIONS: readonly string[] = ["pem", "crt", "cer", "der", "p12", "pfx", "keychain", "keychain-db"];

/** A certificate is 1-4 KB; this is room for a long bundle, and the most a certificate file is ever read. */
export const CERTIFICATE_BYTE_CAP = 256 * 1024;

export type CertificateFormat = "pem" | "der" | "pkcs12" | "keychain" | "unknown";

const PEM_ARMOUR = "-----BEGIN ";

function hasPemArmour(bytes: Uint8Array): boolean {
	const first = PEM_ARMOUR.charCodeAt(0);
	outer: for (let start = 0; start + PEM_ARMOUR.length <= bytes.length; start += 1) {
		if (bytes[start] !== first) continue;
		for (let offset = 1; offset < PEM_ARMOUR.length; offset += 1) {
			if (bytes[start + offset] !== PEM_ARMOUR.charCodeAt(offset)) continue outer;
		}
		return true;
	}
	return false;
}

/**
 * What a DER SEQUENCE is, from its first child: another SEQUENCE is an X.509
 * structure (a certificate), and the INTEGER 3 PKCS#12 starts with is its
 * version. Anything else, including a text file that merely starts with "0",
 * is not recognised.
 */
function classifyDer(bytes: Uint8Array): "der" | "pkcs12" | null {
	if (bytes.length < 2 || bytes[0] !== 0x30) return null;
	const lengthByte = bytes[1] ?? 0;
	let child = 2;
	if (lengthByte >= 0x80) {
		const lengthBytes = lengthByte & 0x7f;
		if (lengthBytes < 1 || lengthBytes > 4) return null;
		child = 2 + lengthBytes;
	}
	if (bytes.length < child + 3) return null;
	const tag = bytes[child];
	if (tag === 0x30) return "der";
	if (tag === 0x02 && bytes[child + 1] === 0x01 && bytes[child + 2] === 0x03) return "pkcs12";
	return null;
}

export function detectCertificateFormat(bytes: Uint8Array): CertificateFormat {
	// Apple keychains start with the ASCII magic "kych".
	if (bytes.length >= 4 && bytes[0] === 0x6b && bytes[1] === 0x79 && bytes[2] === 0x63 && bytes[3] === 0x68) return "keychain";
	const der = classifyDer(bytes);
	if (der !== null) return der;
	return hasPemArmour(bytes) ? "pem" : "unknown";
}

export interface PemBlock {
	/** The text between `BEGIN` and the dashes: `CERTIFICATE`, `RSA PRIVATE KEY`, ... */
	readonly label: string;
	/** RFC 1421 header lines (`Proc-Type: 4,ENCRYPTED`); empty for a plain block. */
	readonly headers: readonly string[];
	/** The base64 body with its line breaks removed. */
	readonly body: string;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9][A-Z0-9 ]{0,63})-----((?:(?!-----)[\s\S])*)-----END \1-----/g;
const PEM_HEADER = /^[A-Za-z][A-Za-z0-9-]*:/;

/**
 * Every complete PEM block in `text`, in file order. A block whose END line is
 * missing (a file cut at the byte cap) or names another label is not returned.
 */
export function scanPemBlocks(text: string): readonly PemBlock[] {
	const blocks: PemBlock[] = [];
	for (const match of text.matchAll(PEM_BLOCK)) {
		const label = match[1] ?? "";
		const headers: string[] = [];
		let body = "";
		for (const raw of (match[2] ?? "").split(/\r?\n/)) {
			const line = raw.trim();
			if (line === "") continue;
			if (PEM_HEADER.test(line)) headers.push(line);
			else body += line;
		}
		blocks.push({ label, headers, body });
	}
	return blocks;
}

export function isCertificateLabel(label: string): boolean {
	return label === "CERTIFICATE" || label === "X509 CERTIFICATE" || label === "TRUSTED CERTIFICATE";
}

export function isPrivateKeyLabel(label: string): boolean {
	return label.endsWith("PRIVATE KEY");
}

const OPENSSH_MAGIC = "openssh-key-v1\0";

/**
 * Whether a private-key block is passphrase-protected, read from its label and
 * headers, and for OpenSSH keys from the cipher name at the start of the body
 * (the only bytes of a key body this ever decodes). `null` when it cannot tell.
 */
export function privateKeyEncrypted(block: PemBlock): boolean | null {
	if (block.label.startsWith("ENCRYPTED ")) return true;
	if (block.headers.some((header) => /^Proc-Type:.*ENCRYPTED/i.test(header))) return true;
	if (block.label !== "OPENSSH PRIVATE KEY") return false;
	try {
		const head = atob(block.body.slice(0, 80));
		if (!head.startsWith(OPENSSH_MAGIC)) return null;
		const at = OPENSSH_MAGIC.length;
		const length = ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0;
		if (at + 4 + length > head.length) return null;
		return head.slice(at + 4, at + 4 + length) !== "none";
	} catch {
		return null;
	}
}

export const KEY_USAGE_NAMES = [
	"digitalSignature",
	"contentCommitment",
	"keyEncipherment",
	"dataEncipherment",
	"keyAgreement",
	"keyCertSign",
	"cRLSign",
	"encipherOnly",
	"decipherOnly",
] as const;

export type KeyUsageName = (typeof KEY_USAGE_NAMES)[number];

/** Extended key usage OIDs the panel names; every other OID is shown as its number. */
export const EXTENDED_KEY_USAGE_NAMES: Readonly<Record<string, "serverAuth" | "clientAuth" | "codeSigning" | "emailProtection" | "timeStamping" | "ocspSigning">> = {
	"1.3.6.1.5.5.7.3.1": "serverAuth",
	"1.3.6.1.5.5.7.3.2": "clientAuth",
	"1.3.6.1.5.5.7.3.3": "codeSigning",
	"1.3.6.1.5.5.7.3.4": "emailProtection",
	"1.3.6.1.5.5.7.3.8": "timeStamping",
	"1.3.6.1.5.5.7.3.9": "ocspSigning",
};

interface Tlv {
	readonly tag: number;
	readonly start: number;
	readonly end: number;
}

/** The DER element at `at`, or null when its header or its content runs past `limit`. */
function tlvAt(bytes: Uint8Array, at: number, limit: number): Tlv | null {
	if (at + 2 > limit) return null;
	const tag = bytes[at] ?? 0;
	const first = bytes[at + 1] ?? 0;
	let length = first;
	let start = at + 2;
	if (first >= 0x80) {
		const count = first & 0x7f;
		if (count < 1 || count > 4 || start + count > limit) return null;
		length = 0;
		for (let index = 0; index < count; index += 1) length = length * 256 + (bytes[start + index] ?? 0);
		start += count;
	}
	const end = start + length;
	return end > limit ? null : { tag, start, end };
}

function children(bytes: Uint8Array, parent: Tlv): readonly Tlv[] {
	const found: Tlv[] = [];
	let at = parent.start;
	while (at < parent.end) {
		const child = tlvAt(bytes, at, parent.end);
		if (child === null) break;
		found.push(child);
		at = child.end;
	}
	return found;
}

const KEY_USAGE_OID = [0x55, 0x1d, 0x0f];

/**
 * The keyUsage bits of a DER certificate, in bit order. Walks
 * Certificate > TBSCertificate > extensions > keyUsage with bounds checks, and
 * returns nothing for bytes that are not a whole certificate.
 */
export function readKeyUsage(der: Uint8Array): readonly KeyUsageName[] {
	const certificate = tlvAt(der, 0, der.length);
	if (certificate === null || certificate.tag !== 0x30) return [];
	const tbs = children(der, certificate)[0];
	if (tbs === undefined || tbs.tag !== 0x30) return [];
	const explicit = children(der, tbs).find((child) => child.tag === 0xa3);
	const list = explicit === undefined ? undefined : children(der, explicit)[0];
	if (list === undefined || list.tag !== 0x30) return [];
	for (const extension of children(der, list)) {
		const [oid, ...rest] = children(der, extension);
		if (oid === undefined || oid.tag !== 0x06 || oid.end - oid.start !== KEY_USAGE_OID.length) continue;
		if (!KEY_USAGE_OID.every((byte, index) => der[oid.start + index] === byte)) continue;
		const octets = rest.find((child) => child.tag === 0x04);
		const bits = octets === undefined ? undefined : children(der, octets)[0];
		if (bits === undefined || bits.tag !== 0x03 || bits.end - bits.start < 2) return [];
		const used: KeyUsageName[] = [];
		KEY_USAGE_NAMES.forEach((name, bit) => {
			const byte = bit >> 3 < bits.end - bits.start - 1 ? (der[bits.start + 1 + (bit >> 3)] ?? 0) : 0;
			if (((byte >> (7 - (bit & 7))) & 1) === 1) used.push(name);
		});
		return used;
	}
	return [];
}
