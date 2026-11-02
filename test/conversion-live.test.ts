import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFileeFormats, resolveFileeExecutable } from "@autorag/librarian";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFileeConversionService } from "../src/main/conversion-service";
import { planConversion } from "../src/main/conversion-plan";
import { parseFormatTargets } from "../src/main/filee-formats";
import { t } from "../src/shared/i18n/core";

/**
 * Live: the real filee-cli and the real ffmpeg it drives. Skipped where either
 * is missing. Nothing is mocked: a cancel must end the actual process tree.
 */
const filee = resolveFileeExecutable();
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const live = process.platform !== "win32" && filee !== undefined && hasFfmpeg;

let root: string;
let dataDir: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "dazzi-convert-live-"));
	dataDir = join(root, "filee-data");
});
afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

/** pids of programs whose command line mentions `needle` (the fixture folder is unique to this run). */
function pidsMatching(needle: string): number[] {
	const out = spawnSync("pgrep", ["-f", needle], { encoding: "utf8" }).stdout;
	return out
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => pid > 0 && pid !== process.pid);
}

describe.runIf(live)("convert-on-rename against the real filee-cli", () => {
	const service = () =>
		createFileeConversionService(() => ({
			autoInstall: false,
			dataDir,
			...(filee === undefined ? {} : { binaryPath: filee }),
		}));

	it("converts a real file", async () => {
		const path = join(root, "note.txt");
		await writeFile(path, "hello\n");
		const outcome = await service().run({ id: "live-ok", path, newName: "note.pdf" });
		expect(outcome.output).toBe(join(root, "note.pdf"));
		expect((await readdir(root)).filter((name) => name.startsWith(".dazzi-convert-"))).toEqual([]);
	}, 60_000);

	it("the route table never promises a conversion filee-cli does not list", async () => {
		const pairs: ReadonlyArray<readonly [string, string]> = [["txt", "pdf"], ["docx", "svg"], ["png", "jpeg"], ["mp4", "webm"], ["heif", "jpg"], ["htm", "md"]];
		for (const [from, to] of pairs) {
			expect(planConversion(`a.${from}`, `a.${to}`).kind).toBe("convert");
			const listed = parseFormatTargets(await listFileeFormats(from, { executable: filee as string }));
			expect(listed?.has(to === "jpeg" ? "jpg" : to), `${from} -> ${to}`).toBe(true);
		}
	}, 60_000);

	it("fails a route filee does not have, at once and with nothing on disk", async () => {
		const path = join(root, "plain.txt");
		await writeFile(path, "x");
		const started = Date.now();
		await expect(service().run({ id: "live-no", path, newName: "plain.mp4" })).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(3000);
		expect((await readdir(root)).filter((name) => name.startsWith(".dazzi-convert-"))).toEqual([]);
	});

	it("cancel stops the running filee, the ffmpeg under it, and leaves no partial output", async () => {
		const folder = join(root, "cancel-run");
		await mkdir(folder);
		const clip = join(folder, "big.mp4");
		execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=90", "-c:v", "libx264", "-preset", "ultrafast", clip]);
		expect(existsSync(clip)).toBe(true);

		const converter = service();
		const outcome = converter.run({ id: "live-cancel", path: clip, newName: "big.webm" });
		const settled = outcome.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);

		// Wait until the real ffmpeg is encoding this very file. The condition lives in another OS
		// process, so no fake clock can observe it: bounded polling is the only option.
		const deadline = Date.now() + 30_000;
		while (pidsMatching(clip).length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
		const before = pidsMatching(clip);
		expect(before.length).toBeGreaterThanOrEqual(2);

		const cancelledAt = Date.now();
		await converter.cancel("live-cancel");
		expect(await settled).toBe(t("main.convert.cancelled", { name: "big.mp4" }));
		expect(Date.now() - cancelledAt).toBeLessThan(10_000);

		expect(pidsMatching(clip)).toEqual([]);
		expect(await readdir(folder)).toEqual(["big.mp4"]);
	}, 120_000);
});
