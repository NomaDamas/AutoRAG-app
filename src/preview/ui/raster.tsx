import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { PreviewDocument } from "../shared/contract";
import { FallbackView, Status } from "./fallback";

/**
 * Camera RAW, Photoshop, EPS, icns, tga, exr, Sketch and Figma files: the main
 * process sends one PNG or JPEG (`file.mime`) it took from the file itself or
 * had the OS decode, and the panel shows it like a picture. A file that has
 * none arrives without bytes and gets the "Other" panel with a note.
 */
export function RasterView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (bytes === null) return;
		const next = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: file.mime }));
		setFailed(false);
		setUrl(next);
		return () => {
			URL.revokeObjectURL(next);
			setUrl(null);
		};
	}, [bytes, file.mime]);
	if (bytes === null || failed) return <FallbackView file={file} note={t("quickLook.raster.noPreview")} />;
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} onError={() => setFailed(true)} />;
}
