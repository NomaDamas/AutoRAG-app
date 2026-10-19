import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { unzipSync } from "fflate";
import type { PreviewDocument } from "../shared/contract";
import { renderOdpSlide, renderOdt, type OdfDom, type ResolvePicture } from "../shared/odf-render";
import { pictureMime, PICTURE_CAP, PICTURES_TOTAL_CAP, type OdfDocument, type ParseOdf } from "../shared/odf-xml";
import { buildOdpDeck, type OdpDeck } from "../shared/odp-model";
import { buildOdtDocument, odtPictures, type OdtDocument } from "../shared/odt-model";
import { FallbackView, Status } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

function parseOdfXml(text: string): OdfDocument | null {
	const document = new DOMParser().parseFromString(text, "application/xml");
	return document.getElementsByTagName("parsererror").length > 0 ? null : (document as unknown as OdfDocument);
}

const parse: ParseOdf = parseOdfXml;

/** Inflates just the named picture entries and returns blob URLs for them (revoke with `release`). */
function loadPictures(bytes: Uint8Array, wanted: ReadonlySet<string>): Map<string, string> {
	const urls = new Map<string, string>();
	if (wanted.size === 0) return urls;
	let total = 0;
	try {
		const files = unzipSync(bytes, {
			filter: (entry) => {
				if (!wanted.has(entry.name) || pictureMime(entry.name) === null || entry.originalSize > PICTURE_CAP) return false;
				if (entry.compression !== 0 && entry.compression !== 8) return false;
				total += entry.originalSize;
				return total <= PICTURES_TOTAL_CAP;
			},
		});
		for (const [name, data] of Object.entries(files)) {
			const mime = pictureMime(name);
			if (mime !== null) urls.set(name, URL.createObjectURL(new Blob([new Uint8Array(data)], { type: mime })));
		}
	} catch {
		// A damaged picture entry only costs the pictures.
	}
	return urls;
}

function release(urls: ReadonlyMap<string, string>): void {
	for (const url of urls.values()) URL.revokeObjectURL(url);
}

/** `.odt`: the document's headings, paragraphs, lists, tables, and pictures on a white page. */
export function OdtView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const model: OdtDocument | null = useMemo(() => (bytes === null ? null : buildOdtDocument(bytes, parse)), [bytes]);
	const [host, setHost] = useState<HTMLDivElement | null>(null);
	useEffect(() => {
		if (host === null || bytes === null || model === null) return;
		const urls = loadPictures(bytes, new Set(odtPictures(model)));
		const resolve: ResolvePicture = (entry) => urls.get(entry) ?? null;
		host.replaceChildren(renderOdt(document as unknown as OdfDom, model.blocks, resolve) as unknown as Node);
		return () => {
			host.replaceChildren();
			release(urls);
		};
	}, [host, bytes, model]);
	if (bytes === null || model === null) return <FallbackView file={file} note={t("quickLook.odf.readFailed")} />;
	return <div ref={setHost} className="ql__odt flex-1 self-stretch w-full min-h-0 overflow-auto bg-ql-sunk select-text" data-truncated={model.truncated} />;
}

/** `.odp` in the PDF panel's paged layout, each `draw:page` drawn as positioned DOM. */
export function OdpView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const deck: OdpDeck | null = useMemo(() => (bytes === null ? null : buildOdpDeck(bytes, parse)), [bytes]);
	const boxes = useMemo(() => (deck === null ? [] : deck.slides.map(() => ({ width: deck.width, height: deck.height }))), [deck]);
	const draw = useCallback<DrawPage>(
		(index, width, onBox) => {
			if (deck === null || bytes === null) throw new Error(t("quickLook.odf.openFailed"));
			const slide = deck.slides[index];
			if (slide === undefined) throw new Error(t("quickLook.odf.noSlides"));
			onBox({ width: deck.width, height: deck.height });
			const urls = loadPictures(bytes, new Set(slide.media));
			const node = renderOdpSlide(document as unknown as OdfDom, deck, index, (entry) => urls.get(entry) ?? null) as unknown as HTMLElement;
			const scale = width / deck.width;
			node.style.transformOrigin = "top left";
			node.style.transform = `scale(${scale})`;
			const wrapper = document.createElement("div");
			wrapper.className = "ql__odp-slide";
			wrapper.style.position = "relative";
			wrapper.style.width = `${width}px`;
			wrapper.style.height = `${Math.round(deck.height * scale)}px`;
			wrapper.style.overflow = "hidden";
			wrapper.appendChild(node);
			const images = Array.from(wrapper.querySelectorAll("img"));
			const done = Promise.all(images.map((image) => image.decode().catch(() => undefined))).then(() => wrapper);
			return { done, cancel: () => release(urls) };
		},
		[deck, bytes, t],
	);
	if (bytes === null || deck === null) return <FallbackView file={file} note={t("quickLook.odf.readFailed")} />;
	return (
		<div className="ql__odp flex flex-1 flex-col min-h-0 w-full self-stretch">
			<PagedView file={file} boxes={boxes} draw={draw} />
		</div>
	);
}

/** `.odg`/`.ods`/a damaged `.odt`: the embedded first-page image, or the "Other" panel. */
export function OdfImageView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (bytes === null) return;
		const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
		setFailed(false);
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [bytes]);
	if (bytes === null || failed) return <FallbackView file={file} note={t("quickLook.odf.noPreview")} />;
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
