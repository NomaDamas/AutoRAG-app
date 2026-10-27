/**
 * "용량 줄이기": the file types whose size can be reduced while the file stays
 * the same format (a smaller `.pdf` is still a `.pdf`). Which of these a given
 * machine can actually do depends on its engines, so main reports the
 * extensions it can handle in `ActionCapabilities.reducibleExtensions`; this
 * table only says what each extension is.
 */

/** The engine family that reduces a type. */
export type ReductionKind = "pdf" | "image" | "video" | "audio";

/** How aggressively `reduceSize` trades fidelity/resolution for smaller bytes. */
export const REDUCTION_LEVELS = ["light", "balanced", "max"] as const;
export type ReductionLevel = (typeof REDUCTION_LEVELS)[number];

const KIND_EXTENSIONS: Readonly<Record<ReductionKind, readonly string[]>> = {
	pdf: ["pdf"],
	image: ["jpg", "jpeg", "png", "webp", "heic", "heif"],
	video: ["mp4", "m4v", "mov", "mkv", "webm"],
	audio: ["mp3", "m4a", "aac", "opus"],
};

const EXTENSION_KINDS: ReadonlyMap<string, ReductionKind> = new Map(
	(Object.keys(KIND_EXTENSIONS) as ReductionKind[]).flatMap((kind) =>
		KIND_EXTENSIONS[kind].map((extension): [string, ReductionKind] => [extension, kind]),
	),
);

/** Every extension some machine might reduce. */
export const REDUCIBLE_EXTENSIONS: readonly string[] = [...EXTENSION_KINDS.keys()];

/** The lower-case extension of a file name without the dot; "" for none or a dotfile. */
export function extensionOfName(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The engine family for `name`, or null when its type has no size reduction. */
export function reductionKindOf(name: string): ReductionKind | null {
	return EXTENSION_KINDS.get(extensionOfName(name)) ?? null;
}

/** The extensions of one family. */
export function extensionsOfKind(kind: ReductionKind): readonly string[] {
	return KIND_EXTENSIONS[kind];
}

/** "2.0 KB", "812 B": binary units, one decimal below 10. */
export function formatByteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"] as const;
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Single canonical `-reduced` sibling name for copy mode: strips any existing
 * `-reduced` or `-reduced N` suffix so re-running never stacks `-reduced-reduced`
 * or spawns `-reduced 2 .. 8` clutter.
 */
export function reducedCopyName(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	const hasExt = dot > 0 && dot < fileName.length - 1;
	const stem = hasExt ? fileName.slice(0, dot) : fileName;
	const ext = hasExt ? fileName.slice(dot) : "";
	const cleanStem = stem.replace(/-reduced(?: \d+)?$/u, "");
	return `${cleanStem}-reduced${ext}`;
}

/** Reads pixel dimensions from a JPEG's SOF header without spawning an external tool; null when not a JPEG. */
export function jpegDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
	if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
	let offset = 2;
	while (offset + 3 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
		const marker = bytes[offset];
		offset += 1;
		if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
		if (offset + 1 >= bytes.length) return null;
		const length = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
		if (length < 2 || offset + length > bytes.length) return null;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			if (length < 7) return null;
			const height = ((bytes[offset + 3] ?? 0) << 8) | (bytes[offset + 4] ?? 0);
			const width = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		offset += length;
	}
	return null;
}
