import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { viewerForExtension, type ViewerKind } from "../shared/registry";
import { SmallFolderGlyph } from "./icons";

/** Panel width shared by every "contains" panel: the folder and the archive. */
export const CONTENTS_WIDTH = 640;
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
	legacyDoc: "bg-ql-badge-doc",
	sheet: "bg-ql-badge-sheet",
	pptx: "bg-ql-badge-slides",
	legacyPpt: "bg-ql-badge-slides",
	markdown: "bg-ql-badge-text",
	html: "bg-ql-badge-html",
	text: "bg-ql-badge-code",
	archive: "bg-ql-badge-archive",
	archiveList: "bg-ql-badge-archive",
	iwork: "bg-ql-badge-doc",
	odt: "bg-ql-badge-doc",
	odp: "bg-ql-badge-slides",
	odg: "bg-ql-badge-image",
	epub: "bg-ql-badge-doc",
	hwp: "bg-ql-badge-doc",
	font: "bg-ql-badge-other",
	rtf: "bg-ql-badge-text",
	webloc: "bg-ql-badge-html",
	webarchive: "bg-ql-badge-html",
	rtfd: "bg-ql-badge-text",
	iconset: "bg-ql-badge-image",
	textclipping: "bg-ql-badge-text",
	data: "bg-ql-badge-sheet",
	jsonl: "bg-ql-badge-code",
	plist: "bg-ql-badge-code",
	mail: "bg-ql-badge-doc",
	msg: "bg-ql-badge-doc",
	contact: "bg-ql-badge-doc",
	calendar: "bg-ql-badge-doc",
	gdrive: "bg-ql-badge-doc",
	fallback: "bg-ql-badge-other",
};

/** One thing a folder or an archive holds, as the item grid draws it. */
export interface ContentsItem {
	readonly name: string;
	readonly folder: boolean;
	readonly ext: string;
}

function ItemTile({ item }: { readonly item: ContentsItem }): ReactElement {
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
 * The sunken "포함된 항목" box under a folder's or an archive's header: a
 * strip of its leading items, with how they are ordered and how many there are.
 */
export function ContentsBox({
	items,
	total,
	order,
	empty,
	kind,
}: {
	readonly items: readonly ContentsItem[];
	readonly total: number;
	/** How `items` are ordered, e.g. "최근 수정 순". */
	readonly order: string;
	/** What an empty container is called. */
	readonly empty: string;
	/** Namespaces the grid's class (`ql-folder__items`, `ql-archive__items`). */
	readonly kind: "folder" | "archive";
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="flex flex-none flex-col gap-10 mx-16 mb-16 px-14 pt-12 pb-14 rounded-12 bg-ql-sunk">
			<div className="flex items-baseline text-[11.5px] text-ql-ink-secondary">
				<span className="font-semibold text-ql-ink">{t("quickLook.contents.title")}</span>
				<span className="flex-1" />
				{total === 0 ? null : (
					<span>
						{order} · {items.length} / {total}
					</span>
				)}
			</div>
			{items.length === 0 ? (
				<div className="py-12 text-center text-[12px] text-ql-ink-secondary">{empty}</div>
			) : (
				<div className={`ql-${kind}__items grid grid-cols-6 gap-8`}>
					{items.map((item) => (
						<ItemTile key={item.name} item={item} />
					))}
				</div>
			)}
		</div>
	);
}
