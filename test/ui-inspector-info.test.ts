import { describe, expect, it } from "vitest";
import type { FsFileDetails, FsImageMetadata } from "../src/shared/fs-contract";
import type { FinderEntry } from "../src/renderer/src/data/entries";
import {
	buildInfoRows,
	formatAperture,
	formatDimensions,
	formatExposure,
	formatFocalLength,
	formatGeo,
	hasMoreInfoRows,
	visibleInfoRows,
} from "../src/renderer/src/state/inspector-info";

const LOCAL_STAMP = new Date(2026, 0, 2, 3, 4, 5);
const LOCAL_LABEL = "2026-01-02 03:04:05";

function entry(overrides: Partial<FinderEntry> = {}): FinderEntry {
	return {
		name: "photo.jpg",
		path: "/Users/me/Pictures/photo.jpg",
		kind: "file",
		fileKind: "png",
		iconUrl: null,
		dateLabel: "Jan 2, 03:04",
		sizeLabel: "4.8 MB",
		kindLabel: "JPEG image",
		location: "/Users/me/Pictures",
		modifiedValue: 0,
		sizeValue: 5_033_164,
		...overrides,
	};
}

function image(overrides: Partial<FsImageMetadata> = {}): FsImageMetadata {
	return {
		width: 4000,
		height: 3000,
		make: "Apple",
		model: "iPhone 15 Pro",
		lens: null,
		iso: 100,
		fNumber: 1.78,
		exposureTime: 0.008,
		focalLength: 6.765,
		focalLength35mm: 24,
		dateTaken: LOCAL_STAMP.toISOString(),
		exposureProgram: null,
		meteringMode: null,
		flash: null,
		whiteBalance: null,
		colorSpace: null,
		orientation: null,
		software: null,
		artist: null,
		copyright: null,
		gps: null,
		...overrides,
	};
}

function details(overrides: Partial<FsFileDetails> = {}): FsFileDetails {
	return {
		path: "/Users/me/Pictures/photo.jpg",
		kind: "file",
		size: 5_033_164,
		createdAt: LOCAL_STAMP.toISOString(),
		modifiedAt: LOCAL_STAMP.toISOString(),
		accessedAt: LOCAL_STAMP.toISOString(),
		changedAt: LOCAL_STAMP.toISOString(),
		isSymlink: false,
		linkTarget: null,
		permissions: "-rw-r--r--",
		owner: "me",
		group: "staff",
		inode: 123456,
		image: null,
		...overrides,
	};
}

const labels = (rows: readonly { readonly label: string }[]): string[] => rows.map((row) => row.label);
const valueOf = (rows: readonly { readonly label: string; readonly value: string }[], label: string): string | undefined =>
	rows.find((row) => row.label === label)?.value;

describe("buildInfoRows without rich details", () => {
	it("shows the entry summary and nothing more", () => {
		const rows = buildInfoRows(null, entry());
		expect(labels(rows)).toEqual(["종류", "크기", "위치", "경로", "수정한 날짜"]);
		expect(rows.every((row) => row.core)).toBe(true);
		expect(hasMoreInfoRows(rows)).toBe(false);
		expect(valueOf(rows, "수정한 날짜")).toBe("Jan 2, 03:04");
	});
});

describe("buildInfoRows with rich details", () => {
	it("keeps the six core rows and hides the long tail until Show more", () => {
		const rows = buildInfoRows(details(), entry());
		expect(labels(visibleInfoRows(rows, true))).toEqual([
			"종류",
			"크기",
			"위치",
			"경로",
			"생성한 날짜",
			"수정한 날짜",
		]);
		expect(hasMoreInfoRows(rows)).toBe(true);
		expect(labels(visibleInfoRows(rows, false))).toContain("접근한 날짜");
		expect(labels(visibleInfoRows(rows, false))).toContain("권한");
	});

	it("formats the OS fields it read", () => {
		const rows = buildInfoRows(details(), entry());
		expect(valueOf(rows, "크기")).toBe("4.8 MB");
		expect(valueOf(rows, "권한")).toBe("-rw-r--r--");
		expect(valueOf(rows, "소유자")).toBe("me");
		expect(valueOf(rows, "아이노드")).toBe("123456");
		expect(valueOf(rows, "생성한 날짜")).toBe(LOCAL_LABEL);
	});

	it("adds a symlink target row only for a symlink", () => {
		const plain = buildInfoRows(details(), entry());
		expect(labels(plain)).not.toContain("심볼릭 링크");
		const linked = buildInfoRows(
			details({ isSymlink: true, linkTarget: "/Users/me/Pictures/original.jpg" }),
			entry(),
		);
		expect(valueOf(linked, "심볼릭 링크")).toBe("/Users/me/Pictures/original.jpg");
	});

	it("appends EXIF rows under the image section and omits absent tags", () => {
		const rows = buildInfoRows(details({ image: image() }), entry());
		const imageSection = rows.filter((row) => row.section === "image");
		expect(imageSection.every((row) => !row.core)).toBe(true);
		expect(labels(imageSection)).toEqual([
			"이미지 크기",
			"카메라 제조사",
			"카메라 모델",
			"ISO",
			"조리개",
			"셔터 속도",
			"초점 거리",
			"35mm 환산",
			"촬영 일시",
		]);
		expect(valueOf(rows, "카메라 모델")).toBe("iPhone 15 Pro");
		expect(valueOf(rows, "ISO")).toBe("100");
		expect(valueOf(rows, "조리개")).toBe("f/1.78");
		expect(valueOf(rows, "셔터 속도")).toBe("1/125초");
		expect(valueOf(rows, "촬영 일시")).toBe(LOCAL_LABEL);
	});

	it("shows no image rows for a non-image file", () => {
		const rows = buildInfoRows(details({ image: null }), entry());
		expect(rows.some((row) => row.section === "image")).toBe(false);
	});
});

describe("metadata value formatting", () => {
	it("formats aperture, shutter, focal length, dimensions, and GPS", () => {
		expect(formatAperture(2.8)).toBe("f/2.8");
		expect(formatAperture(11)).toBe("f/11");
		expect(formatExposure(0.008)).toBe("1/125초");
		expect(formatExposure(2.5)).toBe("2.5초");
		expect(formatFocalLength(35)).toBe("35 mm");
		expect(formatDimensions(4000, 3000)).toBe("4000 × 3000");
		expect(formatGeo(37.5665, 126.978)).toBe("37.566500, 126.978000");
	});
});
