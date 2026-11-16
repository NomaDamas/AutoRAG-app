import { Fragment, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, CornerLeftUp, File, Folder } from "lucide-react";
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

/** What the folder list above the map needs from it: each search folder's progress, and which one is in view. */
export interface MapScope {
	/** How much of a search folder is read; null until the map has it. */
	readonly counts: (root: string) => { readonly indexed: number; readonly targets: number } | null;
	readonly totals: { readonly indexed: number; readonly targets: number } | null;
	/** The search folder the map is inside, or null for 전체. */
	readonly selected: string | null;
	/** Show one search folder, or every one (null). */
	readonly select: (root: string | null) => void;
}

export interface IndexMapPanelProps {
	/** The search folders in the config. When they change, the map reads again and shows the whole scope. */
	readonly searchPaths: readonly string[];
	/** The exclusions in the config, to tell a folder left out on its own from one left out by a folder above it. */
	readonly excludePaths: readonly string[];
	/** True while a change to the scope is being saved. */
	readonly busy: boolean;
	readonly onExclude: (path: string) => void;
	readonly onInclude: (path: string) => void;
	/** Drawn above the map, with the map's view of the search folders (Settings → 인덱싱's 검색할 폴더). */
	readonly header?: (scope: MapScope) => ReactNode;
	/** Drawn between the header and the legend: the 진행 상황 heading and the activity card. */
	readonly progressHead?: ReactNode;
}

/**
 * The index map on Settings → Indexing (Figma 532:9970): a radial chart of the search folders with their completion, a
 * ring on the places a running index just moved to, the path to the folder in view (each part goes back to it), and the
 * folder's contents as rows. Pointing at a row or a sector dims everything else, so what a 제외 would leave out is the
 * one thing still lit; the row's 제외 (or 다시 포함) is at its right.
 */
