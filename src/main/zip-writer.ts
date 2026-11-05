/**
 * Zip container writer with Zip64 (APPNOTE.TXT 6.3.10, §4.3.14–4.3.16, §4.5.3).
 *
 * The classic zip records hold 16-bit entry counts and 32-bit sizes and
 * offsets. A folder such as a source checkout with `node_modules` passes 65,535
 * entries, and a large tree passes 4 GiB; a writer without Zip64 then stores the
 * count modulo 65,536 and truncated offsets, and readers that trust the central
 * directory (Archive Utility, Explorer, `unzip`) list a fraction of the archive or
 * reject it. Here every field that overflows is written as its all-ones marker
 * with the real value in a Zip64 extra field, and the end record gets a Zip64
 * end record and locator once the count, the directory size, or its offset
 * overflow. Small archives stay classic zips, byte-compatible with every reader.
 *
 * Each file is read, CRC'd, and deflated (zlib, off the main thread) before it
 * is written, so its local header already carries the final sizes: no data
 * descriptors, and peak memory tracks the largest file. A file deflate cannot
 * shrink is stored. A failed write removes the partial archive.
 */

import { promisify } from "node:util";
import { crc32, deflateRaw } from "node:zlib";
import { rawFs } from "./raw-fs";

const { open, readFile, rm } = rawFs.promises;
const deflate = promisify(deflateRaw);

/** One file or directory to write, with its archive-relative "/"-separated path. */
export interface ZipMember {
	readonly source: string;
	/** Directories end in "/". */
	readonly entry: string;
	readonly directory: boolean;
}

export interface ZipOptions {
	/**
	 * Sizes and offsets at or above this are written through Zip64. The format's
	 * limit is 0xFFFFFFFF; tests lower it to exercise the Zip64 records without
	 * writing gigabytes.
	 */
	readonly zip64Threshold?: number;
}

/** zlib's tuned default balance of size and time. */
const DEFLATE_LEVEL = 6;
const MAX_32 = 0xffffffff;
const MAX_16 = 0xffff;
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END_OF_CENTRAL = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA = 0x0001;
/** 2.0 for deflate and directories, 4.5 for Zip64. */
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;
/** General purpose bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** MS-DOS directory attribute, in the low byte of the external attributes. */
const DOS_DIRECTORY = 0x10;

/** What the central directory needs about an entry once its data is written. */
interface CentralRecord {
	readonly name: Buffer;
	readonly method: number;
	readonly crc: number;
	readonly compressedSize: number;
	readonly size: number;
	readonly offset: number;
	readonly directory: boolean;
}

/** MS-DOS time and date (local time), as zip stores modification times. */
function dosDateTime(date: Date): { readonly time: number; readonly date: number } {
	const year = Math.max(1980, date.getFullYear());
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
	};
}

/** A Zip64 extended-information extra field holding `values` as 8-byte integers. */
function zip64Extra(values: readonly number[]): Buffer {
	const extra = Buffer.alloc(4 + 8 * values.length);
	extra.writeUInt16LE(ZIP64_EXTRA, 0);
	extra.writeUInt16LE(8 * values.length, 2);
	values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + 8 * index));
	return extra;
}

