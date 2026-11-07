import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Ban, CornerLeftUp, File, Folder, RotateCcw } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import type { IndexMapNode } from "../../../../../shared/index-map-contract";
import { availableActions } from "../../../../../shared/index-scope-edit";
import { useIndexActivity } from "../../../hooks/useIndexActivity";
import { localIndexRunning } from "../../../state/index-activity";
import { indexMapTargets, layoutRadial, nodeKey, radialState, type RadialState } from "./radial";
import { useLiveIndexMap } from "./useLiveIndexMap";

const STATES: readonly RadialState[] = ["indexed", "partial", "unindexed", "excluded"];
const STATE_LABEL: Readonly<Record<RadialState, LocaleKey>> = {
	indexed: "settingsSources.indexMap.state.indexed",
	partial: "settingsSources.indexMap.state.partial",
	unindexed: "settingsSources.indexMap.state.unindexed",
	excluded: "settingsSources.indexMap.state.excluded",
};

export interface IndexMapPanelProps {
	/** The search folders in the config. When they change, the map reads again and shows the whole scope. */
	readonly searchPaths: readonly string[];
	/** The exclusions in the config, to tell a folder left out on its own from one left out by a folder above it. */
	readonly excludePaths: readonly string[];
	/** True while a change to the scope is being saved. */
	readonly busy: boolean;
	readonly onExclude: (path: string) => void;
	readonly onInclude: (path: string) => void;
}

/**
 * The index map under the progress bar on Settings → Indexing: a radial chart of the search folders with their
 * completion, a ring on the places a running index just moved to, and, for the folder or file in view, the one change
 * that would work (leave it out, or bring it back).
 */
