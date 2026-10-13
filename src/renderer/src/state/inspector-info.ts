/**
 * The Info panel's metadata rows. `buildInfoRows` turns the focused entry plus
 * its rich `FsFileDetails` into the ordered label/value list the panel renders;
 * `visibleInfoRows` applies the Show more / Show less collapse. Both are pure so
 * the labels and the collapse rule can be tested without a DOM.
 *
 * `core` marks the rows that survive the collapse: the Finder summary a user
 * always wants (kind, size, where, path, created, modified). Everything else —
 * access/change times, ownership, and the whole EXIF block — belongs to Show
 * more, keeping a wide photo's panel scrollable rather than endless.
 */

import type { FsFileDetails, FsImageMetadata } from "../../../shared/fs-contract";
import { t, type LocaleKey } from "../../../shared/i18n/core";
import type { FinderEntry } from "../data/entries";
import { dateLabelOf, kindLabelOf, locationOf, sizeLabelOf } from "./entry-values";
import { formatSize, formatTimestamp } from "./format";

export type InfoSection = "general" | "image";

export interface InfoRow {
	readonly label: string;
	readonly value: string;
	readonly section: InfoSection;
	readonly core: boolean;
}

function formatDecimal(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** f/2.8 */
export function formatAperture(fNumber: number): string {
	return `f/${formatDecimal(fNumber)}`;
}

/** "1/125초" for a fast shutter, "2.5초" for a long one. */
export function formatExposure(seconds: number): string {
	if (seconds > 0 && seconds < 1) return t("finderState.seconds", { value: `1/${Math.round(1 / seconds)}` });
	return t("finderState.seconds", { value: formatDecimal(seconds) });
}

/** 35 mm */
export function formatFocalLength(mm: number): string {
	return `${formatDecimal(mm)} mm`;
}

/** 4000 × 3000 */
export function formatDimensions(width: number, height: number): string {
	return `${width} × ${height}`;
}

/** 37.566500, 126.978000 */
export function formatGeo(latitude: number, longitude: number): string {
	return `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
}

function imageRows(image: FsImageMetadata): readonly InfoRow[] {
	const rows: InfoRow[] = [];
	const push = (key: LocaleKey, value: string | null): void => {
		if (value !== null) rows.push({ label: t(key), value, section: "image", core: false });
	};
	push("inspector.labels.imageSize", image.width !== null && image.height !== null ? formatDimensions(image.width, image.height) : null);
	push("inspector.labels.cameraMake", image.make);
	push("inspector.labels.cameraModel", image.model);
	push("inspector.labels.lens", image.lens);
	push("inspector.labels.iso", image.iso === null ? null : String(image.iso));
	push("inspector.labels.aperture", image.fNumber === null ? null : formatAperture(image.fNumber));
	push("inspector.labels.shutterSpeed", image.exposureTime === null ? null : formatExposure(image.exposureTime));
	push("inspector.labels.focalLength", image.focalLength === null ? null : formatFocalLength(image.focalLength));
	push("inspector.labels.focalLength35mm", image.focalLength35mm === null ? null : formatFocalLength(image.focalLength35mm));
	push("inspector.labels.dateTaken", image.dateTaken === null ? null : formatTimestamp(image.dateTaken));
	push("inspector.labels.exposureProgram", image.exposureProgram);
	push("inspector.labels.meteringMode", image.meteringMode);
	push("inspector.labels.flash", image.flash);
	push("inspector.labels.whiteBalance", image.whiteBalance);
	push("inspector.labels.colorSpace", image.colorSpace);
	push("inspector.labels.orientation", image.orientation);
	push("inspector.labels.software", image.software);
	push("inspector.labels.artist", image.artist);
	push("inspector.labels.copyright", image.copyright);
	push("inspector.labels.gps", image.gps === null ? null : formatGeo(image.gps.latitude, image.gps.longitude));
	return rows;
}

/** Ordered rows for the focused entry; rich when `details` has arrived, summary otherwise. */
export function buildInfoRows(details: FsFileDetails | null, entry: FinderEntry): readonly InfoRow[] {
	const general: InfoRow[] = [];
	const push = (key: LocaleKey, value: string | null, core: boolean): void => {
		if (value !== null) general.push({ label: t(key), value, section: "general", core });
	};
	push("inspector.labels.kind", kindLabelOf(entry), true);
	push("inspector.labels.size", details === null ? sizeLabelOf(entry) : formatSize(details.size), true);
	push("inspector.labels.location", locationOf(entry), true);
	push("inspector.labels.path", details?.path ?? entry.path, true);
	push("inspector.labels.dateCreated", details === null ? null : formatTimestamp(details.createdAt), true);
	push("inspector.labels.dateModified", details === null ? dateLabelOf(entry) : formatTimestamp(details.modifiedAt), true);
	if (details !== null) {
		push("inspector.labels.dateAccessed", formatTimestamp(details.accessedAt), false);
		push("inspector.labels.dateChanged", formatTimestamp(details.changedAt), false);
		push("inspector.labels.symlink", details.isSymlink ? details.linkTarget : null, false);
		push("inspector.labels.permissions", details.permissions, false);
		push("inspector.labels.owner", details.owner, false);
		push("inspector.labels.group", details.group, false);
		push("inspector.labels.inode", String(details.inode), false);
	}
	return details?.image == null ? general : [...general, ...imageRows(details.image)];
}

/** Collapsed view keeps the core summary; expanded shows every row. */
export function visibleInfoRows(rows: readonly InfoRow[], brief: boolean): readonly InfoRow[] {
	return brief ? rows.filter((row) => row.core) : rows;
}

/** True when Show more has anything to reveal. */
export function hasMoreInfoRows(rows: readonly InfoRow[]): boolean {
	return rows.some((row) => !row.core);
}
