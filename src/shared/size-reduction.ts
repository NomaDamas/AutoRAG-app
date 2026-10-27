/**
 * "용량 줄이기": the file types whose size can be reduced while the file stays
 * the same format (a smaller `.pdf` is still a `.pdf`). Which of these a given
 * machine can actually do depends on its engines, so main reports the
 * extensions it can handle in `ActionCapabilities.reducibleExtensions`; this
 * table only says what each extension is.
 */

/** The engine family that reduces a type. */
export type ReductionKind = "pdf" | "image" | "video" | "audio";

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
