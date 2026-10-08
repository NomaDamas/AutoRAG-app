/**
 * Keynote slide order from a `.key` package. A `.key` stores its slide tree
 * in `Index/Document.iwa`, an IWA container: repeated `[0x00][3-byte length]`
 * chunks, each a raw snappy block (no framing), whose concatenation is a
 * sequence of length-prefixed ArchiveInfo protobufs followed by the object
 * payloads. Object type 2 is the show; its field 3 lists the slide nodes as
 * TSP.Reference messages, and a slide node's field 16 names the data id that
 * ends its `Data/st-<uuid>-<dataId>.jpg` render. Nothing here renders slides;
 * it just recovers the order the app wrote them in.
 */

/** A decompressed IWA object: its identifier, its type, and its payload bytes. */
export interface IwaObject {
	readonly identifier: number;
	readonly type: number;
	readonly payload: Uint8Array;
}

/** A malformed IWA, snappy, or protobuf stream. The caller degrades to the first page. */
export class IwaDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IwaDecodeError";
	}
}

/** Object type of the Keynote show. */
const SHOW_TYPE = 2;
/** Object type of a slide node in the show's tree. */
const SLIDE_NODE_TYPE = 4;
/** IWA ArchiveInfo and Keynote message field numbers (see DESIGN.md). */
const FIELD_IDENTIFIER = 1;
const FIELD_MESSAGE_INFO = 2;
const FIELD_MESSAGE_TYPE = 1;
const FIELD_MESSAGE_LENGTH = 3;
const FIELD_SLIDE_TREE = 3;
const FIELD_SLIDE_REFERENCE = 2;
const FIELD_SLIDE_THUMBNAIL = 16;
/** Only `Data/st-` entries are slide renders; `Data/mt-` ones are media. */
const SLIDE_IMAGE_PREFIX = "Data/st-";
/** One decompressed chunk this large is a corrupt header, not a real slide. */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;

/** A raw snappy block's decompressed bytes. */
function decompressSnappy(chunk: Uint8Array): Uint8Array {
	let pos = 0;
	let length = 0;
	let shift = 0;
	for (;;) {
		if (pos >= chunk.length || shift > 35) throw new IwaDecodeError("snappy chunk length is malformed");
		const byte = chunk[pos]!;
		pos += 1;
		length += (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) break;
		shift += 7;
	}
	if (length > MAX_CHUNK_BYTES) throw new IwaDecodeError(`snappy chunk declares ${length} bytes`);
	const out = new Uint8Array(length);
	let written = 0;
	while (pos < chunk.length) {
		const tag = chunk[pos]!;
		pos += 1;
		const kind = tag & 3;
		if (kind === 0) {
			let count = tag >> 2;
			if (count >= 60) {
				const extra = count - 59;
				if (pos + extra > chunk.length) throw new IwaDecodeError("snappy literal length is truncated");
				count = 0;
				for (let index = 0; index < extra; index += 1) count += chunk[pos + index]! * 2 ** (8 * index);
				pos += extra;
			}
			count += 1;
			if (pos + count > chunk.length || written + count > length) throw new IwaDecodeError("snappy literal runs past the chunk");
			out.set(chunk.subarray(pos, pos + count), written);
			pos += count;
			written += count;
			continue;
		}
		let count: number;
		let offset: number;
		if (kind === 1) {
			if (pos >= chunk.length) throw new IwaDecodeError("snappy copy offset is truncated");
			count = ((tag >> 2) & 7) + 4;
			offset = ((tag >> 5) << 8) | chunk[pos]!;
			pos += 1;
		} else if (kind === 2) {
			if (pos + 2 > chunk.length) throw new IwaDecodeError("snappy copy offset is truncated");
			count = (tag >> 2) + 1;
			offset = chunk[pos]! | (chunk[pos + 1]! << 8);
			pos += 2;
		} else {
			if (pos + 4 > chunk.length) throw new IwaDecodeError("snappy copy offset is truncated");
			count = (tag >> 2) + 1;
			offset = chunk[pos]! | (chunk[pos + 1]! << 8) | (chunk[pos + 2]! << 16) | chunk[pos + 3]! * 2 ** 24;
			pos += 4;
		}
		if (offset === 0 || offset > written || written + count > length) throw new IwaDecodeError("snappy copy does not stay inside the output");
		for (let index = 0; index < count; index += 1) out[written + index] = out[written + index - offset]!;
		written += count;
	}
	if (written !== length) throw new IwaDecodeError(`snappy chunk produced ${written} of ${length} bytes`);
	return out;
}

