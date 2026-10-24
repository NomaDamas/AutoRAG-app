import type { ReactElement } from "react";
import type { FinderEntry } from "../../data/entries";
import { useFirstPageTile } from "../../lib/first-page-tile";
import { fileKindOf } from "../../state/entry-values";
import { FileTile } from "./FileTile";

/** Pixel width of a drawn first page: a grid tile is ~64px at 2x, a row icon is 16-22px. */
const LARGE_WIDTH = 160;
const ROW_WIDTH = 48;

/** A row's file tile: the OS icon, or the first page of a PDF/HWP the OS drew nothing for. */
export function EntryTile({ entry, size, large = false }: { readonly entry: FinderEntry; readonly size?: 16 | 18 | 22; readonly large?: boolean }): ReactElement {
	const firstPage = useFirstPageTile(entry, large ? LARGE_WIDTH : ROW_WIDTH);
	return <FileTile kind={fileKindOf(entry)} iconUrl={entry.iconUrl ?? firstPage} {...(size === undefined ? {} : { size })} large={large} />;
}
