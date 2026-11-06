import { useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpLeft, CornerLeftUp, File, Folder } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import type { IndexMapNode } from "../../../../../shared/index-map-contract";
import { useIndexActivity } from "../../../hooks/useIndexActivity";
import { localIndexRunning } from "../../../state/index-activity";
import { ModalShell } from "../SettingsKit";
import { indexMapTargets, layoutRadial, radialState, type RadialState } from "./radial";
import { useLiveIndexMap } from "./useLiveIndexMap";

const STATES: readonly RadialState[] = ["indexed", "partial", "unindexed", "excluded"];
const STATE_LABEL: Readonly<Record<RadialState, LocaleKey>> = {
	indexed: "settingsSources.indexMap.state.indexed",
	partial: "settingsSources.indexMap.state.partial",
	unindexed: "settingsSources.indexMap.state.unindexed",
	excluded: "settingsSources.indexMap.state.excluded",
};

/** A node's identity across re-reads: ids are renumbered when the tree changes, a path and kind name the same place. State is left out, so a file turning blue under the pointer stays hovered. */
const keyOf = (node: IndexMapNode): string => `${node.kind}\u0000${node.path}`;

export function IndexMapModal({ onClose }: { readonly onClose: () => void }): ReactElement {
	const { t, i18n } = useTranslation();
	const running = localIndexRunning(useIndexActivity());
	const { map, error } = useLiveIndexMap({
		read: () => (window.autorag?.fs === undefined ? Promise.reject(new Error(t("settingsSources.indexMap.unavailable"))) : window.autorag.fs.indexMap()),
		onRefreshed: (listener) => window.autorag?.fs?.onIndexRefreshed?.(listener) ?? (() => {}),
		running,
	});
	// The focused folder and the hovered item are kept by path: a re-read renumbers nodes, but a path names the same place.
	const [focusPath, setFocusPath] = useState<string | null>(null);
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const focus = map?.nodes.find((node) => node.path === focusPath && (node.kind === "root" || node.kind === "folder")) ?? null;
	const active = map?.nodes.find((node) => keyOf(node) === activeKey) ?? focus;
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
		setActiveKey(keyOf(node));
		if ((node.kind === "folder" || node.kind === "root") && node.state !== "excluded") setFocusPath(node.path);
	};
	const roots = map?.nodes.filter((node) => node.parent === null) ?? [];
	const up = (): void => {
		const parent = map?.nodes.find((node) => node.id === focus?.parent);
		// A lone search root is the whole scope already, so going up from its folders lands on the overview.
		setFocusPath(parent === undefined || (parent.kind === "root" && roots.length === 1) ? null : parent.path);
		setActiveKey(null);
	};
	const listingParent = focus?.id ?? (roots.length === 1 ? roots[0]?.id : null);
	const children = map?.nodes.filter((node) => node.parent === listingParent) ?? [];
	const detail = active;
	const total = map === null ? 0 : indexMapTargets(map.totals);

	return (
		<ModalShell onClose={onClose} className="index-map-modal" label={t("settingsSources.indexMap.title")}>
			<div className="index-map-head">
				<div><h2>{t("settingsSources.indexMap.title")}</h2><p>{t("settingsSources.indexMap.desc")}</p></div>
			</div>
			<ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>{STATES.map((state) => <li key={state} data-state={state}><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t(STATE_LABEL[state])}</span></li>)}</ul>
			<div className="index-map-body">
				<div className="index-map-stage">
					<svg className="index-map-chart" viewBox="0 0 640 640" role="group" aria-label={t("settingsSources.indexMap.canvasLabel")}>
						{sectors.map(({ node, path }) => <path key={node.id} d={path} className="index-map-sector" data-node-id={node.id} data-state={radialState(node)} data-kind={node.kind} data-path={node.path} data-active={active !== null && keyOf(active) === keyOf(node) ? "true" : undefined} tabIndex={0} role="button" aria-label={describe(node)} onPointerEnter={() => setActiveKey(keyOf(node))} onFocus={() => setActiveKey(keyOf(node))} onClick={() => enter(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enter(node); } }}><title>{describe(node)}</title></path>)}
					</svg>
					{map !== null ? <button type="button" className="index-map-center" onClick={up} disabled={focus === null} aria-label={focus === null ? t("settingsSources.indexMap.allRoots") : t("settingsSources.indexMap.up")}>
						{focus !== null ? <ArrowUpLeft size={14} aria-hidden="true" /> : null}<strong>{percent}</strong><small>{focus === null ? t("settingsSources.indexMap.allRoots") : label(focus)}</small>
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
						</>}
					</div>
					<div className="index-map-folders" aria-label={t("settingsSources.indexMap.scopeLabel")}>
						{focus !== null ? <button type="button" className="index-map-parent" data-action="index-map-parent" aria-label={t("settingsSources.indexMap.up")} onClick={up}><CornerLeftUp size={15} aria-hidden="true" /><span>..</span></button> : null}
						{children.map((node) => <button type="button" key={keyOf(node)} data-state={radialState(node)} onPointerEnter={() => setActiveKey(keyOf(node))} onFocus={() => setActiveKey(keyOf(node))} onClick={() => enter(node)}>{node.kind === "folder" || node.kind === "root" ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}<span>{label(node)}</span><small>{node.state === "excluded" ? "—" : `${number.format(node.counts.indexed)}/${number.format(indexMapTargets(node.counts))}`}</small></button>)}
					</div>
				</aside>
			</div>
			{map !== null && map.truncated ? <p className="index-map-note">{t("settingsSources.indexMap.truncated", { total: number.format(total) })}</p> : null}
		</ModalShell>
	);
}
