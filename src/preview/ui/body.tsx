import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { assertNever } from "../shared/assert";
import type { PreviewDocument } from "../shared/contract";
import { viewerForExtension } from "../shared/registry";
import { looksLikeText } from "../shared/text-sample";
import { ArchiveListView, ArchiveView } from "./archive";
import { CalendarView } from "./calendar";
import { ContactView } from "./contact";
import { HtmlView, JsonLinesView, PlistView, TextView } from "./code";
import { DataView } from "./data";
import { DocxView, RtfView, SheetView } from "./documents";
import { FallbackView } from "./fallback";
import { GoogleDriveView } from "./google-drive";
import { MailView } from "./mail";
import { MarkdownView } from "./markdown";
import { HwpView } from "./hwp";
import { LegacyDocView, LegacyPptView } from "./legacy-office";
import { FontView, HeicView, ImageView, TiffView } from "./media";
import { IworkView } from "./iwork";
import { EpubView } from "./packages";
import { OdfImageView, OdpView, OdtView } from "./odf";
import { PptxView } from "./pptx";
import { RasterView } from "./raster";
import { PdfView } from "./pdf";
import { AudioView, VideoView } from "./player";

/** `anchor` holds AI Search evidence excerpts to highlight; viewers that cannot locate text ignore it. */
export function PreviewBody({ file, anchor = null }: { readonly file: PreviewDocument; readonly anchor?: readonly string[] | null }): ReactElement {
	const { t } = useTranslation();
	const kind = viewerForExtension(file.ext);
	if (file.size === 0) return <FallbackView file={file} note={t("quickLook.body.emptyFile")} />;
	// Only whole-file viewers arrive truncated without bytes; streamed and prefix viewers always have what they need.
	if (file.truncated && file.bytes === null) {
		return <FallbackView file={file} note={t("quickLook.body.tooLarge")} />;
	}
	switch (kind) {
		case "image":
			return <ImageView file={file} />;
		case "video":
			return <VideoView file={file} />;
		case "audio":
			return <AudioView file={file} />;
		case "font":
			return <FontView file={file} />;
		case "tiff":
			return <TiffView file={file} />;
		case "heic":
			return <HeicView file={file} />;
		case "pdf":
			return <PdfView file={file} anchor={anchor} />;
		case "docx":
			return <DocxView file={file} />;
		case "legacyDoc":
			return <LegacyDocView file={file} />;
		case "sheet":
			return <SheetView file={file} />;
		case "pptx":
			return <PptxView file={file} />;
		case "legacyPpt":
			return <LegacyPptView file={file} />;
		case "odt":
			return <OdtView file={file} />;
		case "odp":
			return <OdpView file={file} />;
		case "odg":
			return <OdfImageView file={file} />;
		case "markdown":
			return <MarkdownView file={file} anchor={anchor} />;
		case "html":
			return <HtmlView file={file} />;
		case "text":
			return <TextView file={file} anchor={anchor} />;
		case "rtf":
			return <RtfView file={file} />;
		case "data":
			return <DataView file={file} />;
		case "jsonl":
			return <JsonLinesView file={file} />;
		case "plist":
			return <PlistView file={file} />;
		case "archive":
			return <ArchiveView file={file} />;
		case "archiveList":
			return <ArchiveListView file={file} />;
		case "iwork":
			return <IworkView file={file} />;
		case "epub":
			return <EpubView file={file} />;
		case "hwp":
			return <HwpView file={file} anchor={anchor} />;
		case "mail":
		case "msg":
			return <MailView file={file} />;
		case "contact":
			return <ContactView file={file} />;
		case "calendar":
			return <CalendarView file={file} />;
		case "gdrive":
			return <GoogleDriveView file={file} />;
		case "raster":
			return <RasterView file={file} />;
		case "fallback":
			if (file.bytes !== null && looksLikeText(file.bytes)) return <TextView file={file} anchor={anchor} />;
			return <FallbackView file={file} />;
		default:
			return assertNever(kind);
	}
}
