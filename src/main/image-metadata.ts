/**
 * EXIF reader for the Inspector's photo metadata. exifr handles the container
 * formats (JPEG, PNG, WebP, HEIC/HEIF, AVIF, TIFF); this module decides which
 * extensions are worth opening, guards the read against oversized files, and
 * maps exifr's tag bag onto the typed contract so the renderer never sees an
 * unbounded object.
 */

import { readFile, stat } from "node:fs/promises";
// exifr ships CommonJS; electron-vite externalizes it, so take the interop default.
import exifr from "exifr";
import type { FsImageMetadata } from "../shared/fs-contract";

/** Extensions exifr can read a metadata block from. */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
	"jpg",
	"jpeg",
	"jfif",
	"pjpeg",
	"pjp",
	"png",
	"apng",
	"webp",
	"avif",
	"heic",
	"heif",
	"tif",
	"tiff",
]);

/** Reading a whole photo costs memory; anything past this is left unparsed. */
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

type ParsedExif = Readonly<Record<string, unknown>>;

function asText(value: unknown): string | null {
	if (typeof value === "string") {
		const text = value.trim();
		return text === "" ? null : text;
	}
	if (Array.isArray(value)) {
		const text = value.filter((part): part is string => typeof part === "string").join(" ").trim();
		return text === "" ? null : text;
	}
	return null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** exifr revives date tags to `Date`; a raw EXIF stamp survives as its string. */
function asDate(value: unknown): string | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
	if (typeof value === "number") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? null : date.toISOString();
	}
	return asText(value);
}

function firstNumber(...values: readonly unknown[]): number | null {
	for (const value of values) {
		const parsed = asNumber(value);
		if (parsed !== null) return parsed;
	}
	return null;
}

/** Map an exifr tag bag onto the typed contract; every absent tag is null. */
export function imageMetadataFromExif(parsed: ParsedExif): FsImageMetadata {
	const latitude = asNumber(parsed.GPSLatitude);
	const longitude = asNumber(parsed.GPSLongitude);
	return {
		width: firstNumber(parsed.ExifImageWidth, parsed.ImageWidth),
		height: firstNumber(parsed.ExifImageHeight, parsed.ImageHeight),
		make: asText(parsed.Make),
		model: asText(parsed.Model),
		lens: asText(parsed.LensModel) ?? asText(parsed.Lens),
		iso: firstNumber(parsed.ISO, parsed.ISOSpeedRatings),
		fNumber: asNumber(parsed.FNumber),
		exposureTime: asNumber(parsed.ExposureTime),
		focalLength: asNumber(parsed.FocalLength),
		focalLength35mm: asNumber(parsed.FocalLengthIn35mmFormat),
		dateTaken: asDate(parsed.DateTimeOriginal),
		exposureProgram: asText(parsed.ExposureProgram),
		meteringMode: asText(parsed.MeteringMode),
		flash: asText(parsed.Flash),
		whiteBalance: asText(parsed.WhiteBalance),
		colorSpace: asText(parsed.ColorSpace),
		orientation: asText(parsed.Orientation),
		software: asText(parsed.Software),
		artist: asText(parsed.Artist),
		copyright: asText(parsed.Copyright),
		gps: latitude !== null && longitude !== null ? { latitude, longitude } : null,
	};
}

function hasAnyValue(image: FsImageMetadata): boolean {
	return Object.values(image).some((value) => value !== null);
}

/** EXIF for an image path, or null when the extension, size, or file rules it out. */
export async function readImageMetadata(path: string, ext: string): Promise<FsImageMetadata | null> {
	if (!IMAGE_EXTENSIONS.has(ext.toLowerCase())) return null;
	try {
		const info = await stat(path);
		if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null;
		const bytes = await readFile(path);
		// exifr types `parse` as `Promise<any>`; the tag bag is opaque until mapped.
		const parsed = (await exifr.parse(bytes, {
			tiff: true,
			exif: true,
			gps: true,
			translateValues: true,
			reviveValues: true,
			sanitize: true,
		})) as unknown as ParsedExif | undefined;
		if (parsed === undefined || parsed === null || typeof parsed !== "object") return null;
		const image = imageMetadataFromExif(parsed);
		return hasAnyValue(image) ? image : null;
	} catch {
		// A corrupt or unreadable image simply carries no metadata to show.
		return null;
	}
}
