/**
 * Settings → 검색 범위 → 인덱싱 지도: the scope drawn as a planet, called like
 * an election night. Land is what the index is meant to hold: blue where it is
 * indexed, red where it needs indexing (new or changed since). What is left
 * out is sea. On open the count rolls in and the scoreboard ticks with the
 * globe; the map is read again after every refresh a toggle started (shown
 * at once, without replaying the count). Hovering names the region under the
 * pointer.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, RefreshCw } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import { INDEX_MAP_STATES, type IndexMap, type IndexMapState } from "../../../../../shared/index-map-contract";
import { ModalShell } from "../SettingsKit";
import { createIndexMapScene, type IndexMapScene, type SceneHover } from "./scene";
import { GLOBE_COLORS, isLand } from "./globe";

/** Legend order is `INDEX_MAP_STATES`: what is held, what needs work, what is left out. */
const STATE_LABEL: Readonly<Record<IndexMapState, LocaleKey>> = {
	indexed: "settingsSources.indexMap.state.indexed",
	stale: "settingsSources.indexMap.state.stale",
	unindexed: "settingsSources.indexMap.state.unindexed",
	excluded: "settingsSources.indexMap.state.excluded",
	unindexable: "settingsSources.indexMap.state.unindexable",
};

type Load = { readonly status: "loading" } | { readonly status: "ready"; readonly map: IndexMap } | { readonly status: "error"; readonly message: string };

function swatch(state: IndexMapState): string {
	const [r, g, b] = GLOBE_COLORS[state];
	return `rgb(${r}, ${g}, ${b})`;
}

function reducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function IndexMapModal({ onClose }: { readonly onClose: () => void }): ReactElement {
	const { t, i18n } = useTranslation();
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [hover, setHover] = useState<SceneHover | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const sceneRef = useRef<IndexMapScene | null>(null);
	/** The opening count plays once per open; a map read again after a refresh shows at once. */
	const countedRef = useRef(false);
	const [progress, setProgress] = useState(0);

	const reload = useCallback((): void => {
		const fs = window.autorag?.fs;
		if (fs === undefined) {
			setLoad({ status: "error", message: t("settingsSources.indexMap.unavailable") });
			return;
		}
		setLoad((current) => (current.status === "ready" ? current : { status: "loading" }));
		fs.indexMap().then(
			(map) => setLoad({ status: "ready", map }),
			(error: unknown) => setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) }),
		);
	}, [t]);

	useEffect(() => {
		reload();
		return window.autorag?.fs?.onIndexRefreshed?.(() => reload());
	}, [reload]);

	const map = load.status === "ready" ? load.map : null;
	useEffect(() => {
		const canvas = canvasRef.current;
		if (canvas === null || map === null) return;
		const scene = createIndexMapScene(canvas, map, { reducedMotion: reducedMotion(), reveal: !countedRef.current, onHover: setHover, onProgress: setProgress });
		countedRef.current = true;
		sceneRef.current = scene;
		return () => {
			scene.dispose();
			sceneRef.current = null;
			setHover(null);
		};
	}, [map]);

	const number = new Intl.NumberFormat(i18n.language);
	const total = map === null ? 0 : Object.values(map.totals).reduce((sum, count) => sum + count, 0);
	const indexable = map === null ? 0 : map.totals.indexed + map.totals.stale + map.totals.unindexed;
	// The tally follows the globe: every indexed file starts on the red side and crosses over as the count reaches it.
	const indexedTotal = map?.totals.indexed ?? 0;
	const blue = Math.round(indexedTotal * progress);
	const red = indexable - blue;
	const coverage = indexable === 0 ? null : Math.round((blue * 100) / indexable);
	const counting = progress < 1;
	const bar = (share: number): CSSProperties => ({ width: `${indexable === 0 ? 0 : (share * 100) / indexable}%` });

	return (
		<ModalShell onClose={onClose} className="index-map-modal" label={t("settingsSources.indexMap.title")}>
			<div className="index-map-head">
				<div>
					<h2>{t("settingsSources.indexMap.title")}</h2>
					<p>{t("settingsSources.indexMap.desc")}</p>
				</div>
				{coverage !== null ? (
					<div className="index-map-coverage" aria-label={t("settingsSources.indexMap.coverageLabel")}>
						<strong>{coverage}%</strong>
						<span>{t("settingsSources.indexMap.coverage", { indexed: number.format(blue), total: number.format(indexable) })}</span>
					</div>
				) : null}
			</div>
			{map !== null && indexable > 0 ? (
				<div className="index-map-scoreboard" data-counting={counting ? "true" : "false"}>
					<div className="index-map-party" data-party="blue">
						<span>{t("settingsSources.indexMap.blueParty")}</span>
						<strong>{number.format(blue)}</strong>
					</div>
					<div className="index-map-race">
						<div className="index-map-race-head">
							<span className="index-map-live">{counting ? t("settingsSources.indexMap.counting", { percent: Math.round(progress * 100) }) : t("settingsSources.indexMap.counted")}</span>
							<span>{t("settingsSources.indexMap.majority")}</span>
						</div>
						<div className="index-map-race-bar" role="img" aria-label={t("settingsSources.indexMap.coverage", { indexed: number.format(blue), total: number.format(indexable) })}>
							<span className="index-map-race-blue" style={bar(blue)} />
							<span className="index-map-race-red" style={bar(red)} />
							<span className="index-map-race-majority" aria-hidden="true" />
						</div>
					</div>
					<div className="index-map-party" data-party="red">
						<span>{t("settingsSources.indexMap.redParty")}</span>
						<strong>{number.format(red)}</strong>
					</div>
				</div>
			) : null}
			<div className="index-map-stage">
				<canvas ref={canvasRef} className="index-map-canvas" aria-label={t("settingsSources.indexMap.canvasLabel")} data-testid="index-map-canvas" />
				{load.status === "loading" ? <div className="index-map-overlay">{t("settingsSources.indexMap.loading")}</div> : null}
				{load.status === "error" ? <div className="index-map-overlay" role="alert">{t("settingsSources.indexMap.error", { message: load.message })}</div> : null}
				{map !== null && map.nodes.length === 0 ? <div className="index-map-overlay">{t("settingsSources.indexMap.empty")}</div> : null}
				{hover !== null ? (
					<div className="index-map-tooltip" style={{ left: hover.x, top: hover.y }} role="status">
						<span className="index-map-tooltip-dot" style={{ background: swatch(hover.node.state) }} aria-hidden="true" />
						<span className="index-map-tooltip-name">
							{hover.node.kind === "parcel"
								? t("settingsSources.indexMap.parcel", { files: number.format(hover.node.weight), state: t(STATE_LABEL[hover.node.state]) })
								: hover.node.name}
						</span>
						<span className="index-map-tooltip-meta">
							{hover.node.kind === "file"
								? t(STATE_LABEL[hover.node.state])
								: hover.node.kind === "parcel"
									? hover.node.path
									: t("settingsSources.indexMap.folderCounts", { indexed: number.format(hover.node.counts.indexed), total: number.format(hover.node.weight) })}
						</span>
					</div>
				) : null}
				{map !== null && map.nodes.length > 0 ? <div className="index-map-hint">{t("settingsSources.indexMap.dragHint")}</div> : null}
				<div className="index-map-tools">
					<button type="button" className="index-map-tool" aria-label={t("settingsSources.indexMap.fit")} title={t("settingsSources.indexMap.fit")} onClick={() => sceneRef.current?.fit()}>
						<Maximize2 size={14} aria-hidden="true" focusable="false" />
					</button>
					<button type="button" className="index-map-tool" aria-label={t("settingsSources.indexMap.reload")} title={t("settingsSources.indexMap.reload")} onClick={reload}>
						<RefreshCw size={14} aria-hidden="true" focusable="false" />
					</button>
				</div>
			</div>
			<ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>
				{INDEX_MAP_STATES.map((state) => (
					<li key={state} data-state={state} data-ground={isLand(state) ? "land" : "sea"}>
						<span className="index-map-legend-swatch" style={{ background: swatch(state) }} aria-hidden="true" />
						<span>{t(STATE_LABEL[state])}</span>
						<strong>{number.format(map?.totals[state] ?? 0)}</strong>
					</li>
				))}
			</ul>
			{map !== null && (map.truncated || map.folded) ? (
				<p className="index-map-note">
					{map.truncated ? t("settingsSources.indexMap.truncated", { total: number.format(total) }) : t("settingsSources.indexMap.folded", { total: number.format(total) })}
				</p>
			) : null}
		</ModalShell>
	);
}
