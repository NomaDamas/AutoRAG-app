import type { Bounds } from "./fit";
import type { ZoomDirection, ZoomGeometry } from "./zoom";

/**
 * Quick Look runs in its own pre-warmed BrowserWindow (the sigma-file-manager
 * v1 design). The Finder window asks the main process to show or hide a file;
 * the main process reads the file once and pushes it to the preview window,
 * which reports the media size back so the window can fit it before it shows.
 */
export const PREVIEW_CHANNELS = {
	/** Finder -> main (invoke): preview this file. */
	show: "preview:show",
	/** Finder -> main (invoke): hide the preview. */
	hide: "preview:hide",
	/** Main -> Finder: the preview closed itself (Space, Escape, close button). */
	closed: "preview:closed",
	/** Main -> Finder: move the Finder selection (arrow keys pressed in the preview). */
	navigate: "preview:navigate",
	/** Main -> preview window: render this file. */
	load: "preview:load",
	/** Main -> preview window: drop the content so media stops. */
	unload: "preview:unload",
	/** Preview window -> main: the file rendered; media size when it has one. */
	ready: "preview:ready",
	/** Preview window -> main (invoke): toolbar and keyboard actions. */
	request: "preview:request",
	/** Main -> preview window: drive one step of the open/close zoom. */
	zoom: "preview:zoom",
	/** Preview window -> main: a zoom step finished. */
	zoomed: "preview:zoomed",
} as const;

/**
 * One file the preview can render. `bytes` is null when the viewer streams
 * the custom protocol instead, or when the file is over the byte cap.
 */
export interface PreviewDocument {
	readonly name: string;
	readonly path: string;
	readonly ext: string;
	readonly size: number;
	readonly modifiedAt: string;
	readonly mime: string;
	readonly truncated: boolean;
	readonly bytes: Uint8Array | null;
}

export interface QuickLookTarget {
	readonly path: string;
	readonly name: string;
}

/** `seq` orders loads; the main process ignores `ready` for a stale seq. */
export interface QuickLookLoad {
	readonly seq: number;
	readonly name: string;
	readonly path: string;
	readonly document: PreviewDocument | null;
	readonly error: string | null;
}

/** Zero width or height means the content has no intrinsic size. */
export interface QuickLookReady {
	readonly seq: number;
	readonly width: number;
	readonly height: number;
}

export type QuickLookAction = "close" | "next" | "previous" | "open" | "fullscreen";

export type NavigateDelta = 1 | -1;

/**
 * Main -> preview zoom steps. `prepare` lays the panel out at its final size
 * inside the larger zoom window, posed at its start; `run` animates it;
 * `settle` drops the zoom styling once the window has its final bounds.
 */
export type QuickLookZoom =
	| { readonly id: number; readonly phase: "prepare"; readonly direction: ZoomDirection; readonly geometry: ZoomGeometry }
	| { readonly id: number; readonly phase: "run" | "settle" };

export interface QuickLookZoomed {
	readonly id: number;
	readonly phase: "prepared" | "done";
}

/** Exposed to the Finder window as `window.autorag.preview`. */
export interface PreviewBridge {
	/** `origin` is the file's icon in the Finder viewport (CSS pixels); null when it is not on screen. */
	show(target: QuickLookTarget, origin: Bounds | null): Promise<void>;
	hide(origin: Bounds | null): Promise<void>;
	onClosed(listener: () => void): () => void;
	onNavigate(listener: (delta: NavigateDelta) => void): () => void;
}

/** Exposed to the Quick Look window as `window.quickLook`. */
export interface QuickLookWindowBridge {
	readonly platform: string;
	onLoad(listener: (load: QuickLookLoad) => void): () => void;
	onUnload(listener: () => void): () => void;
	onZoom(listener: (zoom: QuickLookZoom) => void): () => void;
	ready(report: QuickLookReady): void;
	zoomed(report: QuickLookZoomed): void;
	request(action: QuickLookAction): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isPreviewDocument(value: unknown): value is PreviewDocument {
	if (!isRecord(value)) return false;
	if (typeof value.name !== "string" || typeof value.path !== "string" || typeof value.ext !== "string") return false;
	if (typeof value.size !== "number" || typeof value.modifiedAt !== "string" || typeof value.mime !== "string") return false;
	if (typeof value.truncated !== "boolean") return false;
	return value.bytes === null || value.bytes instanceof Uint8Array;
}

export function isQuickLookTarget(value: unknown): value is QuickLookTarget {
	if (!isRecord(value)) return false;
	return typeof value.path === "string" && value.path.length > 0 && typeof value.name === "string";
}

export function isBounds(value: unknown): value is Bounds {
	if (!isRecord(value)) return false;
	return [value.x, value.y, value.width, value.height].every((part) => typeof part === "number" && Number.isFinite(part));
}

export function isQuickLookZoom(value: unknown): value is QuickLookZoom {
	if (!isRecord(value) || typeof value.id !== "number") return false;
	if (value.phase === "run" || value.phase === "settle") return true;
	if (value.phase !== "prepare" || (value.direction !== "in" && value.direction !== "out")) return false;
	const geometry = value.geometry;
	if (!isRecord(geometry) || !isBounds(geometry.union) || !isBounds(geometry.from) || !isBounds(geometry.to)) return false;
	return (geometry.anchorX === "left" || geometry.anchorX === "right") && (geometry.anchorY === "top" || geometry.anchorY === "bottom");
}

export function isQuickLookZoomed(value: unknown): value is QuickLookZoomed {
	return isRecord(value) && typeof value.id === "number" && (value.phase === "prepared" || value.phase === "done");
}

export function isQuickLookLoad(value: unknown): value is QuickLookLoad {
	if (!isRecord(value)) return false;
	if (typeof value.seq !== "number" || typeof value.name !== "string" || typeof value.path !== "string") return false;
	if (value.document !== null && !isPreviewDocument(value.document)) return false;
	return value.error === null || typeof value.error === "string";
}

export function isQuickLookReady(value: unknown): value is QuickLookReady {
	if (!isRecord(value)) return false;
	return (
		typeof value.seq === "number" &&
		typeof value.width === "number" &&
		Number.isFinite(value.width) &&
		typeof value.height === "number" &&
		Number.isFinite(value.height)
	);
}

export function isQuickLookAction(value: unknown): value is QuickLookAction {
	return value === "close" || value === "next" || value === "previous" || value === "open" || value === "fullscreen";
}

export function isNavigateDelta(value: unknown): value is NavigateDelta {
	return value === 1 || value === -1;
}

export const PREVIEW_SCHEME = "autorag-preview";

export function previewStreamUrl(filePath: string): string {
	const url = new URL(`${PREVIEW_SCHEME}://local/`);
	url.searchParams.set("path", filePath);
	return url.toString();
}

export function pathFromPreviewUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch (error) {
		if (error instanceof TypeError) return null;
		throw error;
	}
	if (url.protocol !== `${PREVIEW_SCHEME}:`) return null;
	const path = url.searchParams.get("path");
	if (path === null || path.length === 0 || path.includes("\0")) return null;
	return path;
}
