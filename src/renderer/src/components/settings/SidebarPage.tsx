import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
	AppWindow,
	Box,
	ChevronDown,
	ChevronUp,
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
	Monitor,
	Music,
	Package,
	RotateCcw,
	Server,
	Sparkles,
	Star,
	Tag,
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
import { hostPlatform } from "../../lib/shortcuts";
import { basename } from "../../state/paths";
import { Switch } from "../primitives/Switch";
import { TagDotMark } from "../primitives/TagDot";
import { AppCustomizerModal } from "./AppCustomizerModal";
import { PromptModal, Section, SettingsPageHead } from "./SettingsKit";

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
	cloud: Cloud,
	disk: HardDrive,
	network: Server,
};

const SECTION_ICONS: Readonly<Record<SidebarSectionId, LucideIcon>> = {
	favorites: Star,
	cloud: Cloud,
	locations: HardDrive,
	tags: Tag,
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
	onOpenAiSettings,
}: {
	readonly appSettings: AppSettings;
	readonly onAppSettingsChanged: (settings: AppSettings) => void;
	readonly onSettingsError: (message: string) => void;
	readonly onOpenAiSettings?: () => void;
}): ReactElement {
	const { t } = useTranslation();
	const [locations, setLocations] = useState<readonly FsLocation[]>([]);
	const [tags, setTags] = useState<readonly FsTag[]>([]);
	const [customizerOpen, setCustomizerOpen] = useState(false);
	const [addFolderOpen, setAddFolderOpen] = useState(false);

	const sidebar = useMemo(() => normalizeSidebarSettings(appSettings.sidebar), [appSettings.sidebar]);
	const hiddenItems = useMemo(() => new Set(sidebar.hiddenItems), [sidebar.hiddenItems]);
	const hiddenSections = useMemo(() => new Set<string>(sidebar.hiddenSections), [sidebar.hiddenSections]);

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
		const all = [...standard, ...custom];
		const orderIndex = new Map<string, number>(sidebar.favoritesOrder.map((id, idx) => [id, idx]));
		return all
			.map((row, idx) => ({ row, order: orderIndex.get(row.id) ?? sidebar.favoritesOrder.length + idx }))
			.sort((a, b) => a.order - b.order)
			.map(({ row }) => row);
	}, [locations, localizedPlaceLabel, sidebar.customFavorites, sidebar.favoritesOrder]);

	const toggleItem = (id: string): void => {
		const nextHidden = new Set(sidebar.hiddenItems);
		if (nextHidden.has(id)) nextHidden.delete(id);
		else nextHidden.add(id);
		void updateSidebar({ ...sidebar, hiddenItems: [...nextHidden] });
	};

	const moveFavorite = (index: number, delta: -1 | 1): void => {
		const targetIndex = index + delta;
		if (targetIndex < 0 || targetIndex >= favoriteRows.length) return;
		const ids = favoriteRows.map((row) => row.id);
		const [moved] = ids.splice(index, 1);
		if (moved === undefined) return;
		ids.splice(targetIndex, 0, moved);
		void updateSidebar({ ...sidebar, favoritesOrder: ids });
	};

	const addCustomFavorite = (rawPath: string): void => {
		const trimmed = rawPath.trim();
		if (trimmed.length === 0) return;
		const nextCustom = [...sidebar.customFavorites.filter((item) => item.path !== trimmed), { path: trimmed }];
		const nextHidden = sidebar.hiddenItems.filter((id) => id !== customSidebarItemId(trimmed));
		setAddFolderOpen(false);
		void updateSidebar({
			...sidebar,
			customFavorites: nextCustom,
			hiddenItems: nextHidden,
		});
	};

	const removeCustomFavorite = (path: string): void => {
		const id = customSidebarItemId(path);
		void updateSidebar({
			...sidebar,
			customFavorites: sidebar.customFavorites.filter((item) => item.path !== path),
			favoritesOrder: sidebar.favoritesOrder.filter((item) => item !== id),
			hiddenItems: sidebar.hiddenItems.filter((item) => item !== id),
		});
	};

	const toggleSection = (sectionId: HideableSidebarSectionId): void => {
		const next = new Set<HideableSidebarSectionId>(sidebar.hiddenSections);
		if (next.has(sectionId)) next.delete(sectionId);
		else next.add(sectionId);
		void updateSidebar({ ...sidebar, hiddenSections: [...next] });
	};

	const moveSection = (index: number, delta: -1 | 1): void => {
		const targetIndex = index + delta;
		if (targetIndex < 0 || targetIndex >= sidebar.sectionOrder.length) return;
		const order = [...sidebar.sectionOrder];
		const [moved] = order.splice(index, 1);
		if (moved === undefined) return;
		order.splice(targetIndex, 0, moved);
		void updateSidebar({ ...sidebar, sectionOrder: order });
	};

	const sectionLabel = (sectionId: SidebarSectionId): string => {
		switch (sectionId) {
			case "favorites":
				return t("places.favorites");
			case "cloud":
				return t("places.cloud");
			case "locations":
				return t("places.locations");
			case "tags":
				return t("places.tags");
		}
	};

	const cloudRows = useMemo(() => locations.filter((loc) => loc.section === "cloud"), [locations]);
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
					onClick={() => setCustomizerOpen(true)}
				>
					<img src={dazziMark} alt="" className="sidebar-ai-hero__btn-logo" aria-hidden="true" draggable={false} />
					<span>{t("settingsCore.sidebar.aiHeroButton")}</span>
				</button>
			</div>

			<div className="sidebar-presets-bar" role="group" aria-label={t("settingsCore.sidebar.presetsTitle")}>
				<span className="sidebar-presets-bar__label">{t("settingsCore.sidebar.presetsTitle")}</span>
				<div className="sidebar-presets-bar__actions">
					<button
						type="button"
						className={`sidebar-preset-pill${isShowAllActive ? " is-active" : ""}`}
						data-action="sidebar-preset-all"
						onClick={() => void updateSidebar({ ...sidebar, hiddenItems: [], hiddenSections: [] })}
					>
						{t("settingsCore.sidebar.presetShowAll")}
					</button>
					<button
						type="button"
						className={`sidebar-preset-pill${isMinimalActive ? " is-active" : ""}`}
						data-action="sidebar-preset-minimal"
						onClick={() => void updateSidebar({ ...sidebar, hiddenItems: [...MINIMAL_HIDDEN_FAVORITE_IDS] })}
					>
						{t("settingsCore.sidebar.presetMinimal")}
					</button>
					<button
						type="button"
						className="sidebar-preset-pill is-reset"
						data-action="sidebar-reset-default"
						disabled={isDefault}
						onClick={() => void updateSidebar(DEFAULT_SIDEBAR_SETTINGS)}
					>
						<RotateCcw size={11} aria-hidden="true" />
						<span>{t("settingsCore.sidebar.resetDefault")}</span>
					</button>
				</div>
			</div>

			<Section title={t("settingsCore.sidebar.sectionsTitle")} description={t("settingsCore.sidebar.sectionsDesc")}>
				<div className="sidebar-sections-stack">
					{sidebar.sectionOrder.map((sectionId, idx) => {
						const isFav = sectionId === "favorites";
						const sectionVisible = isFav ? true : !hiddenSections.has(sectionId);
						const label = sectionLabel(sectionId);
						const SectionIcon = SECTION_ICONS[sectionId];
						const counts = sectionCounts(sectionId);

						return (
							<div
								key={sectionId}
								className={`sidebar-section-card${sectionVisible ? "" : " is-collapsed"}`}
								data-sidebar-section={sectionId}
							>
								<div className="sidebar-section-card__head">
									<div className="sidebar-custom-row__order">
										<button
											type="button"
											className="sidebar-order-btn"
											data-action={`move-section-up-${sectionId}`}
											disabled={idx === 0}
											title={t("settingsCore.sidebar.moveUp", { name: label })}
											aria-label={t("settingsCore.sidebar.moveUp", { name: label })}
											onClick={() => moveSection(idx, -1)}
										>
											<ChevronUp size={12} />
										</button>
										<button
											type="button"
											className="sidebar-order-btn"
											data-action={`move-section-down-${sectionId}`}
											disabled={idx === sidebar.sectionOrder.length - 1}
											title={t("settingsCore.sidebar.moveDown", { name: label })}
											aria-label={t("settingsCore.sidebar.moveDown", { name: label })}
											onClick={() => moveSection(idx, 1)}
										>
											<ChevronDown size={12} />
										</button>
									</div>
									<span className="sidebar-section-card__glyph" aria-hidden="true">
										<SectionIcon size={15} />
									</span>
									<div className="sidebar-section-card__title-wrap">
										<span className="sidebar-section-card__title">{label}</span>
										{isFav ? (
											<span className="sidebar-custom-badge is-locked" title={t("settingsCore.sidebar.sectionAlwaysShown")}>
												{t("settingsCore.sidebar.lockedBadge")}
											</span>
										) : null}
										{counts !== null && sectionVisible ? (
											<span className="sidebar-section-card__count">
												{t("settingsCore.sidebar.sectionCount", counts)}
											</span>
										) : null}
									</div>
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
									<div className="sidebar-section-card__items">
										<div className="sidebar-custom-row is-locked" title={t("settingsCore.sidebar.lockedHint")}>
											<div className="sidebar-custom-row__order" aria-hidden="true">
												<Lock size={12} className="sidebar-custom-row__lock-glyph" />
											</div>
											<span className="sidebar-custom-row__icon is-accent" aria-hidden="true">
												<Sparkles size={15} />
											</span>
											<div className="sidebar-custom-row__main">
												<span className="sidebar-custom-row__name">{t("places.aiSearch")}</span>
												<span className="sidebar-custom-badge is-locked">{t("settingsCore.sidebar.lockedBadge")}</span>
											</div>
											<Switch
												checked={true}
												disabled={true}
												dataSwitchId="app:aiSearch"
												ariaLabel={t("places.aiSearch")}
												onChange={() => undefined}
											/>
										</div>

										<div className="sidebar-custom-row is-locked" title={t("settingsCore.sidebar.lockedHint")}>
											<div className="sidebar-custom-row__order" aria-hidden="true">
												<Lock size={12} className="sidebar-custom-row__lock-glyph" />
											</div>
											<span className="sidebar-custom-row__icon is-accent" aria-hidden="true">
												<Zap size={15} />
											</span>
											<div className="sidebar-custom-row__main">
												<span className="sidebar-custom-row__name">{t("places.automations")}</span>
												<span className="sidebar-custom-badge is-locked">{t("settingsCore.sidebar.lockedBadge")}</span>
											</div>
											<Switch
												checked={true}
												disabled={true}
												dataSwitchId="app:automations"
												ariaLabel={t("places.automations")}
												onChange={() => undefined}
											/>
										</div>

										{favoriteRows.map((row, index) => {
											const Icon = row.icon;
											const visible = !hiddenItems.has(row.id);
											return (
												<div key={row.id} className={`sidebar-custom-row${visible ? "" : " is-muted"}`} data-sidebar-row={row.id}>
													<div className="sidebar-custom-row__order">
														<button
															type="button"
															className="sidebar-order-btn"
															data-action={`move-up-${row.id}`}
															disabled={index === 0}
															title={t("settingsCore.sidebar.moveUp", { name: row.label })}
															aria-label={t("settingsCore.sidebar.moveUp", { name: row.label })}
															onClick={() => moveFavorite(index, -1)}
														>
															<ChevronUp size={12} />
														</button>
														<button
															type="button"
															className="sidebar-order-btn"
															data-action={`move-down-${row.id}`}
															disabled={index === favoriteRows.length - 1}
															title={t("settingsCore.sidebar.moveDown", { name: row.label })}
															aria-label={t("settingsCore.sidebar.moveDown", { name: row.label })}
															onClick={() => moveFavorite(index, 1)}
														>
															<ChevronDown size={12} />
														</button>
													</div>
													<span className="sidebar-custom-row__icon" aria-hidden="true">
														<Icon size={15} />
													</span>
													<div className="sidebar-custom-row__main">
														<span className="sidebar-custom-row__name">{row.label}</span>
														{row.customPath !== undefined ? (
															<span className="sidebar-custom-badge">{t("settingsCore.sidebar.customBadge")}</span>
														) : null}
														{row.subtitle !== undefined ? (
															<span className="sidebar-custom-row__path" title={row.subtitle}>
																{row.subtitle}
															</span>
														) : null}
													</div>
													<div className="sidebar-custom-row__controls">
														{row.customPath !== undefined ? (
															<button
																type="button"
																className="sidebar-remove-btn"
																data-action={`remove-custom-${row.customPath}`}
																title={t("settingsCore.sidebar.removeCustom", { name: row.label })}
																aria-label={t("settingsCore.sidebar.removeCustom", { name: row.label })}
																onClick={() => removeCustomFavorite(row.customPath!)}
															>
																<X size={13} />
															</button>
														) : null}
														<Switch
															checked={visible}
															dataSwitchId={row.id}
															ariaLabel={row.label}
															onChange={() => toggleItem(row.id)}
														/>
													</div>
												</div>
											);
										})}

										<div className="sidebar-section-card__foot">
											<button
												type="button"
												className="linear-btn"
												data-action="add-custom-favorite"
												onClick={() => setAddFolderOpen(true)}
											>
												{t("settingsCore.sidebar.addCustomFolder")}
											</button>
										</div>
									</div>
								) : null}

								{sectionVisible && sectionId === "cloud" ? (
									<div className="sidebar-section-card__items">
										{cloudRows.length === 0 ? (
											<p className="sidebar-section-card__empty">{t("settingsCore.sidebar.emptyCloud")}</p>
										) : (
											cloudRows.map((loc) => {
												const id = cloudSidebarItemId(loc.path);
												const Icon = KIND_ICONS[loc.icon];
												const visible = !hiddenItems.has(id);
												return (
													<div key={id} className={`sidebar-custom-row${visible ? "" : " is-muted"}`} data-sidebar-row={id}>
														<div className="sidebar-custom-row__order" aria-hidden="true" />
														<span className="sidebar-custom-row__icon" aria-hidden="true">
															<Icon size={15} />
														</span>
														<div className="sidebar-custom-row__main">
															<span className="sidebar-custom-row__name">{loc.name}</span>
															<span className="sidebar-custom-row__path" title={loc.path}>
																{loc.path}
															</span>
														</div>
														<Switch
															checked={visible}
															dataSwitchId={id}
															ariaLabel={loc.name}
															onChange={() => toggleItem(id)}
														/>
													</div>
												);
											})
										)}
									</div>
								) : null}

								{sectionVisible && sectionId === "locations" ? (
									<div className="sidebar-section-card__items">
										{locationRows.length === 0 ? (
											<p className="sidebar-section-card__empty">{t("settingsCore.sidebar.emptyLocations")}</p>
										) : (
											locationRows.map((loc) => {
												const id = locationSidebarItemId(loc.path);
												const Icon = KIND_ICONS[loc.icon];
												const visible = !hiddenItems.has(id);
												return (
													<div key={id} className={`sidebar-custom-row${visible ? "" : " is-muted"}`} data-sidebar-row={id}>
														<div className="sidebar-custom-row__order" aria-hidden="true" />
														<span className="sidebar-custom-row__icon" aria-hidden="true">
															<Icon size={15} />
														</span>
														<div className="sidebar-custom-row__main">
															<span className="sidebar-custom-row__name">{loc.name}</span>
															<span className="sidebar-custom-row__path" title={loc.path}>
																{loc.path}
															</span>
														</div>
														<Switch
															checked={visible}
															dataSwitchId={id}
															ariaLabel={loc.name}
															onChange={() => toggleItem(id)}
														/>
													</div>
												);
											})
										)}
									</div>
								) : null}

								{sectionVisible && sectionId === "tags" ? (
									<div className="sidebar-section-card__items">
										{tags.length === 0 ? (
											<p className="sidebar-section-card__empty">{t("settingsCore.sidebar.emptyTags")}</p>
										) : (
											tags.map((tag) => {
												const id = tagSidebarItemId(tag.name);
												const visible = !hiddenItems.has(id);
												return (
													<div key={id} className={`sidebar-custom-row${visible ? "" : " is-muted"}`} data-sidebar-row={id}>
														<div className="sidebar-custom-row__order" aria-hidden="true" />
														<span className="sidebar-custom-row__icon" aria-hidden="true">
															<TagDotMark color={tag.color} size={10} />
														</span>
														<div className="sidebar-custom-row__main">
															<span className="sidebar-custom-row__name">{tag.name}</span>
														</div>
														<Switch
															checked={visible}
															dataSwitchId={id}
															ariaLabel={tag.name}
															onChange={() => toggleItem(id)}
														/>
													</div>
												);
											})
										)}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
			</Section>

			{addFolderOpen ? (
				<PromptModal
					title={t("settingsCore.sidebar.addCustomModalTitle")}
					description={t("settingsCore.sidebar.addCustomModalDesc")}
					label={t("settingsCore.sidebar.addCustomPathLabel")}
					placeholder={t("settingsCore.sidebar.addCustomPathPlaceholder")}
					confirmLabel={t("settingsCore.sidebar.addCustomConfirm")}
					onCancel={() => setAddFolderOpen(false)}
					onSubmit={addCustomFavorite}
				/>
			) : null}

			{customizerOpen ? (
				<AppCustomizerModal
					onClose={() => setCustomizerOpen(false)}
					onSettingsUpdated={(next) => onAppSettingsChanged(next)}
					onOpenAiSettings={onOpenAiSettings}
				/>
			) : null}
		</>
	);
}
