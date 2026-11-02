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

import { t } from "../../../shared/i18n/core";
import type {
	ActionCapabilities,
	ActionRequest,
	ImageFormat,
	OpenWithApplication,
	VideoContainer,
} from "../../../shared/actions-contract";
import { archiveFormatOf } from "../../../shared/archive-formats";
import { extensionOfName } from "../../../shared/size-reduction";

export type FileActionIcon = "open" | "openWith" | "compress" | "extract" | "share" | "askAi" | "image" | "video" | "reduce";

/** Where a click leads. `request` is the work main performs. */
export type FileActionTarget =
	| { readonly kind: "open" }
	| { readonly kind: "openWith" }
	| { readonly kind: "share" }
	| { readonly kind: "askAi" }
	| { readonly kind: "request"; readonly request: ActionRequest };

export interface FileActionItem {
	readonly id: string;
	readonly label: string;
	readonly target: FileActionTarget;
	/** An image (data URL) drawn before the label, e.g. an application icon. */
	readonly icon?: string | null;
	/** Draw a divider above this item. */
	readonly separated?: boolean;
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
/** Resize presets, longest edge in pixels. */
const RESIZE_PRESETS: readonly number[] = [1920, 1280, 640];

const FORMAT_LABELS: Readonly<Record<ImageFormat, string>> = {
	jpeg: "JPEG",
	png: "PNG",
	webp: "WebP",
	heic: "HEIC",
	avif: "AVIF",
	gif: "GIF",
	tiff: "TIFF",
	bmp: "BMP",
};

/** Extensions that name the same format under another spelling. */
const EXTENSION_ALIASES: Readonly<Record<string, ImageFormat>> = { jpg: "jpeg", tif: "tiff", heif: "heic" };

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
	const normalized = EXTENSION_ALIASES[ext] ?? ext;
	return Object.hasOwn(FORMAT_LABELS, normalized) ? (normalized as ImageFormat) : null;
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
			label: t("inspector.actions.convertTo", { format: FORMAT_LABELS[format] }),
			target: { kind: "request", request: { kind: "convertImage", format } },
		});
	}
	// Resizing rewrites the file's own format, so it needs the source format to
	// be one the engine can encode (WebP only arrives with ffmpeg, and then only
	// as a conversion target). GIF is excluded: both engines resize one frame,
	// which would silently drop an animation.
	if (source !== null && source !== "webp" && source !== "gif" && capabilities.imageFormats.includes(source)) {
		for (const maxEdge of RESIZE_PRESETS) {
			items.push({
				id: `image:resize:${maxEdge}`,
				label: t("inspector.actions.maxEdge", { edge: maxEdge }),
				target: { kind: "request", request: { kind: "resizeImage", maxEdge } },
			});
		}
	}
	return items;
}

function videoItems(name: string, capabilities: ActionCapabilities): readonly FileActionItem[] {
	const source = fileExtension(name);
	return capabilities.videoContainers
		.filter((container) => container !== source)
		.map((container) => ({
			id: `video:convert:${container}`,
			label: t("inspector.actions.convertTo", { format: CONTAINER_LABELS[container] }),
			target: { kind: "request", request: { kind: "convertVideo", container } } as const,
		}));
}

/** Shown/enabled state of the toolbar Share item. */
export interface ShareControl {
	readonly shown: boolean;
	readonly enabled: boolean;
}

/**
 * The toolbar Share item. macOS Finder keeps Share in the toolbar, and it is
 * the same OS share sheet the Inspector's 공유 action opens; where the platform
 * has no share sheet (Windows) the item is hidden rather than dead. It is
 * enabled only with a focused row to share.
 */
export function toolbarShareControl(hasFocusedEntry: boolean, capabilities: ActionCapabilities): ShareControl {
	return { shown: capabilities.share, enabled: capabilities.share && hasFocusedEntry };
}

