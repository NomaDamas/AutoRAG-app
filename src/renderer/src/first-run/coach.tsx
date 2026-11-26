import type { CSSProperties, ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import dazziMark from "../assets/dazzi-mark.png";
import type { Rect } from "./tour";

/**
 * The overlay every guided step uses, the onboarding tour and the later tutorials alike (Figma 156:591, 162:1334,
 * 162:2172, 162:1576, 162:1839): a white card that sizes to its words, the title over the body, and at the bottom the
 * progress dots and 건너뛰기 (완료 on the last step).
 */
export function CoachCard({
	title,
	body,
	index,
	count,
	waiting = false,
	note,
	children,
}: {
	readonly title: string;
	readonly body: string;
	readonly index: number;
	readonly count: number;
	/** The step waits on something (an answer being written): a spinner leads the title. */
	readonly waiting?: boolean;
	/** A line under the body for what the body cannot say (a right click, a drag). */
	readonly note?: string | null;
	/** The links at the bottom right, in reading order: 건너뛰기, then 다음 or 완료. */
	readonly children: ReactNode;
}): ReactElement {
	const { t } = useTranslation();
	return (
		<div className="fr-coach-card">
			<div className="fr-coach-copy">
				<h2 className="fr-coach-title">
					{waiting ? <span className="fr-coach-spinner" aria-hidden="true" /> : null}
					{title}
				</h2>
				<p className="fr-coach-body">{body}</p>
				{note === undefined || note === null ? null : <p className="fr-coach-note">{note}</p>}
			</div>
			<div className="fr-coach-actions">
				<span className="fr-coach-dots" role="img" aria-label={t("firstRun.tour.progress", { index: index + 1, count })}>
					{Array.from({ length: count }, (_, dot) => (
						<span key={dot} className="fr-coach-dot" data-current={dot === index ? "true" : undefined} />
					))}
				</span>
				<span className="fr-coach-links">{children}</span>
			</div>
		</div>
	);
}

/** A target this small gets a ring around it; a wider one (a row, a title) is pointed at by the sunflower alone. */
const RING_MAX = 64;
/** A row this wide is pointed at where its name is, not at its far corner. */
const ROW_MIN = 400;
const MASCOT = 60;

/**
 * Where the step wants a click: a blue ring around a small target (a send button, a citation number) with the sunflower
 * beside it, or the sunflower alone on the corner of a wider one. Without a click target it sits on the spotlight's
 * top-right corner. Clicks pass through.
 */
export function CoachMarker({ target, spot, data }: { readonly target: Rect | null; readonly spot: Rect | null; readonly data: Readonly<Record<string, string>> }): ReactElement | null {
	const box = target ?? spot;
	if (box === null) return null;
	const ring = target !== null && target.width <= RING_MAX && target.height <= RING_MAX;
	const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
	const diameter = Math.max(30, Math.max(box.width, box.height) + 20);
	// Beside the ring on its right (Figma 156:591); on a row's name (162:1576); else on the box's top-right corner (162:2172, 162:1839).
	const mascot =
		ring
			? { x: centre.x + diameter / 2 + 8, y: centre.y }
			: target !== null && target.width >= ROW_MIN
				? { x: target.left + Math.min(176, target.width * 0.34), y: target.top }
				: { x: box.left + box.width - 13, y: box.top + 9 };
	// The element sits on the point a click lands on (the QA lanes click there), and draws the ring and the sunflower around it.
	const aim =
		target === null
			? mascot
			: target.width > 180
				? { x: target.left + Math.min(116, target.width * 0.34), y: target.top + target.height * 0.58 }
				: { x: centre.x, y: centre.y };
	const ringStyle: CSSProperties = {
		left: centre.x - diameter / 2 - aim.x,
		top: centre.y - diameter / 2 - aim.y,
		width: diameter,
		height: diameter,
		borderWidth: diameter >= 48 ? 5 : 3,
	};
	return (
		<div className="fr-cursor" aria-hidden="true" style={{ left: aim.x, top: aim.y }} {...data}>
			{ring ? <span className="fr-cursor-ring" style={ringStyle} /> : null}
			<img
				className="fr-mascot"
				src={dazziMark}
				alt=""
				width={MASCOT}
				height={MASCOT}
				style={{ left: mascot.x - MASCOT / 2 - aim.x, top: mascot.y - MASCOT / 2 - aim.y }}
				draggable={false}
			/>
		</div>
	);
}
