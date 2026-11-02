import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRemoteStatic, REMOTE_BOOTSTRAP_PATH, rewriteIndexHtml } from "../src/main/remote/static";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("rewriteIndexHtml", () => {
	it("injects the remote bootstrap before the bundle script", () => {
		// Given a production index.html with the Electron CSP and bundle script.
		const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' blob: autorag-preview:" /><title>x</title></head><body><script type="module" src="/assets/index.js"></script></body></html>`;

		// When the remote server rewrites it.
		const out = rewriteIndexHtml(html);

		// Then the bootstrap comes before the bundle so window.autorag exists first.
		expect(out.indexOf(REMOTE_BOOTSTRAP_PATH)).toBeGreaterThan(-1);
		expect(out.indexOf(REMOTE_BOOTSTRAP_PATH)).toBeLessThan(out.indexOf("/assets/index.js"));
		expect(out).toContain("connect-src 'self' blob: http: https:");
	});
});

describe("readRemoteStatic", () => {
	it("serves an asset with its content type", async () => {
		// Given a renderer root with a script asset.
		const root = await mkdtemp(join(tmpdir(), "remote-static-"));
		directories.push(root);
		await mkdir(join(root, "assets"), { recursive: true });
		await writeFile(join(root, "assets", "index.js"), "console.log(1)");

		// When the asset is requested.
		const file = await readRemoteStatic(root, "/assets/index.js");

		// Then its bytes and JavaScript content type come back.
		expect(file).not.toBeNull();
		expect(file?.contentType).toBe("text/javascript; charset=utf-8");
		expect(Buffer.from(file?.body ?? []).toString("utf8")).toBe("console.log(1)");
	});

	it("refuses paths escaping the renderer root", async () => {
		// Given a renderer root and a secret outside it.
		const root = await mkdtemp(join(tmpdir(), "remote-static-root-"));
		const outside = await mkdtemp(join(tmpdir(), "remote-static-out-"));
		directories.push(root, outside);
		await writeFile(join(outside, "secret.txt"), "secret");
		const escape = `/../${outside.split("/").pop()}/secret.txt`;

		// When a traversal is requested.
		const file = await readRemoteStatic(root, escape);

		// Then nothing outside the root is served.
		expect(file).toBeNull();
	});

	it("refuses missing files and unknown extensions", async () => {
		// Given an empty renderer root.
		const root = await mkdtemp(join(tmpdir(), "remote-static-missing-"));
		directories.push(root);
		await writeFile(join(root, "data.bin"), "x");

		// When a missing file or an unlisted extension is requested.
		const missing = await readRemoteStatic(root, "/none.js");
		const unknown = await readRemoteStatic(root, "/data.bin");

		// Then both are refused.
		expect(missing).toBeNull();
		expect(unknown).toBeNull();
	});
});
