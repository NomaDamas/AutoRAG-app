/**
 * File actions — the Inspector's per-type action set ("Send to", Archive,
 * Share, and the simple edits a file's own type suggests).
 *
 * The renderer decides *which* actions a file offers (`src/renderer/src/state/
 * file-actions.ts`) and calls main through this contract; main owns every
 * filesystem write, external process, and OS integration. Capabilities are
 * reported by main so the renderer never shows a button the machine cannot
 * honour (no ffmpeg, no video conversion; no macOS share sheet, no Share).
 *
 * All paths crossing this boundary are absolute OS paths.
 */

/** IPC channel names. Keep in 1:1 sync with the main-process handlers. */
export const ACTIONS_CHANNELS = {
	capabilities: "actions:capabilities",
	run: "actions:run",
	share: "actions:share",
	openWithApplications: "actions:open-with-applications",
} as const;

export type ActionsChannel = (typeof ACTIONS_CHANNELS)[keyof typeof ACTIONS_CHANNELS];

/** Image formats the conversion action can write. */
export type ImageFormat = "jpeg" | "png" | "webp" | "tiff" | "heic";

/** Video containers the container-conversion action can remux into. */
export type VideoContainer = "mp4" | "mov" | "mkv";

/**
 * One unit of work. `openWith`, `compress`, and the share sheet act on the
 * whole target list (one chooser, one archive, one sheet); `extract` and the
 * edit conversions take exactly one target, and the rest carry their
 * parameter in the discriminant. `openWith` names the application to launch
 * (one of `openWithApplications`), or `null` to let the user choose any
 * application from the system chooser ("기타…").
 */
export type ActionRequest =
	| { readonly kind: "openWith"; readonly application: string | null }
	| { readonly kind: "compress" }
	| { readonly kind: "extract" }
	| { readonly kind: "convertImage"; readonly format: ImageFormat }
	| { readonly kind: "resizeImage"; readonly maxEdge: number }
	| { readonly kind: "optimizeImage" }
	| { readonly kind: "convertVideo"; readonly container: VideoContainer };

/**
 * What this machine can actually do. Every field is a real probe result — a
 * capability that is false is one the renderer must not offer.
 */
export interface ActionCapabilities {
	/** A chooser dialog can pick an application and the OS can launch it with the file. */
	readonly openWith: boolean;
	/** The OS native share sheet is available (macOS `ShareMenu`). */
	readonly share: boolean;
	/** Compress / extract (always available: the archiver is in-process). */
	readonly archive: boolean;
	/** Image formats the image engine can encode, in preference order. */
	readonly imageFormats: readonly ImageFormat[];
	/** Containers the video engine can remux into (empty without ffmpeg). */
	readonly videoContainers: readonly VideoContainer[];
}

/**
 * An application the OS registers for a file's type, as offered by the
 * "다른 앱으로 열기" menu. `path` is what `openWith` launches with.
 */
export interface OpenWithApplication {
	readonly path: string;
	/** Display name without the `.app` suffix. */
	readonly name: string;
	/** The OS's default handler for this file. */
	readonly isDefault: boolean;
	/** The application's icon as an image URL the renderer can load, or null when none could be read. */
	readonly icon: string | null;
}

/** Result of a successful action; `output` is the created file or folder. */
export interface ActionOutcome {
	readonly output: string | null;
	/** Completion note for the toast, already in the UI's language. */
	readonly note: string;
}

/** Share-sheet anchor: the button's rect in window CSS pixels. */
export interface ActionAnchor {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * Exposed to the Finder window as `window.autorag.actions`. `run` and `share`
 * carry the whole selection; a single row arrives as a one-path list.
 */
export interface ActionsBridge {
	capabilities(): Promise<ActionCapabilities>;
	run(paths: readonly string[], request: ActionRequest): Promise<ActionOutcome>;
	/**
	 * Applications the OS registers for `path`'s type, default first. Empty
	 * where the platform cannot enumerate them (the chooser is then the only way).
	 */
	openWithApplications(path: string): Promise<readonly OpenWithApplication[]>;
	/** macOS only; rejects elsewhere and when `capabilities().share` is false. */
	share(paths: readonly string[], anchor: ActionAnchor): Promise<void>;
}

const IMAGE_FORMATS: readonly string[] = ["jpeg", "png", "webp", "tiff", "heic"];
const VIDEO_CONTAINERS: readonly string[] = ["mp4", "mov", "mkv"];

export function isActionRequest(value: unknown): value is ActionRequest {
	if (typeof value !== "object" || value === null || !("kind" in value)) return false;
	switch (value.kind) {
		case "openWith":
			return (
				"application" in value &&
				(value.application === null || (typeof value.application === "string" && value.application.length > 0))
			);
		case "compress":
		case "extract":
		case "optimizeImage":
			return true;
		case "convertImage":
			return "format" in value && typeof value.format === "string" && IMAGE_FORMATS.includes(value.format);
		case "resizeImage":
			return (
				"maxEdge" in value &&
				typeof value.maxEdge === "number" &&
				Number.isFinite(value.maxEdge) &&
				value.maxEdge >= 16 &&
				value.maxEdge <= 20000
			);
		case "convertVideo":
			return (
				"container" in value && typeof value.container === "string" && VIDEO_CONTAINERS.includes(value.container)
			);
		default:
			return false;
	}
}

export function isActionAnchor(value: unknown): value is ActionAnchor {
	if (typeof value !== "object" || value === null) return false;
	const { x, y, width, height } = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
	return [x, y, width, height].every((part) => typeof part === "number" && Number.isFinite(part));
}

/** Every target list crossing the boundary: a non-empty array of non-empty paths. */
export function isActionPaths(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((path): path is string => typeof path === "string" && path.length > 0)
	);
}

/**
 * The weakest capability set: no share sheet, no image or video engine, and no
 * application chooser. Used where the bridge is absent (fixtures, tests).
 */
export const NO_CAPABILITIES: ActionCapabilities = {
	openWith: false,
	share: false,
	archive: false,
	imageFormats: [],
	videoContainers: [],
};
