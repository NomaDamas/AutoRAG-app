/**
 * Manual QA — Quick Look plays .avi videos.
 *
 * Chromium has no AVI demuxer, so Space on an .avi used to land on the "couldn't
 * play the video" card whatever the codecs. Main now rewrites the file with
 * ffmpeg into an MP4 in its cache and the panel plays that, showing the progress
 * meanwhile. Builds clips with the system ffmpeg, drives the production build
 * (`bun run build` first), opens each with Space in the real Quick Look window
 * and checks what the media pipeline really did:
 *
 *   - xvid + mp3, h264 + mp3, h264 + AC-3 and a silent avi: the video plays (time
 *     advances, picture decoded), decodes its own sound when the file has any,
 *     and seeks with ArrowRight.
 *   - the played source is the cached copy, not the avi; the cache holds one MP4
 *     per file; opening a file again plays it from the cache without a progress
 *     screen.
 *   - a long avi shows "Preparing the video…" with a rising percentage first;
 *     closing the panel meanwhile stops ffmpeg and leaves no partial output.
 *   - a file named .avi that is not a video falls back to the "couldn't play" card.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
	console.log("SKIP  ffmpeg is not installed");
	process.exit(0);
}

const EVIDENCE = process.argv[2] ?? process.env.QA_OUT ?? "/tmp/autorag-quicklook-video-avi";
mkdirSync(EVIDENCE, { recursive: true });
/** Hang ceilings, not speed gates. */
const OPEN_MS = 30_000;
const PREPARE_MS = 120_000;

