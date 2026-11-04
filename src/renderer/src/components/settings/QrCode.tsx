/*
 * QR Code generator (Level M byte-mode) + crisp inline SVG component,
 * adapted from Ovis (`devswha/ovis`, MIT) and Project Nayuki's QR Code generator
 * (https://github.com/nayuki/QR-Code-generator, Copyright (c) Project Nayuki, MIT).
 *
 * Dark modules on a white field in both light and dark themes so phone cameras
 * scan reliably without contrast inversion issues.
 */
import { useMemo, type ReactElement } from "react";

const QUIET_ZONE = 4;

const ECC_LENGTH = [
	-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
	28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
] as const;

const BLOCK_COUNT = [
	-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33,
	35, 37, 38, 40, 43, 45, 47, 49,
] as const;

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

function appendBits(bits: boolean[], value: number, count: number): void {
	for (let i = count - 1; i >= 0; i--) {
		bits.push(getBit(value, i));
	}
}

function rawModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		result -= (25 * align - 10) * align - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

function capacityBytes(version: number): number {
	return Math.floor(rawModules(version) / 8) - (ECC_LENGTH[version] ?? 0) * (BLOCK_COUNT[version] ?? 0);
}

function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function interleaveBlocks(version: number, data: Uint8Array): Uint8Array {
	const count = BLOCK_COUNT[version]!;
	const degree = ECC_LENGTH[version]!;
	const raw = Math.floor(rawModules(version) / 8);
	const shortCount = count - (raw % count);
	const shortLength = Math.floor(raw / count);

	const divisor = new Uint8Array(degree);
	divisor[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			divisor[j] = gfMultiply(divisor[j]!, root);
			if (j + 1 < degree) divisor[j]! ^= divisor[j + 1]!;
		}
		root = gfMultiply(root, 2);
	}

	const blocks: Uint8Array[] = [];
	let offset = 0;
	for (let b = 0; b < count; b++) {
		const length = shortLength - degree + (b < shortCount ? 0 : 1);
		const remainder = new Uint8Array(degree);
		const block = new Uint8Array(shortLength + 1);
		block.set(data.subarray(offset, offset + length), 0);
		for (let i = 0; i < length; i++) {
			const factor = data[offset + i]! ^ remainder[0]!;
			remainder.copyWithin(0, 1, degree);
			remainder[degree - 1] = 0;
			for (let j = 0; j < degree; j++) {
				remainder[j]! ^= gfMultiply(divisor[j]!, factor);
			}
		}
		offset += length;
		block.set(remainder, shortLength + 1 - degree);
		blocks.push(block);
	}

	const result = new Uint8Array(raw);
	let k = 0;
	for (let i = 0; i < shortLength + 1; i++) {
		for (let b = 0; b < count; b++) {
			if (i !== shortLength - degree || b >= shortCount) {
				result[k++] = blocks[b]![i]!;
			}
		}
	}
	return result;
}

