// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CertificateInfo, CertificatePreview, PreviewDocument, QuickLookWindowBridge } from "../src/preview/shared/contract";
import { ChromeProvider, type QuickLookChrome } from "../src/preview/ui/chrome";
import { CertificateView } from "../src/preview/ui/certificate";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const never = (): Promise<never> => new Promise(() => undefined);

function bridgeAnswering(answer: (path: string) => Promise<CertificatePreview>): QuickLookWindowBridge {
	return {
		platform: "darwin",
		language: "en",
		onLanguage: () => () => undefined,
		onLoad: () => () => undefined,
		onUnload: () => () => undefined,
		onZoom: () => () => undefined,
		onApp: () => () => undefined,
		onOffice: () => () => undefined,
		onSlides: () => () => undefined,
		onThumbnail: () => () => undefined,
		ready: () => undefined,
		zoomed: () => undefined,
		request: never,
		details: never,
		sha256: never,
		folderSize: never,
		audioMetadata: never,
		videoAudio: never,
		dataPreview: never,
		archivePreview: never,
		certificatePreview: answer,
		share: never,
		copyText: never,
		textEntry: () => undefined,
	};
}

function fileAt(path: string, size = 1234): PreviewDocument {
	return {
		name: path.split("/").pop() ?? path,
		path,
		ext: path.split(".").pop() ?? "",
		size,
		modifiedAt: "2026-01-02T03:04:05.000Z",
		mime: "application/octet-stream",
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
	};
}

const CERT: CertificateInfo = {
	subject: "C=KR, O=Dazzi QA, CN=dazzi.test",
	commonName: "dazzi.test",
	issuer: "C=KR, O=Dazzi QA, CN=Dazzi Root",
	serial: "23E451FAA69A7019",
	notBefore: "2026-01-01T00:00:00.000Z",
	notAfter: "2027-01-01T00:00:00.000Z",
	status: "valid",
	signatureAlgorithm: "sha256WithRSAEncryption",
	keyAlgorithm: "RSA",
	keyBits: 2048,
	curve: null,
	subjectAltNames: ["DNS:dazzi.test", "IP Address:10.0.0.7"],
	keyUsage: ["digitalSignature", "keyEncipherment"],
	extendedKeyUsage: ["1.3.6.1.5.5.7.3.1", "1.2.3.4.5"],
	ca: false,
	sha256: "66:9A:A0:E7",
	sha1: "52:D6:85:2B",
};

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	await setAppLanguage("ko");
});

async function show(file: PreviewDocument, answer: (path: string) => Promise<CertificatePreview>): Promise<void> {
	const chrome: QuickLookChrome = { bridge: bridgeAnswering(answer), toolbar: null, report: () => undefined, resize: () => undefined, hideTitle: () => undefined, app: null };
	await act(async () => {
		root.render(
			<ChromeProvider value={chrome}>
				<CertificateView file={file} />
			</ChromeProvider>,
		);
	});
}

const certificates = (overrides: Partial<CertificateInfo>[], extra: Extract<CertificatePreview, { kind: "certificates" }>["entries"] = []): CertificatePreview => ({
	kind: "certificates",
	source: "pem",
	entries: [...overrides.map((override) => ({ kind: "certificate" as const, certificate: { ...CERT, ...override } })), ...extra],
	omitted: 0,
	truncated: false,
});

