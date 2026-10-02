import type { ReactElement } from "react";
import { assertNever } from "../shared/assert";
import type { PreviewDocument } from "../shared/contract";
import type { Size } from "../shared/fit";
import { viewerForExtension, wantsBytes } from "../shared/registry";
import { looksLikeText } from "../shared/text-sample";
import { DocxView, PdfView, SheetView } from "./documents";
import { FallbackView, Status } from "./fallback";
import { AudioView, FontView, HeicView, ImageView, TiffView, VideoView } from "./media";
import { ArchiveView, EpubView, HwpxView, PptxView } from "./packages";
import { HtmlView, MarkdownView, RtfView, TextView } from "./text-view";

/**
 * `onIntrinsicSize` lets a viewer that knows its own page shape (PDF) size the
 * preview window before the first paint settles.
 */
export function PreviewBody({
	file,
	onIntrinsicSize,
}: {
	readonly file: PreviewDocument;
	readonly onIntrinsicSize?: ((size: Size) => void) | undefined;
}): ReactElement {
	const kind = viewerForExtension(file.ext);
	if (file.size === 0) return <FallbackView file={file} note="빈 파일" />;
	if (file.truncated && file.bytes === null && wantsBytes(kind)) {
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
			return <PdfView file={file} onIntrinsicSize={onIntrinsicSize} />;
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
		case "hwpx":
			return <HwpxView file={file} />;
		case "fallback":
			if (file.bytes !== null && looksLikeText(file.bytes)) return <TextView file={file} />;
			return <FallbackView file={file} note="이 형식은 미리보기를 지원하지 않습니다" />;
		default:
			return assertNever(kind);
	}
}

export function LoadingBody(): ReactElement {
	return <Status>불러오는 중</Status>;
}
