import { useEffect, useMemo, useState, type ReactElement } from "react";
import { gunzipSync, strFromU8, unzipSync } from "fflate";
import type { PreviewDocument } from "../shared/contract";
import { formatBytes } from "../shared/format";
import { listTarEntries } from "../shared/tar-list";
import { looksLikeText, decodeUtf8 } from "../shared/text-sample";
import { listZipEntries } from "../shared/zip-list";
import { FallbackView, Status } from "./fallback";

function inflate(bytes: Uint8Array, accept: (name: string) => boolean): ReadonlyMap<string, Uint8Array> {
	const out = unzipSync(bytes, {
		filter(entry) {
			return accept(entry.name) && entry.originalSize <= 4_000_000 && (entry.compression === 0 || entry.compression === 8);
		},
	});
	return new Map(Object.entries(out));
}

function stripTags(source: string): string {
	return source
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function tagged(source: string, tag: string): string {
	const parts: string[] = [];
	const pattern = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "g");
	for (const match of source.matchAll(pattern)) {
		const text = match[1];
		if (text !== undefined && text.trim() !== "") parts.push(text);
	}
	return parts.join("");
}

export function ArchiveView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	if (bytes === null) return <FallbackView file={file} note="압축 파일을 읽지 못했습니다" />;
	if (file.ext === "gz" || file.ext === "gzip" || file.ext === "tgz") {
		try {
			const inflated = gunzipSync(bytes);
			const tar = listTarEntries(inflated);
			if (tar !== null) return <EntryList rows={tar.map((entry) => ({ name: entry.name, detail: formatBytes(entry.size) }))} />;
			if (looksLikeText(inflated)) return <pre className="ql__pre">{decodeUtf8(inflated)}</pre>;
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : "압축을 풀지 못했습니다";
			return <FallbackView file={file} note={message} />;
		}
	}
	if (file.ext === "tar") {
		const tar = listTarEntries(bytes);
		if (tar === null) return <FallbackView file={file} note="tar 목록을 읽지 못했습니다" />;
		return <EntryList rows={tar.map((entry) => ({ name: entry.name, detail: formatBytes(entry.size) }))} />;
	}
	const zip = listZipEntries(bytes);
	if (zip === null) return <FallbackView file={file} note="압축 목록을 읽지 못했습니다" />;
	return <EntryList rows={zip.map((entry) => ({ name: entry.name, detail: formatBytes(entry.uncompressedSize) }))} />;
}

function EntryList({ rows }: { readonly rows: readonly { readonly name: string; readonly detail: string }[] }): ReactElement {
	return (
		<div className="ql__list">
			{rows.map((row) => (
				<div className="ql__row" key={row.name}>
					<span>{row.name}</span>
					<span>{row.detail}</span>
				</div>
			))}
		</div>
	);
}

export function EpubView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const text = useMemo(() => {
		if (bytes === null) return null;
		const files = inflate(bytes, (name) => name.endsWith(".xhtml") || name.endsWith(".html") || name.endsWith(".htm"));
		const chunks: string[] = [];
		for (const [name, body] of files) {
			if (name.startsWith("META-INF/")) continue;
			chunks.push(stripTags(strFromU8(body)));
			if (chunks.join("\n").length > 20_000) break;
		}
		return chunks.join("\n\n").slice(0, 20_000);
	}, [bytes]);
	if (text === null) return <FallbackView file={file} note="책을 읽지 못했습니다" />;
	if (text.trim() === "") return <FallbackView file={file} note="본문을 찾지 못했습니다" />;
	return <pre className="ql__pre">{text}</pre>;
}

export function HwpxView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const text = useMemo(() => {
		if (bytes === null) return null;
		const files = inflate(bytes, (name) => name.startsWith("Contents/section") && name.endsWith(".xml"));
		const chunks: string[] = [];
		for (const body of files.values()) chunks.push(tagged(strFromU8(body), "hp:t"));
		return chunks.join("\n").slice(0, 20_000);
	}, [bytes]);
	if (text === null) return <FallbackView file={file} note="문서를 읽지 못했습니다" />;
	if (text.trim() === "") return <FallbackView file={file} note="본문을 찾지 못했습니다" />;
	return <pre className="ql__pre">{text}</pre>;
}

export function PptxView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const [slides, setSlides] = useState<{
		readonly pages: readonly { readonly name: string; readonly text: string }[];
		readonly images: readonly { readonly name: string; readonly url: string }[];
	} | null>(null);
	useEffect(() => {
		if (bytes === null) return;
		const files = inflate(bytes, (name) => name.startsWith("ppt/slides/slide") || name.startsWith("ppt/media/"));
		const pages: { name: string; text: string }[] = [];
		const images: { name: string; url: string }[] = [];
		for (const [name, body] of files) {
			if (name.endsWith(".xml")) pages.push({ name, text: tagged(strFromU8(body), "a:t") });
			if (/\.(png|jpe?g|gif|webp)$/i.test(name)) {
				const copy = new Uint8Array(body.byteLength);
				copy.set(body);
				images.push({ name, url: URL.createObjectURL(new Blob([copy])) });
			}
		}
		pages.sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
		setSlides({ pages, images });
		return () => {
			for (const image of images) URL.revokeObjectURL(image.url);
		};
	}, [bytes]);
	if (bytes === null) return <FallbackView file={file} note="프레젠테이션을 읽지 못했습니다" />;
	if (slides === null) return <Status>불러오는 중</Status>;
	return (
		<div className="ql__slides">
			{slides.pages.map((page, index) => (
				<section className="ql__slide" key={page.name}>
					<h2>슬라이드 {index + 1}</h2>
					<p>{page.text === "" ? "텍스트 없음" : page.text}</p>
				</section>
			))}
			{slides.images.length === 0 ? null : (
				<div className="ql__thumbs">
					{slides.images.map((image) => (
						<img key={image.name} alt="" src={image.url} />
					))}
				</div>
			)}
		</div>
	);
}
