import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const exec = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const QUICK_LOOK_TOOLBAR = 52;

/** A square multi-page PDF, so the window can hug the page shape and the rail matters. */
function minimalPdf(pageCount: number): Buffer {
	const fontId = 3 + pageCount * 2;
	const kids: string[] = [];
	const parts: string[] = [];
	parts[0] = "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n";
	for (let index = 0; index < pageCount; index += 1) {
		const pageId = 3 + index * 2;
		const contentId = pageId + 1;
		const stream = `BT /F1 24 Tf 60 300 Td (Page ${index + 1}) Tj ET`;
		kids.push(`${pageId} 0 R`);
		parts[pageId - 1] = `${pageId} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 600 600]/Contents ${contentId} 0 R/Resources<</Font<</F1 ${fontId} 0 R>>>>>>endobj\n`;
		parts[contentId - 1] = `${contentId} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream\nendobj\n`;
	}
	parts[1] = `2 0 obj<</Type/Pages/Count ${pageCount}/Kids[${kids.join(" ")}]>>endobj\n`;
	parts[fontId - 1] = `${fontId} 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n`;
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const part of parts) {
		offsets.push(body.length);
		body += part;
	}
	const xrefAt = body.length;
	let xref = `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) xref += String(offset).padStart(10, "0") + " 00000 n \n";
	body += `${xref}trailer<</Size ${parts.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(body);
}

async function writeClip(path: string): Promise<void> {
	await exec("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=s=640x360:d=10", "-pix_fmt", "yuv420p", path]);
}

function quickLookWindow(app: ElectronApplication): Promise<{
	readonly visible: boolean;
	readonly resizable: boolean;
	readonly width: number;
	readonly height: number;
}> {
	return app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
		if (window === undefined) return { visible: false, resizable: false, width: 0, height: 0 };
		return { visible: window.isVisible(), resizable: window.isResizable(), width: window.getBounds().width, height: window.getBounds().height };
	});
}

/**
 * Presses a key in the Quick Look window through Electron's native input path.
 * Playwright's CDP key events skip `before-input-event`, where Quick Look
 * handles its keys, so they would not exercise what a user's keyboard does.
 */
async function pressInPreview(app: ElectronApplication, keyCode: "Space" | "Escape" | "Up" | "Down"): Promise<void> {
	await app.evaluate(({ BrowserWindow }, code) => {
		const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
		if (window === undefined) throw new Error("Quick Look window is missing");
		window.webContents.sendInputEvent({ type: "keyDown", keyCode: code });
		window.webContents.sendInputEvent({ type: "keyUp", keyCode: code });
	}, keyCode);
}

