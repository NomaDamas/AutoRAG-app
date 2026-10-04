import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { imageMetadataFromExif, readImageMetadata } from "../src/main/image-metadata";
import { buildExifJpeg, buildPlainJpeg } from "./support/exif-fixture";

describe("imageMetadataFromExif", () => {
	it("maps the EXIF tags a camera writes to the contract fields", () => {
		const image = imageMetadataFromExif({
			Make: "Apple",
			Model: "iPhone 15 Pro",
			LensModel: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
			ISO: 100,
			FNumber: 1.78,
			ExposureTime: 0.008,
			FocalLength: 6.765,
			FocalLengthIn35mmFormat: 24,
			DateTimeOriginal: new Date("2026-01-02T03:04:05.000Z"),
			ExposureProgram: "Auto",
			MeteringMode: "Pattern",
			Flash: "Flash did not fire",
			WhiteBalance: "Auto white balance",
			ColorSpace: "sRGB",
			Orientation: "Horizontal (normal)",
			Software: "17.2",
			Artist: "J. Doe",
			Copyright: "© 2026",
			ExifImageWidth: 4032,
			ExifImageHeight: 3024,
			GPSLatitude: 37.5665,
			GPSLongitude: 126.978,
		});

		expect(image).toEqual({
			width: 4032,
			height: 3024,
			make: "Apple",
			model: "iPhone 15 Pro",
			lens: "iPhone 15 Pro back triple camera 6.765mm f/1.78",
			iso: 100,
			fNumber: 1.78,
			exposureTime: 0.008,
			focalLength: 6.765,
			focalLength35mm: 24,
			dateTaken: "2026-01-02T03:04:05.000Z",
			exposureProgram: "Auto",
			meteringMode: "Pattern",
			flash: "Flash did not fire",
			whiteBalance: "Auto white balance",
			colorSpace: "sRGB",
			orientation: "Horizontal (normal)",
			software: "17.2",
			artist: "J. Doe",
			copyright: "© 2026",
			gps: { latitude: 37.5665, longitude: 126.978 },
		});
	});

	it("returns nulls for every tag the file does not carry", () => {
		const image = imageMetadataFromExif({});
		expect(Object.values(image).every((value) => value === null)).toBe(true);
	});

	it("falls back to the plain ImageWidth/ImageHeight tags and keeps a string date", () => {
		const image = imageMetadataFromExif({
			ImageWidth: 800,
			ImageHeight: 600,
			DateTimeOriginal: "2026:05:06 07:08:09",
		});
		expect(image.width).toBe(800);
		expect(image.height).toBe(600);
		expect(image.dateTaken).toBe("2026:05:06 07:08:09");
	});

	it("drops a partial GPS fix rather than reporting half a coordinate", () => {
		expect(imageMetadataFromExif({ GPSLatitude: 37.5 }).gps).toBeNull();
	});

	it("drops a non-finite or unparsable numeric tag", () => {
		const image = imageMetadataFromExif({ ISO: "high", FNumber: Number.NaN });
		expect(image.iso).toBeNull();
		expect(image.fNumber).toBeNull();
	});
});

describe("readImageMetadata", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "autorag-image-meta-"));
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("reads EXIF out of a JPEG file", async () => {
		const file = join(root, "photo.jpg");
		await writeFile(file, buildExifJpeg());
		const image = await readImageMetadata(file, "jpg");
		expect(image).toMatchObject({
			make: "TestMake",
			model: "TestModel",
			lens: "TestLens 24-70",
			iso: 400,
			fNumber: 2.8,
			width: 4000,
			height: 3000,
		});
	});

	it("returns null for a JPEG with no EXIF segment", async () => {
		const file = join(root, "plain.jpg");
		await writeFile(file, buildPlainJpeg());
		expect(await readImageMetadata(file, "jpg")).toBeNull();
	});

	it("returns null without reading when the extension is not an image", async () => {
		const file = join(root, "notes.txt");
		await writeFile(file, "not an image");
		expect(await readImageMetadata(file, "txt")).toBeNull();
	});
});
