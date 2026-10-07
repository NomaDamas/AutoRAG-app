import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A function with a stable identity that always runs the latest `callback`.
 *
 * `useCallback(fn, deps)` hands out a new closure whenever a dep changes, and
 * each closure keeps the whole render scope it was created in alive. In a hook
 * as large as the Finder controller those scopes link: an old callback still
 * held by a child, a store, or an event handler retains its render's listing
 * arrays, which retain the next older callback, and so on — memory that grows
 * with every click. The wrapper returned here is created once and reaches the
 * current callback only through a ref, so no render scope outlives its render.
 *
 * Only for event handlers and imperative calls: the wrapper never changes, so
 * it must not stand in for a value an effect or memo should re-run on.
 */
export function useLatestCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
	const ref = useRef(callback);
	// Insertion effects run before every layout effect, so a child's layout
	// effect (or a store publish) calling the wrapper already sees this render.
	useInsertionEffect(() => {
		ref.current = callback;
	});
	return useCallback((...args: Args) => ref.current(...args), []);
}
