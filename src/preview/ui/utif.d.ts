declare module "pdfjs-dist/build/pdf.worker.min.mjs?url" {
	const src: string;
	export default src;
}

declare module "utif" {
	export interface TiffPage {
		width: number;
		height: number;
	}

	export function decode(buffer: Uint8Array): TiffPage[];
	export function decodeImage(buffer: Uint8Array, page: TiffPage): void;
	export function toRGBA8(page: TiffPage): Uint8Array;
}
