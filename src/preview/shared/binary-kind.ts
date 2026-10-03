/** One extra row the "Other" preview adds for executables and disk images. */
export interface BinaryKind {
	readonly label: "플랫폼" | "포맷";
	readonly value: string;
}

const PE_MACHINES: Readonly<Record<number, string>> = {
	0x14c: "x86",
	0x8664: "x86-64",
	0xaa64: "ARM64",
	0x1c4: "ARM",
};

const MACHO_CPUS: Readonly<Record<number, string>> = {
	0x7: "x86",
	0x01000007: "x86-64",
	0xc: "arm",
	0x0100000c: "arm64",
};

const ELF_MACHINES: Readonly<Record<number, string>> = {
	0x3: "x86",
	0x3e: "x86-64",
	0x28: "ARM",
	0xb7: "AArch64",
	0xf3: "RISC-V",
};

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
	return head.length >= magic.length && magic.every((value, index) => head[index] === value);
}

function portableExecutable(view: DataView): BinaryKind | null {
	if (view.byteLength < 0x40) return null;
	const offset = view.getUint32(0x3c, true);
	if (offset + 26 > view.byteLength) return null;
	if (view.getUint32(offset, false) !== 0x50450000) return null;
	const machine = PE_MACHINES[view.getUint16(offset + 4, true)] ?? "unknown CPU";
	const format = view.getUint16(offset + 24, true) === 0x20b ? "PE32+" : "PE32";
	return { label: "플랫폼", value: `Windows (${format}, ${machine})` };
}

/**
 * Names what an opaque binary is from its first bytes (and, for disk images,
 * its last 512): the platform a Windows, macOS, or Linux executable targets,
 * or the UDIF format of an Apple disk image. Anything else stays unnamed.
 */
export function describeBinary(head: Uint8Array, tail: Uint8Array | null): BinaryKind | null {
	const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
	if (startsWith(head, [0x4d, 0x5a])) return portableExecutable(view);
	if (head.length >= 8 && (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xce, 0xfa, 0xed, 0xfe]))) {
		const cpu = MACHO_CPUS[view.getUint32(4, true)] ?? "unknown CPU";
		return { label: "플랫폼", value: `macOS (Mach-O, ${cpu})` };
	}
	if (startsWith(head, [0xca, 0xfe, 0xba, 0xbe]) && head.length >= 8 && view.getUint32(4, false) < 20) {
		// Java class files share the magic; their next word is a version far above 20.
		return { label: "플랫폼", value: "macOS (Universal)" };
	}
	if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46]) && head.length >= 20) {
		const bits = head[4] === 2 ? "64-bit" : "32-bit";
		const machine = ELF_MACHINES[view.getUint16(18, head[5] !== 2)] ?? "unknown CPU";
		return { label: "플랫폼", value: `Linux (ELF ${bits}, ${machine})` };
	}
	if (tail !== null && startsWith(tail, [0x6b, 0x6f, 0x6c, 0x79])) return { label: "포맷", value: "Apple 디스크 이미지 (UDIF)" };
	return null;
}
