/**
 * Manual QA — sound in Quick Look for videos whose audio Chromium cannot decode.
 *
 * Space on an mkv/mp4 with AC-3, E-AC-3 or DTS audio used to show the picture and
 * play nothing (the element reported no error and decoded 0 audio bytes). The
 * panel now plays that track through ffmpeg beside the video. Builds clips with
 * the system ffmpeg, drives the production build (`bun run build` first), opens
 * each with Space in the real Quick Look window, and checks what the media
 * pipeline really decoded, not what the script assumes:
 *
 *   - AC-3 / E-AC-3 / DTS clips: a sidecar `<audio>` exists, is playing, has decoded
 *     audio bytes, the video's own decoder stays silent (no doubled sound), and the
 *     two sit within a fraction of a second of each other, also after a seek
 *     (ArrowRight) and a pause/resume through the HUD button.
 *   - an AAC clip: no sidecar is made (the video decodes its own sound).
 *   - a clip with no audio: no sidecar, no error.
 *   - closing the panel leaves no ffmpeg decoding.
 *
 * `QA_VIDEO_DIR=<folder>` additionally plays the first video files of a real
 * folder (e.g. a TV-series rip with AC-3 5.1) in a second session rooted there;
 * `QA_VIDEO_COUNT` (default 2) limits it.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finderWindow, launchFinder } from "./launch-finder.mjs";

if (spawnSync("ffmpeg", ["-version"]).status !== 0) {
	console.log("SKIP  ffmpeg is not installed");
	process.exit(0);
}

const EVIDENCE = process.argv[2] ?? "/tmp/autorag-quicklook-video-audio";
mkdirSync(EVIDENCE, { recursive: true });
/** Hang ceilings, not speed gates. */
const OPEN_MS = 30_000;
const DECODE_MS = 20_000;
/** Audio and video are in step when they sit this close (seconds). */
const IN_STEP = 0.5;

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

const inStep = (state) => state?.audio != null && Math.abs(state.audio.time - state.video.time) < IN_STEP;

