import { describe, expect, it } from "vitest";
import { followVideo, type FollowedMedia } from "../src/preview/ui/audio-follow";

class FakeMedia extends EventTarget implements FollowedMedia {
	currentTime = 0;
	paused = true;
	ended = false;
	playbackRate = 1;
	volume = 1;
	muted = false;
	readyState = 4;
	plays = 0;
	pauses = 0;
	play(): Promise<void> {
		this.paused = false;
		this.plays += 1;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
		this.pauses += 1;
	}
	emit(name: string): void {
		this.dispatchEvent(new Event(name));
	}
}

function pair(): { video: FakeMedia; audio: FakeMedia } {
	return { video: new FakeMedia(), audio: new FakeMedia() };
}

/** The video plays: state first, then the event the element would fire. */
function startVideo(video: FakeMedia, at = 0): void {
	video.currentTime = at;
	video.paused = false;
	video.emit("play");
}

describe("followVideo", () => {
	it("plays the audio when the video plays and pauses it when the video pauses", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		startVideo(video, 12);
		expect(audio.paused).toBe(false);
		expect(audio.currentTime).toBe(12);
		video.paused = true;
		video.emit("pause");
		expect(audio.paused).toBe(true);
	});

	it("joins a video that was already playing, at its position", () => {
		const { video, audio } = pair();
		video.paused = false;
		video.currentTime = 7.5;
		followVideo(video, audio);
		expect(audio.paused).toBe(false);
		expect(audio.currentTime).toBe(7.5);
	});

	it("stays silent while the video is paused", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		expect(audio.paused).toBe(true);
		expect(audio.plays).toBe(0);
	});

	it("moves to the video's position on a seek, playing or not", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		video.currentTime = 90;
		video.emit("seeking");
		expect(audio.currentTime).toBe(90);
		startVideo(video, 90);
		video.currentTime = 30;
		video.emit("seeked");
		expect(audio.currentTime).toBe(30);
		expect(audio.paused).toBe(false);
	});

	it("pulls a drifting audio back past the limit and leaves small drift to the player", () => {
		const { video, audio } = pair();
		followVideo(video, audio, { maxDriftSeconds: 0.3 });
		startVideo(video, 10);
		audio.currentTime = 10.2;
		video.currentTime = 10.25;
		video.emit("timeupdate");
		expect(audio.currentTime).toBe(10.2);
		video.currentTime = 11;
		video.emit("timeupdate");
		expect(audio.currentTime).toBe(11);
	});

	it("holds the audio while the video buffers and resumes it aligned", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		startVideo(video, 5);
		video.emit("waiting");
		expect(audio.paused).toBe(true);
		video.currentTime = 6;
		video.emit("playing");
		expect(audio.paused).toBe(false);
		expect(audio.currentTime).toBe(6);
	});

	it("stops with the video at the end", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		startVideo(video, 100);
		video.ended = true;
		video.emit("ended");
		expect(audio.paused).toBe(true);
	});

	it("keeps the speed, volume, and mute of the video it follows", () => {
		const { video, audio } = pair();
		followVideo(video, audio);
		video.playbackRate = 1.5;
		video.emit("ratechange");
		video.volume = 0.4;
		video.muted = true;
		video.emit("volumechange");
		expect([audio.playbackRate, audio.volume, audio.muted]).toEqual([1.5, 0.4, true]);
	});

	it("takes the video's current speed and volume when it starts following", () => {
		const { video, audio } = pair();
		video.playbackRate = 2;
		video.volume = 0.25;
		video.muted = true;
		followVideo(video, audio);
		expect([audio.playbackRate, audio.volume, audio.muted]).toEqual([2, 0.25, true]);
	});

	it("starts once the audio has data, when the video got there first", () => {
		const { video, audio } = pair();
		audio.readyState = 0;
		followVideo(video, audio);
		startVideo(video, 20);
		video.currentTime = 21;
		audio.readyState = 4;
		audio.emit("canplay");
		expect(audio.paused).toBe(false);
		expect(audio.currentTime).toBe(21);
	});

	it("gives up the sidecar when the video turns out to decode its own audio", () => {
		const { video, audio } = pair();
		let native = false;
		let reported = 0;
		followVideo(video, audio, { hasNativeAudio: () => native, onNativeAudio: () => (reported += 1) });
		startVideo(video, 0);
		video.currentTime = 0.5;
		video.emit("timeupdate");
		expect(audio.paused).toBe(false);
		native = true;
		video.currentTime = 1;
		video.emit("timeupdate");
		expect(audio.paused).toBe(true);
		expect(reported).toBe(1);
		const playsBefore = audio.plays;
		video.emit("pause");
		startVideo(video, 2);
		video.emit("timeupdate");
		expect(audio.plays).toBe(playsBefore);
		expect(reported).toBe(1);
	});

	it("lets go of both elements when disposed", () => {
		const { video, audio } = pair();
		const dispose = followVideo(video, audio);
		startVideo(video, 3);
		dispose();
		expect(audio.paused).toBe(true);
		const plays = audio.plays;
		startVideo(video, 4);
		video.currentTime = 50;
		video.emit("seeking");
		expect(audio.plays).toBe(plays);
		expect(audio.currentTime).toBe(3);
	});
});
