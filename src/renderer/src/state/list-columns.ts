/**
 * List view column visibility + widths (v7 handoff, column header menu).
 *
 * The reference keeps a flat set of optional columns and remembers which are
 * shown; the name column is fixed and always first. Widths are only stored for
 * the columns the reference lets you drag (Name / Size / Kind), but the map
 * accepts any column key so the template can honour a stored value wherever a
 * future column becomes resizable.
 */

export type ListColumnKey = "extension" | "date" | "size" | "kind" | "relativePath" | "index";

export interface ListColumnsState {
	readonly visible: Readonly<Record<ListColumnKey, boolean>>;
	readonly widths: Readonly<Record<string, number>>;
}

/** Column menu order; `name` is fixed and always rendered first. */
export const LIST_COLUMN_OPTIONS: readonly { key: ListColumnKey | "name"; label: string; fixed?: boolean }[] = [
	{ key: "name", label: "Name", fixed: true },
	{ key: "extension", label: "Extension" },
	{ key: "date", label: "Date Modified" },
	{ key: "size", label: "Size" },
	{ key: "kind", label: "Kind" },
	{ key: "relativePath", label: "Relative Path" },
	{ key: "index", label: "Index" },
];

/** Reference widths: `minmax(180px,1fr) 112px 68px 106px 44px`. */
const DEFAULT_WIDTHS: Readonly<Record<ListColumnKey, number>> = {
	extension: 92,
	date: 112,
	size: 68,
	kind: 106,
	relativePath: 150,
	index: 44,
};

/** The index column is a fixed 44px checkbox track, never user-resized. */
const INDEX_WIDTH = 44;

const NAME_DEFAULT = 180;

const WIDTH_LIMITS: Readonly<Record<string, readonly [number, number]>> = {
	name: [180, 720],
	size: [58, 280],
	kind: [62, 260],
	extension: [58, 280],
	date: [58, 280],
	relativePath: [58, 280],
	index: [58, 280],
};

export const DEFAULT_LIST_COLUMNS: ListColumnsState = {
	visible: {
		extension: false,
		date: true,
		size: true,
		kind: true,
		relativePath: false,
		index: true,
	},
	widths: {},
};

export function toggleListColumn(state: ListColumnsState, key: ListColumnKey): ListColumnsState {
	return { ...state, visible: { ...state.visible, [key]: !state.visible[key] } };
}

export function resetListColumns(): ListColumnsState {
	return { visible: { ...DEFAULT_LIST_COLUMNS.visible }, widths: {} };
}

export function setListColumnWidth(state: ListColumnsState, key: string, px: number): ListColumnsState {
	const [min, max] = WIDTH_LIMITS[key] ?? [58, 280];
	const clamped = Math.max(min, Math.min(max, Math.round(px)));
	return { ...state, widths: { ...state.widths, [key]: clamped } };
}

/**
 * `grid-template-columns` for the list head and rows: the name track first,
 * then every visible column in menu order. The index column is fixed at 44px;
 * every other track uses its stored width or the reference default.
 */
export function listGridTemplate(state: ListColumnsState): string {
	// Once the user drags the name grip the track freezes to the dragged width
	// (the reference's --name-col override); the untouched default stays fluid.
	const name = state.widths.name;
	const parts = [name === undefined ? `minmax(${NAME_DEFAULT}px,1fr)` : `${name}px`];
	for (const option of LIST_COLUMN_OPTIONS) {
		if (option.key === "name") continue;
		if (!state.visible[option.key]) continue;
		const width = option.key === "index" ? INDEX_WIDTH : (state.widths[option.key] ?? DEFAULT_WIDTHS[option.key]);
		parts.push(`${width}px`);
	}
	return parts.join(" ");
}

/**
 * Total fixed track width when the name track is frozen (px), null while the
 * name column is still fluid. The list uses it to widen beyond the pane and
 * scroll horizontally, like the reference's `.view { overflow: auto }`.
 */
export function listFixedWidth(state: ListColumnsState): number | null {
	if (state.widths.name === undefined) return null;
	let total = state.widths.name;
	for (const option of LIST_COLUMN_OPTIONS) {
		if (option.key === "name") continue;
		if (!state.visible[option.key]) continue;
		total += option.key === "index" ? INDEX_WIDTH : (state.widths[option.key] ?? DEFAULT_WIDTHS[option.key]);
	}
	return total;
}

/** localStorage key that remembers the visible columns across launches. */
export const LIST_COLUMNS_STORAGE_KEY = "autorag.finder.listColumns";

/** Merge a stored record over the defaults; any parse failure falls back. */
export function loadListColumns(): ListColumnsState {
	try {
		const raw = globalThis.localStorage?.getItem(LIST_COLUMNS_STORAGE_KEY);
		if (!raw) return resetListColumns();
		const parsed = JSON.parse(raw) as { visible?: unknown; widths?: unknown };
		const visible = { ...DEFAULT_LIST_COLUMNS.visible };
		const storedVisible = parsed?.visible;
		if (storedVisible !== null && typeof storedVisible === "object") {
			for (const option of LIST_COLUMN_OPTIONS) {
				if (option.key === "name") continue;
				const value = (storedVisible as Record<string, unknown>)[option.key];
				if (typeof value === "boolean") visible[option.key] = value;
			}
		}
		const widths: Record<string, number> = {};
		const storedWidths = parsed?.widths;
		if (storedWidths !== null && typeof storedWidths === "object") {
			for (const [key, value] of Object.entries(storedWidths as Record<string, unknown>)) {
				if (typeof value === "number" && Number.isFinite(value)) widths[key] = value;
			}
		}
		return { visible, widths };
	} catch {
		return resetListColumns();
	}
}

export function saveListColumns(state: ListColumnsState): void {
	try {
		globalThis.localStorage?.setItem(LIST_COLUMNS_STORAGE_KEY, JSON.stringify(state));
	} catch {
		// Storage may be unavailable or full; persistence is best-effort.
	}
}
