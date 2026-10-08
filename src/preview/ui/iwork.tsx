import { useEffect, useState, type ReactElement } from "react";
import type { PreviewDocument } from "../shared/contract";
import { FallbackView, Status } from "./fallback";

/**
 * Numbers, Pages, and Keynote files: the first sheet, page, or slide, drawn
 * from the JPEG the app stored inside the package (the main process hands it
 * over as the document's bytes). A package without one gets the "Other" panel.
 */
export function IworkView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (bytes === null) return;
		const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
		setFailed(false);
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [bytes]);
	if (bytes === null || failed) return <FallbackView file={file} note="이 문서에는 미리보기 이미지가 없습니다" />;
	if (url === null) return <Status>불러오는 중</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