describe("the certificate panel", () => {
	it("asks the main process for the shown file and draws every field", async () => {
		const asked: string[] = [];
		await show(fileAt("/tmp/server.crt"), async (path) => {
			asked.push(path);
			return certificates([{}]);
		});
		expect(asked).toEqual(["/tmp/server.crt"]);
		const text = host.textContent ?? "";
		for (const expected of [
			"dazzi.test",
			"C=KR, O=Dazzi QA, CN=dazzi.test",
			"CN=Dazzi Root",
			"23E451FAA69A7019",
			"sha256WithRSAEncryption",
			"RSA",
			"2048",
			"DNS:dazzi.test",
			"IP Address:10.0.0.7",
			"Digital Signature",
			"Key Encipherment",
			"TLS Web Server Authentication",
			"1.2.3.4.5",
			"66:9A:A0:E7",
			"52:D6:85:2B",
			"SHA-256",
			"SHA-1",
		]) {
			expect(text, expected).toContain(expected);
		}
		expect(host.querySelector("[data-certificate-status]")?.getAttribute("data-certificate-status")).toBe("valid");
		expect(text).not.toContain("Expired");
	});

	it("marks an expired certificate and a not-yet-valid one", async () => {
		await show(fileAt("/tmp/old.pem"), async () => certificates([{ status: "expired", notAfter: "2020-01-01T00:00:00.000Z" }]));
		expect(host.querySelector("[data-certificate-status]")?.getAttribute("data-certificate-status")).toBe("expired");
		expect(host.textContent).toContain("Expired");
		await show(fileAt("/tmp/new.pem"), async () => certificates([{ status: "notYetValid" }]));
		expect(host.textContent).toContain("Not yet valid");
	});

	it("draws each certificate of a bundle, the count, and what was left out", async () => {
		await show(fileAt("/tmp/ca-bundle.pem"), async () => ({ ...(certificates([{ commonName: "First CA" }, { commonName: "Second CA" }]) as Extract<CertificatePreview, { kind: "certificates" }>), omitted: 3, truncated: true }));
		const text = host.textContent ?? "";
		expect(text).toContain("First CA");
		expect(text).toContain("Second CA");
		expect(text).toContain("2 certificates");
		expect(text).toContain("3 more");
		expect(text).toContain("first part of the file");
	});

	it("says a private key is hidden, with its type and protection, and shows nothing else of it", async () => {
		await show(fileAt("/tmp/bundle.pem"), async () =>
			certificates([{}], [
				{ kind: "privateKey", label: "RSA PRIVATE KEY", encrypted: false },
				{ kind: "privateKey", label: "ENCRYPTED PRIVATE KEY", encrypted: true },
				{ kind: "other", label: "PUBLIC KEY" },
				{ kind: "invalid", label: "CERTIFICATE" },
			]),
		);
		const text = host.textContent ?? "";
		expect(text).toContain("RSA PRIVATE KEY");
		expect(text).toContain("ENCRYPTED PRIVATE KEY");
		expect(text).toContain("Private key — contents hidden");
		expect(text).toContain("Encrypted");
		expect(text).toContain("Not encrypted");
		expect(text).toContain("PUBLIC KEY");
		expect(text).toContain("could not be read");
	});

	it("labels a PKCS#12 bundle and a keychain, with the file's size and no certificate fields", async () => {
		await show(fileAt("/tmp/id.p12", 2699), async () => ({ kind: "container", container: "pkcs12", recognized: true }));
		let text = host.textContent ?? "";
		expect(text).toContain("id.p12");
		expect(text).toContain("PKCS #12 bundle");
		expect(text).toContain("3 KB");
		expect(text).toContain("password-protected");
		expect(text).not.toContain("SHA-256");
		await show(fileAt("/tmp/login.keychain-db", 5_000_000), async () => ({ kind: "container", container: "keychain", recognized: true }));
		text = host.textContent ?? "";
		expect(text).toContain("Keychain");
		expect(text).toContain("not read or decrypted");
	});

	it("says so when a p12 or a .pem is not what its name claims", async () => {
		await show(fileAt("/tmp/odd.pfx"), async () => ({ kind: "container", container: "pkcs12", recognized: false }));
		expect(host.textContent).toContain("isn’t a valid PKCS #12 bundle");
		await show(fileAt("/tmp/notes.pem"), async () => ({ kind: "unreadable", reason: "notCertificate" }));
		expect(host.textContent).toContain("No certificate was found in this file");
		await show(fileAt("/tmp/empty.cer", 0), async () => ({ kind: "unreadable", reason: "empty" }));
		expect(host.textContent).toContain("This file is empty");
	});

	it("shows the error's own message when the main process refuses", async () => {
		await show(fileAt("/tmp/x.crt"), () => Promise.reject(new Error("Quick Look is not attached to this window")));
		expect(host.textContent).toContain("Quick Look is not attached to this window");
	});

	it("is translated: Korean copy replaces the English labels", async () => {
		await setAppLanguage("ko");
		await show(fileAt("/tmp/server.crt"), async () => certificates([{ status: "expired" }]));
		const text = host.textContent ?? "";
		expect(text).not.toContain("Subject");
		expect(text).not.toContain("Expired");
		expect(text).toContain("만료");
	});
});
