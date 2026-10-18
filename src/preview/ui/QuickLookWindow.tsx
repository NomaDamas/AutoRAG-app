import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { setAppLanguage } from "../../shared/i18n";
import type { QuickLookLoad, QuickLookWindowBridge, QuickLookZoom } from "../shared/contract";
import type { QuickLookFit, Size } from "../shared/fit";
import { extensionOf, formatBytes } from "../shared/format";
import { describeExtension, viewerForExtension, type ViewerKind } from "../shared/registry";
import { ZOOM_IDENTITY, zoomTransform, type ZoomDirection } from "../shared/zoom";
import { PreviewBody } from "./body";
import { BundleView } from "./bundle";
import { ChromeProvider, TOOL_BUTTON, type QuickLookChrome } from "./chrome";
import { ErrorView } from "./fallback";
import { FolderView } from "./folder";
import { CloseIcon, FullscreenIcon, ShareIcon } from "./icons";
import { ZOOM_IN, ZOOM_OUT } from "./zoom-motion";
import "./quick-look.css";

declare global {
	interface Window {
		readonly quickLook: QuickLookWindowBridge;
	}
}

type StageKind = ViewerKind | "folder" | "bundle" | "error";

const NO_INTRINSIC_SIZE: Size = { width: 0, height: 0 };
/** Frames a measured viewer gets to lay out before the window falls back to a page shape. */
const MEASURE_FRAMES = 12;

/**
 * Viewers that state their own panel size through the chrome (or, for
 * pictures, through their decoded size). The rest are measured from the box
 * they lay out in a centering stage.
 */
const SELF_SIZED: Partial<Record<StageKind, true>> = {
	image: true,
	iwork: true,
	odg: true,
	odp: true,
	tiff: true,
	heic: true,
	video: true,
	audio: true,
	pdf: true,
	hwp: true,
	pptx: true,
	markdown: true,
	html: true,
	text: true,
	data: true,
	jsonl: true,
	plist: true,
	fallback: true,
	folder: true,
	bundle: true,
	error: true,
};

/** Pictures size the window by their decoded pixels, scaled as a whole. */
const MEDIA: Partial<Record<StageKind, true>> = { image: true, tiff: true, heic: true, video: true, iwork: true, odg: true };

function mediaSize(target: EventTarget): Size | null {
	if (target instanceof HTMLImageElement) return { width: target.naturalWidth, height: target.naturalHeight };
	if (target instanceof HTMLVideoElement) return { width: target.videoWidth, height: target.videoHeight };
	return null;
}

/**
 * The box a measured viewer laid out, which is the size the window should
 * hug. Iframes and the loading line carry no size of their own, so they report
 * zero and the window keeps a page shape.
 */
function contentSize(stage: HTMLElement | null): Size {
	const child = stage?.firstElementChild;
	if (!(child instanceof HTMLElement) || child instanceof HTMLIFrameElement) return NO_INTRINSIC_SIZE;
	if (child.classList.contains("ql__status")) return NO_INTRINSIC_SIZE;
	const width = Math.ceil(child.offsetWidth);
	const height = Math.ceil(child.offsetHeight);
	return width > 0 && height > 0 ? { width, height } : NO_INTRINSIC_SIZE;
}

/**
 * Runs the zoom steps the main process drives (src/preview/node/window.ts) on
 * `#root`: `prepare` lays the panel out at its final size, anchored to the
 * zoom window's edges, and poses it at the start of the motion; `run` plays the
 * motion; `settle` clears it. The pose is in layout before the window shows, so
 * no full-size panel can flash behind the growing one.
 */
