/**
 * "Open this magic action's editor": the 자동화 tab lists right-click actions but edits them in Settings → 우클릭
 * 메뉴, which may not be mounted yet. A request waits here until that page mounts (or reaches it at once when it is).
 */
let pending: string | null = null;
let listener: ((id: string) => void) | null = null;

export function requestMagicActionEdit(id: string): void {
	if (listener === null) pending = id;
	else listener(id);
}

/** Called by the mounted 우클릭 메뉴 page: returns any waiting request, then receives later ones. */
export function attachMagicActionEdit(onRequest: (id: string) => void): { readonly initial: string | null; readonly detach: () => void } {
	const initial = pending;
	pending = null;
	listener = onRequest;
	return {
		initial,
		detach: () => {
			if (listener === onRequest) listener = null;
		},
	};
}
