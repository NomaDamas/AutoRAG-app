import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

/**
 * Numbers, Pages, and Keynote files. Numbers and Pages show the first sheet or
 * page Apple stored in the package. A Keynote deck shows every slide in the
 * PDF panel's paged layout: the quality first-page image from `preview.jpg`,
 * then the app's own 356px render of each following slide. A package without a
 * page image gets the "Other" panel.
 */
export function IworkView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const pages = file.pages ?? null;
	const paged = pages !== null && pages.length > 1;
	const [url, setUrl] = useState<string | null>(null);
	const [urls, setUrls] = useState<readonly string[] | null>(null);
	const [box, setBox] = useState<Size | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!paged || pages === null) return;
		const next = pages.map((page) => URL.createObjectURL(new Blob([new Uint8Array(page)], { type: "image/jpeg" })));
		setFailed(false);
		setUrls(next);
		return () => {
			for (const entry of next) URL.revokeObjectURL(entry);
			setUrls(null);
		};
	}, [paged, pages]);

	useEffect(() => {
		if (paged || bytes === null) return;
		const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
		setFailed(false);
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [paged, bytes]);

	// Every slide shares the deck's aspect ratio, so the first image sizes them all.
	useEffect(() => {
		const source = urls?.[0];
		if (source === undefined) return;
		let cancelled = false;
		const image = new Image();
		image.onload = () => {
			if (!cancelled) setBox({ width: image.naturalWidth, height: image.naturalHeight });
		};
		image.onerror = () => {
			if (!cancelled) setFailed(true);
		};
		image.src = source;
		return () => {
			cancelled = true;
			image.onload = null;
			image.onerror = null;
		};
	}, [urls]);

	const draw = useCallback<DrawPage>(
		(index) => {
			const source = urls?.[index];
			if (source === undefined) throw new Error(t("quickLook.iwork.slideMissing"));
			const image = new Image();
			image.alt = t("quickLook.iwork.page", { count: index + 1 });
			image.draggable = false;
			const done = new Promise<HTMLElement>((resolve, reject) => {
				image.onload = () => resolve(image);
				image.onerror = () => reject(new Error(t("quickLook.iwork.drawFailed")));
			});
			image.src = source;
			return { done, cancel: () => image.removeAttribute("src") };
		},
		[urls, t],
	);

	if (bytes === null || failed) return <FallbackView file={file} note={t("quickLook.iwork.noPreview")} />;
	if (pages !== null && pages.length > 1) {
		if (box === null) return <Status>{t("quickLook.status.loading")}</Status>;
		// The stage centers single pictures, which would shrink the paged column
		// to fit; stretching the wrapper keeps the rail and the paper cards full width.
		return (
			<div className="ql__iwork-pages flex flex-1 self-stretch min-w-0 min-h-0">
				<PagedView file={file} boxes={pages.map(() => box)} draw={draw} />
			</div>
		);
	}
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
