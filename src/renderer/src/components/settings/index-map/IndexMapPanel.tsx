import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, CornerLeftUp, File, Folder } from "lucide-react";
import type { LocaleKey } from "../../../../../shared/i18n/core";
import type { IndexMapNode } from "../../../../../shared/index-map-contract";
import { availableActions } from "../../../../../shared/index-scope-edit";
import { useIndexActivity } from "../../../hooks/useIndexActivity";
import { localIndexRunning } from "../../../state/index-activity";
import { easeInOutCubic, GOLDEN_ANGLE_DEG, lerpShape, litSeeds, motionAllowed, planTween, SEED_FRONTIER, SEED_RADIUS, SEED_STAGGER_MS, SEEDS, ZOOM_MS, type SectorTween } from "./motion";
import { indexMapTargets, layoutRadial, nodeKey, radialState, sectorPath, type RadialSector, type RadialState } from "./radial";
import { useLiveIndexMap } from "./useLiveIndexMap";

const SVG_NS = "http://www.w3.org/2000/svg";
/** After a zoom the seeds stay empty while the seed head turns, then fill again one step apart, centre first. */
const EMPTY_MS = Math.round(ZOOM_MS * 0.45);
const REFILL_MS = SEEDS.length * SEED_STAGGER_MS + 300;

/** A short outward bounce about the chart's centre: a folder that just finished, or the ring when the scope does. */
function pop(element: Element | null | undefined, delay = 0): void {
	if (element === null || element === undefined || typeof element.animate !== "function") return;
	element.animate([{ transform: "scale(1)" }, { transform: "scale(1.04)", offset: 0.45 }, { transform: "scale(1)" }], { duration: 520, delay, easing: "cubic-bezier(.34,1.56,.64,1)" });
}

/**
 * Plays a zoom: every sector moves from its old shape to its new one, and the ones that leave are drawn as stand-ins
 * until they have folded away. Returns a function that ends it at once, in the final layout.
 */
