import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { LegacyOfficeError, officePageWidth, readPowerPointDeck, readWordDocument, sniffLegacyContainer, type DeckText, type WordText } from "../shared/legacy-office";
import { DocxView, RtfView } from "./documents";
import { Segmented, ToolbarSlot, useChrome } from "./chrome";
import { FallbackView } from "./fallback";
import { PptxView } from "./pptx";

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: LegacyOfficeError["code"] };

function attempt<T>(bytes: Uint8Array, read: (bytes: Uint8Array) => T): Read<T> {
	try {
		return { ok: true, value: read(bytes) };
	} catch (error) {
		if (error instanceof LegacyOfficeError) return { ok: false, code: error.code };
		throw error;
	}
}

const CODE_KEYS = {
	encrypted: "quickLook.legacyOffice.encrypted",
	unsupported: "quickLook.legacyOffice.unsupported",
	corrupt: "quickLook.legacyOffice.corrupt",
	empty: "quickLook.legacyOffice.empty",
} as const;

type Mode = "page" | "text";

/** Window height asked for a page: tall, and clamped to the screen by the window. */
const PAGE_HEIGHT = 1400;
/** Width asked for the extracted-text view. */
const TEXT_WIDTH = 760;
/** The window width asked for a first-page image before the page states its own: a slide, or a Word page with margin room. */
const SLIDE_WIDTH = 736;
const DOCUMENT_WIDTH = 675;

/**
 * The page macOS drew for the file, in a frame with no permissions (no
 * scripts, no network, no navigation; the page also carries its own CSP).
 * While the whole page is still being drawn, the OS first-page image holds
 * the place (`firstPage`) and is removed once the frame has painted.
 */
