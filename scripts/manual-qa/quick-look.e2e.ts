import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";

const exec = promisify(execFile);
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function minimalPdf(): Buffer {
	const objects = [
		"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
		"2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n",
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
		"4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Hello PDF) Tj ET\nendstream\nendobj\n",
		"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
	];
	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (const object of objects) {
		offsets.push(body.length);
		body += object;
	}
	const xrefAt = body.length;
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(body);
}

async function writeClip(path: string): Promise<void> {
	await exec("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=160x120:d=0.3", "-pix_fmt", "yuv420p", path]);
}

function pgrep(pattern: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("pgrep", ["-f", pattern], (error) => resolve(error === null));
	});
}

test("space grows an in-app quick look from the file row", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autorag-ql-"));
	const evidence = "/tmp/autorag-quicklook-qa";
	await mkdir(evidence, { recursive: true });
	await writeFile(join(dir, "photo.png"), PNG);
	await writeFile(join(dir, "note.txt"), "hello preview");
	await writeFile(join(dir, "page.pdf"), minimalPdf());
	await writeClip(join(dir, "clip.mp4"));
	const app = await electron.launch({
		args: ["."],
		cwd: process.cwd(),
		env: { ...process.env, AUTORAG_QA_ROOT: dir, AUTORAG_SKIP_DUPEY_CHECK: "1" },
	});
	try {
		const page = await app.firstWindow();
		const row = page.getByRole("row", { name: /photo\.png/ });
		await row.waitFor({ timeout: 30_000 });
		await row.click();
		const box = await row.boundingBox();
		if (box === null) throw new Error("photo row has no box");
		await page.keyboard.press("Space");
		const panel = page.locator(".ql__panel");
		await expect(panel).toHaveAttribute("data-quicklook-state", "open", { timeout: 10_000 });
		const originX = Number(await panel.getAttribute("data-origin-x"));
		const originY = Number(await panel.getAttribute("data-origin-y"));
		expect(Math.abs(originX - (box.x + box.width / 2))).toBeLessThan(3);
		expect(Math.abs(originY - (box.y + box.height / 2))).toBeLessThan(3);
		await expect(page.getByRole("dialog", { name: "photo.png" })).toBeVisible();
		await expect
			.poll(async () => page.locator(".ql__image").evaluate((node) => (node instanceof HTMLImageElement ? node.naturalWidth : 0)))
			.toBeGreaterThan(0);
		await page.screenshot({ path: join(evidence, "photo.png") });
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByRole("dialog", { name: "page.pdf" })).toBeVisible();
		await expect(page.locator("canvas.ql__canvas")).toBeVisible({ timeout: 15_000 });
		await page.screenshot({ path: join(evidence, "pdf.png") });
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByRole("dialog", { name: "note.txt" })).toBeVisible();
		await expect(page.locator(".ql__pre")).toContainText("hello preview");
		await page.keyboard.press("ArrowLeft");
		await expect(page.getByRole("dialog", { name: "clip.mp4" })).toBeVisible();
		await expect(page.locator("video")).toBeVisible();
		await page.screenshot({ path: join(evidence, "video.png") });
		await page.keyboard.press("Escape");
		await expect(page.locator(".ql__panel")).toHaveCount(0);
		expect(await pgrep("qlmanage -p")).toBe(false);
	} finally {
		await app.close();
		await rm(dir, { recursive: true, force: true });
	}
});
