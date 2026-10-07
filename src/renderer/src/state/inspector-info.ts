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
import type { FinderEntry } from "../data/entries";
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
	if (seconds > 0 && seconds < 1) return `1/${Math.round(1 / seconds)}초`;
	return `${formatDecimal(seconds)}초`;
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

function imageRows(image: FsImageMetadata, translate?: (key: string, def: string) => string): readonly InfoRow[] {
	const rows: InfoRow[] = [];
	const push = (key: string, def: string, value: string | null): void => {
		if (value !== null) rows.push({ label: translate ? translate(key, def) : def, value, section: "image", core: false });
	};
	push("inspector.labels.imageSize", "이미지 크기", image.width !== null && image.height !== null ? formatDimensions(image.width, image.height) : null);
	push("inspector.labels.cameraMake", "카메라 제조사", image.make);
	push("inspector.labels.cameraModel", "카메라 모델", image.model);
	push("inspector.labels.lens", "렌즈", image.lens);
	push("inspector.labels.iso", "ISO", image.iso === null ? null : String(image.iso));
	push("inspector.labels.aperture", "조리개", image.fNumber === null ? null : formatAperture(image.fNumber));
	push("inspector.labels.shutterSpeed", "셔터 속도", image.exposureTime === null ? null : formatExposure(image.exposureTime));
	push("inspector.labels.focalLength", "초점 거리", image.focalLength === null ? null : formatFocalLength(image.focalLength));
	push("inspector.labels.focalLength35mm", "35mm 환산", image.focalLength35mm === null ? null : formatFocalLength(image.focalLength35mm));
	push("inspector.labels.dateTaken", "촬영 일시", image.dateTaken === null ? null : formatTimestamp(image.dateTaken));
	push("inspector.labels.exposureProgram", "노출 프로그램", image.exposureProgram);
	push("inspector.labels.meteringMode", "측광 방식", image.meteringMode);
	push("inspector.labels.flash", "플래시", image.flash);
	push("inspector.labels.whiteBalance", "화이트 밸런스", image.whiteBalance);
	push("inspector.labels.colorSpace", "색 공간", image.colorSpace);
	push("inspector.labels.orientation", "방향", image.orientation);
	push("inspector.labels.software", "소프트웨어", image.software);
	push("inspector.labels.artist", "저작자", image.artist);
	push("inspector.labels.copyright", "저작권", image.copyright);
	push("inspector.labels.gps", "위치 (GPS)", image.gps === null ? null : formatGeo(image.gps.latitude, image.gps.longitude));
	return rows;
}

/** Ordered rows for the focused entry; rich when `details` has arrived, summary otherwise. */
export function buildInfoRows(
	details: FsFileDetails | null,
	entry: FinderEntry,
	translate?: (key: string, def: string) => string,
): readonly InfoRow[] {
	const general: InfoRow[] = [];
	const push = (key: string, def: string, value: string | null, core: boolean): void => {
		if (value !== null) general.push({ label: translate ? translate(key, def) : def, value, section: "general", core });
	};
	push("inspector.labels.kind", "종류", entry.kindLabel, true);
	push("inspector.labels.size", "크기", details === null ? entry.sizeLabel : formatSize(details.size), true);
	push("inspector.labels.location", "위치", entry.location, true);
	push("inspector.labels.path", "경로", details?.path ?? entry.path, true);
	push("inspector.labels.dateCreated", "생성한 날짜", details === null ? null : formatTimestamp(details.createdAt), true);
	push("inspector.labels.dateModified", "수정한 날짜", details === null ? entry.dateLabel : formatTimestamp(details.modifiedAt), true);
	if (details !== null) {
		push("inspector.labels.dateAccessed", "접근한 날짜", formatTimestamp(details.accessedAt), false);
		push("inspector.labels.dateChanged", "변경한 날짜", formatTimestamp(details.changedAt), false);
		push("inspector.labels.symlink", "심볼릭 링크", details.isSymlink ? details.linkTarget : null, false);
		push("inspector.labels.permissions", "권한", details.permissions, false);
		push("inspector.labels.owner", "소유자", details.owner, false);
		push("inspector.labels.group", "그룹", details.group, false);
		push("inspector.labels.inode", "아이노드", String(details.inode), false);
	}
	return details?.image == null ? general : [...general, ...imageRows(details.image, translate)];
}

/** Collapsed view keeps the core summary; expanded shows every row. */
export function visibleInfoRows(rows: readonly InfoRow[], brief: boolean): readonly InfoRow[] {
	return brief ? rows.filter((row) => row.core) : rows;
}

/** True when Show more has anything to reveal. */
export function hasMoreInfoRows(rows: readonly InfoRow[]): boolean {
	return rows.some((row) => !row.core);
}
