/**
 * Badge state → documented visual state (DESIGN.md §5 PillBadge).
 *
 * Pure mapping: labels, tone, dot token, and the tooltip that doubles as the
 * accessible name. Every label ships with its dot. The tone is semantic;
 * PillBadge maps it to utilities and to the `pill--*` selector hook.
 */

export type PillTone = "included" | "excluded" | "failed";

export interface BadgeVisual {
	readonly label: string;
	readonly tone: PillTone;
	readonly dotToken: string | null;
	readonly hollowDot: boolean;
	readonly spinning: boolean;
	readonly title: string;
}

export type IndexState = "included" | "excluded" | "failed" | "retrying";

export function indexBadge(state: IndexState, reason = ""): BadgeVisual {
	switch (state) {
		case "included":
			return {
				label: "포함",
				tone: "included",
				dotToken: "--index-dot-included",
				hollowDot: false,
				spinning: false,
				title: "에이전트 검색에 포함됨 · 클릭하면 제외",
			};
		case "excluded":
			return {
				label: "제외",
				tone: "excluded",
				dotToken: null,
				hollowDot: true,
				spinning: false,
				title: "인덱싱에서 제외됨 · 클릭하면 포함",
			};
		case "failed":
			return {
				label: "재시도",
				tone: "failed",
				dotToken: null,
				hollowDot: false,
				spinning: false,
				title: `인덱싱 실패 · ${reason} — 클릭하면 다시 시도`,
			};
		case "retrying":
			return {
				label: "재시도 중",
				tone: "failed",
				dotToken: null,
				hollowDot: false,
				spinning: true,
				title: `인덱싱 실패 · ${reason} — 클릭하면 다시 시도`,
			};
	}
}
