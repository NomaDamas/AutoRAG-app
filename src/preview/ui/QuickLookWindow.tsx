import { StrictMode, useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import type { QuickLookLoad, QuickLookWindowBridge } from "../shared/contract";
import type { Size } from "../shared/fit";
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

function QuickLookWindow({ bridge }: { readonly bridge: QuickLookWindowBridge }): ReactElement {
	const [load, setLoad] = useState<QuickLookLoad | null>(null);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const reported = useRef(-1);

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
