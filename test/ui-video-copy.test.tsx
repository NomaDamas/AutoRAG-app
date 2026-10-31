// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewStreamUrl, type PreviewDocument, type QuickLookWindowBridge } from "../src/preview/shared/contract";
import type { VideoPlaybackPlan, VideoPlaybackProgress } from "../src/preview/shared/video-playback";
import { ChromeProvider, type QuickLookChrome } from "../src/preview/ui/chrome";
import { VideoView } from "../src/preview/ui/player";
import { setAppLanguage } from "../src/shared/i18n";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const never = (): Promise<never> => new Promise(() => undefined);

interface Calls {
	readonly started: { path: string; id: string }[];
	readonly cancelled: string[];
	emit(progress: Partial<VideoPlaybackProgress>): void;
	finish(plan: VideoPlaybackPlan): void;
	fail(error: unknown): void;
}

function bridgeWith(): { bridge: QuickLookWindowBridge; calls: Calls } {
	const listeners = new Set<(progress: VideoPlaybackProgress) => void>();
	const pending = Promise.withResolvers<VideoPlaybackPlan>();
	const started: Calls["started"] = [];
	const cancelled: string[] = [];
	const bridge: QuickLookWindowBridge = {
		platform: "darwin",
		language: "en",
		onLanguage: () => () => undefined,
		onLoad: () => () => undefined,
		onUnload: () => () => undefined,
		onZoom: () => () => undefined,
		onApp: () => () => undefined,
		onOffice: () => () => undefined,
		onSlides: () => () => undefined,
		onThumbnail: () => () => undefined,
		ready: () => undefined,
		zoomed: () => undefined,
		request: never,
		details: never,
		sha256: never,
		folderSize: never,
		audioMetadata: never,
		videoAudio: () => Promise.resolve({ kind: "native" }),
		videoPlayback: (path, id) => {
			started.push({ path, id });
			return pending.promise;
		},
		cancelVideoPlayback: (id) => {
			cancelled.push(id);
		},
		onVideoPlaybackProgress: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dataPreview: never,
		archivePreview: never,
		certificatePreview: never,
		share: never,
		copyText: never,
		textEntry: () => undefined,
	};
	const calls: Calls = {
		started,
		cancelled,
		emit: (progress) => {
			for (const listener of listeners) listener({ id: started.at(-1)?.id ?? "", fraction: 0, ...progress });
		},
		finish: (plan) => pending.resolve(plan),
		fail: (error) => pending.reject(error),
	};
	return { bridge, calls };
}

function fileAt(path: string): PreviewDocument {
	return {
		name: path.split("/").pop() ?? path,
		path,
		ext: path.split(".").pop() ?? "",
		size: 1234,
		modifiedAt: "2026-01-02T03:04:05.000Z",
		mime: "video/x-msvideo",
		truncated: false,
		bytes: null,
		pages: null,
		office: null,
		thumbnail: null,
		slidesRendering: false,
	};
}

let host: HTMLDivElement;
let root: Root;

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await setAppLanguage("en");
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	act(() => root.unmount());
	host.remove();
	vi.useRealTimers();
	await setAppLanguage("ko");
});

async function show(file: PreviewDocument, bridge: QuickLookWindowBridge): Promise<void> {
	const chrome: QuickLookChrome = { bridge, toolbar: null, report: () => undefined, resize: () => undefined, hideTitle: () => undefined, app: null };
	await act(async () => {
		root.render(
			<ChromeProvider value={chrome}>
				<VideoView file={file} />
			</ChromeProvider>,
		);
	});
}

const videoSrc = (): string | null => host.querySelector("video")?.getAttribute("src") ?? null;

describe("the video panel for an avi", () => {
	it("asks main for a playable copy, shows its progress after a moment, and plays the copy it returns", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/old.avi"), bridge);
		expect(calls.started.map((call) => call.path)).toEqual(["/Movies/old.avi"]);
		expect(videoSrc()).toBeNull();
		expect(host.textContent).not.toContain("Preparing");

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(host.textContent).toContain("Preparing the video to play… 0%");

		await act(async () => calls.emit({ fraction: 0.426 }));
		expect(host.textContent).toContain("42%");

		await act(async () => calls.emit({ id: "someone-else", fraction: 0.9 }));
		expect(host.textContent).toContain("42%");

		await act(async () => calls.finish({ kind: "file", path: "/cache/abc.mp4" }));
		expect(videoSrc()).toBe(previewStreamUrl("/cache/abc.mp4"));
		expect(host.textContent).not.toContain("Preparing");
	});

	it("shows no progress notice for a copy that arrives at once", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/old.avi"), bridge);
		await act(async () => calls.finish({ kind: "file", path: "/cache/abc.mp4" }));
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(host.textContent).not.toContain("Preparing");
		expect(videoSrc()).toBe(previewStreamUrl("/cache/abc.mp4"));
	});

	it("plays the file itself when main makes no copy", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/old.avi"), bridge);
		await act(async () => calls.finish({ kind: "native" }));
		expect(videoSrc()).toBe(previewStreamUrl("/Movies/old.avi"));
	});

	it("plays the file itself when the request fails", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/old.avi"), bridge);
		await act(async () => calls.fail(new Error("not showing")));
		expect(videoSrc()).toBe(previewStreamUrl("/Movies/old.avi"));
	});

	it("stops the work under the same id when the panel leaves the file", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/old.avi"), bridge);
		const id = calls.started[0]?.id ?? "";
		expect(id).not.toBe("");
		act(() => root.unmount());
		expect(calls.cancelled).toEqual([id]);
	});

	it("does not ask for a copy of a video the page opens itself", async () => {
		const { bridge, calls } = bridgeWith();
		await show(fileAt("/Movies/clip.mkv"), bridge);
		expect(calls.started).toEqual([]);
		expect(videoSrc()).toBe(previewStreamUrl("/Movies/clip.mkv"));
	});
});
