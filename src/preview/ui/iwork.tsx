import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

/**
 * Numbers, Pages, and Keynote files. Numbers and Pages show the first sheet or
 * page Apple stored in the package. A Keynote deck shows every slide in the
 * PDF panel's paged layout: the quality first-page image from `preview.jpg`,
 * then the app's own 356px render of each following slide. When the Keynote app
 * is installed those are upgraded in place to full-size slides it draws
 * (`slidesRendering` shows a badge until they land). A package without a
 * page image gets the "Other" panel.
 */
export function IworkView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const pages = file.pages ?? null;
	const paged = pages !== null && pages.length > 1;
	const [url, setUrl] = useState<string | null>(null);
	const [firstUrl, setFirstUrl] = useState<string | null>(null);
	const [revisions, setRevisions] = useState<readonly number[]>([]);
	const [box, setBox] = useState<Size | null>(null);
	const [failed, setFailed] = useState(false);
	/** One object URL per slide's bytes: a slide whose bytes did not change keeps its URL (and its drawn card). */
	const urlByBytes = useRef(new Map<Uint8Array, string>());
	const urlsRef = useRef<readonly string[]>([]);

	useEffect(() => {
		if (!paged || pages === null) return;
		const known = urlByBytes.current;
		const keep = new Set<Uint8Array>(pages);
		for (const [entry, source] of known) {
			if (keep.has(entry)) continue;
			URL.revokeObjectURL(source);
			known.delete(entry);
		}
		const next = pages.map((page) => {
			let source = known.get(page);
			if (source === undefined) {
				source = URL.createObjectURL(new Blob([new Uint8Array(page)], { type: "image/jpeg" }));
				known.set(page, source);
			}
			return source;
		});
		const before = urlsRef.current;
		urlsRef.current = next;
		setFailed(false);
		setFirstUrl(next[0] ?? null);
		setRevisions((current) => next.map((source, index) => (source === before[index] ? (current[index] ?? 0) : (current[index] ?? 0) + 1)));
	}, [paged, pages]);

	useEffect(() => {
		const known = urlByBytes.current;
		return () => {
			for (const source of known.values()) URL.revokeObjectURL(source);
			known.clear();
			urlsRef.current = [];
		};
	}, []);

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
		if (firstUrl === null) return;
		let cancelled = false;
		const image = new Image();
		image.onload = () => {
			if (!cancelled) setBox({ width: image.naturalWidth, height: image.naturalHeight });
		};
		image.onerror = () => {
			if (!cancelled) setFailed(true);
		};
		image.src = firstUrl;
		return () => {
			cancelled = true;
			image.onload = null;
			image.onerror = null;
		};
	}, [firstUrl]);

	// Stable across upgrades: a sharper slide redraws only its own card (`revisions`).
	const draw = useCallback<DrawPage>(
		(index) => {
			const source = urlsRef.current[index];
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
		[t],
	);

	if (bytes === null || failed) return <FallbackView file={file} note={t("quickLook.iwork.noPreview")} />;
	if (pages !== null && pages.length > 1) {
		if (box === null) return <Status>{t("quickLook.status.loading")}</Status>;
		// The stage centers single pictures, which would shrink the paged column
		// to fit; stretching the wrapper keeps the rail and the paper cards full width.
		return (
			<div className="ql__iwork-pages relative flex flex-1 self-stretch min-w-0 min-h-0">
				<PagedView file={file} boxes={pages.map(() => box)} draw={draw} revisions={revisions} />
				{file.slidesRendering ? (
					<div
						role="status"
						className="ql__iwork-rendering pointer-events-none absolute top-12 left-[calc((100%-128px)/2)] -translate-x-1/2 flex items-center gap-6 rounded-full bg-ql-panel-solid px-12 py-6 text-[12px] text-ql-ink shadow-ql-panel"
					>
						<span aria-hidden="true" className="size-12 animate-spin rounded-full border-2 border-current border-t-transparent" />
						{t("quickLook.iwork.rendering")}
					</div>
				) : null}
			</div>
		);
	}
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
