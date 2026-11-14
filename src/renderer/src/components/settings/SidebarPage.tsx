import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
	AppWindow,
	Box,
	Clock,
	Cloud,
	Download,
	File,
	Film,
	Folder,
	HardDrive,
	Hexagon,
	House,
	Image,
	Lock,
	MessagesSquare,
	Monitor,
	Music,
	Package,
	Plus,
	RotateCcw,
	Server,
	Sparkles,
	Trash2,
	X,
	Zap,
	type LucideIcon,
} from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import { RECENTS_PATH, type FsBridge, type FsLocation, type FsLocationIcon, type FsTag } from "../../../../shared/fs-contract";
import type { AppSettings, SettingsBridge } from "../../../../shared/settings-contract";
import {
	cloudSidebarItemId,
	connectionSidebarItemId,
	customSidebarItemId,
	DEFAULT_SIDEBAR_SETTINGS,
	isDefaultSidebarSettings,
	locationSidebarItemId,
	MINIMAL_HIDDEN_FAVORITE_IDS,
	normalizeSidebarSettings,
	placeSidebarItemId,
	STANDARD_FAVORITE_KINDS,
	tagSidebarItemId,
	type HideableSidebarSectionId,
	type SidebarSectionId,
	type SidebarSettings,
} from "../../../../shared/sidebar-contract";
import {
	sortByFavoritesOrder,
	withCustomFavorite,
	withFavoriteMoved,
	withoutCustomFavorite,
} from "../../../../shared/sidebar-favorites";
import { hostPlatform } from "../../lib/shortcuts";
import { basename, normalizeTypedPath } from "../../state/paths";
import { Switch } from "../primitives/Switch";
import { TagDotMark } from "../primitives/TagDot";
import { PromptModal, SettingsPageHead } from "./SettingsKit";
import { useReorder, useSlideAnimation } from "./reorder";
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";

type SidebarBridgeWindow = Window & {
	readonly autorag?: {
		readonly settings?: Pick<SettingsBridge, "set">;
		readonly fs?: Pick<FsBridge, "locations" | "tags">;
	};
};

function getSettingsWriter(): Pick<SettingsBridge, "set"> | undefined {
	return (window as SidebarBridgeWindow).autorag?.settings;
}

function getFsReader(): Pick<FsBridge, "locations" | "tags"> | undefined {
	return (window as SidebarBridgeWindow).autorag?.fs;
}

const KIND_ICONS: Readonly<Record<FsLocationIcon, LucideIcon>> = {
	recents: Clock,
	home: House,
	applications: AppWindow,
	desktop: Monitor,
	documents: File,
	downloads: Download,
	music: Music,
	movies: Film,
	pictures: Image,
	trash: Trash2,
	qa: Folder,
	icloud: Cloud,
	"google-drive": Hexagon,
	onedrive: Cloud,
	dropbox: Box,
	box: Package,
	discord: MessagesSquare,
	cloud: Cloud,
	disk: HardDrive,
	network: Server,
};


interface FavoriteRowModel {
	readonly id: string;
	readonly label: string;
	readonly subtitle?: string;
	readonly icon: LucideIcon;
	readonly customPath?: string;
}