function playZoom(svg: SVGSVGElement, ghosts: SVGGElement | null, plan: readonly SectorTween[]): () => void {
	const drawn = new Map<string, SVGPathElement>();
	svg.querySelectorAll<SVGPathElement>("path.index-map-sector[data-key]").forEach((path) => drawn.set(path.getAttribute("data-key") ?? "", path));
	const stand: SVGPathElement[] = [];
	const items = plan.map((tween) => {
		if (!tween.leaving) return { tween, element: drawn.get(tween.key) };
		if (ghosts === null) return { tween, element: undefined };
		const element = document.createElementNS(SVG_NS, "path");
		element.setAttribute("class", "index-map-sector");
		element.setAttribute("data-state", tween.state);
		element.setAttribute("aria-hidden", "true");
		ghosts.appendChild(element);
		stand.push(element);
		return { tween, element };
	});
	const draw = (t: number): void => {
		for (const { tween, element } of items) {
			if (element === undefined) continue;
			const shape = lerpShape(tween.from, tween.to, t);
			element.setAttribute("d", sectorPath(shape.start, shape.end, shape.inner, shape.outer));
		}
	};
	let frame = 0;
	let done = false;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	const finish = (): void => {
		if (done) return;
		done = true;
		cancelAnimationFrame(frame);
		clearTimeout(fallback);
		draw(1);
		for (const element of stand) element.remove();
		svg.classList.remove("is-zooming");
	};
	svg.classList.add("is-zooming");
	draw(0);
	const began = performance.now();
	const tick = (now: number): void => {
		const progress = Math.min(1, (now - began) / ZOOM_MS);
		draw(easeInOutCubic(progress));
		if (progress < 1) frame = requestAnimationFrame(tick);
		else finish();
	};
	frame = requestAnimationFrame(tick);
	// A hidden window gets no animation frames: the map still lands in its final layout.
	fallback = setTimeout(finish, ZOOM_MS + 250);
	return finish;
}

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
	/** Drawn between the header and the legend: the 진행 상황 heading and its banner, which counts from the map's totals. */
	readonly progressHead?: ReactNode | ((scope: MapScope) => ReactNode);
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
	const leftOut = children.filter((node) => (node.kind === "folder" || node.kind === "root") && radialState(node) === "excluded").length;
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

	// ── Motion: the zoom between folders, the seed head, and the pop when a folder (or the whole scope) finishes. ──
	const svgRef = useRef<SVGSVGElement>(null);
	const ghostRef = useRef<SVGGElement>(null);
	const turnRef = useRef<SVGGElement>(null);
	const turned = useRef(0);
	const stopZoom = useRef<() => void>(() => {});
	const shown = useRef<{ readonly sectors: readonly RadialSector[]; readonly focusPath: string | null; readonly percentage: number | null; readonly states: ReadonlyMap<string, RadialState> } | null>(null);
	// Each zoom empties the seeds, then fills them again from the centre outward for the folder now in view.
	const [seedPhase, setSeedPhase] = useState<"steady" | "empty" | "refill">("steady");
	const seedTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
	const litCount = seedPhase === "empty" ? 0 : litSeeds(indexed, targets);
	const seedState = (index: number): "true" | "new" | undefined => (index >= litCount ? undefined : index >= litCount - SEED_FRONTIER && percentage !== 100 ? "new" : "true");
	const focusNow = focus?.path ?? null;
	useLayoutEffect(() => {
		const before = shown.current;
		shown.current = { sectors, focusPath: focusNow, percentage, states: new Map(sectors.map((sector) => [nodeKey(sector.node), radialState(sector.node)])) };
		const svg = svgRef.current;
		if (before === null || svg === null || !motionAllowed()) return;
		if (before.focusPath !== focusNow) {
			stopZoom.current();
			const goingIn = before.focusPath === null || chain.some((node) => node.path === before.focusPath);
			// The folder both views share, nearest first: the one entered (going in) or the one left (coming out).
			const from = goingIn ? focus : nodes.find((node) => node.path === before.focusPath && (node.kind === "root" || node.kind === "folder"));
			const anchors: string[] = [];
			for (let node: IndexMapNode | undefined = from ?? undefined; node !== undefined; node = parentOf(node)) anchors.push(nodeKey(node));
			const plan = planTween(before.sectors, sectors, anchors);
			if (plan !== null) stopZoom.current = playZoom(svg, ghostRef.current, plan);
			const turn = turnRef.current;
			if (turn !== null) {
				const direction = goingIn ? 1 : -1;
				const start = turned.current;
				const end = start + direction * GOLDEN_ANGLE_DEG;
				turned.current = end;
				turn.style.transform = `rotate(${end}deg)`;
				if (typeof turn.animate === "function") {
					turn.animate([
						{ transform: `rotate(${start}deg) scale(1)` },
						{ transform: `rotate(${start + (end - start) * 0.6}deg) scale(${goingIn ? 0.78 : 1.12})`, offset: 0.55 },
						{ transform: `rotate(${end}deg) scale(1)` },
					], { duration: ZOOM_MS, easing: "cubic-bezier(.4,0,.2,1)" });
				}
			}
			for (const timer of seedTimers.current) clearTimeout(timer);
			setSeedPhase("empty");
			seedTimers.current = [
				setTimeout(() => setSeedPhase("refill"), EMPTY_MS),
				setTimeout(() => setSeedPhase("steady"), EMPTY_MS + REFILL_MS),
			];
			return;
		}
		const drawn = (key: string): Element | null => svg.querySelector(`path.index-map-sector[data-key="${CSS.escape(key)}"]`);
		for (const sector of sectors) {
			if (sector.node.kind !== "folder" && sector.node.kind !== "root") continue;
			const key = nodeKey(sector.node);
			const was = before.states.get(key);
			if (was !== undefined && was !== "indexed" && radialState(sector.node) === "indexed") pop(drawn(key));
		}
		// The whole scope in view just finished: the first ring of more than one sector blooms, one sector after another.
		if (before.percentage !== null && before.percentage < 100 && percentage === 100) {
			const levels = new Map<number, RadialSector[]>();
			for (const sector of sectors) levels.set(sector.level, [...(levels.get(sector.level) ?? []), sector]);
			const ring = [...levels.keys()].sort((a, b) => a - b).find((level) => (levels.get(level)?.length ?? 0) > 1) ?? 0;
			[...(levels.get(ring) ?? [])].sort((a, b) => a.start - b.start).forEach((sector, index) => pop(drawn(nodeKey(sector.node)), index * 45));
		}
		// Only the layout drives this; the rest is read from the render that produced it.
	}, [sectors]);
	useEffect(() => () => {
		stopZoom.current();
		for (const timer of seedTimers.current) clearTimeout(timer);
	}, []);

	return (
		<>
			{header?.(scope)}
			<section className="index-map-panel" aria-label={t("settingsSources.indexMap.title")}>
				{typeof progressHead === "function" ? progressHead(scope) : progressHead}
				<ul className="index-map-legend" aria-label={t("settingsSources.indexMap.legendLabel")}>
					{STATES.map((state) => <li key={state} data-state={state}><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t(STATE_LABEL[state])}</span></li>)}
					{progress.here.size > 0 ? <li data-state="progress"><span className="index-map-legend-swatch" aria-hidden="true" /><span>{t("settingsSources.indexMap.progress")}</span></li> : null}
				</ul>
				<div className="index-map-body">
					<div className="index-map-stage">
						<svg ref={svgRef} className="index-map-chart" viewBox="0 0 640 640" role="group" aria-label={t("settingsSources.indexMap.canvasLabel")} onPointerLeave={() => setHoverKey(null)}>
							{map !== null && targets > 0 ? (
								<g ref={turnRef} className="index-map-seeds-turn" aria-hidden="true">
									<g className={seedPhase === "refill" ? "index-map-seeds is-refill" : "index-map-seeds"}>
										{SEEDS.map((seed, index) => <circle key={index} className="index-map-seed" cx={seed.x} cy={seed.y} r={SEED_RADIUS} data-lit={seedState(index)} style={{ "--i": index } as CSSProperties} />)}
									</g>
								</g>
							) : null}
							<g ref={ghostRef} aria-hidden="true" />
							{sectors.map(({ node, path }) => <path key={nodeKey(node)} d={path} className="index-map-sector" data-key={nodeKey(node)} data-node-id={node.id} data-state={radialState(node)} data-kind={node.kind} data-path={node.path} data-active={hovered !== null && nodeKey(hovered) === nodeKey(node) ? "true" : undefined} data-dimmed={dimmed(node)} data-progress={progress.here.has(nodeKey(node)) ? "true" : undefined} tabIndex={0} role="button" aria-label={describe(node)} {...preview(node)} onClick={() => enter(node)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); enter(node); } }}><title>{describe(node)}</title></path>)}
							{sectors.filter(({ node }) => progress.here.has(nodeKey(node))).map(({ node, edge }) => <path key={`edge-${nodeKey(node)}`} d={edge} className="index-map-edge" data-path={node.path} aria-hidden="true" />)}
						</svg>
						{map !== null ? <button type="button" className="index-map-center" onClick={up} disabled={focus === null} aria-label={focus === null ? t("settingsSources.indexMap.allRoots") : t("settingsSources.indexMap.up")}>
							<strong>{percent}</strong><small>{focus === null ? t("settingsSources.scope.allFolders") : <><CornerLeftUp size={11} aria-hidden="true" />{t("settingsSources.indexMap.upShort")}</>}</small>
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
							<p>{[t("settingsSources.indexMap.coverage", { indexed: number.format(indexed), total: number.format(targets) }), leftOut > 0 ? t("settingsSources.indexMap.excludedFolders", { count: leftOut }) : null].filter((part) => part !== null).join(" · ")}</p>
						</div>
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
										data-opens={opens ? "true" : undefined}
										title={progress.inside.has(nodeKey(node)) ? t("settingsSources.indexMap.progress") : describe(node)}
										onPointerEnter={() => setHoverKey(nodeKey(node))}
										// Anywhere on a folder's row goes into it (its name, its counts, the chevron), except its 제외 / 포함;
										// the name is the button, so Enter and Space do the same from the keyboard.
										onClick={(event) => {
											if (opens && !(event.target instanceof Element && event.target.closest(".index-map-row-action") !== null)) enter(node);
										}}
									>
										<button type="button" className="index-map-row-main" disabled={!opens} {...preview(node)}>
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
