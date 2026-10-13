import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { unzipSync } from "fflate";
import type { PreviewDocument } from "../shared/contract";
import { buildPptxDeck, entryMime, EMU_PER_PX, type ParseXml, type PptxDeck, type XmlDocument } from "../shared/pptx-model";
import { renderSlide, type PptxDom } from "../shared/pptx-render";
import { FallbackView } from "./fallback";
import { PagedView, type DrawPage } from "./paged";

/** The largest single media entry the preview will inflate for one slide. */
const MEDIA_CAP = 24 * 1024 * 1024;

/**
 * OOXML is parsed with the renderer's `DOMParser`; a `<parsererror>` element
 * means the text was not usable XML and that part fails. This is the only
 * place the model's DOM-free walk gets real DOM types.
 */
function parsePptxXml(text: string): XmlDocument | null {
	const document = new DOMParser().parseFromString(text, "application/xml");
	// `Document` and the model's structural `XmlDocument` describe the same tree.
	return document.getElementsByTagName("parsererror").length > 0 ? null : (document as unknown as XmlDocument);
}

/**
 * PowerPoint `.pptx`/`.pptm`/`.ppsx` in the PDF panel's paged layout: every
 * slide drawn from the OOXML as real DOM (selectable text, positioned shapes,
 * pictures, tables, backgrounds). Each slide's pictures are inflated from the
 * zip only when that page or thumbnail is drawn, and their blob URLs are
 * revoked when the page is released.
 */
export function PptxView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const deck: PptxDeck | null = useMemo(() => (bytes === null ? null : buildPptxDeck(bytes, parsePptxXml)), [bytes]);
	const boxes = useMemo(
		() => (deck === null ? [] : deck.slides.map(() => ({ width: deck.width / EMU_PER_PX, height: deck.height / EMU_PER_PX }))),
		[deck],
	);
	const draw = useCallback<DrawPage>(
		(index, width, onBox) => {
			if (deck === null || bytes === null) throw new Error(t("quickLook.pptx.openFailed"));
			const slide = deck.slides[index];
			if (slide === undefined) throw new Error(t("quickLook.pptx.noSlides"));
			const naturalWidth = deck.width / EMU_PER_PX;
			const naturalHeight = deck.height / EMU_PER_PX;
			onBox({ width: naturalWidth, height: naturalHeight });
			const needed = new Set(slide.media);
			let files: Record<string, Uint8Array> = {};
			if (needed.size > 0) {
				try {
					files = unzipSync(bytes, {
						filter: (entry) => needed.has(entry.name) && entry.originalSize <= MEDIA_CAP && (entry.compression === 0 || entry.compression === 8),
					});
				} catch {
					files = {};
				}
			}
			const urls = new Map<string, string>();
			for (const [name, data] of Object.entries(files)) urls.set(name, URL.createObjectURL(new Blob([new Uint8Array(data)], { type: entryMime(name) })));
			const node = renderSlide(deck, index, (entry) => urls.get(entry) ?? null, document as unknown as PptxDom);
			const scale = width / naturalWidth;
			const wrapper = document.createElement("div");
			wrapper.className = "ql__pptx-slide";
			wrapper.style.position = "relative";
			wrapper.style.width = `${width}px`;
			wrapper.style.height = `${Math.round(naturalHeight * scale)}px`;
			wrapper.style.overflow = "hidden";
			const scaled = node as unknown as HTMLElement;
			scaled.style.transformOrigin = "top left";
			scaled.style.transform = `scale(${scale})`;
			wrapper.appendChild(scaled);
			// Resolve pictures before the page swaps in, so a drawn slide is never blank.
			const images = Array.from(wrapper.querySelectorAll("img"));
			const done = Promise.all(images.map((image) => image.decode().catch(() => undefined))).then(() => wrapper);
			return {
				done,
				cancel: () => {
					for (const url of urls.values()) URL.revokeObjectURL(url);
				},
			};
		},
		[deck, bytes, t],
	);
	if (bytes === null || deck === null || deck.slides.length === 0) return <FallbackView file={file} note={t("quickLook.pptx.readFailed")} />;
	// The stage centers measured viewers, which would collapse `PagedView`'s
	// flex row to its content width; this pane stretches it in either layout.
	return (
		<div className="ql__pptx flex flex-1 flex-col min-h-0 w-full self-stretch">
			<PagedView file={file} boxes={boxes} draw={draw} />
		</div>
	);
}