export function IndexMapPanel({ searchPaths, excludePaths, busy, onExclude, onInclude }: IndexMapPanelProps): ReactElement {
	const { t, i18n } = useTranslation();
	const running = localIndexRunning(useIndexActivity());
	const { map, error, progress } = useLiveIndexMap({
		read: () => (window.autorag?.fs === undefined ? Promise.reject(new Error(t("settingsSources.indexMap.unavailable"))) : window.autorag.fs.indexMap()),
		onRefreshed: (listener) => window.autorag?.fs?.onIndexRefreshed?.(listener) ?? (() => {}),
		running,
		// Any change to what the index covers reads the map again at once.
		revision: JSON.stringify([searchPaths, excludePaths]),
	});
	// What is in view is kept by path: a re-read renumbers nodes, but a path names the same place. The pointer only
	// previews; the click is what picks, so the buttons stay reachable after the pointer leaves the chart.
	const [focusPath, setFocusPath] = useState<string | null>(null);
	const [hoverKey, setHoverKey] = useState<string | null>(null);
	const [pickedKey, setPickedKey] = useState<string | null>(null);
	// A different set of search folders is a different map: show all of it, rather than the folder that was in view,
	// which may not even be among the new roots (a folder just added would be off screen).
	const foldersKey = JSON.stringify(searchPaths);
	const [seenFolders, setSeenFolders] = useState(foldersKey);
	if (seenFolders !== foldersKey) {
		setSeenFolders(foldersKey);
		setFocusPath(null);
		setPickedKey(null);
		setHoverKey(null);
	}
	const focus = map?.nodes.find((node) => node.path === focusPath && (node.kind === "root" || node.kind === "folder")) ?? null;
	const picked = map?.nodes.find((node) => nodeKey(node) === pickedKey) ?? null;
	const detail = map?.nodes.find((node) => nodeKey(node) === hoverKey) ?? picked ?? focus;
	const sectors = useMemo(() => map === null ? [] : layoutRadial(map, focus?.id ?? null), [map, focus]);
	const counts = focus?.counts ?? map?.totals;
	const targets = counts === undefined ? 0 : indexMapTargets(counts);
	const indexed = counts?.indexed ?? 0;
	const percentage = targets === 0 ? null : Math.min(indexed === targets ? 100 : 99, Math.round(indexed * 100 / targets));
	const number = new Intl.NumberFormat(i18n.language);
	const percent = percentage === null ? "—" : `${number.format(percentage)}%`;
	const label = (node: IndexMapNode): string => node.kind === "parcel"
		? t("settingsSources.indexMap.parcel", { files: number.format(node.weight), state: t(STATE_LABEL[radialState(node)]) })
		: node.kind === "root" ? node.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? node.path : node.name;
	const describe = (node: IndexMapNode): string => `${label(node)} · ${t(STATE_LABEL[radialState(node)])} · ${t("settingsSources.indexMap.folderCounts", { indexed: number.format(node.counts.indexed), total: number.format(indexMapTargets(node.counts)) })}`;
	const enter = (node: IndexMapNode): void => {
		setPickedKey(nodeKey(node));
		setHoverKey(null);
		if ((node.kind === "folder" || node.kind === "root") && node.state !== "excluded") setFocusPath(node.path);
	};
	const roots = map?.nodes.filter((node) => node.parent === null) ?? [];
	const up = (): void => {
		const parent = map?.nodes.find((node) => node.id === focus?.parent);
		// A lone search root is the whole scope already, so going up from its folders lands on the overview.
		setFocusPath(parent === undefined || (parent.kind === "root" && roots.length === 1) ? null : parent.path);
		setPickedKey(null);
		setHoverKey(null);
	};
	const exclude = (path: string): void => {
		// Leaving out the folder that is in view leaves nothing to look at inside it.
		if (focus !== null && focus.path === path) up();
		setPickedKey(null);
		onExclude(path);
	};
	const listingParent = focus?.id ?? (roots.length === 1 ? roots[0]?.id : null);
	const children = map?.nodes.filter((node) => node.parent === listingParent) ?? [];
	const actions = detail === null ? null : availableActions({ path: detail.path, kind: detail.kind, state: radialState(detail), excludePaths });
	const total = map === null ? 0 : indexMapTargets(map.totals);
	const preview = (node: IndexMapNode) => ({ onPointerEnter: () => setHoverKey(nodeKey(node)), onFocus: () => setHoverKey(nodeKey(node)), onBlur: () => setHoverKey(null) });

	return (
		<section className="index-map-panel" aria-label={t("settingsSources.indexMap.title")}>
			<ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>
				{STATES.map((state) => <li key={state} data-state={state}><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t(STATE_LABEL[state])}</span></li>)}
				{progress.here.size > 0 ? <li data-state="progress"><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t("settingsSources.indexMap.progress")}</span></li> : null}
			</ul>
			<div className="index-map-body">
				<div className="index-map-stage">
					<svg className="index-map-chart" viewBox="0 0 640 640" role="group" aria-label={t("settingsSources.indexMap.canvasLabel")} onPointerLeave={() => setHoverKey(null)}>
						{sectors.map(({ node, path }) => <path key={nodeKey(node)} d={path} className="index-map-sector" data-node-id={node.id} data-state={radialState(node)} data-kind={node.kind} data-path={node.path} data-active={detail !== null && nodeKey(detail) === nodeKey(node) ? "true" : undefined} data-progress={progress.here.has(nodeKey(node)) ? "true" : undefined} tabIndex={0} role="button" aria-label={describe(node)} {...preview(node)} onClick={() => enter(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enter(node); } }}><title>{describe(node)}</title></path>)}
						{sectors.filter(({ node }) => progress.here.has(nodeKey(node))).map(({ node, edge }) => <path key={`edge-${nodeKey(node)}`} d={edge} className="index-map-edge" data-path={node.path} aria-hidden="true" />)}
					</svg>
					{map !== null ? <button type="button" className="index-map-center" onClick={up} disabled={focus === null} aria-label={focus === null ? t("settingsSources.indexMap.allRoots") : t("settingsSources.indexMap.up")}>
						{focus !== null ? <CornerLeftUp size={14} aria-hidden="true" /> : null}<strong>{percent}</strong><small>{focus === null ? t("settingsSources.indexMap.allRoots") : label(focus)}</small>
					</button> : null}
					{map === null && error === null ? <div className="index-map-overlay">{t("settingsSources.indexMap.loading")}</div> : null}
					{map === null && error !== null ? <div className="index-map-overlay" role="alert">{t("settingsSources.indexMap.error", { message: error })}</div> : null}
					{map !== null && targets === 0 && sectors.length === 0 ? <div className="index-map-overlay">{t("settingsSources.indexMap.empty")}</div> : null}
				</div>
				<aside className="index-map-sidebar">
					<div className="index-map-summary" data-indexed={indexed} data-targets={targets}>
						<span className="index-map-kicker">{t("settingsSources.indexMap.scopeLabel")}</span>
						<h3>{focus === null ? t("settingsSources.indexMap.allRoots") : label(focus)}</h3>
						<p>{t("settingsSources.indexMap.coverage", { indexed: number.format(indexed), total: number.format(targets) })}</p>
					</div>
					<div className="index-map-details" aria-live="polite">
						{detail === null ? <p>{t("settingsSources.indexMap.selectHint")}</p> : <>
							<span className="index-map-status" data-state={radialState(detail)}>{t(STATE_LABEL[radialState(detail)])}</span>
							<h4>{label(detail)}</h4><p className="index-map-path">{detail.path}</p>
							<p>{detail.state === "excluded" ? t("settingsSources.indexMap.excludedHint") : t("settingsSources.indexMap.folderCounts", { indexed: number.format(detail.counts.indexed), total: number.format(indexMapTargets(detail.counts)) })}</p>
							{detail.kind === "file" && detail.state === "stale" ? <p>{t("settingsSources.indexMap.state.stale")}</p> : null}
							{detail.kind === "file" && detail.state === "unindexable" ? <p>{t("settingsSources.indexMap.state.unindexable")}</p> : null}
							{actions?.exclude === true ? <button type="button" className="linear-btn settings-btn-quiet index-map-action" data-action="index-map-exclude" disabled={busy} onClick={() => exclude(detail.path)}><Ban size={13} aria-hidden="true" />{t("contextMenu.excludeFromIndex")}</button> : null}
							{actions?.include === true ? <button type="button" className="linear-btn settings-btn-quiet index-map-action" data-action="index-map-include" disabled={busy} onClick={() => onInclude(detail.path)}><RotateCcw size={13} aria-hidden="true" />{t("contextMenu.includeInIndex")}</button> : null}
						</>}
					</div>
					<div className="index-map-folders" aria-label={t("settingsSources.indexMap.scopeLabel")} onPointerLeave={() => setHoverKey(null)}>
						{focus !== null ? <button type="button" className="index-map-parent" data-action="index-map-parent" aria-label={t("settingsSources.indexMap.up")} onClick={up}><CornerLeftUp size={15} aria-hidden="true" /><span>..</span></button> : null}
						{children.map((node) => <button type="button" key={nodeKey(node)} data-state={radialState(node)} data-progress={progress.inside.has(nodeKey(node)) ? "true" : undefined} title={progress.inside.has(nodeKey(node)) ? t("settingsSources.indexMap.progress") : undefined} {...preview(node)} onClick={() => enter(node)}>{node.kind === "folder" || node.kind === "root" ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}<span>{label(node)}</span><small>{node.state === "excluded" ? "—" : `${number.format(node.counts.indexed)}/${number.format(indexMapTargets(node.counts))}`}</small></button>)}
					</div>
				</aside>
			</div>
			{map !== null && map.truncated ? <p className="index-map-note">{t("settingsSources.indexMap.truncated", { total: number.format(total) })}</p> : null}
		</section>
	);
}
