import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { FsTagCatalog } from "../../../shared/fs-contract";
import type { FinderSource } from "../data/source";
import { NO_TAG_COLORS, tagColorsOf, type TagColors } from "../state/tags";

/** Finder's tag registry as the window knows it, and the colour lookup derived from it. */
export interface TagCatalogState {
	readonly catalog: FsTagCatalog;
	readonly colors: TagColors;
}

export const NO_TAG_CATALOG: TagCatalogState = {
	catalog: { supported: false, tags: [], colorNames: [], colorsDenied: false },
	colors: NO_TAG_COLORS,
};

export const TagCatalogContext = createContext<TagCatalogState>(NO_TAG_CATALOG);

export function useTagCatalog(): TagCatalogState {
	return useContext(TagCatalogContext);
}

/**
 * Reads Finder's tag registry once at start and again whenever the window
 * regains focus: tags are created, recoloured, and pinned in Finder itself,
 * and no event reaches this app when they are.
 */
export function useTagCatalogLoader(source: FinderSource, onError: (error: unknown) => void): TagCatalogState {
	const [catalog, setCatalog] = useState<FsTagCatalog>(NO_TAG_CATALOG.catalog);
	useEffect(() => {
		let live = true;
		const load = (): void => {
			source
				.tags()
				.then((next) => {
					if (live) setCatalog((current) => (sameCatalog(current, next) ? current : next));
				})
				.catch(onError);
		};
		load();
		window.addEventListener("focus", load);
		return () => {
			live = false;
			window.removeEventListener("focus", load);
		};
	}, [source, onError]);
	return useMemo(() => ({ catalog, colors: tagColorsOf(catalog) }), [catalog]);
}

function sameCatalog(a: FsTagCatalog, b: FsTagCatalog): boolean {
	return (
		a.supported === b.supported &&
		a.colorsDenied === b.colorsDenied &&
		a.colorNames.join("\u0000") === b.colorNames.join("\u0000") &&
		a.tags.length === b.tags.length &&
		a.tags.every((tag, index) => {
			const other = b.tags[index];
			return other !== undefined && tag.name === other.name && tag.color === other.color && tag.sidebar === other.sidebar;
		})
	);
}
