import { useMemo, type ReactElement } from "react";
import { gunzipSync } from "fflate";
import type { PreviewDocument } from "../shared/contract";
import { summarizeArchive, type ArchiveEntry } from "../shared/archive-items";
import { formatFinderDate, formatFinderSize, formatItemCount } from "../shared/format";
import { describeExtension } from "../shared/registry";
import { listTarEntries } from "../shared/tar-list";
import { decodeUtf8, looksLikeText } from "../shared/text-sample";
import { listZipEntries } from "../shared/zip-list";
import { useHiddenTitle, usePanelHeight } from "./chrome";
import { CONTENTS_WIDTH, ContentsBox } from "./contents";
import { FallbackView } from "./fallback";
import { FileGlyph } from "./icons";

/** Children the archive panel lists, the same strip the folder panel shows. */
const ARCHIVE_PREVIEW_ITEMS = 6;

type Listing =
	| { readonly kind: "entries"; readonly entries: readonly ArchiveEntry[] }
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "failed"; readonly note: string };

function read(file: PreviewDocument, bytes: Uint8Array): Listing {
	if (file.ext === "gz" || file.ext === "gzip" || file.ext === "tgz") {
		try {
			const inflated = gunzipSync(bytes);
			const tar = listTarEntries(inflated);
			if (tar !== null) return { kind: "entries", entries: tar };
			if (looksLikeText(inflated)) return { kind: "text", text: decodeUtf8(inflated) };
		} catch (caught) {
			return { kind: "failed", note: caught instanceof Error ? caught.message : "압축을 풀지 못했습니다" };
		}
		return { kind: "failed", note: "압축 목록을 읽지 못했습니다" };
	}
	if (file.ext === "tar") {
		const tar = listTarEntries(bytes);
		return tar === null ? { kind: "failed", note: "tar 목록을 읽지 못했습니다" } : { kind: "entries", entries: tar };
	}
	const zip = listZipEntries(bytes);
	if (zip === null) return { kind: "failed", note: "압축 목록을 읽지 못했습니다" };
	return { kind: "entries", entries: zip.map((entry) => ({ name: entry.name, size: entry.uncompressedSize, modified: entry.modified })) };
}

function ArchivePanel({ file, entries }: { readonly file: PreviewDocument; readonly entries: readonly ArchiveEntry[] }): ReactElement {
	useHiddenTitle();
	const attach = usePanelHeight(CONTENTS_WIDTH);
	const summary = useMemo(() => summarizeArchive(entries, ARCHIVE_PREVIEW_ITEMS), [entries]);
	return (
		<div ref={attach} className="ql-archive flex flex-col w-full">
			<div className="flex flex-none items-center gap-36 h-200 pr-40 pl-48">
				<FileGlyph label={file.ext.slice(0, 4).toUpperCase()} scale={0.8} />
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-archive__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{file.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">{describeExtension(file.ext)}</div>
					<div className="ql-archive__count text-[14px] text-ql-ink-secondary">
						{formatItemCount(summary.itemCount)}, {formatFinderSize(file.size)}
					</div>
					<div className="text-[14px] text-ql-ink-secondary">Last modified {formatFinderDate(file.modifiedAt, false)}</div>
				</div>
			</div>
			<ContentsBox kind="archive" items={summary.items} total={summary.itemCount} order="최근 수정 순" empty="비어 있는 압축 파일" />
		</div>
	);
}

/**
 * Archives read like folders: the same header (glyph, name, kind, "N items,
 * size", date) over the same "포함된 항목" strip of top-level children. A gzip
 * of a single text file shows the text instead, since it holds no items.
 */
export function ArchiveView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const bytes = file.bytes;
	const listing = useMemo(() => (bytes === null ? null : read(file, bytes)), [file, bytes]);
	if (listing === null) return <FallbackView file={file} note="압축 파일을 읽지 못했습니다" />;
	if (listing.kind === "failed") return <FallbackView file={file} note={listing.note} />;
	if (listing.kind === "text") {
		return <pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{listing.text}</pre>;
	}
	return <ArchivePanel file={file} entries={listing.entries} />;
}