/** Write `members` as a zip at `target`, in member order. */
export async function writeZip(target: string, members: readonly ZipMember[], options: ZipOptions = {}): Promise<void> {
	const threshold = options.zip64Threshold ?? MAX_32;
	const stamp = dosDateTime(new Date());
	const handle = await open(target, "w");
	let offset = 0;
	const write = async (data: Buffer | Uint8Array): Promise<void> => {
		await handle.write(data, 0, data.length, offset);
		offset += data.length;
	};
	try {
		const records: CentralRecord[] = [];
		for (const member of members) {
			const name = Buffer.from(member.entry, "utf8");
			const content = member.directory ? Buffer.alloc(0) : await readFile(member.source);
			let method = METHOD_STORE;
			let body: Uint8Array = content;
			if (content.length > 0) {
				const packed = await deflate(content, { level: DEFLATE_LEVEL });
				if (packed.length < content.length) {
					method = METHOD_DEFLATE;
					body = packed;
				}
			}
			const record: CentralRecord = {
				name,
				method,
				crc: content.length > 0 ? crc32(content) : 0,
				compressedSize: body.length,
				size: content.length,
				offset,
				directory: member.directory,
			};
			// The local Zip64 field, when present, must hold both sizes.
			const local64 = record.size >= threshold || record.compressedSize >= threshold;
			const extra = local64 ? zip64Extra([record.size, record.compressedSize]) : Buffer.alloc(0);
			const header = Buffer.alloc(30);
			header.writeUInt32LE(LOCAL_HEADER, 0);
			header.writeUInt16LE(local64 ? VERSION_ZIP64 : VERSION_DEFLATE, 4);
			header.writeUInt16LE(FLAG_UTF8, 6);
			header.writeUInt16LE(method, 8);
			header.writeUInt16LE(stamp.time, 10);
			header.writeUInt16LE(stamp.date, 12);
			header.writeUInt32LE(record.crc, 14);
			header.writeUInt32LE(local64 ? MAX_32 : record.compressedSize, 18);
			header.writeUInt32LE(local64 ? MAX_32 : record.size, 22);
			header.writeUInt16LE(name.length, 26);
			header.writeUInt16LE(extra.length, 28);
			await write(Buffer.concat([header, name, extra]));
			if (body.length > 0) await write(body);
			records.push(record);
		}

		const directoryOffset = offset;
		const central: Buffer[] = [];
		for (const record of records) {
			// Only the overflowing fields go in the extra, in this fixed order.
			const wide: number[] = [];
			const size = record.size >= threshold ? (wide.push(record.size), MAX_32) : record.size;
			const compressedSize = record.compressedSize >= threshold ? (wide.push(record.compressedSize), MAX_32) : record.compressedSize;
			const localOffset = record.offset >= threshold ? (wide.push(record.offset), MAX_32) : record.offset;
			const extra = wide.length > 0 ? zip64Extra(wide) : Buffer.alloc(0);
			const version = wide.length > 0 ? VERSION_ZIP64 : VERSION_DEFLATE;
			const header = Buffer.alloc(46);
			header.writeUInt32LE(CENTRAL_HEADER, 0);
			header.writeUInt16LE(VERSION_ZIP64, 4);
			header.writeUInt16LE(version, 6);
			header.writeUInt16LE(FLAG_UTF8, 8);
			header.writeUInt16LE(record.method, 10);
			header.writeUInt16LE(stamp.time, 12);
			header.writeUInt16LE(stamp.date, 14);
			header.writeUInt32LE(record.crc, 16);
			header.writeUInt32LE(compressedSize, 20);
			header.writeUInt32LE(size, 24);
			header.writeUInt16LE(record.name.length, 28);
			header.writeUInt16LE(extra.length, 30);
			header.writeUInt32LE(record.directory ? DOS_DIRECTORY : 0, 38);
			header.writeUInt32LE(localOffset, 42);
			central.push(header, record.name, extra);
		}
		const directory = Buffer.concat(central);
		await write(directory);

		const count = records.length;
		const zip64 = count >= MAX_16 || directory.length >= threshold || directoryOffset >= threshold;
		if (zip64) {
			const recordOffset = offset;
			const record = Buffer.alloc(56);
			record.writeUInt32LE(ZIP64_END_OF_CENTRAL, 0);
			// Size of the record after this field.
			record.writeBigUInt64LE(44n, 4);
			record.writeUInt16LE(VERSION_ZIP64, 12);
			record.writeUInt16LE(VERSION_ZIP64, 14);
			record.writeBigUInt64LE(BigInt(count), 24);
			record.writeBigUInt64LE(BigInt(count), 32);
			record.writeBigUInt64LE(BigInt(directory.length), 40);
			record.writeBigUInt64LE(BigInt(directoryOffset), 48);
			const locator = Buffer.alloc(20);
			locator.writeUInt32LE(ZIP64_LOCATOR, 0);
			locator.writeBigUInt64LE(BigInt(recordOffset), 8);
			locator.writeUInt32LE(1, 16);
			await write(Buffer.concat([record, locator]));
		}
		const end = Buffer.alloc(22);
		end.writeUInt32LE(END_OF_CENTRAL, 0);
		end.writeUInt16LE(Math.min(count, MAX_16), 8);
		end.writeUInt16LE(Math.min(count, MAX_16), 10);
		end.writeUInt32LE(directory.length >= threshold ? MAX_32 : directory.length, 12);
		end.writeUInt32LE(directoryOffset >= threshold ? MAX_32 : directoryOffset, 16);
		await write(end);
		await handle.close();
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(target, { force: true });
		throw error;
	}
}
