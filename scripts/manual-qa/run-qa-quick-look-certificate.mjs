/**
 * Manual QA — Quick Look opens certificates and key files (#353).
 *
 * Builds fixtures (real OpenSSL-made certificates, node-made keys), drives the production build (`bun
 * run build` first), opens each file with Space from the Finder list, and reads
 * the panel in the DOM. Checks that:
 *  - pem/crt/cer/der show subject, issuer, serial, validity, algorithms, SAN,
 *    usages and both fingerprints, matching what `openssl x509` prints;
 *  - an expired certificate is marked, a multi-certificate bundle lists each;
 *  - a PEM that holds a private key shows the label and "contents hidden" and
 *    not one line of the key body, neither in the DOM nor in what the main
 *    process sent over IPC (the preview:certificate reply is captured);
 *  - p12/pfx/keychain/keychain-db open a labelled panel, not "Other";
 *  - a file far larger than the byte cap is read only up to the cap.
 */

import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CERT_ONLY_P12_BASE64, EC_EXPIRED, EC_EXPIRED_PEM, RSA_CA, RSA_CA_PEM } from "../../test/support/certificate-fixture.ts";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

const EVIDENCE = process.env.QA_OUT ?? process.argv[2] ?? fileURLToPath(new URL("../../.omo/evidence/quick-look-certificate/", import.meta.url));
mkdirSync(EVIDENCE, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "autorag-ql-certificate-"));

// Certificates are the committed fixtures, whose serials and fingerprints are what OpenSSL printed for them
// (the guest's LibreSSL cannot make them). Private keys are made here, never committed.
const SERVER = RSA_CA;
const EXPIRED = EC_EXPIRED;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const encryptedKeyPem = rsa.privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "secret" }).toString();
const bodyLines = (pem) => pem.split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
const keyBodyLines = bodyLines(keyPem);
const encryptedBodyLines = bodyLines(encryptedKeyPem);

writeFileSync(join(root, "server.pem"), RSA_CA_PEM);
writeFileSync(join(root, "server.crt"), RSA_CA_PEM);
const der = new X509Certificate(RSA_CA_PEM).raw;
writeFileSync(join(root, "server.cer"), der);
writeFileSync(join(root, "server.der"), der);
writeFileSync(join(root, "expired.pem"), EC_EXPIRED_PEM);
writeFileSync(join(root, "chain.pem"), `${RSA_CA_PEM}${EC_EXPIRED_PEM}`);
writeFileSync(join(root, "with-key.pem"), `${RSA_CA_PEM}${keyPem}`);
writeFileSync(join(root, "private.key.pem"), `${encryptedKeyPem}${keyPem}`);
// A real PKCS #12 container (openssl pkcs12 -export -nokeys), under both of its extensions.
const p12 = Buffer.from(CERT_ONLY_P12_BASE64, "base64");
writeFileSync(join(root, "identity.p12"), p12);
writeFileSync(join(root, "identity.pfx"), p12);
// Apple keychains start with "kych"; the panel must not read any further.
writeFileSync(join(root, "login.keychain-db"), Buffer.concat([Buffer.from("kych"), Buffer.alloc(8192, 0x41)]));
writeFileSync(join(root, "old.keychain"), Buffer.concat([Buffer.from("kych"), Buffer.alloc(2048, 0x42)]));
writeFileSync(join(root, "notes.pem"), "These are just notes, no certificate here.\n");
// A bundle whose second certificate begins after the 256 KB cap: only the first is shown, and the panel says it is cut.
writeFileSync(join(root, "huge.pem"), `${RSA_CA_PEM}${"# padding\n".repeat(40_000)}${EC_EXPIRED_PEM}`);

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${String(detail).slice(0, 160)})`}`);
}

async function poll(read, accept, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		value = await read();
	}
	return value;
}

