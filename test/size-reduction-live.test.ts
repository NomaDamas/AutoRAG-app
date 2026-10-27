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
		const reducedMp4 = (await service.run([mp4], { kind: "reduceSize" }, null)).output ?? "";
		expect(reducedMp4).toBe(join(root, "clip-reduced.mp4"));
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
});