/**
 * The "다른 앱으로 열기" menu: the applications the OS registers for the file's
 * type first (default marked, in the order the OS reports), then "기타…" — the
 * only entry that reaches the full application chooser.
 */
export function openWithItems(applications: readonly OpenWithApplication[]): readonly FileActionItem[] {
	return [
		...applications.map(
			(application): FileActionItem => ({
				id: `app:${application.path}`,
				label: application.isDefault ? t("finderState.openWithDefault", { name: application.name }) : application.name,
				icon: application.icon,
				target: { kind: "request", request: { kind: "openWith", application: application.path } },
			}),
		),
		{
			id: "other",
			label: t("finderState.openWithOther"),
			// An icon-width spacer keeps the label aligned with the application rows.
			...(applications.length > 0 ? { icon: null } : {}),
			separated: applications.length > 0,
			target: { kind: "request", request: { kind: "openWith", application: null } },
		},
	];
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
				label: t("inspector.actions.compress"),
				icon: "compress",
				target: { kind: "request", request: { kind: "compress" } },
			});
			actions.push({
				kind: "action",
				id: "compress7z",
				label: t("inspector.actions.compress7z"),
				icon: "compress",
				target: { kind: "request", request: { kind: "compress", format: "7z" } },
			});
		}
		if (capabilities.share) {
			actions.push({ kind: "action", id: "share", label: t("inspector.actions.share"), icon: "share", target: { kind: "share" } });
		}
		actions.push({ kind: "action", id: "askAi", label: t("inspector.actions.askAi"), icon: "askAi", target: { kind: "askAi" } });
		return actions;
	}

	const actions: FileAction[] = [
		{ kind: "action", id: "open", label: t("inspector.actions.open"), icon: "open", target: { kind: "open" } },
	];
	if (capabilities.openWith) {
		actions.push({
			kind: "action",
			id: "openWith",
			label: t("inspector.actions.openWith"),
			icon: "openWith",
			target: { kind: "openWith" },
		});
	}
	if (capabilities.archive && archiveFormatOf(subject.name) !== null) {
		actions.push({
			kind: "action",
			id: "extract",
			label: t("inspector.actions.extract"),
			icon: "extract",
			target: { kind: "request", request: { kind: "extract" } },
		});
	}
	if (isImage(subject.name)) {
		const items = imageItems(subject.name, capabilities);
		if (items.length > 0) {
			actions.push({ kind: "menu", id: "imageEdit", label: t("inspector.actions.imageEdit"), icon: "image", items });
		}
	}
	if (isVideo(subject.name)) {
		const items = videoItems(subject.name, capabilities);
		if (items.length > 0) {
			actions.push({ kind: "menu", id: "videoConvert", label: t("inspector.actions.videoConvert"), icon: "video", items });
		}
	}
	// Same format, fewer bytes: one entry for every type this machine can shrink (PDF, pictures, video, audio).
	if (capabilities.reducibleExtensions.includes(extensionOfName(subject.name))) {
		actions.push({
			kind: "action",
			id: "reduceSize",
			label: t("inspector.actions.reduceSize"),
			icon: "reduce",
			target: { kind: "request", request: { kind: "reduceSize" } },
		});
	}
	if (capabilities.archive) {
		actions.push({
			kind: "action",
			id: "compress",
			label: t("inspector.actions.compress"),
			icon: "compress",
			target: { kind: "request", request: { kind: "compress" } },
		});
		actions.push({
			kind: "action",
			id: "compress7z",
			label: t("inspector.actions.compress7z"),
			icon: "compress",
			target: { kind: "request", request: { kind: "compress", format: "7z" } },
		});
	}
	if (capabilities.share) {
		actions.push({ kind: "action", id: "share", label: t("inspector.actions.share"), icon: "share", target: { kind: "share" } });
	}
	actions.push({ kind: "action", id: "askAi", label: t("inspector.actions.askAi"), icon: "askAi", target: { kind: "askAi" } });
	return actions;
}
