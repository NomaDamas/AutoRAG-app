import { useEffect, useState, type ReactElement } from "react";
import type { FolderSize, FolderSummary } from "../shared/contract";
import { formatFinderDate, formatFinderSize, formatItemCount } from "../shared/format";
import { useChrome, useHiddenTitle, usePanelHeight } from "./chrome";
import { CONTENTS_WIDTH, ContentsBox } from "./contents";
import { FolderGlyph } from "./icons";

/**
 * The folder panel: the folder glyph with its name, item count, total size,
 * and date, over a strip of its most recently modified children. The size
 * arrives after a bounded walk; until then the line shows the count alone.
 */
export function FolderView({ folder }: { readonly folder: FolderSummary }): ReactElement {
	useHiddenTitle();
	const { bridge } = useChrome();
	const attach = usePanelHeight(CONTENTS_WIDTH);
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
			<ContentsBox
				kind="folder"
				items={folder.recent}
				total={folder.itemCount}
				order="최근 수정 순"
				empty="비어 있는 폴더"
			/>
		</div>
	);
}
