/**
 * Step 6 — smart-indexing scope (Figma 05c): what the first index reads on the left, what it leaves out on the
 * right. Folders move between the two by dragging. The left panel browses: its top level is the selected folders,
 * and a pill with sub-folders opens them under a breadcrumb. The right panel groups what is left out by the
 * selected folder it lies under; a whole selected folder dragged over (or left out by the AI) is unselected and
 * listed on its own.
 */

import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactElement, type WheelEvent } from "react";
import { ChevronRight, CircleHelp, Folder } from "lucide-react";
import type { FolderCandidate } from "../../../../shared/onboarding-contract";
import type { SmartExclusion } from "../../../../shared/smart-indexing-contract";
import { cn } from "../../lib/cn";
import { canSelectCloudEmbedding, etaMinutes, formatSize, localEmbeddingAllowed, resolveEmbed, scanTotals } from "../flow";
import { excludedTotals, visibleScope } from "../smart-scope";
import type { OnboardingCtx, SubFolder } from "../context";

type Side = "include" | "exclude";

/** What a pill stands for when it moves: a whole selected folder, or a folder inside one. */
interface Moving {
	readonly path: string;
	readonly from: Side;
	readonly top: boolean;
}

/** The part of a left-out folder's path below the folder it lies under, with "/" between its parts. */
function insidePath(item: SmartExclusion): string {
	return item.path.slice(item.root.length).replace(/^[\\/]+/u, "").replace(/\\/gu, "/");
}

/** The panels only scroll sideways, so a mouse wheel moves them that way too. */
function scrollSideways(event: WheelEvent<HTMLElement>): void {
	if (event.deltaX === 0) event.currentTarget.scrollLeft += event.deltaY;
}

/** How the AI decides; shown while the pointer (or focus) rests on its label. */
function Criteria({ t }: { readonly t: OnboardingCtx["t"] }): ReactElement {
	return (
		<span className="si-criteria-wrap">
			<button type="button" className="si-criteria-toggle" aria-describedby="si-criteria-tip">
				<CircleHelp size={16} aria-hidden="true" focusable="false" />
				{t("onboarding.smartScope.criteria.label")}
			</button>
			<span id="si-criteria-tip" className="si-criteria" role="tooltip">
				{(["include", "exclude"] as const).map((part) => (
					<span key={part} className="si-criteria-part">
						<b>{t(`onboarding.smartScope.criteria.${part}Title`)}</b>
						<span className="si-criteria-item">{t(`onboarding.smartScope.criteria.${part}Body`)}</span>
					</span>
				))}
			</span>
		</span>
	);
}

