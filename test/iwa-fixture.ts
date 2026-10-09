/**
 * Hand-built IWA fixtures for the Keynote slide-order tests: just enough
 * protobuf, snappy, and container framing to exercise the decoder without a
 * real Keynote deck. Literal-only snappy is enough for most cases; a copy
 * element proves the decompressor follows back-references.
 */

export interface FixtureObject {
	readonly identifier: number;
	readonly type: number;
	readonly payload: Uint8Array;
}

function varintBytes(value: number): number[] {
	const out: number[] = [];
	let rest = value;
	while (rest > 0x7f) {
		out.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 128);
	}
	out.push(rest);
	return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function pbVarint(field: number, value: number): Uint8Array {
	return Uint8Array.from([...varintBytes((field << 3) | 0), ...varintBytes(value)]);
}

export function pbBytes(field: number, value: Uint8Array): Uint8Array {
	return concat([Uint8Array.from([...varintBytes((field << 3) | 2), ...varintBytes(value.length)]), value]);
}

/** A snappy literal op without the block header, split into ≤60-byte runs. */
export function snappyOpLiteral(data: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	for (let offset = 0; offset < data.length; offset += 60) {
		const run = data.subarray(offset, Math.min(offset + 60, data.length));
		parts.push(concat([Uint8Array.from([(run.length - 1) << 2]), run]));
	}
	return concat(parts);
}

/** A snappy 2-byte-offset copy op without the block header. */
export function snappyOpCopy2(offset: number, length: number): Uint8Array {
	return Uint8Array.from([((length - 1) << 2) | 2, offset & 0xff, (offset >> 8) & 0xff]);
}

/** A raw snappy block: varint uncompressed length, then the ops. */
export function snappyBlock(uncompressedLength: number, ops: readonly Uint8Array[]): Uint8Array {
	return concat([Uint8Array.from(varintBytes(uncompressedLength)), ...ops]);
}

/** A snappy block that encodes `data` with literals only. */
export function snappyLiteral(data: Uint8Array): Uint8Array {
	return snappyBlock(data.length, [snappyOpLiteral(data)]);
}

/** The IWA container: repeated `[0x00][3-byte LE length][snappy block]`. */
export function iwaContainer(blocks: readonly Uint8Array[]): Uint8Array {
	const parts: Uint8Array[] = [];
	for (const block of blocks) {
		parts.push(Uint8Array.from([0x00, block.length & 0xff, (block.length >> 8) & 0xff, (block.length >> 16) & 0xff]), block);
	}
	return concat(parts);
}

/** One object's uncompressed stream bytes: length-prefixed ArchiveInfo then payloads. */
export function iwaObjectStream(object: FixtureObject): Uint8Array {
	const messageInfo = pbBytes(2, concat([pbVarint(1, object.type), pbVarint(3, object.payload.length)]));
	const archiveInfo = concat([pbVarint(1, object.identifier), messageInfo]);
	return concat([Uint8Array.from(varintBytes(archiveInfo.length)), archiveInfo, object.payload]);
}

/** A complete IWA file (one literal-only snappy chunk) holding `objects` in order. */
export function buildIwa(objects: readonly FixtureObject[]): Uint8Array {
	return iwaContainer([snappyLiteral(concat(objects.map(iwaObjectStream)))]);
}
