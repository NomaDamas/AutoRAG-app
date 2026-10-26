import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { gunzipSync } from "fflate";
import { t } from "../../shared/i18n/core";
import type { ArchivePreview, PreviewDocument } from "../shared/contract";
import { summarizeArchive, type ArchiveEntry } from "../shared/archive-items";
import { formatFinderDate, formatFinderSize, formatItemCount } from "../shared/format";
import { describeExtension } from "../shared/registry";
import { listTarEntries } from "../shared/tar-list";
import { decodeUtf8, looksLikeText } from "../shared/text-sample";
import { listZipEntries } from "../shared/zip-list";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
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
			return { kind: "failed", note: caught instanceof Error ? caught.message : t("quickLook.archive.extractFailed") };
		}
		return { kind: "failed", note: t("quickLook.archive.listFailed") };
	}
	if (file.ext === "tar") {
		const tar = listTarEntries(bytes);
		return tar === null ? { kind: "failed", note: t("quickLook.archive.tarListFailed") } : { kind: "entries", entries: tar };
	}
	const zip = listZipEntries(bytes);
	if (zip === null) return { kind: "failed", note: t("quickLook.archive.listFailed") };
	return { kind: "entries", entries: zip.map((entry) => ({ name: entry.name, size: entry.uncompressedSize, modified: entry.modified })) };
}

/** `entries` is null while the main process is still reading the archive: the panel draws at its final size with an empty strip. */
function ArchivePanel({ file, entries }: { readonly file: PreviewDocument; readonly entries: readonly ArchiveEntry[] | null }): ReactElement {
	const { t } = useTranslation();
	useHiddenTitle();
	const attach = usePanelHeight(CONTENTS_WIDTH);
	const summary = useMemo(() => summarizeArchive(entries ?? [], ARCHIVE_PREVIEW_ITEMS), [entries]);
	return (
		<div ref={attach} className="ql-archive flex flex-col w-full">
			<div className="flex flex-none items-center gap-36 h-200 pr-40 pl-48">
				<FileGlyph label={file.ext.slice(0, 4).toUpperCase()} scale={0.8} />
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-archive__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{file.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">{describeExtension(file.ext)}</div>
					<div className="ql-archive__count text-[14px] text-ql-ink-secondary">
						{entries === null ? formatFinderSize(file.size) : `${formatItemCount(summary.itemCount)}, ${formatFinderSize(file.size)}`}
					</div>
					<div className="text-[14px] text-ql-ink-secondary">{t("quickLook.fallback.lastModified", { date: formatFinderDate(file.modifiedAt, false) })}</div>
				</div>
			</div>
			<ContentsBox
				kind="archive"
				items={summary.items}
				total={summary.itemCount}
				order={t("quickLook.archive.order")}
				empty={entries === null ? t("quickLook.status.loading") : t("quickLook.archive.empty")}
			/>
		</div>
	);
}

/**
 * Archives read like folders: the same header (glyph, name, kind, "N items,
 * size", date) over the same "포함된 항목" strip of top-level children. A gzip
 * of a single text file shows the text instead, since it holds no items.
 */
export function ArchiveView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t, i18n } = useTranslation();
	const bytes = file.bytes;
	const listing = useMemo(() => (bytes === null ? null : read(file, bytes)), [file, bytes, i18n.language]);
	if (listing === null) return <FallbackView file={file} note={t("quickLook.archive.readFailed")} />;
	if (listing.kind === "failed") return <FallbackView file={file} note={listing.note} />;
	if (listing.kind === "text") {
		return <pre className="ql__pre box-border self-stretch w-full h-auto m-0 px-24 py-20 bg-window text-ink font-mono text-meta leading-[1.55] whitespace-pre-wrap [word-break:break-word] select-text">{listing.text}</pre>;
	}
	return <ArchivePanel file={file} entries={listing.entries} />;
}

type ListLoaded = { readonly path: string; readonly preview: ArchivePreview } | { readonly path: string; readonly error: string };

/**
 * Containers the page cannot read itself (7z, RAR, ISO, deb, rpm, CAB, and the
 * bzip2, xz, and zstd tars). The main process lists them and sends back one
 * entry per top-level child; this page only draws the same panel as a zip.
 */
export function ArchiveListView({ file }: { readonly file: PreviewDocument }): ReactElement {
	const { t } = useTranslation();
	const { bridge } = useChrome();
	const [loaded, setLoaded] = useState<ListLoaded | null>(null);
	useEffect(() => {
		let cancelled = false;
		bridge.archivePreview(file.path).then(
			(preview) => {
				if (!cancelled) setLoaded({ path: file.path, preview });
			},
			(caught: unknown) => {
				if (!cancelled) setLoaded({ path: file.path, error: caught instanceof Error ? caught.message : t("quickLook.archive.readFailed") });
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, file.path, t]);
	if (loaded === null || loaded.path !== file.path) return <ArchivePanel file={file} entries={null} />;
	if ("error" in loaded) return <FallbackView file={file} note={loaded.error} />;
	if (loaded.preview.kind === "unreadable") return <FallbackView file={file} note={t(`quickLook.archive.unreadable.${loaded.preview.reason}`)} />;
	return <ArchivePanel file={file} entries={loaded.preview.entries} />;
}
