import { useEffect, useState, type ReactElement } from "react";
import type { FolderItem, FolderSize, FolderSummary } from "../shared/contract";
import { formatFinderDate, formatFinderSize, formatItemCount } from "../shared/format";
import { viewerForExtension, type ViewerKind } from "../shared/registry";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { FolderGlyph, SmallFolderGlyph } from "./icons";

const FOLDER_WIDTH = 640;
/** Plain-text extensions get the neutral badge; every other text kind is code. */
const PLAIN_TEXT: Partial<Record<string, true>> = { txt: true, text: true, log: true, md: true, markdown: true, mdx: true, rtf: true };

const BADGE: Readonly<Record<ViewerKind, string>> = {
	image: "bg-ql-badge-image",
	tiff: "bg-ql-badge-image",
	heic: "bg-ql-badge-image",
	video: "bg-ql-badge-video",
	audio: "bg-ql-badge-audio",
	pdf: "bg-ql-badge-pdf",
	docx: "bg-ql-badge-doc",
	sheet: "bg-ql-badge-sheet",
	pptx: "bg-ql-badge-slides",
	markdown: "bg-ql-badge-text",
	html: "bg-ql-badge-html",
	text: "bg-ql-badge-code",
	archive: "bg-ql-badge-archive",
	epub: "bg-ql-badge-doc",
	hwp: "bg-ql-badge-doc",
	font: "bg-ql-badge-other",
	rtf: "bg-ql-badge-text",
	fallback: "bg-ql-badge-other",
};

function ItemTile({ item }: { readonly item: FolderItem }): ReactElement {
	const badge = PLAIN_TEXT[item.ext] === true ? "bg-ql-badge-text" : BADGE[viewerForExtension(item.ext)];
	return (
		<div className="flex flex-col items-center gap-6 min-w-0" title={item.name}>
			<div className="grid place-items-center w-44 h-52">
				{item.folder ? (
					<SmallFolderGlyph />
				) : (
					<div className="relative w-38 h-48 rounded-3 bg-ql-glyph-paper shadow-ql-doc">
						<span className={`absolute right-4 bottom-6 left-4 grid place-items-center h-12 rounded-2 text-on-badge text-[7px] font-bold tracking-[0.04em] ${badge}`}>
							{item.ext.slice(0, 4).toUpperCase()}
						</span>
					</div>
				)}
			</div>
			<span className="max-w-full overflow-hidden text-[11px] leading-[1.3] text-center text-ellipsis whitespace-nowrap">{item.name}</span>
		</div>
	);
}

/**
 * The folder panel: the folder glyph with its name, item count, total size,
 * and date, over a strip of its most recently modified children. The size
 * arrives after a bounded walk; until then the line shows the count alone.
 */
export function FolderView({ folder }: { readonly folder: FolderSummary }): ReactElement {
	useHiddenTitle();
	const { bridge } = useChrome();
	const attach = usePanelHeight(FOLDER_WIDTH);
	const [size, setSize] = useState<FolderSize | null>(null);
	useEffect(() => {
		let cancelled = false;
		bridge.folderSize(folder.path).then(
			(next) => {
				if (!cancelled) setSize(next);
			},
			(caught: unknown) => {
				if (!cancelled && !(caught instanceof Error)) throw caught;
			},
		);
		return () => {
			cancelled = true;
		};
	}, [bridge, folder.path]);
	const total = size === null ? "" : `, ${formatFinderSize(size.bytes)}${size.complete ? "" : "+"}`;
	return (
		<div ref={attach} className="ql-folder flex flex-col w-full">
			<div className="flex flex-none items-center gap-36 h-200 pr-40 pl-48">
				<FolderGlyph />
				<div className="flex flex-col flex-1 gap-3 min-w-0">
					<div className="ql-folder__name mb-4 overflow-hidden text-[22px] font-bold tracking-[-0.01em] text-ellipsis whitespace-nowrap select-text">{folder.name}</div>
					<div className="text-[14px] text-ql-ink-secondary">Folder</div>
					<div className="ql-folder__count text-[14px] text-ql-ink-secondary">
						{formatItemCount(folder.itemCount)}
						{total}
					</div>
					<div className="text-[14px] text-ql-ink-secondary">Last modified {formatFinderDate(folder.modifiedAt, false)}</div>
				</div>
			</div>
			<div className="flex flex-none flex-col gap-10 mx-16 mb-16 px-14 pt-12 pb-14 rounded-12 bg-ql-sunk">
				<div className="flex items-baseline text-[11.5px] text-ql-ink-secondary">
					<span className="font-semibold text-ql-ink">포함된 항목</span>
					<span className="flex-1" />
					{folder.itemCount === 0 ? null : (
						<span>
							최근 수정 순 · {folder.recent.length} / {folder.itemCount}
						</span>
					)}
				</div>
				{folder.recent.length === 0 ? (
					<div className="py-12 text-center text-[12px] text-ql-ink-secondary">비어 있는 폴더</div>
				) : (
					<div className="ql-folder__items grid grid-cols-6 gap-8">
						{folder.recent.map((item) => (
							<ItemTile key={item.name} item={item} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