/** The IWA container's decompressed byte stream. */
function decompressIwa(bytes: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [];
	let total = 0;
	let pos = 0;
	while (pos < bytes.length) {
		if (bytes[pos] !== 0) throw new IwaDecodeError("IWA chunk is not zero-framed");
		if (pos + 4 > bytes.length) throw new IwaDecodeError("IWA chunk header is truncated");
		const length = bytes[pos + 1]! | (bytes[pos + 2]! << 8) | (bytes[pos + 3]! << 16);
		pos += 4;
		if (pos + length > bytes.length) throw new IwaDecodeError("IWA chunk runs past the file");
		const part = decompressSnappy(bytes.subarray(pos, pos + length));
		parts.push(part);
		total += part.length;
		pos += length;
	}
	const stream = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		stream.set(part, offset);
		offset += part.length;
	}
	return stream;
}

/** A protobuf field's number, wire type, and value (a number for varints, bytes otherwise). */
interface ProtoField {
	readonly number: number;
	readonly wire: number;
	readonly value: number | Uint8Array;
}

function readVarint(bytes: Uint8Array, start: number): { readonly value: number; readonly next: number } | null {
	let value = 0;
	let shift = 0;
	let pos = start;
	while (pos < bytes.length) {
		const byte = bytes[pos]!;
		value += (byte & 0x7f) * 2 ** shift;
		pos += 1;
		if ((byte & 0x80) === 0) return { value, next: pos };
		shift += 7;
		if (shift > 49) return null;
	}
	return null;
}

/**
 * The top-level fields of one protobuf message. Only the varint and
 * length-delimited fields the slide tree uses are yielded; fixed-width fields
 * are skipped and groups (which IWA never writes) are rejected.
 */
function* readFields(bytes: Uint8Array): Generator<ProtoField> {
	let pos = 0;
	while (pos < bytes.length) {
		const key = readVarint(bytes, pos);
		if (key === null) throw new IwaDecodeError("protobuf field key is truncated");
		pos = key.next;
		const number = key.value >> 3;
		const wire = key.value & 7;
		if (wire === 0) {
			const field = readVarint(bytes, pos);
			if (field === null) throw new IwaDecodeError("protobuf varint field is truncated");
			pos = field.next;
			yield { number, wire, value: field.value };
		} else if (wire === 2) {
			const length = readVarint(bytes, pos);
			if (length === null || length.next + length.value > bytes.length) throw new IwaDecodeError("protobuf byte field runs past the message");
			pos = length.next;
			yield { number, wire, value: bytes.subarray(pos, pos + length.value) };
			pos += length.value;
		} else if (wire === 1) {
			if (pos + 8 > bytes.length) throw new IwaDecodeError("protobuf fixed64 field is truncated");
			pos += 8;
		} else if (wire === 5) {
			if (pos + 4 > bytes.length) throw new IwaDecodeError("protobuf fixed32 field is truncated");
			pos += 4;
		} else {
			throw new IwaDecodeError(`unsupported protobuf wire type ${wire}`);
		}
	}
}

/** The value of the first varint field numbered `number` in `bytes`, if any. */
function firstVarint(bytes: Uint8Array, number: number): number | null {
	for (const field of readFields(bytes)) {
		if (field.number === number && field.wire === 0) return field.value as number;
	}
	return null;
}

