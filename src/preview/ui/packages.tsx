import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { strFromU8, unzipSync } from "fflate";
import type { PreviewDocument } from "../shared/contract";
import { FallbackView } from "./fallback";

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

export function EpubView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const bytes = file.bytes;
	const text = useMemo(() => {
		if (bytes === null) return null;
		try {
			const files = inflate(bytes, (name) => name.endsWith(".xhtml") || name.endsWith(".html") || name.endsWith(".htm"));
			const chunks: string[] = [];
			for (const [name, body] of files) {
				if (name.startsWith("META-INF/")) continue;
				chunks.push(stripTags(strFromU8(body)));
				if (chunks.join("\n").length > 20_000) break;
			}
			return chunks.join("\n\n").slice(0, 20_000);
		} catch (caught) {
			if (caught instanceof Error) return "";
			throw caught;
		}
	}, [bytes]);
	if (text === null) return <FallbackView file={file} note={t("quickLook.epub.readFailed")} />;
	if (text.trim() === "") return <FallbackView file={file} note={t("quickLook.epub.noText")} />;
	return <pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{text}</pre>;
}