function useZoom(bridge: QuickLookWindowBridge): void {
	useEffect(() => {
		const root = document.getElementById("root");
		if (root === null) return;
		let posed: { readonly id: number; readonly direction: ZoomDirection; readonly start: string } | null = null;
		let motion: Animation | null = null;
		const clear = (): void => {
			posed = null;
			motion?.cancel();
			motion = null;
			root.removeAttribute("style");
			delete root.dataset.zoom;
		};
		const onZoom = (zoom: QuickLookZoom): void => {
			if (zoom.phase === "settle") {
				clear();
				return;
			}
			if (zoom.phase === "prepare") {
				const { geometry, direction } = zoom;
				const start = zoomTransform(geometry.from, geometry.to);
				clear();
				Object.assign(root.style, {
					position: "fixed",
					width: `${geometry.to.width}px`,
					height: `${geometry.to.height}px`,
					[geometry.anchorX]: "0px",
					[geometry.anchorY]: "0px",
					transformOrigin: "0 0",
					transform: direction === "in" ? start : ZOOM_IDENTITY,
					opacity: direction === "in" ? "0.4" : "1",
				});
				root.dataset.zoom = direction;
				posed = { id: zoom.id, direction, start };
				// Force the pose, and the panel's size, into layout before the window shows.
				void root.offsetWidth;
				bridge.zoomed({ id: zoom.id, phase: "prepared" });
				return;
			}
			const step = posed;
			if (step === null || step.id !== zoom.id) return;
			const curve = step.direction === "in" ? ZOOM_IN : ZOOM_OUT;
			const ms = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : curve.duration;
			// Keyframes carry both the start pose and the end state, so the motion
			// never needs a painted frame in between; the Apple spring rides on the
			// easing. `finished` is the real end of the motion.
			motion = root.animate(
				step.direction === "in"
					? [
							{ transform: step.start, opacity: 0.4 },
							{ transform: ZOOM_IDENTITY, opacity: 1 },
						]
					: [
							{ transform: ZOOM_IDENTITY, opacity: 1 },
							{ transform: step.start, opacity: 0 },
						],
				{ duration: ms, easing: curve.easing, fill: "forwards" },
			);
			const playing = motion;
			void playing.finished
				.catch(() => undefined)
				.then(() => {
					if (posed?.id === zoom.id) bridge.zoomed({ id: zoom.id, phase: "done" });
				});
		};
		const off = bridge.onZoom(onZoom);
		return () => {
			off();
			clear();
		};
	}, [bridge]);
}

/** macOS draws a translucent panel over a native blur; other platforms get an opaque one. */
const PANEL =
	"qlw relative flex flex-col h-full overflow-hidden text-ql-ink font-ql antialiased select-none data-[material=glass]:rounded-[18px] data-[material=glass]:bg-ql-panel data-[material=glass]:shadow-ql-panel data-[material=solid]:bg-ql-panel-solid";