test("Quick Look uses a fast reusable window with Finder navigation", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autorag-ql-window-"));
	const evidence = "/tmp/autorag-quicklook-qa";
	await writeFile(join(dir, "photo.png"), PNG);
	await writeFile(join(dir, "note.txt"), "hello preview");
	await writeFile(join(dir, "long.txt"), Array.from({ length: 200 }, (_unused, line) => `line ${line}`).join("\n"));
	await writeFile(join(dir, "page.pdf"), minimalPdf(3));
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
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		const started = performance.now();
		await main.keyboard.press("Space");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png", { timeout: 10_000 });
		await expect.poll(() => preview.locator(".ql__image").evaluate((node) => (node instanceof HTMLImageElement ? node.naturalWidth : 0))).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(500);
		await preview.screenshot({ path: join(evidence, "photo.png") });
		// The panel is translucent: the Finder stays visible behind the window.
		expect(await preview.locator(".qlw").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(246, 246, 248, 0.72)");
		expect(await preview.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
		const photoBounds = await quickLookWindow(app);
		expect(photoBounds.visible).toBe(true);
		expect(photoBounds.resizable).toBe(true);
		expect(photoBounds.width).toBeGreaterThan(0);
		await main.keyboard.press("ArrowUp");
		await expect(preview.locator(".qlw__name")).toHaveText("page.pdf");
		await main.keyboard.press("ArrowDown");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		await main.keyboard.press("ArrowLeft");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		await preview.bringToFront();
		await pressInPreview(app, "Up");
		await expect(preview.locator(".qlw__name")).toHaveText("page.pdf");
		// Every page is on one continuous scroll: no pager, all pages reachable, rail jumps between them.
		await expect(preview.locator(".ql__paper")).toHaveCount(3);
		await expect(preview.locator(".ql__pager")).toHaveCount(0);
		await expect.poll(() => preview.locator(".ql__paper").first().evaluate((node) => node.querySelector("canvas")?.width ?? 0)).toBeGreaterThan(0);
		await expect(preview.locator(".ql__rail-item")).toHaveCount(3);
		// Rail thumbnails observe the fixed rail itself, so every visible slot paints a page preview.
		await expect(preview.locator('.ql__rail-item canvas[data-drawn="true"]')).toHaveCount(3);
		const pdfBounds = await quickLookWindow(app);
		expect(pdfBounds.width / (pdfBounds.height - QUICK_LOOK_TOOLBAR)).toBeCloseTo(1, 1);
		await expect.poll(() => preview.locator(".ql__stage").evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(600);
		await preview.locator(".ql__stage").evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		await expect.poll(() => preview.locator('[data-page="3"]').evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(pdfBounds.height);
		await expect.poll(() => preview.locator('.ql__rail-item[data-active="true"]').getAttribute("aria-label")).toBe("3페이지");
		await preview.screenshot({ path: join(evidence, "page.png") });
		// Toolbar design: close + left-aligned title, actions on the trailing edge, rail over the page's right edge.
		const layout = await preview.evaluate(() => {
			const name = document.querySelector(".qlw__name")?.getBoundingClientRect();
			const trail = document.querySelector(".qlw__trail")?.getBoundingClientRect();
			const rail = document.querySelector(".ql__rail");
			const railBox = rail?.getBoundingClientRect();
			return {
				width: window.innerWidth,
				nameLeft: name?.left ?? -1,
				nameRight: name?.right ?? -1,
				trailRight: trail?.right ?? -1,
				railRight: railBox?.right ?? -1,
				railWidth: railBox?.width ?? -1,
				railBlur: rail === null ? "" : getComputedStyle(rail).backdropFilter,
			};
		});
		expect(layout.nameLeft).toBeLessThan(120);
		expect(layout.nameRight).toBeLessThan(layout.width / 2);
		expect(layout.trailRight).toBeGreaterThan(layout.width - 40);
		expect(layout.railRight).toBeCloseTo(layout.width - 12, 0);
		expect(layout.railWidth).toBe(104);
		expect(layout.railBlur).toContain("blur");
		await preview.locator(".ql__rail-item").first().click();
		await expect.poll(() => preview.locator(".ql__stage").evaluate((node) => node.scrollTop)).toBeLessThan(QUICK_LOOK_TOOLBAR);
		await preview.screenshot({ path: join(evidence, "page-top.png") });
		await pressInPreview(app, "Down");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		// Text hugs its own height instead of filling a page-shaped window.
		await main.getByRole("row", { name: /note\.txt/ }).click();
		await expect(preview.locator(".qlw__name")).toHaveText("note.txt");
		await expect.poll(() => preview.locator(".ql__stage").evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
		const noteBounds = await quickLookWindow(app);
		expect(noteBounds.height).toBeGreaterThanOrEqual(240);
		expect(noteBounds.height).toBeLessThan(320);
		await preview.screenshot({ path: join(evidence, "note.png") });
		await main.getByRole("row", { name: /long\.txt/ }).click();
		await expect(preview.locator(".qlw__name")).toHaveText("long.txt");
		await expect.poll(async () => (await quickLookWindow(app)).height).toBeGreaterThan(noteBounds.height + 100);
		await expect.poll(() => preview.locator(".ql__stage").evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(600);
		await preview.screenshot({ path: join(evidence, "long.png") });
		await main.getByRole("row", { name: /clip\.mp4/ }).click();
		await expect(preview.locator(".qlw__name")).toHaveText("clip.mp4");
		await expect
			.poll(() =>
				preview.locator("video").evaluate((node) => node instanceof HTMLVideoElement && !node.paused && node.currentTime > 0),
			)
			.toBe(true);
		await preview.screenshot({ path: join(evidence, "video.png") });
		// The stream answers byte ranges, so the media pipeline can seek the whole clip.
		await expect.poll(() => preview.locator("video").evaluate((node) => (node instanceof HTMLVideoElement && node.seekable.length > 0 ? node.seekable.end(0) : 0))).toBeGreaterThan(9);
		await preview.locator("video").evaluate((node) => {
			if (node instanceof HTMLVideoElement) node.currentTime = 7;
		});
		await expect.poll(() => preview.locator("video").evaluate((node) => (node instanceof HTMLVideoElement ? node.currentTime : 0))).toBeGreaterThanOrEqual(7);
		const resized = await app.evaluate(({ BrowserWindow }) => {
			const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"));
			if (window === undefined) return null;
			const before = window.getBounds();
			window.setSize(before.width + 120, before.height + 80);
			return { before, after: window.getBounds() };
		});
		expect(resized?.after.width).toBe((resized?.before.width ?? 0) + 120);
		expect(resized?.after.height).toBe((resized?.before.height ?? 0) + 80);
		await preview.screenshot({ path: join(evidence, "resized.png") });
		await pressInPreview(app, "Escape");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
		await main.keyboard.press("Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(true);
		await preview.bringToFront();
		await pressInPreview(app, "Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
		// A focused video's native controls swallow Space; it must still close the preview.
		await main.keyboard.press("Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(true);
		await preview.bringToFront();
		const video = await preview.locator("video").boundingBox();
		if (video === null) throw new Error("video has no box");
		await preview.mouse.click(video.x + video.width / 2, video.y + video.height - 20);
		await expect.poll(() => preview.evaluate(() => document.activeElement?.tagName)).toBe("VIDEO");
		await pressInPreview(app, "Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
