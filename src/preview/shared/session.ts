export interface AnchorRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface QuickLookRequest {
	readonly path: string;
	readonly name: string;
	readonly anchor: AnchorRect | null;
}

export type QuickLookPhase = "closed" | "opening" | "open" | "closing";

export interface QuickLookSession {
	readonly shown: QuickLookRequest | null;
	readonly phase: QuickLookPhase;
}

/**
 * Pure open/swap/close machine. The component applies the result during
 * render so the first paint is already the opening frame (no full-size flash).
 * Returns the same `shown` reference when nothing changed.
 */
export function stepQuickLook(
	target: QuickLookRequest | null,
	shown: QuickLookRequest | null,
	phase: QuickLookPhase,
): QuickLookSession {
	if (target !== null && phase === "closing") {
		return { shown: target, phase: "opening" };
	}
	if (target !== null && (phase === "closed" || shown === null)) {
		return { shown: target, phase: "opening" };
	}
	if (target !== null && shown !== null && target.path !== shown.path && (phase === "open" || phase === "opening")) {
		return { shown: target, phase };
	}
	if (target === null && shown !== null && (phase === "open" || phase === "opening")) {
		return { shown, phase: "closing" };
	}
	if (phase === "closed") {
		return { shown: null, phase: "closed" };
	}
	return { shown, phase };
}
