import { useCallback, useEffect, useState, type ReactElement } from "react";
import wasmUrl from "@rhwp/core/rhwp_bg.wasm?url";
import type { PreviewDocument } from "../shared/contract";
import type { HwpPages } from "../shared/hwp";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

let rhwp: Promise<(bytes: Uint8Array) => HwpPages> | null = null;

/**
 * rhwp (Rust + WebAssembly, the engine alhangeul-macos ships) loads on the
 * first HWP preview, never with the window: its glue and 10MB module stay out
 * of the Quick Look bundle until a document needs them.
 */
function loadRhwp(): Promise<(bytes: Uint8Array) => HwpPages> {
	rhwp ??= Promise.all([import("@rhwp/core"), import("../shared/hwp")]).then(async ([core, hwp]) => {
		await core.default({ module_or_path: wasmUrl });
		return hwp.openHwp;
	});
	return rhwp;
}

/**
 * HWP and HWPX in the PDF panel's paged layout. rhwp paginates the whole
 * document up front and draws each page as SVG; a page is shown as an image
 * of that SVG, so nothing in the document can run script or reach the network.
 */
export function HwpView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [pages, setPages] = useState<HwpPages | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		let opened: HwpPages | null = null;
		loadRhwp()
			.then((open) => {
				if (cancelled) return;
				opened = open(bytes);
				setPages(opened);
			})
			.catch((caught: unknown) => {
				if (!cancelled) setError(caught instanceof Error ? caught.message : "한글 문서를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			opened?.close();
		};
	}, [bytes]);

	const draw = useCallback<DrawPage>(
		(index) => {
			if (pages === null) throw new Error("HWP document is not open");
			const image = new Image();
			image.alt = `${index + 1}페이지`;
			image.draggable = false;
			const done = Promise.resolve()
				.then(() => {
					image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pages.svg(index))}`;
					return image.decode();
				})
				.then(() => image);
			return { done, cancel: () => image.removeAttribute("src") };
		},
		[pages],
	);

	if (bytes === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (pages === null) return <Status>불러오는 중</Status>;
	if (pages.boxes.length === 0) return <FallbackView file={file} note="페이지가 없습니다" />;
	return <PagedView file={file} boxes={pages.boxes} draw={draw} />;
}
