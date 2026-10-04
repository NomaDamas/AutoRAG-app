/**
 * Suggested actions for the Inspector's Info half.
 *
 * Pure data: given a file (name + kind) and the machine's capabilities, this
 * says which actions to offer, in priority order. Adding a new action is one
 * entry here plus one `case` in the controller's dispatcher — nothing else
 * knows about individual actions.
 *
 * A flat action runs on click; a `menu` action opens the list of variants the
 * file's own type implies (image formats, video containers). Quick Look, copy
 * path, and Trash are deliberately absent: the row, the context menu, Space,
 * and ⌫/⌘⌫ already cover them.
 */

import type {
	ActionCapabilities,
	ActionRequest,
	ImageFormat,
	VideoContainer,
} from "../../../shared/actions-contract";

export type FileActionIcon = "open" | "openWith" | "compress" | "extract" | "share" | "askAi" | "image" | "video";

/** Where a click leads. `request` is the work main performs. */
export type FileActionTarget =
	| { readonly kind: "open" }
	| { readonly kind: "share" }
	| { readonly kind: "askAi" }
	| { readonly kind: "request"; readonly request: ActionRequest };

export interface FileActionItem {
	readonly id: string;
	readonly label: string;
	readonly target: FileActionTarget;
}

/** A flat action button, or one that opens a variant menu. */
export type FileAction =
	| {
			readonly kind: "action";
			readonly id: string;
			readonly label: string;
			readonly icon: FileActionIcon;
			readonly target: FileActionTarget;
	  }
	| {
			readonly kind: "menu";
			readonly id: string;
			readonly label: string;
			readonly icon: FileActionIcon;
			readonly items: readonly FileActionItem[];
	  };

/** The slice of a Finder entry the registry needs. */
export interface ActionSubject {
	readonly name: string;
	readonly kind: "file" | "folder";
}

const IMAGE_EXTENSIONS: readonly string[] = ["png", "jpg", "jpeg", "webp", "heic", "heif", "tif", "tiff", "gif", "bmp", "avif"];
const VIDEO_EXTENSIONS: readonly string[] = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];
/** Extensions whose own format the resize/optimize ops can rewrite in place. */
const LOSSY_IMAGE_FORMATS: readonly ImageFormat[] = ["jpeg", "webp", "heic"];
/** Resize presets, longest edge in pixels. */
const RESIZE_PRESETS: readonly number[] = [1920, 1280, 640];

const FORMAT_LABELS: Readonly<Record<ImageFormat, string>> = {
	jpeg: "JPEG",
	png: "PNG",
	webp: "WebP",
	tiff: "TIFF",
	heic: "HEIC",
};

const CONTAINER_LABELS: Readonly<Record<VideoContainer, string>> = {
	mp4: "MP4",
	mov: "MOV",
	mkv: "MKV",
};