/** One app session rooted at `root`, exercising each `{ name, expectation }` in it. */
async function session(root, items) {
	const app = await launchFinder({ env: { AUTORAG_QA_ROOT: root, AUTORAG_SKIP_DUPEY_CHECK: "1" } });
	try {
		const main = await finderWindow(app, OPEN_MS);
		const preview = await poll(
			() => app.windows().find((candidate) => candidate.url().includes("quick-look.html")),
			(candidate) => candidate !== undefined,
			OPEN_MS,
		);
		if (preview === undefined) throw new Error("Quick Look window did not pre-warm");

		// Observe only: remember every `new Audio()` the panel makes so its decoder counters can be read.
		await preview.evaluate(() => {
			const Original = window.Audio;
			window.__sidecars = [];
			window.Audio = function Audio(...args) {
				const element = new Original(...args);
				window.__sidecars.push(element);
				return element;
			};
			window.Audio.prototype = Original.prototype;
		});

		const snapshot = () =>
			preview
				.evaluate(() => {
					const video = document.querySelector("video");
					if (video === null) return null;
					const audio = window.__sidecars.at(-1) ?? null;
					return {
						video: { time: video.currentTime, paused: video.paused, native: video.webkitAudioDecodedByteCount, error: video.error?.message ?? null },
						sidecars: window.__sidecars.length,
						audio: audio === null ? null : { time: audio.currentTime, paused: audio.paused, decoded: audio.webkitAudioDecodedByteCount, error: audio.error?.message ?? null },
					};
				})
				.catch(() => null);

		for (const { name, expectation } of items) {
			await preview.evaluate(() => {
				window.__sidecars.length = 0;
			});
			const row = main.getByRole("row", { name: new RegExp(escapeRegExp(name)) }).first();
			await row.waitFor({ timeout: 60_000 }).catch(() => undefined);
			if ((await row.count()) === 0) {
				check(`${name}: found in the Finder`, false, root);
				continue;
			}
			await row.click();
			await main.keyboard.press("Space");

			const playing = await poll(snapshot, (state) => state !== null && !state.video.paused && state.video.time > 1, DECODE_MS);
			await preview.screenshot({ path: join(EVIDENCE, `${name}.png`) });
			if (playing === null && (await preview.getByText(/play the video/).count()) > 0) {
				// The panel's own error card: the picture itself cannot be decoded (a damaged stream), which the audio path cannot touch.
				// Reported, never counted as a pass; `main` without the sidecar fails on such a file the same way.
				console.log(`SKIP  ${name}: the video stream itself cannot be decoded (damaged file); nothing to hear`);
				await main.keyboard.press("Space");
				continue;
			}
			check(`${name}: the video plays`, playing !== null && !playing.video.paused && playing.video.time > 1, JSON.stringify(playing?.video));

			if (expectation === "sidecar" || expectation === "real") {
				const heard = await poll(snapshot, (state) => state?.audio != null && !state.audio.paused && state.audio.decoded > 0, DECODE_MS);
				const decodes = heard?.audio != null && !heard.audio.paused && heard.audio.decoded > 0;
				if (expectation === "real" && heard?.sidecars === 0 && (heard.video.native ?? 0) > 0) {
					// A file whose audio the page decodes itself needs no sidecar; that is the correct outcome, not a failure.
					check(`${name}: the video decodes its own sound (no sidecar needed)`, true, `native bytes ${heard.video.native}`);
				} else {
					check(`${name}: the sidecar plays and has decoded audio`, decodes, JSON.stringify(heard));
					check(`${name}: the video's own decoder stays silent, so the sound is not doubled`, heard?.video.native === 0, `native bytes ${heard?.video.native}`);
					if (decodes) {
						check(`${name}: audio and video are in step`, inStep(heard), heard.audio === null ? "" : `${Math.abs(heard.audio.time - heard.video.time).toFixed(3)} s`);

						// Seek forward with the arrow key: the audio must land beside the video again.
						const before = (await snapshot())?.video.time ?? 0;
						await preview.keyboard.press("ArrowRight");
						await preview.keyboard.press("ArrowRight");
						const after = await poll(snapshot, (state) => state !== null && state.video.time > before + 8 && inStep(state) && !state.audio.paused, DECODE_MS);
						check(`${name}: audio follows a seek`, after !== null && after.video.time > before + 8 && inStep(after) && !after.audio.paused, JSON.stringify(after));

						// Pause from the HUD: the sound stops with the picture, and comes back with it.
						await preview.getByRole("button", { name: "Play or Pause" }).last().click();
						const paused = await poll(snapshot, (state) => state !== null && state.video.paused && state.audio !== null && state.audio.paused, 5000);
						check(`${name}: pausing the video silences the audio`, paused !== null && paused.video.paused && paused.audio.paused, JSON.stringify(paused));
						await preview.getByRole("button", { name: "Play or Pause" }).last().click();
						const resumed = await poll(snapshot, (state) => state !== null && !state.video.paused && state.audio !== null && !state.audio.paused && inStep(state), 8000);
						check(`${name}: resuming brings the sound back in step`, resumed !== null && !resumed.audio.paused && inStep(resumed), JSON.stringify(resumed));
					}
				}
			} else if (expectation === "native") {
				await sleep(1500);
				const state = await snapshot();
				check(`${name}: the video decodes its own sound`, (state?.video.native ?? 0) > 0, `native bytes ${state?.video.native}`);
				check(`${name}: no sidecar is made`, state?.sidecars === 0, `sidecars ${state?.sidecars}`);
			} else {
				await sleep(1500);
				const state = await snapshot();
				check(`${name}: no sidecar and no error`, state?.sidecars === 0 && state.video.error === null, JSON.stringify(state));
			}

			await main.keyboard.press("Space");
			await poll(
				() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((item) => item.webContents.getURL().includes("quick-look.html") && item.isVisible())),
				(visible) => visible === false,
				5000,
			);
			// Closing the panel drops the content: nothing keeps decoding. `pgrep` has no Windows counterpart in the lanes' toolbox.
			if (process.platform !== "win32") {
				const leftover = await poll(
					() => spawnSync("pgrep", ["-f", `ffmpeg .*${escapeRegExp(name)}.* -f s16le`]).stdout.toString().trim(),
					(pids) => pids === "",
					8000,
				);
				check(`${name}: closing the panel stops ffmpeg`, leftover === "", `pids ${leftover}`);
			}
		}
	} finally {
		await app.close();
	}
}

const root = mkdtempSync(join(tmpdir(), "autorag-ql-video-audio-"));
try {
	// [file name, what the panel should do, ffmpeg audio arguments]
	const FIXTURES = [
		["ac3-51.mkv", "sidecar", ["-c:a", "ac3", "-ac", "6"]],
		["eac3.mp4", "sidecar", ["-c:a", "eac3"]],
		["dts.mkv", "sidecar", ["-strict", "-2", "-c:a", "dca"]],
		["aac.mkv", "native", ["-c:a", "aac"]],
		["silent.mp4", "none", null],
	];
	const SECONDS = 40;
	for (const [name, , audio] of FIXTURES) {
		const picture = ["-f", "lavfi", "-i", `testsrc=size=320x180:rate=24:duration=${SECONDS}`];
		const tone = audio === null ? [] : ["-f", "lavfi", "-i", `sine=frequency=440:duration=${SECONDS}:sample_rate=48000`];
		execFileSync("ffmpeg", ["-v", "error", "-y", ...picture, ...tone, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(audio ?? ["-an"]), join(root, name)]);
	}
	await session(
		root,
		FIXTURES.map(([name, expectation]) => ({ name, expectation })),
	);

	const realDir = process.env.QA_VIDEO_DIR;
	if (realDir !== undefined) {
		const videos = readdirSync(realDir)
			.filter((name) => /\.(mkv|mp4|m4v|mov|avi|webm)$/i.test(name))
			.sort()
			.slice(0, Number(process.env.QA_VIDEO_COUNT ?? 2));
		if (videos.length === 0) throw new Error(`no videos in ${realDir}`);
		await session(
			realDir,
			videos.map((name) => ({ name, expectation: "real" })),
		);
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exit(1);
