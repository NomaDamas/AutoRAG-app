import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const exec = promisify(execFile);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const QUICK_LOOK_TOOLBAR = 46;
/** PDF panel geometry: 56px of panel either side of the page and the 128px page rail. */
const PDF_CHROME_WIDTH = 56 * 2 + 128;

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
		// Record the panel's transform and curve every frame so the Finder-style zoom can be checked.
		await preview.evaluate(() => {
			const samples: string[] = [];
			const easings: string[] = [];
			const tick = (): void => {
				const root = document.getElementById("root");
				if (root?.dataset.zoom !== undefined) {
					samples.push(`${root.dataset.zoom} ${getComputedStyle(root).transform}`);
					const easing = root.getAnimations()[0]?.effect?.getTiming().easing;
					if (typeof easing === "string" && easings.at(-1) !== easing) easings.push(easing);
				}
				document.body.dataset.zoomSamples = samples.join("|");
				document.body.dataset.zoomEasings = easings.join("|");
				requestAnimationFrame(tick);
			};
			tick();
		});
		const icon = await row.locator(".tile").boundingBox();
		const started = performance.now();
		await main.keyboard.press("Space");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png", { timeout: 10_000 });
		await expect.poll(() => preview.locator(".ql__image").evaluate((node) => (node instanceof HTMLImageElement ? node.naturalWidth : 0))).toBeGreaterThan(0);
		expect(performance.now() - started).toBeLessThan(500);
		// Finder zoom: the panel grows out of the icon on Apple's spring curve.
		await expect.poll(() => preview.evaluate(() => document.getElementById("root")?.dataset.zoom ?? "settled")).toBe("settled");
		const easings = await preview.evaluate(() => (document.body.dataset.zoomEasings ?? "").split("|").filter((entry) => entry.length > 0));
		expect(easings.length).toBeGreaterThan(0);
		expect(easings.every((easing) => easing.startsWith("linear("))).toBe(true);
		const opening = await preview.evaluate(() =>
			(document.body.dataset.zoomSamples ?? "")
				.split("|")
				.filter((sample) => sample.startsWith("in matrix("))
				.map((sample) => Number(sample.slice("in matrix(".length).split(",")[0])),
		);
		expect(opening.length).toBeGreaterThan(3);
		expect(Math.min(...opening)).toBeLessThan(0.5);
		expect(opening.at(-1) ?? 0).toBeGreaterThan(0.95);
		expect(opening.every((scale, index) => index === 0 || scale >= (opening[index - 1] ?? 0) - 0.005)).toBe(true);
		const zoomed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("quick-look.html"))?.isVisible());
		expect(zoomed).toBe(true);
		expect(icon).not.toBeNull();
		await preview.screenshot({ path: join(evidence, "photo.png") });
		// The panel is translucent: the Finder stays visible behind the window, and
		// nothing of the page paints a backdrop of its own over the Finder.
		expect(await preview.locator(".qlw").evaluate((node) => getComputedStyle(node).backgroundColor)).toBe("rgba(242, 242, 244, 0.72)");
		const backgrounds = await preview.evaluate(() => ({
			html: getComputedStyle(document.documentElement).backgroundColor,
			body: getComputedStyle(document.body).backgroundColor,
			root: getComputedStyle(document.getElementById("root") ?? document.body).backgroundColor,
		}));
		expect(backgrounds).toEqual({ html: "rgba(0, 0, 0, 0)", body: "rgba(0, 0, 0, 0)", root: "rgba(0, 0, 0, 0)" });
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
		// Rail thumbnails observe the rail itself, so every visible slot paints a page preview.
		await expect(preview.locator('.ql__rail-item [data-drawn="true"]')).toHaveCount(3);
		const pdfBounds = await quickLookWindow(app);
		// The window is the page's width plus the paper margins and the rail.
		expect(pdfBounds.width).toBe(600 + PDF_CHROME_WIDTH);
		const scroller = preview.locator(".ql-pdf__scroll");
		// Three pages are taller than the screen allows, so the column scrolls.
		await expect.poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(100);
		await scroller.evaluate((node) => {
			node.scrollTop = node.scrollHeight;
		});
		await expect.poll(() => preview.locator('[data-page="3"]').evaluate((node) => node.getBoundingClientRect().bottom)).toBeLessThanOrEqual(pdfBounds.height);
		await expect.poll(() => preview.locator('.ql__rail-item[data-active="true"]').getAttribute("aria-label")).toBe("3페이지로 이동");
		await expect(preview.locator(".ql-pdf__pill")).toContainText("3 / 3");
		await preview.screenshot({ path: join(evidence, "page.png") });
		// Toolbar design: close, full screen, then the title; share and "Open with" on the trailing edge; the rail in its own column.
		const layout = await preview.evaluate(() => {
			const box = (selector: string): DOMRect | undefined => document.querySelector(selector)?.getBoundingClientRect();
			const rail = box(".ql__rail");
			return {
				width: window.innerWidth,
				nameLeft: box(".qlw__name")?.left ?? -1,
				openRight: box(".qlw__open")?.right ?? -1,
				share: document.querySelector('button[aria-label="공유"]') !== null,
				railLeft: rail?.left ?? -1,
				railRight: rail?.right ?? -1,
				railWidth: rail?.width ?? -1,
				pagesRight: Math.max(...Array.from(document.querySelectorAll(".ql__paper"), (node) => node.getBoundingClientRect().right)),
			};
		});
		expect(layout.nameLeft).toBeLessThan(120);
		expect(layout.openRight).toBeGreaterThan(layout.width - 20);
		expect(layout.share).toBe(process.platform === "darwin");
		expect(layout.railRight).toBe(layout.width);
		expect(layout.railWidth).toBe(128);
		expect(layout.pagesRight).toBeLessThanOrEqual(layout.railLeft);
		await preview.locator(".ql__rail-item").first().click();
		await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeLessThan(QUICK_LOOK_TOOLBAR);
		await preview.screenshot({ path: join(evidence, "page-top.png") });
		await pressInPreview(app, "Down");
		await expect(preview.locator(".qlw__name")).toHaveText("photo.png");
		// Text hugs its own height instead of filling a page-shaped window.
		await main.getByRole("row", { name: /note\.txt/ }).click();
		await expect(preview.locator(".qlw__name")).toHaveText("note.txt");
		await expect.poll(() => preview.locator(".ql-lines").evaluate((node) => node.scrollHeight - node.clientHeight)).toBe(0);
		const noteBounds = await quickLookWindow(app);
		expect(noteBounds.height).toBeGreaterThanOrEqual(240);
		expect(noteBounds.height).toBeLessThan(320);
		await preview.screenshot({ path: join(evidence, "note.png") });
		await main.getByRole("row", { name: /long\.txt/ }).click();
		await expect(preview.locator(".qlw__name")).toHaveText("long.txt");
		await expect.poll(async () => (await quickLookWindow(app)).height).toBeGreaterThan(noteBounds.height + 100);
		await expect.poll(() => preview.locator(".ql-lines").evaluate((node) => node.scrollHeight - node.clientHeight)).toBeGreaterThan(600);
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
		await preview.evaluate(() => {
			document.body.dataset.zoomSamples = "";
		});
		await pressInPreview(app, "Escape");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
		// Closing shrinks the panel back toward the icon before the window hides.
		const closing = await preview.evaluate(() =>
			(document.body.dataset.zoomSamples ?? "")
				.split("|")
				.filter((sample) => sample.startsWith("out matrix("))
				.map((sample) => Number(sample.slice("out matrix(".length).split(",")[0])),
		);
		expect(closing.length).toBeGreaterThan(2);
		expect(Math.min(...closing)).toBeLessThan(0.5);
		await main.keyboard.press("Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(true);
		await preview.bringToFront();
		await pressInPreview(app, "Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
		// A focused control would take Space as a click; the preview must still close.
		await main.keyboard.press("Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(true);
		await preview.bringToFront();
		await expect.poll(() => preview.evaluate(() => document.getElementById("root")?.dataset.zoom ?? "settled")).toBe("settled");
		await preview.locator('.ql-hud button[aria-label="15초 뒤로"]').focus();
		await expect.poll(() => preview.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("15초 뒤로");
		await pressInPreview(app, "Space");
		await expect.poll(async () => (await quickLookWindow(app)).visible).toBe(false);
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
