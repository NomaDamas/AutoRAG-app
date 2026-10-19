import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import * as UTIF from "utif";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import { FallbackView, Status } from "./fallback";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function ImageView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const [failed, setFailed] = useState(false);
	if (failed) return <FallbackView file={file} note={t("quickLook.media.imageOpenFailed")} />;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" decoding="async" src={previewStreamUrl(file.path)} onError={() => setFailed(true)} />;
}

export function FontView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const [ready, setReady] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const url = previewStreamUrl(file.path);
	useEffect(() => {
		let cancelled = false;
		const face = new FontFace("QuickLookSample", `url(${url})`);
		face
			.load()
			.then((loaded) => {
				if (cancelled) return;
				document.fonts.add(loaded);
				setReady(true);
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				setError(caught instanceof Error ? caught.message : t("quickLook.media.fontOpenFailed"));
			});
		return () => {
			cancelled = true;
			document.fonts.delete(face);
		};
	}, [url]);
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (!ready) return <Status>{t("quickLook.status.loading")}</Status>;
	return (
		<div className="ql__font grid gap-12 p-24 bg-window" style={{ fontFamily: "QuickLookSample, sans-serif" }}>
			<div style={{ fontSize: 42 }}>가나다 Abc 123</div>
			<div style={{ fontSize: 24 }}>The quick brown fox jumps over the lazy dog.</div>
			<div style={{ fontSize: 16 }}>{t("quickLook.media.fontSampleTail")}</div>
		</div>
	);
}

export function TiffView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		// The main process already decoded it with the OS (macOS): a plain PNG, no decoder needed here.
		if (file.mime === "image/png") {
			const next = URL.createObjectURL(new Blob([copyBytes(bytes)], { type: file.mime }));
			setUrl(next);
			return () => URL.revokeObjectURL(next);
		}
		let cancelled = false;
		let current: string | null = null;
		try {
			const pages = UTIF.decode(bytes);
			const page = pages[0];
			if (page === undefined) {
				setError(t("quickLook.media.tiffNoPages"));
				return;
			}
			UTIF.decodeImage(bytes, page);
			const rgba = UTIF.toRGBA8(page);
			const canvas = document.createElement("canvas");
			canvas.width = page.width;
			canvas.height = page.height;
			const context = canvas.getContext("2d");
			if (context === null) {
				setError(t("quickLook.media.canvasFailed"));
				return;
			}
			const image = context.createImageData(page.width, page.height);
			image.data.set(rgba);
			context.putImageData(image, 0, 0);
			canvas.toBlob((blob) => {
				if (cancelled || blob === null) return;
				current = URL.createObjectURL(blob);
				setUrl(current);
			});
		} catch (caught) {
			setError(caught instanceof Error ? caught.message : t("quickLook.media.tiffOpenFailed"));
		}
		return () => {
			cancelled = true;
			if (current !== null) URL.revokeObjectURL(current);
		};
	}, [bytes, file.mime]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.media.imageReadFailed")} />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} />;
}

export function HeicView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		let current: string | null = null;
		const show = (blob: Blob | undefined): void => {
			if (cancelled) return;
			if (blob === undefined) {
				setError(t("quickLook.media.heicNoResult"));
				return;
			}
			current = URL.createObjectURL(blob);
			setUrl(current);
		};
		// The main process already decoded it with the OS (macOS): a plain JPEG.
		if (file.mime === "image/jpeg") {
			show(new Blob([copyBytes(bytes)], { type: file.mime }));
		} else {
			import("heic2any")
				.then((mod) => mod.default({ blob: new Blob([copyBytes(bytes)]), toType: "image/jpeg", quality: 0.82 }))
				.then((converted) => show(converted instanceof Blob ? converted : converted[0]))
				.catch((caught: unknown) => {
					if (cancelled) return;
					setError(caught instanceof Error ? caught.message : t("quickLook.media.heicOpenFailed"));
				});
		}
		return () => {
			cancelled = true;
			if (current !== null) URL.revokeObjectURL(current);
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note={t("quickLook.media.imageReadFailed")} />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (url === null) return <Status>{t("quickLook.status.loading")}</Status>;
	return <img className="ql__image block max-w-full max-h-full min-h-0 object-contain" alt="" src={url} />;
}
