export function looksLikeText(bytes: Uint8Array): boolean {
	const sample = bytes.subarray(0, 4096);
	if (sample.length === 0) return true;
	let odd = 0;
	for (const byte of sample) {
		if (byte === 0) return false;
		if (byte < 9 || (byte > 13 && byte < 32)) odd += 1;
	}
	return odd / sample.length < 0.05;
}

export function decodeUtf8(bytes: Uint8Array, limit = 200_000): string {
	const slice = bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
	return new TextDecoder("utf-8", { fatal: false }).decode(slice);
}
