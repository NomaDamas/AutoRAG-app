import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { LegacyOfficeError, readPowerPointDeck, readWordDocument, sniffLegacyContainer, type DeckText, type WordText } from "../shared/legacy-office";
import { DocxView, RtfView } from "./documents";
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
	const bytes = file.bytes;
	const container = bytes === null ? null : sniffLegacyContainer(bytes);
	const result = useMemo(() => (bytes === null || container !== "ole" ? null : attempt<WordText>(bytes, readWordDocument)), [bytes, container]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (container === "zip") return <DocxView file={file} />;
	if (container === "rtf") return <RtfView file={file} />;
	if (result === null || !result.ok) return <FallbackView file={file} note={t(CODE_KEYS[result === null ? "unsupported" : result.code])} />;
	const { pages, truncated } = result.value;
	return (
		<div className={PAPER}>
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
	const bytes = file.bytes;
	const container = bytes === null ? null : sniffLegacyContainer(bytes);
	const result = useMemo(() => (bytes === null || container !== "ole" ? null : attempt<DeckText>(bytes, readPowerPointDeck)), [bytes, container]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.documents.readFailed")} />;
	if (container === "zip") return <PptxView file={file} />;
	if (result === null || !result.ok) return <FallbackView file={file} note={t(CODE_KEYS[result === null ? "unsupported" : result.code])} />;
	const { slides, truncated } = result.value;
	return (
		<div className={PAPER}>
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