/** The extension without the dot, lower-case, or "" for none/dotfiles. */
export function fileExtension(name: string): string {
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

/** The image format a file name denotes, when the image actions know it. */
function imageFormatOfName(name: string): ImageFormat | null {
	const ext = fileExtension(name);
	const normalized = ext === "jpg" ? "jpeg" : ext === "tif" ? "tiff" : ext === "heif" ? "heic" : ext;
	return (Object.keys(FORMAT_LABELS) as ImageFormat[]).includes(normalized as ImageFormat)
		? (normalized as ImageFormat)
		: null;
}

function isImage(name: string): boolean {
	return IMAGE_EXTENSIONS.includes(fileExtension(name));
}

function isVideo(name: string): boolean {
	return VIDEO_EXTENSIONS.includes(fileExtension(name));
}

function imageItems(name: string, capabilities: ActionCapabilities): readonly FileActionItem[] {
	const source = imageFormatOfName(name);
	const items: FileActionItem[] = [];
	for (const format of capabilities.imageFormats) {
		if (format === source) continue;
		items.push({
			id: `image:convert:${format}`,
			label: `${FORMAT_LABELS[format]}로 변환`,
			target: { kind: "request", request: { kind: "convertImage", format } },
		});
	}
	// Resizing rewrites the file's own format, so it needs the source format to
	// be one the engine can encode (WebP only arrives with ffmpeg, and then only
	// as a conversion target).
	if (source !== null && source !== "webp" && capabilities.imageFormats.includes(source)) {
		for (const maxEdge of RESIZE_PRESETS) {
			items.push({
				id: `image:resize:${maxEdge}`,
				label: `최대 ${maxEdge}px`,
				target: { kind: "request", request: { kind: "resizeImage", maxEdge } },
			});
		}
	}
	if (source !== null && LOSSY_IMAGE_FORMATS.includes(source) && capabilities.imageFormats.includes(source)) {
		items.push({
			id: "image:optimize",
			label: "용량 최적화",
			target: { kind: "request", request: { kind: "optimizeImage" } },
		});
	}
	return items;
}

function videoItems(name: string, capabilities: ActionCapabilities): readonly FileActionItem[] {
	const source = fileExtension(name);
	return capabilities.videoContainers
		.filter((container) => container !== source)
		.map((container) => ({
			id: `video:convert:${container}`,
			label: `${CONTAINER_LABELS[container]}로 변환`,
			target: { kind: "request", request: { kind: "convertVideo", container } } as const,
		}));
}

/**
 * The Inspector action bar for `subject`. Capability-gated: an action whose
 * backing engine is missing never renders, so the bar never lies about the
 * machine.
 */
export function suggestedActions(subject: ActionSubject, capabilities: ActionCapabilities): readonly FileAction[] {
	if (subject.kind === "folder") {
		const actions: FileAction[] = [];
		if (capabilities.archive) {
			actions.push({
				kind: "action",
				id: "compress",
				label: "압축",
				icon: "compress",
				target: { kind: "request", request: { kind: "compress" } },
			});
		}
		if (capabilities.share) {
			actions.push({ kind: "action", id: "share", label: "공유", icon: "share", target: { kind: "share" } });
		}
		actions.push({ kind: "action", id: "askAi", label: "AI 요약", icon: "askAi", target: { kind: "askAi" } });
		return actions;
	}

	const actions: FileAction[] = [
		{ kind: "action", id: "open", label: "열기", icon: "open", target: { kind: "open" } },
	];
	if (capabilities.openWith) {
		actions.push({
			kind: "action",
			id: "openWith",
			label: "다른 앱으로 열기",
			icon: "openWith",
			target: { kind: "request", request: { kind: "openWith" } },
		});
	}
	if (fileExtension(subject.name) === "zip") {
		actions.push({
			kind: "action",
			id: "extract",
			label: "압축 해제",
			icon: "extract",
			target: { kind: "request", request: { kind: "extract" } },
		});
	}
	if (isImage(subject.name)) {
		const items = imageItems(subject.name, capabilities);
		if (items.length > 0) {
			actions.push({ kind: "menu", id: "imageEdit", label: "이미지 편집", icon: "image", items });
		}
	}
	if (isVideo(subject.name)) {
		const items = videoItems(subject.name, capabilities);
		if (items.length > 0) {
			actions.push({ kind: "menu", id: "videoConvert", label: "동영상 변환", icon: "video", items });
		}
	}
	if (capabilities.archive) {
		actions.push({
			kind: "action",
			id: "compress",
			label: "압축",
			icon: "compress",
			target: { kind: "request", request: { kind: "compress" } },
		});
	}
	if (capabilities.share) {
		actions.push({ kind: "action", id: "share", label: "공유", icon: "share", target: { kind: "share" } });
	}
	actions.push({ kind: "action", id: "askAi", label: "AI 요약", icon: "askAi", target: { kind: "askAi" } });
	return actions;
}