function countFinderLikePatterns(history: readonly number[]): number {
	const n = history[1] ?? 0;
	if (n <= 0) return 0;
	const core = history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
	if (!core) return 0;
	return ((history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n ? 1 : 0) + ((history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n ? 1 : 0);
}

function pushRunHistory(run: number, size: number, history: number[]): void {
	const adjusted = history[0] === 0 ? run + size : run;
	for (let i = history.length - 1; i >= 1; i--) {
		history[i] = history[i - 1]!;
	}
	history[0] = adjusted;
}

export function encodeQrMatrix(text: string): readonly (readonly boolean[])[] {
	const bytes = new TextEncoder().encode(text);
	let version = 1;
	for (; version <= 40; version++) {
		const lenBits = version < 10 ? 8 : 16;
		if (bytes.length < 1 << lenBits && 4 + lenBits + bytes.length * 8 <= capacityBytes(version) * 8) {
			break;
		}
	}
	if (version > 40) throw new Error("Text exceeds QR Code Level M capacity");

	const capBits = capacityBytes(version) * 8;
	const bits: boolean[] = [];
	appendBits(bits, 4, 4);
	appendBits(bits, bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) appendBits(bits, byte, 8);
	appendBits(bits, 0, Math.min(4, capBits - bits.length));
	appendBits(bits, 0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) {
		appendBits(bits, pad, 8);
	}

	const data = new Uint8Array(capBits / 8);
	for (let i = 0; i < bits.length; i++) {
		if (bits[i]) data[i >>> 3]! |= 1 << (7 - (i & 7));
	}

	const size = version * 4 + 17;
	const modules: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
	const isFunction: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false));

	const setFunction = (x: number, y: number, dark: boolean): void => {
		modules[y]![x] = dark;
		isFunction[y]![x] = true;
	};

	const drawFinder = (cx: number, cy: number): void => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const xx = cx + dx;
				const yy = cy + dy;
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				if (xx >= 0 && xx < size && yy >= 0 && yy < size) {
					setFunction(xx, yy, dist !== 2 && dist !== 4);
				}
			}
		}
	};

	const drawFormat = (mask: number): void => {
		let rem = mask;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const formatBits = ((mask << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(formatBits, i));
		setFunction(8, 7, getBit(formatBits, 6));
		setFunction(8, 8, getBit(formatBits, 7));
		setFunction(7, 8, getBit(formatBits, 8));
		for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(formatBits, i));
		for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(formatBits, i));
		for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(formatBits, i));
		setFunction(8, size - 8, true);
	};

	const applyMask = (mask: number): void => {
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (isFunction[y]![x]) continue;
				let invert = false;
				switch (mask) {
					case 0:
						invert = (x + y) % 2 === 0;
						break;
					case 1:
						invert = y % 2 === 0;
						break;
					case 2:
						invert = x % 3 === 0;
						break;
					case 3:
						invert = (x + y) % 3 === 0;
						break;
					case 4:
						invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
						break;
					case 5:
						invert = ((x * y) % 2) + ((x * y) % 3) === 0;
						break;
					case 6:
						invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
					case 7:
						invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
						break;
				}
				if (invert) modules[y]![x] = !modules[y]![x];
			}
		}
	};

	const penaltyScore = (): number => {
		let result = 0;
		let darkCount = 0;
		for (let axis = 0; axis < 2; axis++) {
			for (let line = 0; line < size; line++) {
				let color = false;
				let run = 0;
				const history = [0, 0, 0, 0, 0, 0, 0];
				for (let p = 0; p < size; p++) {
					const current = axis === 0 ? modules[line]![p]! : modules[p]![line]!;
					if (current === color) {
						run++;
						if (run === 5) result += 3;
						else if (run > 5) result++;
					} else {
						pushRunHistory(run, size, history);
						if (!color) result += countFinderLikePatterns(history) * 40;
						color = current;
						run = 1;
					}
				}
				if (color) {
					pushRunHistory(run, size, history);
					run = 0;
				}
				pushRunHistory(run + size, size, history);
				result += countFinderLikePatterns(history) * 40;
			}
		}
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const color = modules[y]![x]!;
				if (color) darkCount++;
				if (
					x + 1 < size &&
					y + 1 < size &&
					color === modules[y]![x + 1] &&
					color === modules[y + 1]![x] &&
					color === modules[y + 1]![x + 1]
				) {
					result += 3;
				}
			}
		}
		const total = size * size;
		const k = Math.max(0, Math.floor((Math.abs(darkCount * 20 - total * 10) + total - 1) / total) - 1);
		return result + k * 10;
	};

	for (let i = 0; i < size; i++) {
		setFunction(6, i, i % 2 === 0);
		setFunction(i, 6, i % 2 === 0);
	}
	drawFinder(3, 3);
	drawFinder(size - 4, 3);
	drawFinder(3, size - 4);

	if (version >= 2) {
		const count = Math.floor(version / 7) + 2;
		const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
		const positions = new Array<number>(count).fill(6);
		for (let i = count - 1, pos = size - 7; i >= 1; i--, pos -= step) {
			positions[i] = pos;
		}
		for (let i = 0; i < count; i++) {
			for (let j = 0; j < count; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === count - 1) || (i === count - 1 && j === 0)) continue;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						setFunction(positions[i]! + dx, positions[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			}
		}
	}

	drawFormat(0);
	if (version >= 7) {
		let rem = version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const versionBits = (version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			setFunction(a, b, getBit(versionBits, i));
			setFunction(b, a, getBit(versionBits, i));
		}
	}

	const codewords = interleaveBlocks(version, data);
	let bitIdx = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
				if (!isFunction[y]![x] && bitIdx < codewords.length * 8) {
					modules[y]![x] = getBit(codewords[bitIdx >>> 3]!, 7 - (bitIdx & 7));
					bitIdx++;
				}
			}
		}
	}

	let bestMask = 0;
	let minPenalty = Number.MAX_SAFE_INTEGER;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(mask);
		drawFormat(mask);
		const score = penaltyScore();
		if (score < minPenalty) {
			minPenalty = score;
			bestMask = mask;
		}
		applyMask(mask);
	}
	applyMask(bestMask);
	drawFormat(bestMask);

	return modules;
}

export function qrSvgPath(value: string): { readonly path: string; readonly cells: number } {
	const matrix = encodeQrMatrix(value);
	const count = matrix.length;
	let path = "";
	for (let row = 0; row < count; row++) {
		const rowCells = matrix[row]!;
		for (let col = 0; col < count; col++) {
			if (rowCells[col]) {
				path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
			}
		}
	}
	return { path, cells: count + QUIET_ZONE * 2 };
}

export function QrCode({
	value,
	label,
	size = 148,
}: {
	readonly value: string;
	readonly label: string;
	readonly size?: number;
}): ReactElement {
	const { path, cells } = useMemo(() => qrSvgPath(value), [value]);
	return (
		<svg
			className="settings-remote-qr"
			viewBox={`0 0 ${cells} ${cells}`}
			width={size}
			height={size}
			role="img"
			aria-label={label}
			shapeRendering="crispEdges"
		>
			<rect width={cells} height={cells} fill="#ffffff" />
			<path d={path} fill="#000000" />
		</svg>
	);
}