export function SidebarPage({
	appSettings,
	onAppSettingsChanged,
	onSettingsError,
	customizerOpen,
	onOpenCustomizer,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly onSettingsError: (message: string) => void;
	/** Whether the AI assistant is in the window's right sidebar; the hero offers to open it only while it is not. */
	readonly customizerOpen: boolean;
	readonly onOpenCustomizer: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [tags, setTags] = useState<readonly FsTag[]>([]);
	const [addFolderOpen, setAddFolderOpen] = useState(false);

	const sidebar = useMemo(() => normalizeSidebarSettings(appSettings.sidebar), [appSettings.sidebar]);
	const hiddenItems = useMemo(() => new Set(sidebar.hiddenItems), [sidebar.hiddenItems]);
	const hiddenSections = useMemo(() => new Set<string>(sidebar.hiddenSections), [sidebar.hiddenSections]);

	const isWindows = hostPlatform() === "win32";
	const homePath = useMemo(
		() => locations.find((loc) => loc.section === "favorites" && loc.icon === "home")?.path ?? null,
		[locations],
	);
	useEffect(() => {
		let live = true;
		const fs = getFsReader();
		if (fs === undefined) return;
		void fs
			.locations()
			.then((rows) => {
				if (live) setLocations(rows);
			})
			.catch(() => undefined);
		void fs
			.tags()
			.then((catalog) => {
				if (live && catalog.supported) setTags(catalog.tags.filter((tag) => tag.sidebar));
			})
			.catch(() => undefined);
		return () => {
			live = false;
		};
	}, []);

	const updateSidebar = useCallback(
		async (next: SidebarSettings): Promise<void> => {
			const normalized = normalizeSidebarSettings(next);
			try {
				const writer = getSettingsWriter();
				if (writer === undefined) return;
				const updated = await writer.set({ sidebar: normalized });
				onAppSettingsChanged(updated);
			} catch (cause) {
				onSettingsError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[onAppSettingsChanged, onSettingsError],
	);

	const localizedPlaceLabel = useCallback(
		(kind: FsLocationIcon, fallback: string): string => {
			if (kind === "movies" && hostPlatform() === "win32") return t("places.moviesWindows", fallback);
			if (kind === "trash" && hostPlatform() === "win32") return t("places.trashWindows", fallback);
			return t(`places.${kind}`, fallback);
		},
		[t],
	);

	const favoriteRows = useMemo((): readonly FavoriteRowModel[] => {
		const osByKind = new Map<FsLocationIcon, FsLocation>();
		for (const loc of locations) {
			if (loc.section === "favorites") osByKind.set(loc.icon, loc);
		}
		const standard: FavoriteRowModel[] = STANDARD_FAVORITE_KINDS.map((kind) => {
			const loc = osByKind.get(kind);
			const id = placeSidebarItemId(kind);
			const fallbackName = loc?.name ?? kind;
			return {
				id,
				label: localizedPlaceLabel(kind, fallbackName),
				icon: KIND_ICONS[kind],
				...(loc?.path !== undefined && loc.path !== RECENTS_PATH && !loc.path.endsWith("://") ? { subtitle: loc.path } : {}),
			};
		});
		const custom: FavoriteRowModel[] = sidebar.customFavorites.map((entry) => ({
			id: customSidebarItemId(entry.path),
			label: entry.label ?? (basename(entry.path) || entry.path),
			subtitle: entry.path,
			icon: Folder,
			customPath: entry.path,
		}));
		return sortByFavoritesOrder([...standard, ...custom], sidebar.favoritesOrder);
	}, [locations, localizedPlaceLabel, sidebar.customFavorites, sidebar.favoritesOrder]);

	const toggleItem = (id: string): void => {
		const nextHidden = new Set(sidebar.hiddenItems);
		if (nextHidden.has(id)) nextHidden.delete(id);
		else nextHidden.add(id);
		void updateSidebar({ ...sidebar, hiddenItems: [...nextHidden] });
	};

	const moveFavoriteTo = (from: number, to: number): void => {
		if (to < 0 || to >= favoriteRows.length || to === from) return;
		const next = withFavoriteMoved(sidebar, favoriteRows.map((row) => row.id), from, to);
		if (next !== sidebar) void updateSidebar(next);
	};

	const addCustomFavorite = (rawPath: string): void => {
		setAddFolderOpen(false);
		void (async () => {
			let effectiveHome = homePath;
			if (effectiveHome === null) {
				const fs = getFsReader();
				if (fs !== undefined) {
					const loaded = await fs.locations().catch(() => [] as readonly FsLocation[]);
					if (loaded.length > 0) setLocations(loaded);
					effectiveHome = loaded.find((loc) => loc.section === "favorites" && loc.icon === "home")?.path ?? null;
				}
			}
			const normalizedPath = normalizeTypedPath(rawPath, effectiveHome);
			if (normalizedPath.length === 0) return;
			await updateSidebar(withCustomFavorite(sidebar, normalizedPath));
		})();
	};

	const removeCustomFavorite = (path: string): void => {
		void updateSidebar(withoutCustomFavorite(sidebar, path));
	};

	const toggleSection = (sectionId: HideableSidebarSectionId): void => {
		const next = new Set<HideableSidebarSectionId>(sidebar.hiddenSections);
		if (next.has(sectionId)) next.delete(sectionId);
		else next.add(sectionId);
		void updateSidebar({ ...sidebar, hiddenSections: [...next] });
	};

	const moveSectionTo = (from: number, to: number): void => {
		if (to < 0 || to >= sidebar.sectionOrder.length || to === from) return;
		const order = [...sidebar.sectionOrder];
		const [moved] = order.splice(from, 1);
		if (moved === undefined) return;
		order.splice(to, 0, moved);
		void updateSidebar({ ...sidebar, sectionOrder: order });
	};

	// Drag and drop by the handles (Figma 467:2293): a favorite moves among favorites, a section among sections; the
	// others slide out of the way while it is dragged.
	const reorder = useReorder();
	const pageRef = useRef<HTMLDivElement>(null);
	useSlideAnimation(pageRef);
	const sectionCount = sidebar.sectionOrder.length;

	const sectionLabel = (sectionId: SidebarSectionId): string => {
		switch (sectionId) {
			case "favorites":
				return t("places.favorites");
			case "cloud":
				return t("places.cloud");
			case "connections":
				return t("places.connections");
			case "locations":
				return t("places.locations");
			case "tags":
				return t("places.tags");
		}
	};

	const cloudRows = useMemo(() => locations.filter((loc) => loc.section === "cloud"), [locations]);
	const connectionRows = useMemo(() => locations.filter((loc) => loc.section === "connections"), [locations]);
	const locationRows = useMemo(() => locations.filter((loc) => loc.section === "locations"), [locations]);

	const sectionCounts = (sectionId: SidebarSectionId): { readonly visible: number; readonly total: number } | null => {
		if (sectionId === "favorites") {
			const total = 2 + favoriteRows.length;
			const visible = 2 + favoriteRows.filter((row) => !hiddenItems.has(row.id)).length;
			return { visible, total };
		}
		if (sectionId === "cloud") {
			if (cloudRows.length === 0) return null;
			return {
				visible: cloudRows.filter((loc) => !hiddenItems.has(cloudSidebarItemId(loc.path))).length,
				total: cloudRows.length,
			};
		}
		if (sectionId === "connections") {
			if (connectionRows.length === 0) return null;
			return {
				visible: connectionRows.filter((loc) => !hiddenItems.has(connectionSidebarItemId(loc.path))).length,
				total: connectionRows.length,
			};
		}
		if (sectionId === "locations") {
			if (locationRows.length === 0) return null;
			return {
				visible: locationRows.filter((loc) => !hiddenItems.has(locationSidebarItemId(loc.path))).length,
				total: locationRows.length,
			};
		}
		if (tags.length === 0) return null;
		return {
			visible: tags.filter((tag) => !hiddenItems.has(tagSidebarItemId(tag.name))).length,
			total: tags.length,
		};
	};

	const isDefault = isDefaultSidebarSettings(sidebar);
	const isMinimalActive =
		MINIMAL_HIDDEN_FAVORITE_IDS.every((id) => hiddenItems.has(id)) &&
		sidebar.hiddenItems.length === MINIMAL_HIDDEN_FAVORITE_IDS.length;
	const isShowAllActive = sidebar.hiddenItems.length === 0 && sidebar.hiddenSections.length === 0;

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.sidebar")} description={t("settingsCore.sidebar.description")} />

			{customizerOpen ? null : (
				<div className="sidebar-ai-hero">
					<div className="sidebar-ai-hero__body">
						<span className="sidebar-ai-hero__logo-wrap" aria-hidden="true">
							<img src={dazziMark} alt="" className="sidebar-ai-hero__logo" draggable={false} />
						</span>
						<div className="sidebar-ai-hero__copy">
							<div className="sidebar-ai-hero__title">{t("settingsCore.sidebar.aiHeroTitle")}</div>
							<p className="sidebar-ai-hero__desc">{t("settingsCore.sidebar.aiHeroDesc")}</p>
						</div>
					</div>
					<button
						type="button"
						className="linear-btn settings-btn-primary sidebar-ai-hero__btn"
						data-action="open-app-customizer"
						onClick={onOpenCustomizer}
					>
						<img src={dazziMark} alt="" className="sidebar-ai-hero__btn-logo" aria-hidden="true" draggable={false} />
						<span>{t("settingsCore.sidebar.aiHeroButton")}</span>
					</button>
				</div>
			)}

			{/* Figma 467:2293: 빠른 구성 (전체 표시 / 핵심만 표시 and 기본값으로 복원), then each section as a head over a bordered card. */}
			<div className="sidebar-page" ref={pageRef}>
				<div className="sidebar-quick" role="group" aria-label={t("settingsCore.sidebar.presetsTitle")}>
					<span className="sidebar-quick-label">{t("settingsCore.sidebar.presetsTitle")}</span>
					<div className="shortcuts-segmented">
						<button
							type="button"
							className={cn("shortcuts-segment", isShowAllActive && "is-active")}
							data-action="sidebar-preset-all"
							aria-pressed={isShowAllActive}
							onClick={() => void updateSidebar({ ...sidebar, hiddenItems: [], hiddenSections: [] })}
						>
							{t("settingsCore.sidebar.presetShowAll")}
						</button>
						<button
							type="button"
							className={cn("shortcuts-segment", isMinimalActive && "is-active")}
							data-action="sidebar-preset-minimal"
							aria-pressed={isMinimalActive}
							onClick={() => void updateSidebar({ ...sidebar, hiddenItems: [...MINIMAL_HIDDEN_FAVORITE_IDS] })}
						>
							{t("settingsCore.sidebar.presetMinimal")}
						</button>
					</div>
					<span className="sidebar-row-spacer" />
					<button
						type="button"
						className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
						data-action="sidebar-reset-default"
						disabled={isDefault}
						onClick={() => void updateSidebar(DEFAULT_SIDEBAR_SETTINGS)}
					>
						<RotateCcw aria-hidden="true" />
						{t("settingsCore.sidebar.resetDefault")}
					</button>
				</div>

				<div className="sidebar-sections-stack" {...reorder.zone("section", moveSectionTo)}>
					{reorder.order("section", sectionCount).map((idx) => {
						const sectionId = sidebar.sectionOrder[idx]!;
						const isFav = sectionId === "favorites";
						const sectionVisible = isFav ? true : !hiddenSections.has(sectionId);
						const label = sectionLabel(sectionId);
						const counts = sectionCounts(sectionId);

						return (
							<section
								key={sectionId}
								className={cn("sidebar-section", !sectionVisible && "is-collapsed", reorder.isDragging("section", idx) && "is-dragging")}
								data-sidebar-section={sectionId}
								data-reorder-key={`section:${sectionId}`}
								{...reorder.target("section", idx, sectionCount, moveSectionTo)}
							>
								<div className="sidebar-section-head">
									{reorder.grip({ kind: "section", index: idx, length: sectionCount, id: `section:${sectionId}`, label: t("settingsCore.sidebar.dragHint", { name: label }), attr: "data-sidebar-grip", onMove: moveSectionTo })}
									<span className="sidebar-section-title">{label}</span>
									{isFav ? (
										<span className="sidebar-always-badge" title={t("settingsCore.sidebar.sectionAlwaysShown")}>
											{t("settingsCore.sidebar.lockedBadge")}
										</span>
									) : null}
									<span className="sidebar-row-spacer" />
									{counts !== null && sectionVisible ? (
										<span className="sidebar-section-count">{t("settingsCore.sidebar.sectionCount", counts)}</span>
									) : null}
									<Switch
										checked={sectionVisible}
										disabled={isFav}
										dataSwitchId={`section:${sectionId}`}
										ariaLabel={label}
										onChange={() => {
											if (!isFav) toggleSection(sectionId);
										}}
									/>
								</div>

								{sectionVisible && sectionId === "favorites" ? (
									<div className="sidebar-card" {...reorder.zone("favorite", moveFavoriteTo)}>
										{([
											["app:aiSearch", t("places.aiSearch"), Sparkles],
											["app:automations", t("places.automations"), Zap],
										] as const).map(([id, name, AppIcon]) => (
											<div key={id} className="sidebar-row is-locked" title={t("settingsCore.sidebar.lockedHint")}>
												<span className="sidebar-grip-space" aria-hidden="true">
													<Lock size={14} strokeWidth={1.5} />
												</span>
												<span className="sidebar-row-label">
													<AppIcon size={14} strokeWidth={1.5} className="sidebar-row-icon is-accent" aria-hidden="true" />
													<span className="sidebar-row-name">{name}</span>
												</span>
												<span className="sidebar-row-spacer" />
												<Switch checked={true} disabled={true} dataSwitchId={id} ariaLabel={name} onChange={() => undefined} />
											</div>
										))}

										{reorder.order("favorite", favoriteRows.length).map((index) => {
											const row = favoriteRows[index]!;
											const Icon = row.icon;
											const visible = !hiddenItems.has(row.id);
											return (
												<div
													key={row.id}
													className={cn("sidebar-row", !visible && "is-muted", reorder.isDragging("favorite", index) && "is-dragging")}
													data-sidebar-row={row.id}
													data-reorder-key={`favorite:${row.id}`}
													{...reorder.target("favorite", index, favoriteRows.length, moveFavoriteTo)}
												>
													{reorder.grip({ kind: "favorite", index, length: favoriteRows.length, id: row.id, label: t("settingsCore.sidebar.dragHint", { name: row.label }), attr: "data-sidebar-grip", onMove: moveFavoriteTo })}
													<span className="sidebar-row-label">
														<Icon size={14} strokeWidth={1.5} className="sidebar-row-icon" aria-hidden="true" />
														<span className="sidebar-row-name">{row.label}</span>
														{row.customPath !== undefined ? (
															<span className="sidebar-always-badge is-plain">{t("settingsCore.sidebar.customBadge")}</span>
														) : null}
													</span>
													{row.subtitle !== undefined ? (
														<span className="sidebar-row-path" title={row.subtitle}>
															{row.subtitle}
														</span>
													) : null}
													<span className="sidebar-row-spacer" />
													{row.customPath !== undefined ? (
														<button
															type="button"
															className="shortcuts-reset"
															data-action={`remove-custom-${row.customPath}`}
															title={t("settingsCore.sidebar.removeCustom", { name: row.label })}
															aria-label={t("settingsCore.sidebar.removeCustom", { name: row.label })}
															onClick={() => removeCustomFavorite(row.customPath!)}
														>
															<X size={14} strokeWidth={1.5} />
														</button>
													) : null}
													<Switch checked={visible} dataSwitchId={row.id} ariaLabel={row.label} onChange={() => toggleItem(row.id)} />
												</div>
											);
										})}

										<div className="sidebar-row is-add">
											<button
												type="button"
												className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
												data-action="add-custom-favorite"
												onClick={() => setAddFolderOpen(true)}
											>
												<Plus aria-hidden="true" />
												{t("settingsCore.sidebar.addCustomFolder")}
											</button>
										</div>
									</div>
								) : null}

								{sectionVisible && sectionId !== "favorites" ? (
									<div className="sidebar-card">
										{sectionId === "tags" ? (
											tags.length === 0 ? (
												<p className="sidebar-card-empty">{t("settingsCore.sidebar.emptyTags")}</p>
											) : (
												tags.map((tag) => {
													const id = tagSidebarItemId(tag.name);
													const visible = !hiddenItems.has(id);
													return (
														<div key={id} className={cn("sidebar-row", !visible && "is-muted")} data-sidebar-row={id}>
															<span className="sidebar-grip-space" aria-hidden="true" />
															<span className="sidebar-row-label">
																<span className="sidebar-row-icon" aria-hidden="true">
																	<TagDotMark color={tag.color} size={10} />
																</span>
																<span className="sidebar-row-name">{tag.name}</span>
															</span>
															<span className="sidebar-row-spacer" />
															<Switch checked={visible} dataSwitchId={id} ariaLabel={tag.name} onChange={() => toggleItem(id)} />
														</div>
													);
												})
											)
										) : (
											(() => {
												const rows = sectionId === "cloud" ? cloudRows : sectionId === "connections" ? connectionRows : locationRows;
												const idOf = sectionId === "cloud" ? cloudSidebarItemId : sectionId === "connections" ? connectionSidebarItemId : locationSidebarItemId;
												const empty =
													sectionId === "cloud"
														? t("settingsCore.sidebar.emptyCloud")
														: sectionId === "connections"
															? t("settingsCore.sidebar.emptyConnections")
															: t("settingsCore.sidebar.emptyLocations");
												if (rows.length === 0) return <p className="sidebar-card-empty">{empty}</p>;
												return rows.map((loc) => {
													const id = idOf(loc.path);
													const Icon = KIND_ICONS[loc.icon];
													const visible = !hiddenItems.has(id);
													return (
														<div key={id} className={cn("sidebar-row", !visible && "is-muted")} data-sidebar-row={id}>
															<span className="sidebar-grip-space" aria-hidden="true" />
															<span className="sidebar-row-label">
																<Icon size={14} strokeWidth={1.5} className="sidebar-row-icon" aria-hidden="true" />
																<span className="sidebar-row-name">{loc.name}</span>
															</span>
															<span className="sidebar-row-path" title={loc.path}>
																{loc.path}
															</span>
															<span className="sidebar-row-spacer" />
															<Switch checked={visible} dataSwitchId={id} ariaLabel={loc.name} onChange={() => toggleItem(id)} />
														</div>
													);
												});
											})()
										)}
									</div>
								) : null}
							</section>
						);
					})}
				</div>
			</div>

			{addFolderOpen ? (
				<PromptModal
					title={t("settingsCore.sidebar.addCustomModalTitle")}
					description={t("settingsCore.sidebar.addCustomModalDesc")}
					label={t("settingsCore.sidebar.addCustomPathLabel")}
					placeholder={t(
						isWindows
							? "settingsCore.sidebar.addCustomPathPlaceholderWindows"
							: "settingsCore.sidebar.addCustomPathPlaceholder",
					)}
					confirmLabel={t("settingsCore.sidebar.addCustomConfirm")}
					onCancel={() => setAddFolderOpen(false)}
					onSubmit={addCustomFavorite}
				/>
			) : null}
		</>
	);
}
