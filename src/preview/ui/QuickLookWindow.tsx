import { StrictMode, useEffect, useRef, useState, type ReactElement, type SyntheticEvent } from "react";
import { createRoot } from "react-dom/client";
import type { QuickLookAction, QuickLookLoad, QuickLookWindowBridge } from "../shared/contract";
import type { Size } from "../shared/fit";
import { extensionOf, formatBytes } from "../shared/format";
import { describeExtension, viewerForExtension, type ViewerKind } from "../shared/registry";
import { PreviewBody } from "./body";
import { Status } from "./fallback";
import { CloseIcon, FullscreenIcon, OpenIcon } from "./icons";
import "./quick-look.css";

declare global {
	interface Window {
		readonly quickLook: QuickLookWindowBridge;
	}
}

const AUDIO_SIZE: Size = { width: 520, height: 180 };
const NO_INTRINSIC_SIZE: Size = { width: 0, height: 0 };

function waitsForMedia(kind: ViewerKind): boolean {
	return kind === "image" || kind === "tiff" || kind === "heic" || kind === "video";
}

function intrinsicSize(kind: ViewerKind): Size {
	return kind === "audio" ? AUDIO_SIZE : NO_INTRINSIC_SIZE;
}

function mediaSize(target: EventTarget): Size | null {
	if (target instanceof HTMLImageElement) return { width: target.naturalWidth, height: target.naturalHeight };
	if (target instanceof HTMLVideoElement) return { width: target.videoWidth, height: target.videoHeight };
	return null;
}

function actionForKey(event: KeyboardEvent): QuickLookAction | null {
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	switch (event.key) {
		case " ":
		case "Escape":
			return "close";
		case "ArrowDown":
			return "next";
		case "ArrowUp":
			return "previous";
		default:
			return null;
	}
}

function QuickLookWindow({ bridge }: { readonly bridge: QuickLookWindowBridge }): ReactElement {
	const [load, setLoad] = useState<QuickLookLoad | null>(null);
	const reported = useRef(-1);

	useEffect(() => {
		const offLoad = bridge.onLoad(setLoad);
		const offUnload = bridge.onUnload(() => setLoad(null));
		const onKeyDown = (event: KeyboardEvent): void => {
			const action = actionForKey(event);
			if (action === null) return;
			event.preventDefault();
			event.stopPropagation();
			void bridge.request(action);
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			offLoad();
			offUnload();
			window.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, [bridge]);

	const kind = load === null ? "fallback" : viewerForExtension(extensionOf(load.name));
	const media = load !== null && load.document !== null && load.document.size > 0 && waitsForMedia(kind);

	function report(seq: number, size: Size): void {
		if (reported.current === seq) return;
		reported.current = seq;
		bridge.ready({ seq, width: size.width, height: size.height });
	}

	useEffect(() => {
		if (load === null || media) return;
		report(load.seq, intrinsicSize(kind));
	});

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
				<div className="qlw__lead">
					<button type="button" className="qlw__tool" aria-label="닫기" title="닫기" onClick={() => void bridge.request("close")}>
						<CloseIcon />
					</button>
					<button
						type="button"
						className="qlw__tool"
						aria-label="전체 화면"
						title="전체 화면"
						onClick={() => void bridge.request("fullscreen")}
					>
						<FullscreenIcon />
					</button>
				</div>
				<div className="qlw__titles">
					<div className="qlw__name">{load.name}</div>
					<div className="qlw__meta">{meta}</div>
				</div>
				<div className="qlw__trail">
					<button type="button" className="qlw__open" title="기본 앱으로 열기" onClick={() => void bridge.request("open")}>
						<OpenIcon />
						<span>열기</span>
					</button>
				</div>
			</header>
			<div
				key={seq}
				className="ql__stage"
				data-kind={kind}
				onLoadCapture={onMediaEvent}
				onLoadedMetadataCapture={onMediaEvent}
				onErrorCapture={onMediaError}
			>
				{document === null ? <Status>{load.error ?? "파일을 열 수 없습니다"}</Status> : <PreviewBody file={document} />}
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
