import { describe, expect, it } from "vitest";
import { decodeIwa, IwaDecodeError, keynoteSlideImageNames } from "../src/preview/shared/iwork-slides";
import { buildIwa, concat, iwaContainer, iwaObjectStream, pbBytes, pbVarint, snappyBlock, snappyLiteral, snappyOpCopy2, snappyOpLiteral, type FixtureObject } from "./iwa-fixture";

/** Objects: identifier 1 is the show; every other is a slide node with a thumbnail data id. */
function show(slides: readonly { readonly nodeId: number; readonly dataId: number }[], extra: readonly FixtureObject[] = []): Uint8Array {
	const nodes = slides.map(({ nodeId, dataId }) => ({ identifier: nodeId, type: 4, payload: pbBytes(16, pbVarint(1, dataId)) }));
	const references = slides.map(({ nodeId }) => pbBytes(2, pbVarint(1, nodeId)));
	return buildIwa([{ identifier: 1, type: 2, payload: pbBytes(3, concat(references)) }, ...nodes, ...extra]);
}

const JPEG = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);

describe("IWA decoding", () => {
	it("reads each object's identifier, type, and payload", () => {
		const first = buildIwa([
			{ identifier: 7, type: 2, payload: pbBytes(3, pbVarint(1, 9)) },
			{ identifier: 8, type: 4, payload: JPEG },
		]);
		const objects = decodeIwa(first);
		expect(objects.length).toBe(2);
		expect(objects[0]!.identifier).toBe(7);
		expect(objects[0]!.type).toBe(2);
		expect(objects[1]!.identifier).toBe(8);
		expect(objects[1]!.type).toBe(4);
		expect(Array.from(objects[1]!.payload)).toEqual(Array.from(JPEG));
	});

	it("joins objects across multiple snappy chunks", () => {
		const stream = concat([
			iwaObjectStream({ identifier: 7, type: 2, payload: Uint8Array.from([1, 2, 3]) }),
			iwaObjectStream({ identifier: 8, type: 4, payload: Uint8Array.from([4, 5]) }),
		]);
		const half = 5;
		const file = iwaContainer([
			snappyLiteral(stream.subarray(0, half)),
			snappyLiteral(stream.subarray(half)),
		]);
		const objects = decodeIwa(file);
		expect(objects.map((object) => object.identifier)).toEqual([7, 8]);
		expect(Array.from(objects[1]!.payload)).toEqual([4, 5]);
	});

	it("follows a copy element back-reference", () => {
		const object = { identifier: 5, type: 4, payload: Uint8Array.from([0xaa, 0xbb, 0xcc]) };
		const single = iwaObjectStream(object);
		const stream = concat([single, single]);
		const file = iwaContainer([snappyBlock(stream.length, [snappyOpLiteral(single), snappyOpCopy2(single.length, single.length)])]);
		const objects = decodeIwa(file);
		expect(objects.length).toBe(2);
		expect(Array.from(objects[0]!.payload)).toEqual([0xaa, 0xbb, 0xcc]);
		expect(objects[1]!.identifier).toBe(5);
	});
});

describe("IWA bounds", () => {
	it("rejects a declared output length the literals cannot reach", () => {
		const file = iwaContainer([snappyBlock(5, [snappyOpLiteral(Uint8Array.from([1, 2, 3]))])]);
		expect(() => decodeIwa(file)).toThrow(IwaDecodeError);
	});

	it("rejects a chunk whose length runs past the input", () => {
		expect(() => decodeIwa(Uint8Array.from([0x00, 0xff, 0xff, 0xff]))).toThrow(IwaDecodeError);
	});

	it("rejects a stream that is not zero-framed", () => {
		expect(() => decodeIwa(Uint8Array.from([0x01, 0x02, 0x00, 0x00]))).toThrow(IwaDecodeError);
	});

	it("rejects a copy whose offset points before the output", () => {
		const file = iwaContainer([snappyBlock(3, [snappyOpCopy2(4, 3)])]);
		expect(() => decodeIwa(file)).toThrow(IwaDecodeError);
	});

	it("rejects a copy that overruns the declared output length", () => {
		const file = iwaContainer([snappyBlock(4, [snappyOpLiteral(Uint8Array.from([1, 2, 3])), snappyOpCopy2(3, 3)])]);
		expect(() => decodeIwa(file)).toThrow(IwaDecodeError);
	});

	it("rejects a literal that runs past the chunk", () => {
		const file = iwaContainer([snappyBlock(10, [Uint8Array.from([(9 << 2) | 0, 1, 2])])]);
		expect(() => decodeIwa(file)).toThrow(IwaDecodeError);
	});
});

describe("Keynote slide order", () => {
	const names = [
		"Index/Document.iwa",
		"Data/st-AAA-100.jpg",
		"Data/st-BBB-300.jpg",
		"Data/st-CCC-200.jpg",
		"Data/st-ZZZ-999.jpg",
		"Data/mt-DDD-200.jpg",
	];

	it("returns slide images in show order, not file-name order", () => {
		const document = show([
			{ nodeId: 11, dataId: 200 },
			{ nodeId: 12, dataId: 100 },
			{ nodeId: 13, dataId: 300 },
		]);
		expect(keynoteSlideImageNames(names, document)).toEqual(["Data/st-CCC-200.jpg", "Data/st-AAA-100.jpg", "Data/st-BBB-300.jpg"]);
	});

	it("drops unreferenced template thumbnails and media files", () => {
		const document = show([{ nodeId: 11, dataId: 100 }]);
		expect(keynoteSlideImageNames(names, document)).toEqual(["Data/st-AAA-100.jpg"]);
	});

	it("skips a slide whose thumbnail is not in the package", () => {
		const document = show([
			{ nodeId: 11, dataId: 100 },
			{ nodeId: 12, dataId: 777 },
			{ nodeId: 13, dataId: 300 },
		]);
		expect(keynoteSlideImageNames(names, document)).toEqual(["Data/st-AAA-100.jpg", "Data/st-BBB-300.jpg"]);
	});

	it("skips a reference to a node the file does not contain", () => {
		const document = buildIwa([
			{ identifier: 1, type: 2, payload: pbBytes(3, concat([pbBytes(2, pbVarint(1, 11)), pbBytes(2, pbVarint(1, 99_999))])) },
			{ identifier: 11, type: 4, payload: pbBytes(16, pbVarint(1, 100)) },
		]);
		expect(keynoteSlideImageNames(names, document)).toEqual(["Data/st-AAA-100.jpg"]);
	});

	it("answers an empty list when the file has no show object", () => {
		const document = buildIwa([{ identifier: 3, type: 4, payload: new Uint8Array(0) }]);
		expect(keynoteSlideImageNames(names, document)).toEqual([]);
	});
});