export function IndexMapPanel({ searchPaths, excludePaths, busy, onExclude, onInclude, header, progressHead }: IndexMapPanelProps): ReactElement {
	const { t, i18n } = useTranslation();
	const running = localIndexRunning(useIndexActivity());
	const { map, error, progress } = useLiveIndexMap({
		read: () => (window.autorag?.fs === undefined ? Promise.reject(new Error(t("settingsSources.indexMap.unavailable"))) : window.autorag.fs.indexMap()),
		onRefreshed: (listener) => window.autorag?.fs?.onIndexRefreshed?.(listener) ?? (() => {}),
		running,
		// Any change to what the index covers reads the map again at once.
		revision: JSON.stringify([searchPaths, excludePaths]),
	});
	// What is in view is kept by path: a re-read renumbers nodes, but a path names the same place.
	const [focusPath, setFocusPath] = useState<string | null>(null);
	const [hoverKey, setHoverKey] = useState<string | null>(null);
	// A different set of search folders is a different map: show all of it, rather than the folder that was in view,
	// which may not even be among the new roots (a folder just added would be off screen).
	const foldersKey = JSON.stringify(searchPaths);
	const [seenFolders, setSeenFolders] = useState(foldersKey);
	if (seenFolders !== foldersKey) {
		setSeenFolders(foldersKey);
		setFocusPath(null);
		setHoverKey(null);
	}
	const nodes = map?.nodes ?? [];
	const focus = nodes.find((node) => node.path === focusPath && (node.kind === "root" || node.kind === "folder")) ?? null;
	const hovered = nodes.find((node) => nodeKey(node) === hoverKey) ?? null;
	const sectors = useMemo(() => map === null ? [] : layoutRadial(map, focus?.id ?? null), [map, focus]);
	const parentOf = (node: IndexMapNode): IndexMapNode | undefined => (node.parent === null ? undefined : nodes[node.parent]);
	// The path from the search folder down to the folder in view.
	const chain: IndexMapNode[] = [];
	for (let node: IndexMapNode | undefined = focus ?? undefined; node !== undefined; node = parentOf(node)) chain.unshift(node);
	const roots = nodes.filter((node) => node.parent === null);
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
	const go = (path: string | null): void => {
		setFocusPath(path);
		setHoverKey(null);
	};
	const enter = (node: IndexMapNode): void => {
		if ((node.kind === "folder" || node.kind === "root") && node.state !== "excluded") go(node.path);
	};
	const up = (): void => {
		const parent = focus === null ? undefined : parentOf(focus);
		// A lone search root is the whole scope already, so going up from its folders lands on the overview.
		go(parent === undefined || (parent.kind === "root" && roots.length === 1) ? null : parent.path);
	};
	const exclude = (path: string): void => {
		// Leaving out the folder that is in view leaves nothing to look at inside it.
		if (focus !== null && focus.path === path) up();
		setHoverKey(null);
		onExclude(path);
	};
	const listingParent = focus?.id ?? (roots.length === 1 ? roots[0]?.id : null);
	const children = nodes.filter((node) => node.parent === listingParent);
	// While something is pointed at, everything outside it dims: the node and what is inside it stay lit.
	const lit = useMemo(() => {
		if (hovered === null) return null;
		const inside = new Set<number>([hovered.id]);
		for (const node of nodes) {
			for (let parent = node.parent; parent !== null; parent = nodes[parent]?.parent ?? null) {
				if (parent === hovered.id) {
					inside.add(node.id);
					break;
				}
			}
		}
		return inside;
	}, [hovered, nodes]);
	const dimmed = (node: IndexMapNode): "true" | undefined => (lit !== null && !lit.has(node.id) ? "true" : undefined);
	const total = map === null ? 0 : indexMapTargets(map.totals);
	const preview = (node: IndexMapNode) => ({ onPointerEnter: () => setHoverKey(nodeKey(node)), onFocus: () => setHoverKey(nodeKey(node)), onBlur: () => setHoverKey(null) });
	const rootOfFocus = chain[0] ?? null;
	const scope: MapScope = {
		counts: (path) => {
			const root = roots.find((node) => node.path === path);
			return root === undefined ? null : { indexed: root.counts.indexed, targets: indexMapTargets(root.counts) };
		},
		totals: map === null ? null : { indexed: map.totals.indexed, targets: indexMapTargets(map.totals) },
		selected: rootOfFocus?.path ?? null,
		select: (path) => go(path),
	};
	// Each part of the path goes back to it; with one search folder the folder is the overview itself.
	const crumbs: { readonly key: string; readonly text: string; readonly path: string | null }[] = [
		{ key: "all", text: t("settingsSources.scope.allFolders"), path: null },
		...chain.filter((node) => !(node.kind === "root" && roots.length === 1)).map((node) => ({ key: nodeKey(node), text: label(node), path: node.path })),
	];

	return (
		<>
			{header?.(scope)}
			<section className="index-map-panel" aria-label={t("settingsSources.indexMap.title")}>
				{progressHead}
				<ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>
					{STATES.map((state) => <li key={state} data-state={state}><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t(STATE_LABEL[state])}</span></li>)}
					{progress.here.size > 0 ? <li data-state="progress"><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t("settingsSources.indexMap.progress")}</span></li> : null}
				</ul>
				<div className="index-map-body">
					<div className="index-map-stage">
						<svg className="index-map-chart" viewBox="0 0 640 640" role="group" aria-label={t("settingsSources.indexMap.canvasLabel")} onPointerLeave={() => setHoverKey(null)}>
							{sectors.map(({ node, path }) => <path key={nodeKey(node)} d={path} className="index-map-sector" data-node-id={node.id} data-state={radialState(node)} data-kind={node.kind} data-path={node.path} data-active={hovered !== null && nodeKey(hovered) === nodeKey(node) ? "true" : undefined} data-dimmed={dimmed(node)} data-progress={progress.here.has(nodeKey(node)) ? "true" : undefined} tabIndex={0} role="button" aria-label={describe(node)} {...preview(node)} onClick={() => enter(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enter(node); } }}><title>{describe(node)}</title></path>)}
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
							<nav className="index-map-crumbs" aria-label={t("settingsSources.indexMap.pathLabel")}>
								{crumbs.map((crumb, index) => (
									<Fragment key={crumb.key}>
										{index > 0 ? <ChevronRight size={12} aria-hidden="true" className="index-map-crumb-sep" /> : null}
										{index === crumbs.length - 1 ? (
											<span className="index-map-crumb is-current" aria-current="location">{crumb.text}</span>
										) : (
											<button type="button" className="index-map-crumb" data-crumb={crumb.path ?? ""} onClick={() => go(crumb.path)}>{crumb.text}</button>
										)}
									</Fragment>
								))}
							</nav>
							<h3>{focus === null ? t("settingsSources.indexMap.allRoots") : label(focus)}</h3>
							<p>{t("settingsSources.indexMap.coverage", { indexed: number.format(indexed), total: number.format(targets) })}</p>
						</div>
						<p className="index-map-hint">{t("settingsSources.indexMap.rowHint")}</p>
						<div className="index-map-folders" aria-label={t("settingsSources.indexMap.scopeLabel")} onPointerLeave={() => setHoverKey(null)}>
							{children.map((node) => {
								const state = radialState(node);
								const actions = availableActions({ path: node.path, kind: node.kind, state, excludePaths });
								const opens = (node.kind === "folder" || node.kind === "root") && node.state !== "excluded";
								return (
									<div
										key={nodeKey(node)}
										className="index-map-row"
										data-state={state}
										data-path={node.path}
										data-kind={node.kind}
										data-hovered={hovered !== null && nodeKey(hovered) === nodeKey(node) ? "true" : undefined}
										data-dimmed={dimmed(node)}
										data-progress={progress.inside.has(nodeKey(node)) ? "true" : undefined}
										title={progress.inside.has(nodeKey(node)) ? t("settingsSources.indexMap.progress") : describe(node)}
										onPointerEnter={() => setHoverKey(nodeKey(node))}
									>
										<button type="button" className="index-map-row-main" disabled={!opens} {...preview(node)} onClick={() => enter(node)}>
											{node.kind === "folder" || node.kind === "root" ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
											<span>{label(node)}</span>
											{state === "excluded" ? <em className="index-map-row-badge">{t(STATE_LABEL.excluded)}</em> : null}
										</button>
										{actions.exclude ? <button type="button" className="index-map-row-action" data-action="index-map-exclude" disabled={busy} {...preview(node)} onClick={() => exclude(node.path)}>{t("settingsSources.indexMap.exclude")}</button> : null}
										{actions.include ? <button type="button" className="index-map-row-action is-shown" data-action="index-map-include" disabled={busy} {...preview(node)} onClick={() => onInclude(node.path)}>{t("settingsSources.indexMap.include")}</button> : null}
										{state === "excluded" ? null : <small>{`${number.format(node.counts.indexed)}/${number.format(indexMapTargets(node.counts))}`}</small>}
										<ChevronRight size={14} aria-hidden="true" className="index-map-row-chevron" data-shown={opens ? "true" : undefined} />
									</div>
								);
							})}
						</div>
					</aside>
				</div>
				{map !== null && map.truncated ? <p className="index-map-note">{t("settingsSources.indexMap.truncated", { total: number.format(total) })}</p> : null}
			</section>
		</>
	);
}
