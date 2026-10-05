import type { ReactElement } from "react";
import { assertNever } from "../shared/assert";
import type { PreviewDocument } from "../shared/contract";
import { viewerForExtension } from "../shared/registry";
import { looksLikeText } from "../shared/text-sample";
import { HtmlView, TextView } from "./code";
import { DocxView, RtfView, SheetView } from "./documents";
import { FallbackView } from "./fallback";
import { MarkdownView } from "./markdown";
import { HwpView } from "./hwp";
import { FontView, HeicView, ImageView, TiffView } from "./media";
import { ArchiveView, EpubView, PptxView } from "./packages";
import { PdfView } from "./pdf";
import { AudioView, VideoView } from "./player";

export function PreviewBody({ file }: { readonly file: PreviewDocument }): ReactElement {
	const kind = viewerForExtension(file.ext);
	if (file.size === 0) return <FallbackView file={file} note="빈 파일" />;
	// Only whole-file viewers arrive truncated without bytes; streamed and prefix viewers always have what they need.
	if (file.truncated && file.bytes === null) {
		return <FallbackView file={file} note="이 파일은 너무 커서 내용 대신 정보만 보여 줍니다" />;
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
			return <PdfView file={file} />;
		case "docx":
			return <DocxView file={file} />;
		case "sheet":
			return <SheetView file={file} />;
		case "pptx":
			return <PptxView file={file} />;
		case "markdown":
			return <MarkdownView file={file} />;
		case "html":
			return <HtmlView file={file} />;
		case "text":
			return <TextView file={file} />;
		case "rtf":
			return <RtfView file={file} />;
		case "archive":
			return <ArchiveView file={file} />;
		case "epub":
			return <EpubView file={file} />;
		case "hwp":
			return <HwpView file={file} />;
		case "fallback":
			if (file.bytes !== null && looksLikeText(file.bytes)) return <TextView file={file} />;
			return <FallbackView file={file} />;
		default:
			return assertNever(kind);
	}
}
