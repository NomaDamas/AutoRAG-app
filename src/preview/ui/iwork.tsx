import { useCallback, useEffect, useState, type ReactElement } from "react";
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
			if (source === undefined) throw new Error("이 슬라이드의 이미지가 없습니다");
			const image = new Image();
			image.alt = `${index + 1}페이지`;
			image.draggable = false;
			const done = new Promise<HTMLElement>((resolve, reject) => {
				image.onload = () => resolve(image);
				image.onerror = () => reject(new Error("슬라이드를 그리지 못했습니다"));
			});
			image.src = source;
			return { done, cancel: () => image.removeAttribute("src") };
		},
		[urls],
	);

	if (bytes === null || failed) return <FallbackView file={file} note="이 문서에는 미리보기 이미지가 없습니다" />;
	if (pages !== null && pages.length > 1) {
		if (box === null) return <Status>불러오는 중</Status>;
		// The stage centers single pictures, which would shrink the paged column
		// to fit; stretching the wrapper keeps the rail and the paper cards full width.
		return (
			<div className="ql__iwork-pages flex flex-1 self-stretch min-w-0 min-h-0">
				<PagedView file={file} boxes={pages.map(() => box)} draw={draw} />
			</div>
		);
	}
	if (url === null) return <Status>불러오는 중</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