export function SmartScopeStep({ ctx }: { readonly ctx: OnboardingCtx }): ReactElement {
	const { t, candidates, draft, scans, listSubfolders, measureFolders } = ctx;
	/** The folders opened on the left, outermost first; empty at the top level. */
	const [trail, setTrail] = useState<readonly SubFolder[]>([]);
	const [level, setLevel] = useState<readonly SubFolder[]>([]);
	/** Which listed folders have sub-folders of their own, so only those offer to open. */
	const [opens, setOpens] = useState<ReadonlyMap<string, boolean>>(new Map());
	const [over, setOver] = useState<Side | null>(null);
	const moving = useRef<Moving | null>(null);

	const selectedPaths = draft.folders.filter((folder) => folder.selected).map((folder) => folder.path);
	const selected = selectedPaths.map((path) => candidates.find((candidate) => candidate.path === path)).filter((candidate): candidate is FolderCandidate => candidate !== undefined);
	// A selected folder dragged out stays listed on the right, as long as the AI looked through it.
	const analysed = draft.smartScopeRoots ?? [];
	const unselected = candidates.filter((candidate) => analysed.includes(candidate.path) && !selectedPaths.includes(candidate.path));

	const leftOut = visibleScope(draft.smartScope, selectedPaths).filter((item) => item.excluded);
	const leftOutPaths = new Set(leftOut.map((item) => item.path));
	const totals = excludedTotals(draft.smartScope, selectedPaths);
	const included = scanTotals(selectedPaths, scans);
	const mode = resolveEmbed(draft.embed, canSelectCloudEmbedding(ctx.account), localEmbeddingAllowed(ctx.embedding === null ? null : ctx.embedding.localSpec));
	const minutes = etaMinutes(Math.max(0, included.files - totals.files), mode);
	const groups = selected.map((candidate) => ({ candidate, items: leftOut.filter((item) => item.root === candidate.path) })).filter((group) => group.items.length > 0);

	const current = trail.at(-1)?.path ?? null;
	const shown: readonly SubFolder[] = current === null ? selected.map(({ path, name }) => ({ path, name })) : level.filter((folder) => !leftOutPaths.has(folder.path));
	const shownKey = shown.map((folder) => folder.path).join("\n");

	useEffect(() => {
		if (current === null) return;
		let alive = true;
		setLevel([]);
		void listSubfolders(current).then((folders) => {
			if (!alive) return;
			setLevel(folders);
			if (folders.length > 0) measureFolders(folders.map((folder) => folder.path));
		});
		return () => {
			alive = false;
		};
	}, [current, listSubfolders, measureFolders]);

	useEffect(() => {
		let alive = true;
		for (const path of shownKey.length === 0 ? [] : shownKey.split("\n")) {
			void listSubfolders(path).then((folders) => {
				if (alive) setOpens((previous) => (previous.get(path) === folders.length > 0 ? previous : new Map(previous).set(path, folders.length > 0)));
			});
		}
		return () => {
			alive = false;
		};
	}, [shownKey, listSubfolders]);

	const move = (item: Moving, to: Side): void => {
		if (item.from === to) return;
		if (item.top) ctx.setFolderSelected(item.path, to === "include");
		else if (to === "exclude") ctx.excludeFolder(item.path);
		else ctx.setSmartExcluded(item.path, false);
	};

	const dropZone = (side: Side) => ({
		onDragOver: (event: DragEvent<HTMLElement>): void => {
			if (moving.current === null || moving.current.from === side) return;
			event.preventDefault();
			setOver(side);
		},
		onDragLeave: (event: DragEvent<HTMLElement>): void => {
			if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(null);
		},
		onDrop: (event: DragEvent<HTMLElement>): void => {
			event.preventDefault();
			setOver(null);
			if (moving.current !== null) move(moving.current, side);
			moving.current = null;
		},
	});

	const pill = (item: Moving, label: string, size: string, tone: "blue" | "red", title: string, open?: () => void, suggested = false): ReactElement => (
		<div
			key={item.path}
			className={cn("si-pill", tone)}
			data-path={item.path}
			title={title}
			draggable
			role="button"
			tabIndex={0}
			aria-keyshortcuts={item.from === "include" ? "ArrowRight" : "ArrowLeft"}
			onDragStart={(event) => {
				moving.current = item;
				event.dataTransfer?.setData("text/plain", item.path);
			}}
			onDragEnd={() => {
				moving.current = null;
				setOver(null);
			}}
			onClick={open}
			onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
				if (event.key === "ArrowRight" && item.from === "include") move(item, "exclude");
				else if (event.key === "ArrowLeft" && item.from === "exclude") move(item, "include");
				else if (event.key === "Enter" && open !== undefined) open();
				else return;
				event.preventDefault();
				event.stopPropagation();
			}}
		>
			<Folder size={12} aria-hidden="true" focusable="false" />
			<span className="si-pill-label">{label}</span>
			{open === undefined ? null : <ChevronRight size={12} className="si-pill-open" aria-hidden="true" focusable="false" />}
			<span className="si-pill-size">{size}</span>
			{suggested ? <span className="si-pill-ai">{t("onboarding.smartScope.exclude.aiTag")}</span> : null}
		</div>
	);

	const sizeOf = (path: string): string => {
		const scan = scans.get(path);
		return scan === undefined || scan.error !== null ? "…" : formatSize(scan.bytes);
	};

	return (
		<section className="si-screen">
			<div className="si-head">
				<h1>{t("onboarding.smartScope.policy.title")}</h1>
				<div className="si-lead">
					<p>{t("onboarding.smartScope.policy.lead")}</p>
					{draft.smartSuggest === false ? null : <Criteria t={t} />}
				</div>
			</div>
			<div className="si-dual-panels">
				<div className={cn("si-panel blue", over === "include" && "drop")} {...dropZone("include")}>
					<div className="si-panel-head">
						<div className="si-panel-title">{t("onboarding.smartScope.include.title")}</div>
						<span className="si-panel-meta">{t("onboarding.smartScope.include.meta", { count: selected.length })}</span>
					</div>
					<div className="si-panel-body">
						<nav className="si-crumbs">
							{trail.length === 0 ? (
								<span>{t("onboarding.smartScope.include.all")}</span>
							) : (
								<button type="button" className="si-crumb" onClick={() => setTrail([])}>
									{t("onboarding.smartScope.include.all")}
								</button>
							)}
							{trail.map((crumb, index) => (
								<span key={crumb.path} className="si-crumb-part">
									<ChevronRight size={12} aria-hidden="true" focusable="false" />
									{index === trail.length - 1 ? (
										<span className="si-crumb-here">{crumb.name}</span>
									) : (
										<button type="button" className="si-crumb" onClick={() => setTrail(trail.slice(0, index + 1))}>
											{crumb.name}
										</button>
									)}
								</span>
							))}
						</nav>
						<div className="si-pills" onWheel={scrollSideways}>
							{shown.map((folder) =>
								pill(
									{ path: folder.path, from: "include", top: current === null },
									folder.name,
									sizeOf(folder.path),
									"blue",
									folder.path,
									opens.get(folder.path) === true ? () => setTrail([...trail, folder]) : undefined,
								),
							)}
						</div>
					</div>
				</div>
				<div className={cn("si-panel red", over === "exclude" && "drop")} {...dropZone("exclude")}>
					<div className="si-panel-head">
						<div className="si-panel-title">{t("onboarding.smartScope.exclude.title")}</div>
						<span className="si-panel-meta">{formatSize(totals.bytes)}</span>
					</div>
					<div className="si-panel-body" onWheel={scrollSideways}>
						{unselected.length === 0 && groups.length === 0 ? <p className="si-empty">{t("onboarding.smartScope.exclude.empty")}</p> : null}
						{unselected.length > 0 ? (
							<div className="si-group">
								<p className="si-group-title">{t("onboarding.smartScope.exclude.group", { name: t("onboarding.smartScope.include.all"), count: unselected.length })}</p>
								<div className="si-pills">
									{unselected.map((candidate) => {
										const why = draft.smartScope?.find((item) => item.path === candidate.path && item.root === candidate.path)?.reason;
										return pill({ path: candidate.path, from: "exclude", top: true }, candidate.name, sizeOf(candidate.path), "red", why === undefined ? candidate.displayPath : `${why}\n${candidate.displayPath}`, undefined, why !== undefined);
									})}
								</div>
							</div>
						) : null}
						{groups.map(({ candidate, items }) => (
							<div key={candidate.path} className="si-group">
								<p className="si-group-title">{t("onboarding.smartScope.exclude.group", { name: candidate.name, count: items.length })}</p>
								<div className="si-pills">
									{items.map((item) =>
										pill(
											{ path: item.path, from: "exclude", top: false },
											insidePath(item),
											item.files === 0 ? t("onboarding.smartScope.exclude.noDocs") : formatSize(item.bytes),
											"red",
											item.reason === "" ? item.path : `${item.reason}\n${item.path}`,
											undefined,
											item.reason !== "",
										),
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
			<div className="si-summary">
				<span>
					{t("onboarding.smartScope.summary.eta")} <b>{t("onboarding.smartScope.policy.eta", { minutes })}</b>
				</span>
				<span>
					{t("onboarding.smartScope.summary.total")} <b>{formatSize(Math.max(0, included.bytes - totals.bytes))}</b>
				</span>
			</div>
		</section>
	);
}
