import { reductionKindOf, type ReductionKind, type ReductionLevel } from "../../../shared/size-reduction";
import type { FinderEntry } from "../data/entries";

/**
 * State of the "용량 줄이기" dialog: first lets the user pick how aggressively
 * to shrink (`light` / `balanced` / `max`) and whether to replace the original
 * in place (the original goes safely to the Trash — no `-reduced` clutter) or
 * save a single `-reduced` copy; once started (`working: true`), turns into a
 * live progress card with cancellation.
 */
export interface ReduceSizeDialogState {
	readonly id: string;
	readonly path: string;
	readonly name: string;
	readonly size: number | null;
	readonly kind: ReductionKind;
	readonly level: ReductionLevel;
	readonly replaceOriginal: boolean;
	readonly working: boolean;
	readonly percent: number | null;
}

export function createReduceSizeDialogState(entry: FinderEntry, id: string): ReduceSizeDialogState | null {
	const kind = reductionKindOf(entry.name);
	if (kind === null) return null;
	return {
		id,
		path: entry.path,
		name: entry.name,
		size: entry.size,
		kind,
		level: "balanced",
		replaceOriginal: true,
		working: false,
		percent: null,
	};
}
