import type { TFunction } from "i18next";
import type { IndexActivityItem, IndexActivitySnapshot } from "../../../shared/index-activity-contract";

/** What the sidebar block and the Settings card show for one snapshot; `null` means nothing to show. */
export interface IndexActivityView {
	readonly tone: "run" | "ok" | "error";
	/** 0..100, or `null` for an indeterminate bar. */
	readonly percent: number | null;
	readonly headline: string;
	/** Who started it when that is not this app's own button ("자동 새로 고침", "앱 밖에서 실행"); `null` for the app's own runs. */
	readonly origin: string | null;
	/** Second line: the datasource or phase that is running, or the failure. */
	readonly detail: string | null;
}

export function itemName(item: IndexActivityItem, t: TFunction): string {
	return item.kind === "local" ? t("indexActivity.local") : (item.id ?? t("indexActivity.source"));
}

/** The phase of the running local refresh, as a sentence. */
export function itemPhaseText(item: IndexActivityItem, t: TFunction): string | null {
	return item.phase === null ? null : t(`indexActivity.phases.${item.phase}`);
}

function runningDetail(running: readonly IndexActivityItem[], t: TFunction): string | null {
	const [first] = running;
	if (first === undefined) return null;
	const phase = itemPhaseText(first, t);
	const name = itemName(first, t);
	const text = phase === null ? t("indexActivity.syncing", { name }) : `${name} · ${phase}`;
	return running.length > 1 ? t("indexActivity.andMore", { text, count: running.length - 1 }) : text;
}

export function describeIndexActivity(snapshot: IndexActivitySnapshot, t: TFunction): IndexActivityView | null {
	if (snapshot.state === "idle") return null;
	const origin = snapshot.origin === "scheduled" || snapshot.origin === "external" ? t(`indexActivity.origin.${snapshot.origin}`) : null;
	if (snapshot.state === "running") {
		const finished = snapshot.items.filter((item) => item.state === "done" || item.state === "failed").length;
		const base = snapshot.items.length > 1 ? t("indexActivity.runningCount", { done: finished, total: snapshot.items.length }) : t("indexActivity.running");
		const detail = runningDetail(
			snapshot.items.filter((item) => item.state === "running"),
			t,
		);
		return {
			tone: "run",
			percent: snapshot.fraction === null ? null : Math.min(99, Math.floor(snapshot.fraction * 100)),
			headline: base,
			origin,
			detail,
		};
	}
	if (snapshot.state === "done") {
		return { tone: "ok", percent: 100, headline: t("indexActivity.done"), origin, detail: null };
	}
	const failed = snapshot.items.filter((item) => item.state === "failed");
	const names = failed.map((item) => itemName(item, t)).join(", ");
	return {
		tone: "error",
		percent: 100,
		headline: t("indexActivity.failed"),
		origin,
		detail: [names, snapshot.error].filter((part): part is string => part !== null && part.length > 0).join(" — ") || null,
	};
}

/** The journaled/librarian item for `key` (`local`, `source:<id>`), if the current run has one. */
export function activityItem(snapshot: IndexActivitySnapshot, key: string): IndexActivityItem | null {
	return snapshot.items.find((item) => item.key === key) ?? null;
}