const results = [];
function check(label, pass, detail = "") {
	results.push({ label, pass });
	console.log(`${pass ? "PASS" : "FAIL"}  ${label}${detail === "" ? "" : `  (${detail})`}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function poll(read, accept, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!accept(value) && Date.now() < deadline) {
		await sleep(50);
		value = await read();
	}
	return value;
}

const root = mkdtempSync(join(tmpdir(), "autorag-ql-avi-"));
const userDataDir = mkdtempSync(join(tmpdir(), "autorag-ql-avi-data-"));
const SECONDS = 40;
const picture = (seconds, size = "320x180") => ["-f", "lavfi", "-i", `testsrc=size=${size}:rate=24:duration=${seconds}`];
const tone = (seconds) => ["-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}:sample_rate=48000`];
const make = (name, input, codecs) => execFileSync("ffmpeg", ["-v", "error", "-y", ...input, ...codecs, join(root, name)]);

try {
	make("xvid-mp3.avi", [...picture(SECONDS), ...tone(SECONDS)], ["-c:v", "mpeg4", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame"]);
	make("h264-mp3.avi", [...picture(SECONDS), ...tone(SECONDS)], ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "libmp3lame"]);
	make("h264-ac3.avi", [...picture(SECONDS), ...tone(SECONDS)], ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "ac3", "-ac", "6"]);
	make("silent.avi", picture(SECONDS), ["-c:v", "mpeg4", "-an"]);
	make("long-hd.avi", [...picture(600, "1280x720"), ...tone(600)], ["-c:v", "mpeg4", "-q:v", "3", "-c:a", "libmp3lame"]);
	writeFileSync(join(root, "bogus.avi"), "this is not a video");

	const app = await launchFinder({ userDataDir, env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
	try {
		const main = await finderWindow(app, OPEN_MS);
		const preview = await poll(
			() => app.windows().find((candidate) => candidate.url().includes("quick-look.html")),
			(candidate) => candidate !== undefined,
			OPEN_MS,
		);
		if (preview === undefined) throw new Error("Quick Look window did not pre-warm");
		const cacheDir = join(await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData")), "video-playback");

		const snapshot = () =>
			preview
				.evaluate(() => {
					const video = document.querySelector("video");
					const text = document.body.innerText;
					return {
						text,
						video:
							video === null
								? null
								: {
										src: video.getAttribute("src"),
										time: video.currentTime,
										duration: video.duration,
										paused: video.paused,
										width: video.videoWidth,
										native: video.webkitAudioDecodedByteCount,
										error: video.error?.message ?? null,
									},
					};
				})
				.catch(() => null);

		const open = async (name) => {
			const row = main.getByRole("row", { name: new RegExp(escapeRegExp(name)) }).first();
			await row.waitFor({ timeout: 60_000 });
			await row.click();
			await main.keyboard.press("Space");
		};
		const close = async () => {
			await main.keyboard.press("Space");
			await poll(
				() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible())),
				(visible) => visible === false,
				5000,
			);
		};
		const cached = () => readdirSync(cacheDir).filter((entry) => entry.endsWith(".mp4"));

		for (const [name, hasSound] of [
			["xvid-mp3.avi", true],
			["h264-mp3.avi", true],
			["h264-ac3.avi", true],
			["silent.avi", false],
		]) {
			await open(name);
			const playing = await poll(snapshot, (state) => state?.video != null && !state.video.paused && state.video.time > 1, PREPARE_MS);
			await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
			const video = playing?.video ?? null;
			check(`${name}: the video plays`, video !== null && !video.paused && video.time > 1 && video.error === null, JSON.stringify(video));
			check(`${name}: the picture is decoded`, (video?.width ?? 0) > 0, `width ${video?.width}`);
			check(`${name}: the player's source is a cached copy, not the avi`, (video?.src ?? "").includes(encodeURIComponent(cacheDir)) && !(video?.src ?? "").includes(".avi"), video?.src ?? "");
			if (hasSound) {
				const heard = await poll(snapshot, (state) => (state?.video?.native ?? 0) > 0, 10_000);
				check(`${name}: the video decodes its own sound`, (heard?.video?.native ?? 0) > 0, `native bytes ${heard?.video?.native}`);
			}
			const before = (await snapshot())?.video?.time ?? 0;
			await preview.keyboard.press("ArrowRight");
			await preview.keyboard.press("ArrowRight");
			const after = await poll(snapshot, (state) => state?.video != null && state.video.time > before + 8 && !state.video.paused, 10_000);
			check(`${name}: seeking forward lands and keeps playing`, after?.video != null && after.video.time > before + 8 && !after.video.paused, JSON.stringify(after?.video));
			await close();
		}
		check("the cache holds one MP4 per avi played", cached().length === 4, cached().join(", "));

		// A second opening plays from the cache: no progress screen.
		const reopenStarted = Date.now();
		await open("xvid-mp3.avi");
		let sawProgress = false;
		const replay = await poll(
			async () => {
				const state = await snapshot();
				if (state?.text.includes("Preparing the video")) sawProgress = true;
				return state;
			},
			(state) => state?.video != null && !state.video.paused && state.video.time > 0.5,
			PREPARE_MS,
		);
		check("a second opening plays from the cache without a progress screen", replay?.video != null && !sawProgress, `${Date.now() - reopenStarted} ms`);
		await close();

		// A long file: progress first, then closing stops the work.
		await open("long-hd.avi");
		const percents = [];
		await poll(
			async () => {
				const state = await snapshot();
				const match = /Preparing the video to play… (\d+)%/.exec(state?.text ?? "");
				if (match !== null) percents.push(Number(match[1]));
				return percents.length > 0 && percents.at(-1) >= 8;
			},
			(done) => done === true,
			PREPARE_MS,
		);
		await preview.screenshot({ path: join(EVIDENCE, "long-hd-preparing.png") });
		check("a long avi shows a rising percentage while it is prepared", percents.length > 1 && percents.at(-1) > percents[0], percents.join(","));
		// `pgrep` has no Windows counterpart in the lanes' toolbox.
		const pids = () => (process.platform === "win32" ? null : spawnSync("pgrep", ["-f", "ffmpeg .*long-hd.avi"]).stdout.toString().trim());
		if (pids() !== null) check("ffmpeg is working on it", pids() !== "", `pids ${pids()}`);
		await close();
		const leftover = await poll(
			() => pids() ?? "",
			(pids) => pids === "",
			8000,
		);
		check("closing the panel stops ffmpeg", leftover === "", `pids ${leftover}`);
		check("no partial output or copy of the abandoned file is left", readdirSync(cacheDir).every((entry) => !entry.endsWith(".part")) && cached().length === 4, readdirSync(cacheDir).join(", "));

		// Not a video at all: the usual failure card, not a hang on the progress screen.
		await open("bogus.avi");
		const failure = await poll(snapshot, (state) => /play the video/.test(state?.text ?? ""), PREPARE_MS);
		await preview.screenshot({ path: join(EVIDENCE, "bogus.png") });
		check("a file that is not a video shows the could-not-play card", /play the video/.test(failure?.text ?? ""), failure?.text.slice(0, 80));
		await close();
	} finally {
		await app.close();
	}
} finally {
	rmSync(root, { recursive: true, force: true });
	rmSync(userDataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