/** The data id named by a slide node's field 16 reference. */
function thumbnailDataId(payload: Uint8Array): number | null {
	for (const field of readFields(payload)) {
		if (field.number === FIELD_SLIDE_THUMBNAIL && field.wire === 2) return firstVarint(field.value as Uint8Array, FIELD_IDENTIFIER);
	}
	return null;
}

/** Splits the decompressed stream into its ArchiveInfo objects. */
function readObjects(stream: Uint8Array): readonly IwaObject[] {
	const objects: IwaObject[] = [];
	let pos = 0;
	while (pos < stream.length) {
		const archiveInfoLength = readVarint(stream, pos);
		if (archiveInfoLength === null || archiveInfoLength.value === 0 || archiveInfoLength.next + archiveInfoLength.value > stream.length) {
			throw new IwaDecodeError("IWA ArchiveInfo is truncated");
		}
		const archiveInfo = stream.subarray(archiveInfoLength.next, archiveInfoLength.next + archiveInfoLength.value);
		pos = archiveInfoLength.next + archiveInfoLength.value;
		let identifier: number | null = null;
		const messages: { readonly type: number; readonly length: number }[] = [];
		for (const field of readFields(archiveInfo)) {
			if (field.number === FIELD_IDENTIFIER && field.wire === 0) {
				identifier = field.value as number;
			} else if (field.number === FIELD_MESSAGE_INFO && field.wire === 2) {
				const info = field.value as Uint8Array;
				const type = firstVarint(info, FIELD_MESSAGE_TYPE);
				const length = firstVarint(info, FIELD_MESSAGE_LENGTH);
				if (type !== null && length !== null) messages.push({ type, length });
			}
		}
		if (identifier === null) throw new IwaDecodeError("IWA ArchiveInfo has no identifier");
		for (const message of messages) {
			if (pos + message.length > stream.length) throw new IwaDecodeError("IWA object payload runs past the stream");
			objects.push({ identifier, type: message.type, payload: stream.subarray(pos, pos + message.length) });
			pos += message.length;
		}
	}
	return objects;
}

/** Every object in an IWA file, in the order the file stores them. */
export function decodeIwa(bytes: Uint8Array): readonly IwaObject[] {
	return readObjects(decompressIwa(bytes));
}

/**
 * The `Data/st-...jpg` entries for the show's slides, in presentation order.
 * A file whose show or slide tree cannot be read throws (the caller degrades
 * to the first page); a file with no show object has no slides at all.
 */
export function keynoteSlideImageNames(zipEntryNames: readonly string[], documentIwaBytes: Uint8Array): readonly string[] {
	const objects = decodeIwa(documentIwaBytes);
	const byIdentifier = new Map<number, IwaObject>();
	for (const object of objects) byIdentifier.set(object.identifier, object);
	const show = objects.find((object) => object.type === SHOW_TYPE);
	if (show === undefined) return [];
	const names: string[] = [];
	for (const field of readFields(show.payload)) {
		if (field.number !== FIELD_SLIDE_TREE || field.wire !== 2) continue;
		for (const reference of readFields(field.value as Uint8Array)) {
			if (reference.number !== FIELD_SLIDE_REFERENCE || reference.wire !== 2) continue;
			const nodeId = firstVarint(reference.value as Uint8Array, FIELD_IDENTIFIER);
			if (nodeId === null) continue;
			const node = byIdentifier.get(nodeId);
			if (node === undefined || node.type !== SLIDE_NODE_TYPE) continue;
			const dataId = thumbnailDataId(node.payload);
			if (dataId === null) continue;
			const suffix = `-${dataId}.jpg`;
			const name = zipEntryNames.find((entry) => entry.startsWith(SLIDE_IMAGE_PREFIX) && entry.endsWith(suffix));
			if (name !== undefined) names.push(name);
		}
	}
	return names;
}
