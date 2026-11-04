import { useRef, type ReactElement } from "react";
import type { IndexProgressView, StalledKind } from "../state/index-progress";

/**
 * The "may be stalled" line of a running index. Its text counts minutes, so it changes every minute, and a live
 * region reads out each change of its text: left as the alert itself it would be read again once a minute. The visible
 * line therefore stays out of the accessibility tree and a hidden alert holds the words as they were when the warning
 * appeared (or changed between "signals still arriving" and "signals stopped"), which are read once.
 */
export function StalledWarning({
	view,
	as: Tag = "p",
	className,
	testId,
}: {
	readonly view: Pick<IndexProgressView, "warning" | "warningKind">;
	readonly as?: "p" | "span";
	readonly className?: string;
	readonly testId?: string;
}): ReactElement | null {
	const announced = useRef<{ readonly kind: StalledKind; readonly text: string } | null>(null);
	const { warning, warningKind } = view;
	if (warning === null || warningKind === null) {
		announced.current = null;
		return null;
	}
	if (announced.current?.kind !== warningKind) announced.current = { kind: warningKind, text: warning };
	return (
		<>
			<Tag className={className} data-testid={testId} aria-hidden="true">
				{warning}
			</Tag>
			<span className="sr-only" role="alert">
				{announced.current.text}
			</span>
		</>
	);
}
