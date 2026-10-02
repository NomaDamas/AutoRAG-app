import type { ReactElement } from "react";

/**
 * Three 12px circles in the 48px sidebar top bar (DESIGN.md §5
 * TrafficLights). Decorative in this build — the reference renders them inert.
 */
export function TrafficLights(): ReactElement {
	return (
		<div className="traffic flex items-center gap-8" aria-hidden="true">
			<span className="traffic__light size-traffic rounded-full" style={{ background: "var(--traffic-close)" }} />
			<span className="traffic__light size-traffic rounded-full" style={{ background: "var(--traffic-min)" }} />
			<span className="traffic__light size-traffic rounded-full" style={{ background: "var(--traffic-max)" }} />
		</div>
	);
}
