/**
 * Settings → 검색 범위 → 인덱싱 지도: the scope drawn as land. Blue ground is
 * indexed, red needs indexing (new or changed since), grey translucent ground
 * is left out. The map is read once on open and again after every refresh a
 * toggle started; hovering a star names the file or folder under it.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, RefreshCw } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import { INDEX_MAP_STATES, type IndexMap, type IndexMapState } from "../../../../../shared/index-map-contract";
import { ModalShell } from "../SettingsKit";
import { createIndexMapScene, type IndexMapScene, type SceneHover } from "./scene";
import { TERRITORY_COLORS, TERRITORY_OPACITY } from "./territory";

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
	const [r, g, b] = TERRITORY_COLORS[state];
	return `rgba(${r}, ${g}, ${b}, ${TERRITORY_OPACITY[state]})`;
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
		const scene = createIndexMapScene(canvas, map, { reducedMotion: reducedMotion(), onHover: setHover });
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
	const coverage = indexable === 0 ? null : Math.round((map?.totals.indexed ?? 0) * 100 / indexable);

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
						<span>{t("settingsSources.indexMap.coverage", { indexed: number.format(map?.totals.indexed ?? 0), total: number.format(indexable) })}</span>
					</div>
				) : null}
			</div>
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
					<li key={state} data-state={state}>
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