function QuickLookWindow({ bridge }: { readonly bridge: QuickLookWindowBridge }): ReactElement {
	const { t } = useTranslation();
	const [load, setLoad] = useState<QuickLookLoad | null>(null);
	const [app, setApp] = useState<string | null>(null);
	const [toolbar, setToolbar] = useState<HTMLElement | null>(null);
	const [titleHidden, setTitleHidden] = useState(false);
	const stageRef = useRef<HTMLElement | null>(null);
	const reported = useRef(-1);
	const seqRef = useRef(-1);
	useZoom(bridge);

	useEffect(() => {
		const offLoad = bridge.onLoad((next) => {
			seqRef.current = next.seq;
			setLoad(next);
			setApp(next.app);
		});
		const offApp = bridge.onApp((update) => {
			if (update.seq === seqRef.current) setApp(update.name);
		});
		const offUnload = bridge.onUnload(() => {
			seqRef.current = -1;
			setLoad(null);
		});
		return () => {
			offLoad();
			offApp();
			offUnload();
		};
	}, [bridge]);

	const report = useCallback(
		(size: Size, fit: QuickLookFit) => {
			const seq = seqRef.current;
			if (seq < 0 || reported.current === seq) return;
			reported.current = seq;
			bridge.ready({ seq, width: size.width, height: size.height, fit });
		},
		[bridge],
	);
	const resize = useCallback(
		(size: Size) => {
			const seq = seqRef.current;
			if (seq < 0) return;
			reported.current = seq;
			bridge.ready({ seq, width: size.width, height: size.height, fit: "clamp" });
		},
		[bridge],
	);
	const chrome = useMemo<QuickLookChrome>(() => ({ bridge, toolbar, report, resize, hideTitle: setTitleHidden, app }), [bridge, toolbar, report, resize, app]);

	const kind: StageKind = load === null ? "fallback" : load.bundle !== null ? "bundle" : load.folder !== null ? "folder" : load.document === null ? "error" : viewerForExtension(extensionOf(load.name));
	const measured = load !== null && SELF_SIZED[kind] !== true;

	useEffect(() => {
		if (load === null || !measured) return;
		const stage = stageRef.current;
		if (stage === null) return;
		let frame = 0;
		let frames = 0;
		const step = (): void => {
			frame = requestAnimationFrame(() => {
				const size = contentSize(stage);
				if (size.width > 0) {
					report(size, "clamp");
					return;
				}
				frames += 1;
				if (frames < MEASURE_FRAMES) step();
			});
		};
		step();
		return () => cancelAnimationFrame(frame);
	}, [load, measured, report]);

	const material = bridge.platform === "darwin" ? "glass" : "solid";
	if (load === null) return <div className={PANEL} data-material={material} data-quicklook-state="idle" />;
	const { document, folder, bundle } = load;
	const meta = document === null ? describeExtension(extensionOf(load.name)) : `${describeExtension(document.ext)} · ${formatBytes(document.size)}`;

	function onMediaEvent(event: SyntheticEvent<HTMLElement>): void {
		if (MEDIA[kind] !== true) return;
		const size = mediaSize(event.target);
		if (size !== null && size.width > 0) report(size, "aspect");
	}

	function share(event: SyntheticEvent<HTMLButtonElement>): void {
		const rect = event.currentTarget.getBoundingClientRect();
		void bridge.share({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
	}

	return (
		<ChromeProvider value={chrome}>
			<div className={PANEL} data-material={material} data-quicklook-state="ready" data-platform={bridge.platform} role="dialog" aria-label={load.name}>
				<header className="qlw__toolbar flex flex-none items-center gap-6 h-46 pl-12 pr-10 [-webkit-app-region:drag]">
					<button type="button" className={TOOL_BUTTON} aria-label={t("common.close")} title={t("common.close")} onClick={() => void bridge.request("close")}>
						<CloseIcon />
					</button>
					<button type="button" className={TOOL_BUTTON} aria-label={t("quickLook.window.fullscreen")} title={t("quickLook.window.fullscreen")} onClick={() => void bridge.request("fullscreen")}>
						<FullscreenIcon />
					</button>
					<div className="qlw__name flex-1 min-w-0 ml-4 overflow-hidden text-[14px] font-semibold tracking-[-0.01em] text-ellipsis whitespace-nowrap" title={meta}>
						{titleHidden ? "" : load.name}
					</div>
					<div ref={setToolbar} className="qlw__slot contents" />
					{bridge.platform === "darwin" ? (
						<button type="button" className={TOOL_BUTTON} aria-label={t("toolbar.share")} title={t("toolbar.share")} onClick={share}>
							<ShareIcon />
						</button>
					) : null}
					<button
						type="button"
						className="qlw__open flex-none h-28 ml-4 px-14 border-0 rounded-[999px] bg-ql-button text-ql-ink font-ql text-[13px] font-medium whitespace-nowrap cursor-default hover:bg-ql-button-hover [-webkit-app-region:no-drag]"
						title={t("quickLook.window.openWith")}
						onClick={() => void bridge.request("open")}
					>
						{app === null ? t("quickLook.window.open") : t("quickLook.window.openWithApp", { name: app })}
					</button>
				</header>
				<main
					ref={stageRef}
					key={load.seq}
					className="ql__stage relative flex flex-1 flex-col min-h-0 data-[layout=measured]:items-center data-[layout=measured]:justify-center-safe data-[layout=measured]:overflow-auto data-[layout=fill]:overflow-hidden data-[kind=video]:bg-ql-media data-[kind=image]:items-center data-[kind=image]:justify-center data-[kind=iwork]:items-center data-[kind=iwork]:justify-center data-[kind=odg]:items-center data-[kind=odg]:justify-center data-[kind=tiff]:items-center data-[kind=tiff]:justify-center data-[kind=heic]:items-center data-[kind=heic]:justify-center"
					data-kind={kind}
					data-layout={measured ? "measured" : "fill"}
					onLoadCapture={onMediaEvent}
					onLoadedMetadataCapture={onMediaEvent}
				>
					{bundle !== null ? (
						<BundleView bundle={bundle} />
					) : folder !== null ? (
						<FolderView folder={folder} />
					) : document === null ? (
						<ErrorView message={load.error ?? t("quickLook.window.cannotOpen")} />
					) : (
						<PreviewBody file={document} />
					)}
				</main>
			</div>
		</ChromeProvider>
	);
}

export function mountQuickLookWindow(): void {
	const container = document.getElementById("root");
	if (container === null) throw new Error("Quick Look mount point #root not found");
	// Main pushes the Interface language; react-i18next re-renders the viewers on a change.
	void setAppLanguage(window.quickLook.language);
	window.quickLook.onLanguage((language) => void setAppLanguage(language));
	createRoot(container).render(
		<StrictMode>
			<QuickLookWindow bridge={window.quickLook} />
		</StrictMode>,
	);
}