function RenderedPage({ html, firstPage }: { readonly html: string; readonly firstPage: string | null }): ReactElement {
	const { t } = useTranslation();
	const { resize } = useChrome();
	const width = useMemo(() => officePageWidth(html), [html]);
	// `resize`, not `report`: the pending view may already have sized the window.
	useEffect(() => resize({ width, height: PAGE_HEIGHT }), [resize, width]);
	// A blob URL, not `srcDoc`: the generator writes lengths without units
	// (`width: 720`), which only quirks mode accepts, and an `srcdoc` document is
	// never parsed in quirks mode, so every slide would collapse to nothing.
	const [url, setUrl] = useState<string | null>(null);
	const [painted, setPainted] = useState(false);
	useEffect(() => {
		const next = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
		setPainted(false);
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [html]);
	return (
		<div className="ql__office relative flex-1 self-stretch min-h-0 overflow-hidden bg-window">
			{firstPage !== null && !painted ? <img className="ql__image absolute inset-x-0 top-0 block w-full h-auto" alt="" src={firstPage} draggable={false} /> : null}
			{/* Transparent until it has loaded: its opaque background would otherwise blank the first-page image while the page is still being parsed. */}
			{url === null ? null : <iframe className={`ql__frame absolute inset-0 w-full h-full border-0 bg-window ${painted ? "opacity-100" : "opacity-0"}`} sandbox="" title={t("quickLook.legacyOffice.rendered")} src={url} onLoad={() => setPainted(true)} />}
		</div>
	);
}

/**
 * The OS draws a generic type icon (the Word logo on a transparent page) for a
 * file it cannot render; a real first-page image is an opaque rectangle. Only
 * the corner pixel tells them apart cheaply, and showing the logo as if it were
 * the document would be worse than showing nothing.
 */
function isOpaqueCorner(image: HTMLImageElement): boolean {
	const canvas = document.createElement("canvas");
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (context === null) return false;
	context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
	return (context.getImageData(0, 0, 1, 1).data[3] ?? 0) >= 250;
}

/** The OS first-page image alone, while the whole page is still being drawn; sizes the window like the page will. */
function FirstPage({ src, onGeneric }: { readonly src: string; readonly onGeneric: () => void }): ReactElement {
	const { report } = useChrome();
	const [shape, setShape] = useState<"unknown" | "landscape" | "portrait">("unknown");
	useEffect(() => {
		if (shape !== "unknown") report({ width: shape === "landscape" ? SLIDE_WIDTH : DOCUMENT_WIDTH, height: PAGE_HEIGHT }, "clamp");
	}, [report, shape]);
	return (
		<div className="ql__office relative flex-1 self-stretch min-h-0 overflow-hidden bg-window">
			<img
				className={`ql__image absolute inset-x-0 top-0 block w-full h-auto ${shape === "unknown" ? "opacity-0" : "opacity-100"}`}
				alt=""
				src={src}
				crossOrigin="anonymous"
				draggable={false}
				onLoad={(event) => {
					const image = event.currentTarget;
					if (!isOpaqueCorner(image)) {
						onGeneric();
						return;
					}
					setShape(image.naturalWidth > image.naturalHeight ? "landscape" : "portrait");
				}}
				onError={onGeneric}
			/>
		</div>
	);
}

function PageWithSwitch({ html, firstPage, mode, onMode }: { readonly html: string; readonly firstPage: string | null; readonly mode: Mode; readonly onMode: (mode: Mode) => void }): ReactElement {
	return (
		<>
			<ModeSwitch mode={mode} onMode={onMode} />
			<RenderedPage html={html} firstPage={firstPage} />
		</>
	);
}

function ModeSwitch({ mode, onMode }: { readonly mode: Mode; readonly onMode: (mode: Mode) => void }): ReactElement {
	const { t } = useTranslation();
	const options = useMemo(
		() => [
			{ value: "page" as const, label: t("quickLook.legacyOffice.modePage") },
			{ value: "text" as const, label: t("quickLook.legacyOffice.modeText") },
		],
		[t],
	);
	return (
		<ToolbarSlot>
			<Segmented label={t("quickLook.code.viewMode")} options={options} value={mode} onChange={onMode} />
		</ToolbarSlot>
	);
}

function TextWidth(): null {
	const { report } = useChrome();
	useEffect(() => report({ width: TEXT_WIDTH, height: PAGE_HEIGHT }, "clamp"), [report]);
	return null;
}

const PAPER = "ql__legacy box-border flex flex-col gap-14 self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink text-meta select-text";
const CARD = "rounded-8 border border-divider bg-ql-paper px-20 py-16 leading-[1.6] whitespace-pre-wrap [word-break:break-word]";

function Notice({ children }: { readonly children: string }): ReactElement {
	return <p className="m-0 text-ink-muted text-[12px]">{children}</p>;
}

/**
 * Word 97-2003 `.doc`/`.dot`: the document's text, one card per page break.
 * Layout, pictures, and macros are not read (see `shared/legacy-office.ts`);
 * Word also saves RTF and OOXML under this extension, so the file's own first
 * bytes pick the viewer.
 */
export function LegacyDocView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const [mode, setMode] = useState<Mode>("page");
	const [generic, setGeneric] = useState(false);
	const bytes = file.bytes;
	const container = bytes === null ? null : sniffLegacyContainer(bytes);
	const result = useMemo(() => (bytes === null || container !== "ole" ? null : attempt<WordText>(bytes, readWordDocument)), [bytes, container]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (container === "zip") return <DocxView file={file} />;
	if (container === "rtf") return <RtfView file={file} />;
	const office = file.office;
	if (office !== null && mode === "page") {
		if (office.html !== null) return <PageWithSwitch html={office.html} firstPage={office.firstPage} mode={mode} onMode={setMode} />;
		if (office.pending && office.firstPage !== null && !generic) return <FirstPage src={office.firstPage} onGeneric={() => setGeneric(true)} />;
	}
	if (result === null || !result.ok) return <FallbackView file={file} note={t(CODE_KEYS[result === null ? "unsupported" : result.code])} />;
	const { pages, truncated } = result.value;
	return (
		<div className={PAPER}>
			<TextWidth />
			{office?.html == null ? null : <ModeSwitch mode={mode} onMode={setMode} />}
			{pages.map((page, index) => (
				<section key={index} className={CARD} aria-label={t("quickLook.legacyOffice.page", { count: index + 1 })}>
					{page}
				</section>
			))}
			<Notice>{truncated ? t("quickLook.legacyOffice.truncated") : t("quickLook.legacyOffice.textOnly")}</Notice>
		</div>
	);
}

/** PowerPoint 97-2003 `.ppt`/`.pps`/`.pot`: every slide's title and text lines in show order. */
export function LegacyPptView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const [mode, setMode] = useState<Mode>("page");
	const [generic, setGeneric] = useState(false);
	const bytes = file.bytes;
	const container = bytes === null ? null : sniffLegacyContainer(bytes);
	const result = useMemo(() => (bytes === null || container !== "ole" ? null : attempt<DeckText>(bytes, readPowerPointDeck)), [bytes, container]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (container === "zip") return <PptxView file={file} />;
	const office = file.office;
	if (office !== null && mode === "page") {
		if (office.html !== null) return <PageWithSwitch html={office.html} firstPage={office.firstPage} mode={mode} onMode={setMode} />;
		if (office.pending && office.firstPage !== null && !generic) return <FirstPage src={office.firstPage} onGeneric={() => setGeneric(true)} />;
	}
	if (result === null || !result.ok) return <FallbackView file={file} note={t(CODE_KEYS[result === null ? "unsupported" : result.code])} />;
	const { slides, truncated } = result.value;
	return (
		<div className={PAPER}>
			<TextWidth />
			{office?.html == null ? null : <ModeSwitch mode={mode} onMode={setMode} />}
			{slides.map((slide, index) => (
				<section key={index} className={CARD} aria-label={t("quickLook.legacyOffice.slide", { count: index + 1 })}>
					<div className="mb-6 text-[11px] text-ink-muted">{t("quickLook.legacyOffice.slide", { count: index + 1 })}</div>
					{slide.title === "" ? null : <div className="text-[16px] font-semibold">{slide.title}</div>}
					{slide.lines.map((line, lineIndex) => (
						<div key={lineIndex}>{line}</div>
					))}
				</section>
			))}
			<Notice>{truncated ? t("quickLook.legacyOffice.truncated") : t("quickLook.legacyOffice.textOnly")}</Notice>
		</div>
	);
}
