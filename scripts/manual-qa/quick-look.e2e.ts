import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";

const exec = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function minimalPdf(): Buffer {
	const objects = ["1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n", "2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n", "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n", "4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n", "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const object of objects) { offsets.push(body.length); body += object; }
	const xrefAt = body.length;
	let xref = "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
	for (const offset of offsets.slice(1)) xref += String(offset).padStart(10, "0") + " 00000 n \n";
	body += xref + "trailer<</Size " + (objects.length + 1) + "/Root 1 0 R>>\nstartxref\n" + xrefAt + "\n%%EOF\n";
	return Buffer.from(body);
}

async function writeClip(path: string): Promise<void> { await exec("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=640x360:d=3", "-pix_fmt", "yuv420p", path]); }

test("Quick Look uses a fast reusable window with Finder navigation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autorag-ql-window-"));
	const evidence = "/tmp/autorag-quicklook-qa";
	await writeFile(join(dir, "photo.png"), PNG);
	await writeFile(join(dir, "note.txt"), "hello preview");
	await writeFile(join(dir, "page.pdf"), minimalPdf());
	await writeClip(join(dir, "clip.mp4"));
	const app = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, AUTORAG_QA_ROOT: dir, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
	try {
		const main =
			app.windows().find((page) => page.url().endsWith("/index.html")) ??
			(await app.waitForEvent("window", { predicate: (page) => page.url().endsWith("/index.html"), timeout: 30_000 }));
		const preview =
			app.windows().find((page) => page.url().includes("quick-look.html")) ??
			(await app.waitForEvent("window", { predicate: (page) => page.url().includes("quick-look.html"), timeout: 30_000 }));
		const row = main.getByRole("row", { name: /photo\.png/ });
		await row.waitFor({ timeout: 30_000 }); await row.click();
		const started = performance.now(); await main.keyboard.press("Space");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png", { timeout: 10_000 });
		await expect.poll(() => preview.locator(".ql__image").evaluate((node) => (node instanceof HTMLImageElement ? node.naturalWidth : 0))).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(500);
		await preview.screenshot({ path: join(evidence, "photo.png") });
		const state = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html")); return w === undefined ? null : { visible: w.isVisible(), resizable: w.isResizable(), bounds: w.getBounds() }; });
		expect(state?.visible).toBe(true); expect(state?.resizable).toBe(true);
		await main.keyboard.press("ArrowUp"); await expect(preview.locator(".qlw__name")).toHaveText("page.pdf");
		await main.keyboard.press("ArrowDown"); await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		await main.keyboard.press("ArrowLeft"); await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		await preview.bringToFront();
		await preview.keyboard.press("ArrowUp"); await expect(preview.locator(".qlw__name")).toHaveText("page.pdf");
		await preview.keyboard.press("ArrowDown"); await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		await main.getByRole("row", { name: /clip\.mp4/ }).click(); await expect(preview.locator(".qlw__name")).toHaveText("clip.mp4");
		await expect
			.poll(() =>
				preview.locator("video").evaluate((node) => node instanceof HTMLVideoElement && !node.paused && node.currentTime > 0),
			)
			.toBe(true);
		await preview.screenshot({ path: join(evidence, "video.png") });
		const resized = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html")); if (w === undefined) return null; const before = w.getBounds(); w.setSize(before.width + 120, before.height + 80); return { before, after: w.getBounds() }; });
		expect(resized?.after.width).toBe((resized?.before.width ?? 0) + 120); expect(resized?.after.height).toBe((resized?.before.height ?? 0) + 80);
		await preview.screenshot({ path: join(evidence, "resized.png") });
		await preview.keyboard.press("Escape"); await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false)).toBe(false);
		await main.keyboard.press("Space");
		await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false)).toBe(true);
		await preview.bringToFront();
		await preview.keyboard.press("Space");
		await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("quick-look.html"))?.isVisible() ?? false)).toBe(false);
	} finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
