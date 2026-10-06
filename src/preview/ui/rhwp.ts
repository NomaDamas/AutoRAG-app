import wasmUrl from "@rhwp/core/rhwp_bg.wasm?url";
import { previewStreamUrl } from "../shared/contract";
import type { HwpPages } from "../shared/hwp";

/** Same cap as the Quick Look whole-file read: larger documents keep their tile. */
const HWP_BYTE_CAP = 32 * 1024 * 1024;

let rhwp: Promise<(bytes: Uint8Array) => HwpPages> | null = null;

/**
 * rhwp (Rust + WebAssembly, the engine alhangeul-macos ships) loads on the
 * first HWP a window shows, never with the window: its glue and 10MB module
 * stay out of the startup bundle until a document needs them.
 */
export function loadRhwp(): Promise<(bytes: Uint8Array) => HwpPages> {
	rhwp ??= import("../shared/hwp").then(async (hwp) => {
		await hwp.initRhwp({ module_or_path: wasmUrl });
		return hwp.openHwp;
	});
	return rhwp;
}

/**
 * An `<img>`-ready data URL of the first page of the HWP/HWPX at `path`, read
 * through the preview protocol; null for an empty document or one over the cap.
 */
export async function hwpFirstPageUrl(path: string): Promise<string | null> {
	const response = await fetch(previewStreamUrl(path));
	if (!response.ok) throw new Error(`HWP preview read failed: ${response.status}`);
	if (Number(response.headers.get("content-length") ?? 0) > HWP_BYTE_CAP) return null;
	const [open, bytes] = await Promise.all([loadRhwp(), response.arrayBuffer()]);
	const pages = open(new Uint8Array(bytes));
	try {
		if (pages.boxes.length === 0) return null;
		return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pages.svg(0))}`;
	} finally {
		pages.close();
	}
}