const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" }, language: "en" });
try {
	const main = await finderWindow(app, 30_000);
	const preview = await poll(
		async () => (await app.windows()).find((candidate) => candidate.url().includes("quick-look.html")),
		(candidate) => candidate !== undefined,
		30_000,
	);
	if (preview === undefined) throw new Error("Quick Look window did not pre-warm");

	// What the main process answered on preview:certificate for the shown file, exactly as the page's bridge receives it.
	const replies = [];
	const ipcReply = async (name) => {
		const path = join(root, name);
		const reply = JSON.stringify(await preview.evaluate((file) => window.quickLook.certificatePreview(file), path));
		replies.push({ path, reply });
		return reply;
	};

	const visible = () =>
		app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			return window !== undefined && window.isVisible();
		});

	/** Space on `name`, then wait until the panel stopped loading (a certificate list or a labelled panel). */
	async function open(name) {
		const row = main.getByRole("row", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first();
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		await main.keyboard.press("Space");
		await poll(
			() =>
				preview
					.evaluate((expected) => document.querySelector(".ql-certificate-list") !== null || document.querySelector(".ql-certificate__name")?.textContent === expected, name)
					.catch(() => false),
			Boolean,
			15_000,
		);
		await poll(visible, Boolean);
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	async function close() {
		await main.keyboard.press("Space");
		await poll(async () => !(await visible()), Boolean);
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const panelText = async () => (await preview.locator("body").innerText().catch(() => "")) ?? "";
	const shot = (name) => preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });

	for (const name of ["server.pem", "server.crt", "server.cer", "server.der"]) {
		await open(name);
		const text = await panelText();
		check(`${name} shows the subject and issuer`, text.includes("C=KR, O=Dazzi QA, CN=dazzi.test"), text.slice(0, 120));
		check(`${name} shows openssl's serial number`, text.includes(SERVER.serial));
		check(`${name} shows openssl's SHA-256 and SHA-1 fingerprints`, text.includes(SERVER.sha256) && text.includes(SERVER.sha1));
		check(`${name} shows the SAN list`, text.includes("DNS:dazzi.test") && text.includes("DNS:*.dazzi.test") && text.includes("IP Address:10.0.0.7"));
		check(`${name} shows key usage and extended usage`, text.includes("Digital Signature") && text.includes("Key Encipherment") && text.includes("TLS Web Server Authentication"));
		check(`${name} shows signature and key algorithm`, /sha256WithRSAEncryption/.test(text) && /RSA 2048/.test(text));
		check(`${name} is not marked expired`, !/Expired/.test(text));
		await shot(name);
		await close();
	}

	await open("expired.pem");
	let text = await panelText();
	check("expired.pem is marked Expired", (await preview.locator("[data-certificate-status]").first().getAttribute("data-certificate-status")) === "expired" && text.includes("Expired"), text.slice(0, 120));
	check("expired.pem shows the EC curve and the CA badge", text.includes("prime256v1") && text.includes("CA"));
	check("expired.pem shows openssl's SHA-256", text.includes(EXPIRED.sha256));
	await shot("expired.pem");
	await close();

	await open("chain.pem");
	text = await panelText();
	const sections = await preview.locator("[data-certificate-status]").count();
	check("chain.pem lists both certificates", sections === 2 && text.includes("2 certificates") && text.includes("dazzi.test") && text.includes("Dazzi Test Root CA"), `${sections} sections`);
	await shot("chain.pem");
	await close();

	await open("with-key.pem");
	await ipcReply("with-key.pem");
	text = await panelText();
	check("with-key.pem keeps the certificate and names the private key", text.includes("dazzi.test") && text.includes("PRIVATE KEY") && text.includes("Private key — contents hidden"), text.slice(0, 120));
	check("with-key.pem shows no line of the key body in the panel", keyBodyLines.every((line) => !text.includes(line)));
	await shot("with-key.pem");
	await close();

	await open("private.key.pem");
	await ipcReply("private.key.pem");
	text = await panelText();
	check("private.key.pem shows an encrypted and a plain key, nothing else", text.includes("ENCRYPTED PRIVATE KEY") && text.includes("Encrypted") && text.includes("Not encrypted") && (await preview.locator("[data-certificate-status]").count()) === 0, text.slice(0, 160));
	check("private.key.pem shows no line of either key body", [...keyBodyLines, ...encryptedBodyLines].every((line) => !text.includes(line)));
	await shot("private.key.pem");
	await close();

	for (const [name, kind, size] of [
		["identity.p12", "PKCS #12 bundle", "731 bytes"],
		["identity.pfx", "PKCS #12 bundle", "731 bytes"],
		["login.keychain-db", "Keychain", "8 KB"],
		["old.keychain", "Keychain", "2 KB"],
	]) {
		await open(name);
		await ipcReply(name);
		text = await panelText();
		check(`${name} opens a labelled ${kind} panel with its size`, text.includes(name) && text.includes(kind) && text.includes(size), text.slice(0, 120));
		check(`${name} is not the generic Other panel and shows no certificate fields`, (await preview.locator(".ql-other__name").count()) === 0 && !text.includes("SHA-256"));
		await shot(name);
		await close();
	}

	await open("notes.pem");
	text = await panelText();
	check("notes.pem says no certificate was found", text.includes("No certificate was found in this file"), text.slice(0, 120));
	await shot("notes.pem");
	await close();

	await open("huge.pem");
	await ipcReply("huge.pem");
	text = await panelText();
	check("huge.pem shows only the certificate inside the byte cap and says the file is cut", (await preview.locator("[data-certificate-status]").count()) === 1 && text.includes("Showing the first part of the file") && !text.includes("Dazzi Test Root CA"), text.slice(0, 120));
	await shot("huge.pem");
	await close();

	// What crossed IPC: no key body in any reply the main process sent.
	const sentToPage = replies.map((entry) => entry.reply).join("\n");
	check("the main process answered the audited files", replies.length === 7, `${replies.length} replies`);
	check("no private-key body line crossed the IPC boundary", [...keyBodyLines, ...encryptedBodyLines].every((line) => !sentToPage.includes(line)));
	check("the reply for with-key.pem names the key but carries no body", /"kind":"privateKey"/.test(replies.find((entry) => entry.path.endsWith("with-key.pem"))?.reply ?? ""));
	check("the replies for the containers carry no bytes of them", replies.filter((entry) => /\.(p12|pfx|keychain)/.test(entry.path)).every((entry) => entry.reply.includes('"kind":"container"') && entry.reply.length < 120));
	const huge = replies.find((entry) => entry.path.endsWith("huge.pem"))?.reply ?? "";
	check("the reply for huge.pem is cut at the byte cap", huge.includes('"truncated":true') && !huge.includes("Expired Root"), huge.slice(0, 80));
} finally {
	await app.close();
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
