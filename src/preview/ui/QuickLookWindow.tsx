import { StrictMode, useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import type { QuickLookLoad, QuickLookWindowBridge, QuickLookZoom } from "../shared/contract";
import type { Size } from "../shared/fit";
import { ZOOM_EASING, ZOOM_IDENTITY, ZOOM_IN_MS, ZOOM_OUT_MS, zoomTransform, type ZoomDirection } from "../shared/zoom";
import { extensionOf, formatBytes } from "../shared/format";
import { describeExtension, viewerForExtension, type ViewerKind } from "../shared/registry";
import { PreviewBody } from "./body";
import { Status } from "./fallback";
import { CloseIcon, DocIcon, FullscreenIcon, OpenIcon } from "./icons";
import "./quick-look.css";

declare global {
	interface Window {
		readonly quickLook: QuickLookWindowBridge;
	}
}

const NO_INTRINSIC_SIZE: Size = { width: 0, height: 0 };
/** Frames a viewer gets to lay out before the window falls back to a page shape. */
const MEASURE_FRAMES = 12;

function waitsForMedia(kind: ViewerKind): boolean {
	return kind === "image" || kind === "tiff" || kind === "heic" || kind === "video";
}

function mediaSize(target: EventTarget): Size | null {
	if (target instanceof HTMLImageElement) return { width: target.naturalWidth, height: target.naturalHeight };
	if (target instanceof HTMLVideoElement) return { width: target.videoWidth, height: target.videoHeight };
	return null;
}

/**
 * The box a viewer laid out, which is the size the window should hug. Iframes
 * and the loading line carry no size of their own, so they report zero and the
 * window keeps a page shape.
 */
function contentSize(stage: HTMLElement | null): Size {
	const child = stage?.firstElementChild;
	if (!(child instanceof HTMLElement) || child instanceof HTMLIFrameElement) return NO_INTRINSIC_SIZE;
	if (child.classList.contains("ql__status")) return NO_INTRINSIC_SIZE;
	const width = Math.ceil(child.offsetWidth);
	const height = Math.ceil(child.offsetHeight);
	return width > 0 && height > 0 ? { width, height } : NO_INTRINSIC_SIZE;
}

/** Waits two frames so a style written now has been painted before the next step. */
function afterPaint(run: () => void): void {
	requestAnimationFrame(() => requestAnimationFrame(run));
}

/**
 * Runs the zoom steps the main process drives (src/preview/node/window.ts) on
 * `#root`: `prepare` lays the panel out at its final size, anchored to the
 * zoom window's edges, and poses it; `run` animates it; `settle` clears it.
 */
function useZoom(bridge: QuickLookWindowBridge): void {
	useEffect(() => {
		const root = document.getElementById("root");
		if (root === null) return;
		let running: { readonly id: number; readonly direction: ZoomDirection; readonly end: string } | null = null;
		const clear = (): void => {
			running = null;
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
				const posed = zoomTransform(geometry.from, geometry.to);
				clear();
				Object.assign(root.style, {
					position: "fixed",
					width: `${geometry.to.width}px`,
					height: `${geometry.to.height}px`,
					[geometry.anchorX]: "0px",
					[geometry.anchorY]: "0px",
					transformOrigin: "0 0",
					transform: direction === "in" ? posed : ZOOM_IDENTITY,
					opacity: direction === "in" ? "0.4" : "1",
				});
				root.dataset.zoom = direction;
				running = { id: zoom.id, direction, end: direction === "in" ? ZOOM_IDENTITY : posed };
				afterPaint(() => bridge.zoomed({ id: zoom.id, phase: "prepared" }));
				return;
			}
			const step = running;
			if (step === null || step.id !== zoom.id) return;
			const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
			const ms = reduced ? 0 : step.direction === "in" ? ZOOM_IN_MS : ZOOM_OUT_MS;
			root.style.transition = `transform ${ms}ms ${ZOOM_EASING}, opacity ${ms}ms ${ZOOM_EASING}`;
			root.style.transform = step.end;
			root.style.opacity = step.direction === "in" ? "1" : "0";
			window.setTimeout(() => {
				if (running?.id === step.id) bridge.zoomed({ id: step.id, phase: "done" });
			}, ms);
		};
		const off = bridge.onZoom(onZoom);
		return () => {
			off();
			clear();
		};
	}, [bridge]);
}

