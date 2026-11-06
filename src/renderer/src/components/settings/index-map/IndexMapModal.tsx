import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpLeft, File, Folder, Maximize2, RefreshCw } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import type { IndexMap, IndexMapNode } from "../../../../../shared/index-map-contract";
import { ModalShell } from "../SettingsKit";
import { indexMapTargets, layoutRadial, radialState, type RadialState } from "./radial";

const STATES: readonly RadialState[] = ["indexed", "partial", "unindexed", "excluded"];
const STATE_LABEL: Readonly<Record<RadialState, LocaleKey>> = {
	indexed: "settingsSources.indexMap.state.indexed",
	partial: "settingsSources.indexMap.state.partial",
	unindexed: "settingsSources.indexMap.state.unindexed",
	excluded: "settingsSources.indexMap.state.excluded",
};
type Load = { readonly status: "loading" } | { readonly status: "ready"; readonly map: IndexMap } | { readonly status: "error"; readonly message: string };

export function IndexMapModal({ onClose }: { readonly onClose: () => void }): ReactElement {
	const { t, i18n } = useTranslation();
	const [load, setLoad] = useState<Load>({ status: "loading" });
	const [focusPath, setFocusPath] = useState<string | null>(null);
	const [activeId, setActiveId] = useState<number | null>(null);
	const request = useRef(0);
	const reload = useCallback((): void => {
		const fs = window.autorag?.fs;
		if (fs === undefined) {
			setLoad({ status: "error", message: t("settingsSources.indexMap.unavailable") });
			return;
		}
		const current = ++request.current;
		fs.indexMap().then(
			(map) => { if (current === request.current) { setActiveId(null); setLoad({ status: "ready", map }); } },
			(error: unknown) => { if (current === request.current) setLoad({ status: "error", message: error instanceof Error ? error.message : String(error) }); },
		);
	}, [t]);
	useEffect(() => {
		reload();
		const unsubscribe = window.autorag?.fs?.onIndexRefreshed?.(reload);
		return () => { request.current += 1; unsubscribe?.(); };
	}, [reload]);
	const map = load.status === "ready" ? load.map : null;
	const focus = map?.nodes.find((node) => node.path === focusPath && (node.kind === "root" || node.kind === "folder")) ?? null;
	const active = map?.nodes.find((node) => node.id === activeId) ?? focus;
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
		setActiveId(node.id);
		if ((node.kind === "folder" || node.kind === "root") && node.state !== "excluded") setFocusPath(node.path);
	};
	const overview = (): void => { setFocusPath(null); setActiveId(null); };
	const up = (): void => {
		const parent = map?.nodes.find((node) => node.id === focus?.parent);
		setFocusPath(parent?.kind === "folder" ? parent.path : null);
		setActiveId(null);
	};
	const singleRoot = map?.nodes.filter((node) => node.parent === null);
	const listingParent = focus?.id ?? (singleRoot?.length === 1 ? singleRoot[0]?.id : null);
	const children = map?.nodes.filter((node) => node.parent === listingParent) ?? [];
	const detail = active;
	const total = map === null ? 0 : indexMapTargets(map.totals);

	return (
		<ModalShell onClose={onClose} className="index-map-modal" label={t("settingsSources.indexMap.title")}>
			<div className="index-map-head">
				<div><h2>{t("settingsSources.indexMap.title")}</h2><p>{t("settingsSources.indexMap.desc")}</p></div>
				<div className="index-map-tools">
					<button type="button" className="index-map-tool" data-action="index-map-overview" aria-label={t("settingsSources.indexMap.fit")} title={t("settingsSources.indexMap.fit")} onClick={overview}><Maximize2 size={16} aria-hidden="true" /></button>
					<button type="button" className="index-map-tool" aria-label={t("settingsSources.indexMap.reload")} title={t("settingsSources.indexMap.reload")} onClick={reload}><RefreshCw size={16} aria-hidden="true" /></button>
				</div>
			</div>
			<div className="index-map-body">
				<div className="index-map-stage">
					<svg className="index-map-chart" viewBox="0 0 640 640" role="group" aria-label={t("settingsSources.indexMap.canvasLabel")}>
						{sectors.map(({ node, path }) => <path key={node.id} d={path} className="index-map-sector" data-node-id={node.id} data-state={radialState(node)} data-kind={node.kind} data-path={node.path} data-active={active?.id === node.id ? "true" : undefined} tabIndex={0} role="button" aria-label={describe(node)} onPointerEnter={() => setActiveId(node.id)} onFocus={() => setActiveId(node.id)} onClick={() => enter(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enter(node); } }}><title>{describe(node)}</title></path>)}
					</svg>
					{map !== null ? <button type="button" className="index-map-center" onClick={up} aria-label={focus === null ? t("settingsSources.indexMap.fit") : t("settingsSources.indexMap.up")}>
						{focus !== null ? <ArrowUpLeft size={14} aria-hidden="true" /> : null}<strong>{percent}</strong><span>{t("settingsSources.indexMap.coverageLabel")}</span><small>{focus === null ? t("settingsSources.indexMap.allRoots") : label(focus)}</small>
					</button> : null}
					{load.status === "loading" ? <div className="index-map-overlay">{t("settingsSources.indexMap.loading")}</div> : null}
					{load.status === "error" ? <div className="index-map-overlay" role="alert">{t("settingsSources.indexMap.error", { message: load.message })}</div> : null}
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
						{children.map((node) => <button type="button" key={node.id} data-state={radialState(node)} onPointerEnter={() => setActiveId(node.id)} onFocus={() => setActiveId(node.id)} onClick={() => enter(node)}>{node.kind === "folder" || node.kind === "root" ? <Folder size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}<span>{label(node)}</span><small>{node.state === "excluded" ? "—" : `${number.format(node.counts.indexed)}/${number.format(indexMapTargets(node.counts))}`}</small></button>)}
					</div>
				</aside>
			</div>
			<div className="index-map-footer"><ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>{STATES.map((state) => <li key={state} data-state={state}><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t(STATE_LABEL[state])}</span></li>)}</ul><p>{t("settingsSources.indexMap.dragHint")}</p></div>
			{map !== null && (map.truncated || map.folded) ? <p className="index-map-note">{map.truncated ? t("settingsSources.indexMap.truncated", { total: number.format(total) }) : t("settingsSources.indexMap.folded", { total: number.format(total) })}</p> : null}
		</ModalShell>
	);
}
