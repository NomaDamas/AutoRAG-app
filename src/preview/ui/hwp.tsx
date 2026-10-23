import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import type { HwpPages } from "../shared/hwp";
import { locateMarks } from "../shared/text-marks";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage, type EvidenceMarks } from "./paged";
import { loadRhwp } from "./rhwp";

/**
 * HWP and HWPX in the PDF panel's paged layout. rhwp paginates the whole
 * document up front and draws each page as SVG; a page is shown as an image
 * of that SVG, so nothing in the document can run script or reach the network.
 */
export function HwpView({ file, anchor = null }: { readonly file: PreviewDocument; readonly anchor?: readonly string[] | null }): ReactElement {
	const { t } = useTranslation();
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
				if (!cancelled) setError(caught instanceof Error ? caught.message : t("quickLook.hwp.openFailed"));
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
			image.alt = t("quickLook.hwp.page", { count: index + 1 });
			image.draggable = false;
			const done = Promise.resolve()
				.then(() => {
					image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(pages.svg(index))}`;
					return image.decode();
				})
				.then(() => image);
			return { done, cancel: () => image.removeAttribute("src") };
		},
		[pages, t],
	);
	const evidence = useMemo<EvidenceMarks | null>(() => {
		if (pages === null || anchor === null || anchor.length === 0) return null;
		const marks = locateMarks(
			pages.boxes.map((_box, index) => pages.runs(index)),
			anchor,
		);
		return marks === null ? { state: "missing" } : { state: "found", pages: [marks, ...marks.next] };
	}, [pages, anchor]);

	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (pages === null) return <Status>{t("quickLook.status.loading")}</Status>;
	if (pages.boxes.length === 0) return <FallbackView file={file} note={t("quickLook.hwp.noPages")} />;
	return <PagedView file={file} boxes={pages.boxes} draw={draw} evidence={evidence} />;
}
