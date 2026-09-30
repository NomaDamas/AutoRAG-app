import { useEffect, useState, type ReactElement } from "react";
import * as UTIF from "utif";
import { previewStreamUrl, type PreviewDocument } from "../shared/contract";
import { FallbackView, Status } from "./fallback";

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

export function ImageView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const [failed, setFailed] = useState(false);
	if (failed) return <FallbackView file={file} note="이미지를 열 수 없습니다" />;
	return <img className="ql__image" alt="" src={previewStreamUrl(file.path)} onError={() => setFailed(true)} />;
}

export function VideoView({ file }: { readonly file: PreviewDocument }): ReactElement {
	return (
		<video className="ql__video" controls>
			<source src={previewStreamUrl(file.path)} type={file.mime} />
		</video>
	);
}

export function AudioView({ file }: { readonly file: PreviewDocument }): ReactElement {
	return (
		<div className="ql__audio">
			<div className="ql__glyph">{file.ext.slice(0, 4).toUpperCase() || "AUDIO"}</div>
			<audio controls>
				<source src={previewStreamUrl(file.path)} type={file.mime} />
			</audio>
		</div>
	);
}

export function FontView({ file }: { readonly file: PreviewDocument }): ReactElement {
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
				setError(caught instanceof Error ? caught.message : "글꼴을 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			document.fonts.delete(face);
		};
	}, [url]);
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (!ready) return <Status>불러오는 중</Status>;
	return (
		<div className="ql__font" style={{ fontFamily: "QuickLookSample, sans-serif" }}>
			<div style={{ fontSize: 42 }}>가나다 Abc 123</div>
			<div style={{ fontSize: 24 }}>The quick brown fox jumps over the lazy dog.</div>
			<div style={{ fontSize: 16 }}>0123456789 — 미리보기</div>
		</div>
	);
}

export function TiffView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		let current: string | null = null;
		try {
			const pages = UTIF.decode(bytes);
			const page = pages[0];
			if (page === undefined) {
				setError("TIFF 페이지가 없습니다");
				return;
			}
			UTIF.decodeImage(bytes, page);
			const rgba = UTIF.toRGBA8(page);
			const canvas = document.createElement("canvas");
			canvas.width = page.width;
			canvas.height = page.height;
			const context = canvas.getContext("2d");
			if (context === null) {
				setError("캔버스를 만들지 못했습니다");
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
			setError(caught instanceof Error ? caught.message : "TIFF를 열 수 없습니다");
		}
		return () => {
			cancelled = true;
			if (current !== null) URL.revokeObjectURL(current);
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note="이미지를 읽지 못했습니다" />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (url === null) return <Status>불러오는 중</Status>;
	return <img className="ql__image" alt="" src={url} />;
}

export function HeicView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [url, setUrl] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		let cancelled = false;
		let current: string | null = null;
		import("heic2any")
			.then((mod) => mod.default({ blob: new Blob([copyBytes(bytes)]), toType: "image/jpeg", quality: 0.82 }))
			.then((converted) => {
				if (cancelled) return;
				const blob = converted instanceof Blob ? converted : converted[0];
				if (blob === undefined) {
					setError("HEIC 변환 결과가 없습니다");
					return;
				}
				current = URL.createObjectURL(blob);
				setUrl(current);
			})
			.catch((caught: unknown) => {
				if (cancelled) return;
				setError(caught instanceof Error ? caught.message : "HEIC를 열 수 없습니다");
			});
		return () => {
			cancelled = true;
			if (current !== null) URL.revokeObjectURL(current);
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note="이미지를 읽지 못했습니다" />;
	if (error !== null) return <FallbackView file={file} note={error} />;
	if (url === null) return <Status>불러오는 중</Status>;
	return <img className="ql__image" alt="" src={url} />;
}
