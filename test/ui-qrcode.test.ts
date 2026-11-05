import { describe, expect, it } from "vitest";
import { encodeQrMatrix, qrSvgPath } from "../src/renderer/src/components/settings/QrCode";

describe("QR Code generator (Level M byte-mode)", () => {
	it("produces a valid square module matrix with intact 7x7 finder patterns at all three corners", () => {
		const modules = encodeQrMatrix("http://192.168.0.42:47833/?pair=123456");
		const size = modules.length;
		// Version 3 or 4: size = 4 * version + 17
		expect(size).toBeGreaterThanOrEqual(21);
		expect((size - 17) % 4).toBe(0);
		for (const row of modules) {
			expect(row.length).toBe(size);
		}

		// Top-left, top-right, and bottom-left 7x7 finder patterns have dark outer 7x7 ring and dark 3x3 center
		for (const [ox, oy] of [
			[0, 0],
			[size - 7, 0],
			[0, size - 7],
		] as const) {
			for (let dy = 0; dy < 7; dy++) {
				for (let dx = 0; dx < 7; dx++) {
					const dist = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
					const expectedDark = dist !== 2;
					expect(modules[oy + dy]?.[ox + dx]).toBe(expectedDark);
				}
			}
		}
	});

	it("renders deterministic SVG path with quiet zone", () => {
		const a = qrSvgPath("https://demo.trycloudflare.com/?pair=654321");
		const b = qrSvgPath("https://demo.trycloudflare.com/?pair=654321");
		expect(a).toEqual(b);
		expect(a.cells).toBeGreaterThan(29);
		expect(a.path).toContain("M4 4h1v1h-1z");
	});
});
