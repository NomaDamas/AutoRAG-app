import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFileeExecutable } from "@autorag/librarian";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createActionService, type ActionService } from "../src/main/action-service";
import { createFileePdfReducer } from "../src/main/pdf-reducer";

/**
 * Live: the real action service driving the real filee-cli, ffmpeg and (macOS)
 * sips on real files. Skipped where a tool is missing. Nothing is mocked; each
 * assertion is on bytes the tools wrote.
 */
const filee = resolveFileeExecutable();
const has = (command: string): boolean => spawnSync(command, ["-version"]).status === 0;
const hasFfmpeg = has("ffmpeg");
const live = filee !== undefined && hasFfmpeg;

let root: string;
let service: ActionService;
const progressEvents: { id: string; percent: number }[] = [];

function ffmpeg(...args: string[]): void {
	const result = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);
	if (result.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${result.stderr.toString()}`);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-reduce-live-"));
	const settings = () => ({ autoInstall: false, dataDir: join(root, "filee-data"), ...(filee === undefined ? {} : { binaryPath: filee }) });
	service = createActionService({
		applications: { pick: async () => null },
		pdf: createFileePdfReducer(settings),
		onProgress: (event) => progressEvents.push(event),
	});
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

const size = async (path: string): Promise<number> => (await stat(path)).size;

describe.runIf(live)("reduceSize against the real tools", () => {
	it("offers every family this machine can shrink", async () => {
		const { reducibleExtensions } = await service.capabilities();
		for (const extension of ["pdf", "jpg", "png", "mp4", "mov", "mp3"]) expect(reducibleExtensions).toContain(extension);
	}, 60_000);

	it("shrinks a PDF, stays a readable PDF with the same pages and text, and keeps the original", async () => {
		const noise = join(root, "scan-page.jpg");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=2400x3200", "-frames:v", "1", "-q:v", "1", noise);
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		const image = await doc.embedJpg(await readFile(noise));
		for (let page = 0; page < 3; page += 1) {
			const added = doc.addPage([595, 842]);
			added.drawText(`zebra-keyword page ${page}`, { x: 40, y: 800, size: 12, font });
			added.drawImage(image, { x: 40, y: 100, width: 400, height: 300 });
		}
		const source = join(root, "scan.pdf");
		await writeFile(source, await doc.save());
		const before = await size(source);

		const outcome = await service.run([source], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "scan-reduced.pdf"));
		const output = outcome.output ?? "";
		expect(await size(output)).toBeLessThan(before / 2);
		expect(await size(source)).toBe(before);
		expect((await readFile(output)).subarray(0, 5).toString()).toBe("%PDF-");
		const reread = await PDFDocument.load(await readFile(output));
		expect(reread.getPageCount()).toBe(3);
		expect((await readdir(root)).filter((name) => name.startsWith(".dazzi-reduce-"))).toEqual([]);
	}, 120_000);

	it("shrinks a JPEG and a PNG without changing their format", async () => {
		const jpg = join(root, "photo.jpg");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1600x1200", "-frames:v", "1", "-q:v", "1", jpg);
		const reducedJpg = (await service.run([jpg], { kind: "reduceSize" }, null)).output ?? "";
		expect(reducedJpg).toBe(join(root, "photo-reduced.jpg"));
		expect(await size(reducedJpg)).toBeLessThan(await size(jpg));
		expect((await readFile(reducedJpg)).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

		const png = join(root, "shot.png");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=800x600", "-frames:v", "1", "-compression_level", "0", png);
		const reducedPng = (await service.run([png], { kind: "reduceSize" }, null)).output ?? "";
		expect(await size(reducedPng)).toBeLessThan(await size(png));
		expect((await readFile(reducedPng)).subarray(1, 4).toString()).toBe("PNG");
	}, 120_000);

	it("shrinks MP4 and MP3, keeping the container and a playable stream", async () => {
		const mp4 = join(root, "clip.mp4");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=640x480:r=24", "-f", "lavfi", "-i", "sine=f=440:d=3", "-t", "3", "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "320k", mp4);
		progressEvents.length = 0;
		const reducedMp4 = (await service.run([mp4], { kind: "reduceSize", id: "live-mp4" }, null)).output ?? "";
		expect(reducedMp4).toBe(join(root, "clip-reduced.mp4"));
		expect(progressEvents.some((event) => event.id === "live-mp4" && event.percent > 0 && event.percent <= 99)).toBe(true);
		expect(await size(reducedMp4)).toBeLessThan(await size(mp4));
		const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", reducedMp4]).stdout.toString();
		expect(probe).toContain("h264");
		expect(probe).toContain("aac");

		const mp3 = join(root, "song.mp3");
		ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=5", "-c:a", "libmp3lame", "-b:a", "320k", mp3);
		const reducedMp3 = (await service.run([mp3], { kind: "reduceSize" }, null)).output ?? "";
		expect(await size(reducedMp3)).toBeLessThan(await size(mp3));
		expect(spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", reducedMp3]).stdout.toString()).toContain("mp3");
	}, 180_000);

	it("refuses to flatten an animated PNG and leaves nothing behind", async () => {
		const apng = join(root, "anim.png");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=120x90:r=5", "-t", "1", "-plays", "0", "-f", "apng", apng);
		const before = (await readdir(root)).length;
		await expect(service.run([apng], { kind: "reduceSize" }, null)).rejects.toThrow();
		expect((await readdir(root)).length).toBe(before);
	}, 60_000);

	it("shrinks a digital-only PDF whose objects were uncompressed", async () => {
		const doc = await PDFDocument.create();
		const font = await doc.embedFont(StandardFonts.Helvetica);
		for (let page = 0; page < 15; page += 1) {
			const added = doc.addPage([595, 842]);
			for (let line = 0; line < 40; line += 1) {
				added.drawText(`Page ${page} line ${line}: digital text document stream 1234567890`, { x: 40, y: 800 - line * 16, size: 10, font });
			}
		}
		const digital = join(root, "digital.pdf");
		await writeFile(digital, await doc.save({ useObjectStreams: false }));
		const before = await size(digital);
		const outcome = await service.run([digital], { kind: "reduceSize" }, null);
		expect(outcome.output).toBe(join(root, "digital-reduced.pdf"));
		expect(await size(outcome.output ?? "")).toBeLessThan(before);
		expect((await PDFDocument.load(await readFile(outcome.output ?? ""))).getPageCount()).toBe(15);
	}, 60_000);

	it("cancels a slow real video reduction, kills ffmpeg, and leaves no partial file or staging", async () => {
		const slow = join(root, "live-slow.mp4");
		ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=60", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", slow);
		progressEvents.length = 0;
		const running = service.run([slow], { kind: "reduceSize", id: "live-cancel" }, null);
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && !progressEvents.some((event) => event.id === "live-cancel")) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		await service.cancel("live-cancel");
		await expect(running).rejects.toThrow();
		const names = await readdir(root);
		expect(names).not.toContain("live-slow-reduced.mp4");
		expect(names.filter((name) => name.startsWith(".dazzi-reduce-"))).toEqual([]);
	}, 120_000);

	it("produces strictly smaller outputs at light > balanced > max on both real PDF and real MP4, and replaces in place cleanly", async () => {
		const pageImg = join(root, "lvl-page.jpg");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=2400x3200", "-frames:v", "1", "-q:v", "1", pageImg);
		const doc = await PDFDocument.create();
		const embedded = await doc.embedJpg(await readFile(pageImg));
		for (let i = 0; i < 3; i += 1) {
			const page = doc.addPage([595, 842]);
			page.drawImage(embedded, { x: 0, y: 0, width: 595, height: 842 });
		}
		const pdfSource = join(root, "levels.pdf");
		await writeFile(pdfSource, await doc.save({ useObjectStreams: false }));
		const pdfOriginal = await size(pdfSource);

		const pdfLight = await size((await service.run([pdfSource], { kind: "reduceSize", level: "light" }, null)).output ?? "");
		const pdfBalanced = await size((await service.run([pdfSource], { kind: "reduceSize", level: "balanced" }, null)).output ?? "");
		const pdfMax = await size((await service.run([pdfSource], { kind: "reduceSize", level: "max" }, null)).output ?? "");
		expect(pdfLight).toBeLessThan(pdfOriginal);
		expect(pdfBalanced).toBeLessThan(pdfLight);
		expect(pdfMax).toBeLessThan(pdfBalanced);
		// Repeated copy-mode runs left only ONE levels-reduced.pdf, never levels-reduced 2 / 3.pdf!
		expect((await readdir(root)).filter((n) => n.startsWith("levels-reduced"))).toEqual(["levels-reduced.pdf"]);

		const vidSource = join(root, "levels.mp4");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1920x1080:r=24", "-t", "2", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", vidSource);
		const vidOriginal = await size(vidSource);
		const vidLight = await size((await service.run([vidSource], { kind: "reduceSize", level: "light" }, null)).output ?? "");
		const vidBalanced = await size((await service.run([vidSource], { kind: "reduceSize", level: "balanced" }, null)).output ?? "");
		const vidMax = await size((await service.run([vidSource], { kind: "reduceSize", level: "max" }, null)).output ?? "");
		expect(vidLight).toBeLessThan(vidOriginal);
		expect(vidBalanced).toBeLessThan(vidLight);
		expect(vidMax).toBeLessThan(vidBalanced);

		// In-place replace mode: shrinks the file at its own name with zero -reduced siblings.
		const inplace = join(root, "inplace.mp4");
		await writeFile(inplace, await readFile(vidSource));
		const replaced = await service.run([inplace], { kind: "reduceSize", level: "balanced", replaceOriginal: true }, null);
		expect(replaced.output).toBe(inplace);
		expect(await size(inplace)).toBeLessThan(vidOriginal);
		expect((await readdir(root)).filter((n) => n.startsWith("inplace"))).toEqual(["inplace.mp4"]);
	}, 180_000);

	it("genuinely shrinks already-compressed PNG, 1080p slide PDF, 2 Mbps MP4, and 128k MP3 even on light", async () => {
		// 1. Already max-deflated PNG (-compression_level 9): lossless deflate alone saves 0%, palette 256 saves 40%+.
		const deflatedPng = join(root, "deflated.png");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1000x750", "-frames:v", "1", "-compression_level", "9", deflatedPng);
		const pngOut = (await service.run([deflatedPng], { kind: "reduceSize", level: "light" }, null)).output ?? "";
		expect(await size(pngOut)).toBeLessThan((await size(deflatedPng)) * 0.75);

		// 2. 1920x1080 JPEG-slide PDF at moderate quality (q=5): light must still shrink by >= 20%.
		const slideJpg = join(root, "slide-q5.jpg");
		ffmpeg("-f", "lavfi", "-i", "mandelbrot=s=1920x1080", "-frames:v", "1", "-q:v", "5", slideJpg);
		const slideDoc = await PDFDocument.create();
		const slideImg = await slideDoc.embedJpg(await readFile(slideJpg));
		for (let i = 0; i < 4; i += 1) {
			const p = slideDoc.addPage([960, 540]);
			p.drawImage(slideImg, { x: 0, y: 0, width: 960, height: 540 });
		}
		const slidePdf = join(root, "slides-1080p.pdf");
		await writeFile(slidePdf, await slideDoc.save({ useObjectStreams: true }));
		const pdfOut = (await service.run([slidePdf], { kind: "reduceSize", level: "light" }, null)).output ?? "";
		expect(await size(pdfOut)).toBeLessThan((await size(slidePdf)) * 0.8);

		// 3. Already-compressed 2 Mbps MP4: VBV maxrate cap ensures light shrinks meaningfully.
		const tightMp4 = join(root, "tight-2m.mp4");
		ffmpeg("-f", "lavfi", "-i", "testsrc2=s=1280x720:r=30:d=4", "-c:v", "libx264", "-b:v", "2000k", "-maxrate", "2000k", "-bufsize", "4000k", "-pix_fmt", "yuv420p", tightMp4);
		const mp4Out = (await service.run([tightMp4], { kind: "reduceSize", level: "light" }, null)).output ?? "";
		expect(await size(mp4Out)).toBeLessThan((await size(tightMp4)) * 0.8);

		// 4. Already-128kbps MP3: audio header bitrate stepping shrinks on light instead of inflating to 160k/192k.
		const mp3128 = join(root, "song-128k.mp3");
		ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=6", "-c:a", "libmp3lame", "-b:a", "128k", mp3128);
		const mp3Out = (await service.run([mp3128], { kind: "reduceSize", level: "light" }, null)).output ?? "";
		expect(await size(mp3Out)).toBeLessThan((await size(mp3128)) * 0.82);
	}, 180_000);
});