function QuickLookWindow({ bridge }: { readonly bridge: QuickLookWindowBridge }): ReactElement {
	const [load, setLoad] = useState<QuickLookLoad | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const reported = useRef(-1);
	useZoom(bridge);

	useEffect(() => {
		const offLoad = bridge.onLoad(setLoad);
		const offUnload = bridge.onUnload(() => setLoad(null));
		return () => {
			offLoad();
			offUnload();
		};
	}, [bridge]);

	const kind = load === null ? "fallback" : viewerForExtension(extensionOf(load.name));
	const media = load !== null && load.document !== null && load.document.size > 0 && waitsForMedia(kind);
	// Media reports its decoded size and PDF reports its first page's shape;
	// every other viewer reports the box it laid out after the first frames.
	const selfSized = media || kind === "pdf";

	function report(seq: number, size: Size): void {
		if (reported.current === seq) return;
		reported.current = seq;
		bridge.ready({ seq, width: size.width, height: size.height });
	}

	useEffect(() => {
		if (load === null || selfSized) return;
		const stage = stageRef.current;
		if (stage === null) return;
		const seq = load.seq;
		let frame = 0;
		let frames = 0;
		const step = (): void => {
			frame = requestAnimationFrame(() => {
				const size = contentSize(stage);
				if (size.width > 0) {
					report(seq, size);
					return;
				}
				frames += 1;
				if (frames < MEASURE_FRAMES) step();
			});
		};
		step();
		return () => cancelAnimationFrame(frame);
	}, [load, selfSized]);

	if (load === null) return <div className="qlw" data-quicklook-state="idle" />;
	const seq = load.seq;
	const document = load.document;
	const meta = document === null ? describeExtension(extensionOf(load.name)) : `${describeExtension(document.ext)} · ${formatBytes(document.size)}`;

	function onMediaEvent(event: SyntheticEvent<HTMLDivElement>): void {
		const size = mediaSize(event.target);
		if (size !== null) report(seq, size);
	}

	function onMediaError(event: SyntheticEvent<HTMLDivElement>): void {
		if (mediaSize(event.target) !== null) report(seq, NO_INTRINSIC_SIZE);
	}

	return (
		<div className="qlw" data-quicklook-state="ready" data-platform={bridge.platform} role="dialog" aria-label={load.name}>
			<header className="qlw__toolbar">
				<button type="button" className="qlw__tool" aria-label="닫기" title="닫기" onClick={() => void bridge.request("close")}>
					<CloseIcon />
				</button>
				<div className="qlw__titles" title={meta}>
					<DocIcon />
					<span className="qlw__name">{load.name}</span>
				</div>
				<div className="qlw__trail">
					<button
						type="button"
						className="qlw__tool"
						aria-label="전체 화면"
						title="전체 화면"
						onClick={() => void bridge.request("fullscreen")}
					>
						<FullscreenIcon />
					</button>
					<button type="button" className="qlw__open" title="기본 앱으로 열기" onClick={() => void bridge.request("open")}>
						<OpenIcon />
						<span>열기</span>
					</button>
				</div>
			</header>
			<div
				ref={stageRef}
				key={seq}
				className="ql__stage"
				data-kind={kind}
				onLoadCapture={onMediaEvent}
				onLoadedMetadataCapture={onMediaEvent}
				onErrorCapture={onMediaError}
			>
				{document === null ? (
					<Status>{load.error ?? "파일을 열 수 없습니다"}</Status>
				) : (
					<PreviewBody file={document} onIntrinsicSize={(size) => report(seq, size)} />
				)}
			</div>
		</div>
	);
}

export function mountQuickLookWindow(): void {
	const container = document.getElementById("root");
	if (container === null) throw new Error("Quick Look mount point #root not found");
	createRoot(container).render(
		<StrictMode>
			<QuickLookWindow bridge={window.quickLook} />
		</StrictMode>,
	);
}
