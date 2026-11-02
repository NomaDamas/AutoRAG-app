import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import type { AppCustomizerChange } from "../../../shared/app-customizer-contract";
import type { FsLocation, FsTag } from "../../../shared/fs-contract";
import type { AppSettings, SettingsBridge } from "../../../shared/settings-contract";
import {
	cloudSidebarItemId,
	connectionSidebarItemId,
	customSidebarItemId,
	DEFAULT_SIDEBAR_SETTINGS,
	isHideableSidebarSectionId,
	isLockedSidebarItemId,
	isSidebarSectionId,
	locationSidebarItemId,
	normalizeSidebarItemId,
	normalizeSidebarSettings,
	placeSidebarItemId,
	STANDARD_FAVORITE_KINDS,
	tagSidebarItemId,
	type CustomSidebarFavorite,
	type HideableSidebarSectionId,
	type SidebarSectionId,
	type SidebarSettings,
} from "../../../shared/sidebar-contract";
import {
	BUILTIN_CONTEXT_MENU_ITEM_IDS,
	CONTEXT_MENU_SECTION_IDS,
	DEFAULT_CONTEXT_MENU_SETTINGS,
	isContextMenuSectionId,
	isHideableContextMenuSectionId,
	isLockedContextMenuItemId,
	normalizeContextMenuItemId,
	normalizeContextMenuSettings,
	normalizeMagicAction,
	type BuiltinContextMenuItemId,
	type ContextMenuSectionId,
	type ContextMenuSettings,
	type HideableContextMenuSectionId,
	type MagicAction,
} from "../../../shared/context-menu-contract";
import { intentPromptLine, withIntentTools, type ReplyLanguage } from "../profile-progress";

export type { ReplyLanguage };

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

export interface AppCustomizerToolkitDeps {
	readonly settings: Pick<SettingsBridge, "get" | "set">;
	readonly listLocations: () => Promise<readonly FsLocation[]>;
	readonly listTags: () => Promise<readonly FsTag[]>;
	readonly homeDir?: string;
	readonly language?: () => ReplyLanguage;
	readonly cancelled?: () => boolean;
}

export interface AppCustomizerToolkit {
	readonly tools: readonly ToolDefinition[];
	takeChanges(): readonly AppCustomizerChange[];
	peekChanges(): readonly AppCustomizerChange[];
}

function textResult(value: unknown): { readonly content: [{ readonly type: "text"; readonly text: string }]; readonly details: undefined } {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }], details: undefined };
}

function expandHome(rawPath: string, home: string): string {
	const trimmed = rawPath.trim();
	if (trimmed === "~") return home;
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return join(home, trimmed.slice(2));
	return trimmed;
}

function resolveCandidateItemId(
	raw: string,
	locations: readonly FsLocation[],
	tags: readonly FsTag[],
	customFavorites: readonly CustomSidebarFavorite[],
	home: string,
): string {
	const normalized = normalizeSidebarItemId(raw);
	if (
		normalized.startsWith("app:") ||
		normalized.startsWith("place:") ||
		normalized.startsWith("cloud:") ||
		normalized.startsWith("connection:") ||
		normalized.startsWith("location:") ||
		normalized.startsWith("tag:") ||
		normalized.startsWith("custom:")
	) {
		return normalized;
	}
	const lower = normalized.toLowerCase();
	const cloudMatch = locations.find(
		(loc) => loc.section === "cloud" && (loc.name.toLowerCase() === lower || loc.path === normalized || loc.icon.toLowerCase() === lower),
	);
	if (cloudMatch !== undefined) return cloudSidebarItemId(cloudMatch.path);

	const connMatch = locations.find(
		(loc) => loc.section === "connections" && (loc.name.toLowerCase() === lower || loc.path === normalized || loc.icon.toLowerCase() === lower),
	);
	if (connMatch !== undefined) return connectionSidebarItemId(connMatch.path);

	const locMatch = locations.find(
		(loc) => loc.section === "locations" && (loc.name.toLowerCase() === lower || loc.path === normalized),
	);
	if (locMatch !== undefined) return locationSidebarItemId(locMatch.path);

	const tagMatch = tags.find((tag) => tag.name.toLowerCase() === lower);
	if (tagMatch !== undefined) return tagSidebarItemId(tagMatch.name);

	const expanded = expandHome(normalized, home);
	const customMatch = customFavorites.find(
		(c) => c.path === expanded || c.path === normalized || c.label?.toLowerCase() === lower || basename(c.path).toLowerCase() === lower,
	);
	if (customMatch !== undefined) return customSidebarItemId(customMatch.path);

	return normalized;
}

function summarizeSidebarChange(language: ReplyLanguage, fields: readonly string[], reset: boolean): string {
	if (reset) {
		switch (language) {
			case "ko":
				return "사이드바 구성을 기본값으로 복원";
			case "ja":
				return "サイドバーを初期設定に復元";
			case "zh":
				return "已将侧边栏恢复为默认设置";
			default:
				return "Reset sidebar to default";
		}
	}
	const parts: string[] = [];
	const hasVisibility = fields.includes("sidebar.hiddenItems") || fields.includes("sidebar.hiddenSections");
	const hasOrder = fields.includes("sidebar.favoritesOrder") || fields.includes("sidebar.sectionOrder");
	const hasCustom = fields.includes("sidebar.customFavorites");

	switch (language) {
		case "ko":
			if (hasVisibility) parts.push("표시 항목 변경");
			if (hasOrder) parts.push("순서 정렬");
			if (hasCustom) parts.push("사용자 폴더 업데이트");
			return parts.length > 0 ? `사이드바 ${parts.join(" · ")}` : "사이드바 설정 업데이트";
		case "ja":
			if (hasVisibility) parts.push("表示項目の変更");
			if (hasOrder) parts.push("並び順の更新");
			if (hasCustom) parts.push("カスタムフォルダの更新");
			return parts.length > 0 ? `サイドバー: ${parts.join(" · ")}` : "サイドバー設定を更新";
		case "zh":
			if (hasVisibility) parts.push("显示项已更新");
			if (hasOrder) parts.push("排序已调整");
			if (hasCustom) parts.push("自定义文件夹已更新");
			return parts.length > 0 ? `侧边栏：${parts.join(" · ")}` : "侧边栏设置已更新";
		default:
			if (hasVisibility) parts.push("visibility updated");
			if (hasOrder) parts.push("order updated");
			if (hasCustom) parts.push("custom folders updated");
			return parts.length > 0 ? `Sidebar: ${parts.join(" · ")}` : "Updated sidebar settings";
	}
}

const GENERAL_FIELD_LABELS: Readonly<Record<ReplyLanguage, Readonly<Record<string, string>>>> = {
	ko: {
		appearance: "화면 모드",
		language: "앱 언어",
		showHiddenFiles: "숨김 파일",
		launchAtLogin: "로그인 시 실행",
		autoInstallUpdates: "자동 업데이트",
	},
	en: {
		appearance: "Appearance",
		language: "App Language",
		showHiddenFiles: "Hidden Files",
		launchAtLogin: "Launch at Login",
		autoInstallUpdates: "Auto Updates",
	},
	ja: {
		appearance: "画面モード",
		language: "アプリの言語",
		showHiddenFiles: "隠しファイル",
		launchAtLogin: "ログイン時に起動",
		autoInstallUpdates: "自動アップデート",
	},
	zh: {
		appearance: "显示模式",
		language: "应用语言",
		showHiddenFiles: "隐藏文件",
		launchAtLogin: "登录时启动",
		autoInstallUpdates: "自动更新",
	},
};

function summarizeGeneralChange(language: ReplyLanguage, fields: readonly string[]): string {
	const labels = GENERAL_FIELD_LABELS[language];
	const localized = fields.map((field) => labels[field] ?? field).join(", ");
	switch (language) {
		case "ko":
			return `앱 설정 변경 (${localized})`;
		case "ja":
			return `アプリ設定を変更 (${localized})`;
		case "zh":
			return `应用设置已更改 (${localized})`;
		default:
			return `Updated app settings (${localized})`;
	}
}

function summarizeContextMenuChange(
	language: ReplyLanguage,
	fields: readonly string[],
	opts: { readonly reset?: boolean; readonly upsertedLabel?: string; readonly deletedLabel?: string } = {},
): string {
	if (opts.reset === true) {
		switch (language) {
			case "ko":
				return "우클릭 메뉴 구성을 기본값으로 복원";
			case "ja":
				return "右クリックメニューを初期設定に復元";
			case "zh":
				return "已将右键菜单恢复为默认设置";
			default:
				return "Reset context menu to default";
		}
	}
	if (opts.upsertedLabel !== undefined) {
		switch (language) {
			case "ko":
				return `매직 액션 저장: ${opts.upsertedLabel}`;
			case "ja":
				return `マジックアクションを保存: ${opts.upsertedLabel}`;
			case "zh":
				return `已保存魔法动作: ${opts.upsertedLabel}`;
			default:
				return `Saved Magic Action: ${opts.upsertedLabel}`;
		}
	}
	if (opts.deletedLabel !== undefined) {
		switch (language) {
			case "ko":
				return `매직 액션 삭제: ${opts.deletedLabel}`;
			case "ja":
				return `マジックアクションを削除: ${opts.deletedLabel}`;
			case "zh":
				return `已删除魔法动作: ${opts.deletedLabel}`;
			default:
				return `Deleted Magic Action: ${opts.deletedLabel}`;
		}
	}
	const parts: string[] = [];
	const hasVisibility = fields.includes("contextMenu.hiddenItems") || fields.includes("contextMenu.hiddenSections");
	const hasOrder = fields.includes("contextMenu.sectionOrder") || fields.includes("contextMenu.magicActions");
	switch (language) {
		case "ko":
			if (hasVisibility) parts.push("표시 항목 변경");
			if (hasOrder) parts.push("순서 정렬");
			return parts.length > 0 ? `우클릭 메뉴 ${parts.join(" · ")}` : "우클릭 메뉴 설정 업데이트";
		case "ja":
			if (hasVisibility) parts.push("表示項目の変更");
			if (hasOrder) parts.push("並び順の更新");
			return parts.length > 0 ? `右クリックメニュー: ${parts.join(" · ")}` : "右クリックメニュー設定を更新";
		case "zh":
			if (hasVisibility) parts.push("显示项已更新");
			if (hasOrder) parts.push("排序已调整");
			return parts.length > 0 ? `右键菜单：${parts.join(" · ")}` : "右键菜单设置已更新";
		default:
			if (hasVisibility) parts.push("visibility updated");
			if (hasOrder) parts.push("order updated");
			return parts.length > 0 ? `Context menu: ${parts.join(" · ")}` : "Updated context menu settings";
	}
}

export function createAppCustomizerToolkit(deps: AppCustomizerToolkitDeps): AppCustomizerToolkit {
	const home = deps.homeDir ?? homedir();
	const lang = (): ReplyLanguage => deps.language?.() ?? "ko";
	const isCancelled = (): boolean => deps.cancelled?.() === true;
	const changes: AppCustomizerChange[] = [];
	let mutationQueue: Promise<unknown> = Promise.resolve();
	function serialized<T>(work: () => Promise<T>): Promise<T> {
		const next = mutationQueue.then(work, work);
		mutationQueue = next.catch(() => undefined);
		return next;
	}

	function ensureLive(): void {
		if (isCancelled()) throw new Error("The customization request was cancelled.");
	}

	async function buildInspectionSnapshot(): Promise<Record<string, unknown>> {
		const [appSettings, locations, tags] = await Promise.all([
			deps.settings.get(),
			deps.listLocations(),
			deps.listTags(),
		]);
		const sidebar = normalizeSidebarSettings(appSettings.sidebar);
		const hiddenItems = new Set(sidebar.hiddenItems);
		const hiddenSections = new Set<string>(sidebar.hiddenSections);

		const contextMenu = normalizeContextMenuSettings(appSettings.contextMenu);
		const hiddenMenuItems = new Set<string>(contextMenu.hiddenItems);
		const hiddenMenuSections = new Set<string>(contextMenu.hiddenSections);
		const osFavoriteMap = new Map<string, FsLocation>();
		for (const loc of locations) {
			if (loc.section === "favorites") osFavoriteMap.set(placeSidebarItemId(loc.icon), loc);
		}
		if (!osFavoriteMap.has("place:recents")) {
			osFavoriteMap.set("place:recents", {
				name: "Recents",
				path: "recents://",
				section: "favorites",
				icon: "recents",
				available: true,
				scanned: false,
				ejectable: false,
			});
		}

		const allCustomizableFavorites = [
			...STANDARD_FAVORITE_KINDS.map((kind) => {
				const id = placeSidebarItemId(kind);
				const loc = osFavoriteMap.get(id);
				return {
					id,
					kind,
					label: loc?.name ?? kind,
					path: loc?.path ?? null,
					visible: !hiddenItems.has(id),
					locked: false,
				};
			}),
			...sidebar.customFavorites.map((custom) => {
				const id = customSidebarItemId(custom.path);
				return {
					id,
					kind: "custom",
					label: custom.label ?? basename(custom.path),
					path: custom.path,
					visible: !hiddenItems.has(id),
					locked: false,
				};
			}),
		];

		const orderIndex = new Map<string, number>(sidebar.favoritesOrder.map((id, index) => [id, index]));
		const orderedFavorites = [...allCustomizableFavorites].sort((a, b) => {
			const idxA = orderIndex.get(a.id) ?? sidebar.favoritesOrder.length + allCustomizableFavorites.indexOf(a);
			const idxB = orderIndex.get(b.id) ?? sidebar.favoritesOrder.length + allCustomizableFavorites.indexOf(b);
			return idxA - idxB;
		});

		return {
			sidebar: {
				lockedFavorites: [
					{ id: "app:aiSearch", label: "AI Search (AI 검색)", visible: true, locked: true, note: "Always shown at top of Favorites; cannot be hidden." },
					{ id: "app:automations", label: "Automations (자동화)", visible: true, locked: true, note: "Always shown at top of Favorites; cannot be hidden." },
				],
				favorites: orderedFavorites,
				sections: sidebar.sectionOrder.map((sectionId) => ({
					id: sectionId,
					visible: sectionId === "favorites" ? true : !hiddenSections.has(sectionId),
					locked: sectionId === "favorites",
					items:
						sectionId === "cloud"
							? locations
									.filter((loc) => loc.section === "cloud")
									.map((loc) => ({
										id: cloudSidebarItemId(loc.path),
										label: loc.name,
										path: loc.path,
										visible: !hiddenItems.has(cloudSidebarItemId(loc.path)),
									}))
							: sectionId === "connections"
								? locations
										.filter((loc) => loc.section === "connections")
										.map((loc) => ({
											id: connectionSidebarItemId(loc.path),
											label: loc.name,
											path: loc.path,
											visible: !hiddenItems.has(connectionSidebarItemId(loc.path)),
										}))
								: sectionId === "locations"
									? locations
											.filter((loc) => loc.section === "locations")
											.map((loc) => ({
												id: locationSidebarItemId(loc.path),
												label: loc.name,
												path: loc.path,
												visible: !hiddenItems.has(locationSidebarItemId(loc.path)),
											}))
								: sectionId === "tags"
									? tags.map((tag) => ({
											id: tagSidebarItemId(tag.name),
											label: tag.name,
											visible: !hiddenItems.has(tagSidebarItemId(tag.name)),
										}))
									: undefined,
				})),
				raw: sidebar,
			},
			contextMenu: {
				lockedItems: [
					{
						id: "builtin:tags",
						label: "Tags (태그)",
						visible: true,
						locked: true,
						note: "Always shown when tags are supported; cannot be hidden.",
					},
				],
				builtinItems: BUILTIN_CONTEXT_MENU_ITEM_IDS.map((id) => ({
					id,
					visible: id === "builtin:tags" ? true : !hiddenMenuItems.has(id),
					locked: id === "builtin:tags",
				})),
				sections: contextMenu.sectionOrder.map((sectionId) => ({
					id: sectionId,
					visible: sectionId === "tags" ? true : !hiddenMenuSections.has(sectionId),
					locked: sectionId === "tags",
				})),
				magicActions: contextMenu.magicActions,
				raw: contextMenu,
			},
			general: {
				appearance: appSettings.appearance,
				language: appSettings.language,
				showHiddenFiles: appSettings.showHiddenFiles,
				launchAtLogin: appSettings.launchAtLogin,
				autoInstallUpdates: appSettings.autoInstallUpdates,
			},
		};
	}

	const getAppSettings = defineTool({
		name: "get_app_settings",
		label: "Get App Settings",
		description:
			"Read Dazzi's current app settings (stored in settings-state.json, separate from AutoRAG config), including the full sidebar customization state, the file right-click context menu customization & custom Magic Actions, and general appearance/Finder preferences.",
		parameters: Type.Object({}),
		execute: async () => {
			ensureLive();
			return textResult(await buildInspectionSnapshot());
		},
	});

	const updateSidebar = defineTool({
		name: "update_sidebar",
		label: "Update Sidebar",
		description:
			"Customize which items and sections appear in the Dazzi Finder sidebar, their order, or custom pinned folders. IMPORTANT: `AI Search` (`app:aiSearch`) and `Automations` (`app:automations` / `자동화`) are mandatory core features and can NEVER be hidden.",
		parameters: Type.Object({
			showItems: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Item IDs or names to make visible in the sidebar (e.g. 'place:downloads', 'place:documents', 'music', 'trash', 'cloud:/path', 'tag:Work').",
				}),
			),
			hideItems: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Item IDs or names to hide from the sidebar (e.g. 'place:music', 'place:movies', 'place:pictures', 'place:applications'). Note: 'app:aiSearch' and 'app:automations' cannot be hidden.",
				}),
			),
			showOnlyFavorites: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"When provided, hides all other customizable Favorite items so ONLY 'AI Search', 'Automations', and the items listed here remain visible in Favorites.",
				}),
			),
			favoritesOrder: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Desired order of customizable Favorite items (e.g. ['place:downloads', 'place:documents', 'place:desktop']). Items listed here are placed first in this exact order below 'AI Search' and 'Automations'.",
				}),
			),
			showSections: Type.Optional(
				Type.Array(Type.Union([Type.Literal("cloud"), Type.Literal("connections"), Type.Literal("locations"), Type.Literal("tags")]), {
					description: "Sidebar sections to show as a whole ('cloud', 'connections', 'locations', 'tags').",
				}),
			),
			hideSections: Type.Optional(
				Type.Array(Type.String(), {
					description: "Sidebar sections to hide as a whole ('cloud', 'connections', 'locations', 'tags'). 'favorites' cannot be hidden.",
				}),
			),
			sectionOrder: Type.Optional(
				Type.Array(
					Type.Union([
						Type.Literal("favorites"),
						Type.Literal("cloud"),
						Type.Literal("connections"),
						Type.Literal("locations"),
						Type.Literal("tags"),
					]),
					{
						description: "Order of sidebar sections (default: ['favorites', 'cloud', 'connections', 'locations', 'tags']).",
					},
				),
			),
			addCustomFavorites: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "Folder path on disk (supports ~/...)." }),
						label: Type.Optional(Type.String({ description: "Optional custom display label in the sidebar." })),
					}),
					{ description: "Custom folder paths to pin to the Favorites section." },
				),
			),
			removeCustomFavorites: Type.Optional(
				Type.Array(Type.String(), {
					description: "Paths or IDs ('custom:/path') of custom pinned folders to remove from Favorites.",
				}),
			),
			resetToDefault: Type.Optional(
				Type.Boolean({
					description: "When true, resets the entire sidebar configuration back to factory defaults.",
				}),
			),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const [currentApp, locations, tags] = await Promise.all([
				deps.settings.get(),
				deps.listLocations(),
				deps.listTags(),
			]);
			const current = normalizeSidebarSettings(currentApp.sidebar);
			const warnings: string[] = [];
			const touchedFields = new Set<string>();

			if (params.resetToDefault === true) {
				ensureLive();
				await deps.settings.set({ sidebar: DEFAULT_SIDEBAR_SETTINGS });
				const change: AppCustomizerChange = {
					kind: "sidebar",
					summary: summarizeSidebarChange(lang(), ["sidebar"], true),
					fields: ["sidebar"],
				};
				changes.push(change);
				return textResult({
					ok: true,
					resetToDefault: true,
					change,
					state: await buildInspectionSnapshot(),
				});
			}

			let customFavorites = [...current.customFavorites];

			if (params.removeCustomFavorites !== undefined && params.removeCustomFavorites.length > 0) {
				const removeSet = new Set(
					params.removeCustomFavorites.flatMap((raw) => {
						const trimmed = raw.trim();
						const withoutPrefix = trimmed.startsWith("custom:") ? trimmed.slice("custom:".length) : trimmed;
						const expanded = expandHome(withoutPrefix, home);
						return [trimmed, withoutPrefix, expanded];
					}),
				);
				customFavorites = customFavorites.filter((item) => !removeSet.has(item.path) && !(item.label !== undefined && removeSet.has(item.label)));
				touchedFields.add("sidebar.customFavorites");
			}

			if (params.addCustomFavorites !== undefined && params.addCustomFavorites.length > 0) {
				for (const entry of params.addCustomFavorites) {
					const resolvedPath = expandHome(entry.path, home);
					const info = await stat(resolvedPath).catch(() => null);
					if (info === null || !info.isDirectory()) {
						warnings.push(`Skipped custom folder '${entry.path}' (${resolvedPath}): path does not exist or is not a folder.`);
						continue;
					}
					const label = entry.label?.trim();
					const existingIdx = customFavorites.findIndex((item) => item.path === resolvedPath);
					const nextItem: CustomSidebarFavorite = label !== undefined && label.length > 0 ? { path: resolvedPath, label } : { path: resolvedPath };
					if (existingIdx >= 0) customFavorites[existingIdx] = nextItem;
					else customFavorites.push(nextItem);
					touchedFields.add("sidebar.customFavorites");
				}
			}

			const hiddenItems = new Set<string>(current.hiddenItems);

			if (params.showOnlyFavorites !== undefined) {
				for (const raw of params.showOnlyFavorites) {
					if (isLockedSidebarItemId(raw)) continue;
				}
				const keepIds = new Set<string>(
					params.showOnlyFavorites.map((raw) => resolveCandidateItemId(raw, locations, tags, customFavorites, home)),
				);
				for (const kind of STANDARD_FAVORITE_KINDS) {
					const id = placeSidebarItemId(kind);
					if (keepIds.has(id)) hiddenItems.delete(id);
					else hiddenItems.add(id);
				}
				for (const custom of customFavorites) {
					const id = customSidebarItemId(custom.path);
					if (keepIds.has(id) || keepIds.has(custom.path)) hiddenItems.delete(id);
					else hiddenItems.add(id);
				}
				touchedFields.add("sidebar.hiddenItems");
			}

			if (params.hideItems !== undefined && params.hideItems.length > 0) {
				for (const raw of params.hideItems) {
					if (isLockedSidebarItemId(raw)) {
						warnings.push(
							`'AI Search' (app:aiSearch) and 'Automations / 자동화' (app:automations) are required core features and cannot be hidden. Kept '${raw}' visible.`,
						);
						continue;
					}
					const resolved = resolveCandidateItemId(raw, locations, tags, customFavorites, home);
					if (isLockedSidebarItemId(resolved)) {
						warnings.push(
							`'AI Search' (app:aiSearch) and 'Automations / 자동화' (app:automations) are required core features and cannot be hidden. Kept '${raw}' visible.`,
						);
						continue;
					}
					hiddenItems.add(resolved);
					touchedFields.add("sidebar.hiddenItems");
				}
			}

			if (params.showItems !== undefined && params.showItems.length > 0) {
				for (const raw of params.showItems) {
					const resolved = resolveCandidateItemId(raw, locations, tags, customFavorites, home);
					hiddenItems.delete(resolved);
					touchedFields.add("sidebar.hiddenItems");
				}
			}

			// Newly added custom favorites should default to visible unless explicitly hidden
			if (params.addCustomFavorites !== undefined) {
				for (const entry of params.addCustomFavorites) {
					const resolvedPath = expandHome(entry.path, home);
					hiddenItems.delete(customSidebarItemId(resolvedPath));
				}
			}

			const hiddenSections = new Set<HideableSidebarSectionId>(current.hiddenSections);
			if (params.hideSections !== undefined && params.hideSections.length > 0) {
				for (const section of params.hideSections) {
					const normalizedSection = section.trim().toLowerCase();
					if (
						normalizedSection === "favorites" ||
						normalizedSection === "즐겨찾기" ||
						normalizedSection === "よく使う項目" ||
						normalizedSection === "お気に入り" ||
						normalizedSection === "个人收藏"
					) {
						warnings.push(
							"The 'Favorites' section cannot be hidden because 'AI Search' and 'Automations' live in it and must always remain visible.",
						);
						continue;
					}
					if (isHideableSidebarSectionId(normalizedSection)) {
						hiddenSections.add(normalizedSection);
						touchedFields.add("sidebar.hiddenSections");
					}
				}
			}
			if (params.showSections !== undefined && params.showSections.length > 0) {
				for (const section of params.showSections) {
					if (isHideableSidebarSectionId(section)) {
						hiddenSections.delete(section);
						touchedFields.add("sidebar.hiddenSections");
					}
				}
			}

			let favoritesOrder = [...current.favoritesOrder];
			if (params.favoritesOrder !== undefined) {
				const requestedOrder = params.favoritesOrder
					.map((raw) => resolveCandidateItemId(raw, locations, tags, customFavorites, home))
					.filter((id) => id !== "" && !isLockedSidebarItemId(id));
				const rest = favoritesOrder.filter((id) => !requestedOrder.includes(id));
				favoritesOrder = [...requestedOrder, ...rest];
				touchedFields.add("sidebar.favoritesOrder");
			}

			let sectionOrder: SidebarSectionId[] = [...current.sectionOrder];
			if (params.sectionOrder !== undefined && params.sectionOrder.length > 0) {
				const valid = params.sectionOrder.filter(isSidebarSectionId);
				sectionOrder = [
					...valid,
					...current.sectionOrder.filter((s) => !valid.includes(s)),
				];
				touchedFields.add("sidebar.sectionOrder");
			}

			const nextSidebar: SidebarSettings = normalizeSidebarSettings({
				hiddenItems: [...hiddenItems],
				hiddenSections: [...hiddenSections],
				favoritesOrder,
				sectionOrder,
				customFavorites,
			});

			ensureLive();
			await deps.settings.set({ sidebar: nextSidebar });

			const fields = [...touchedFields];
			if (fields.length > 0 || warnings.length > 0) {
				changes.push({
					kind: "sidebar",
					summary: summarizeSidebarChange(lang(), fields, false),
					fields: fields.length > 0 ? fields : ["sidebar"],
					...(warnings.length > 0 ? { warnings } : {}),
				});
			}

			return textResult({
				ok: true,
				warnings,
				sidebar: nextSidebar,
				state: await buildInspectionSnapshot(),
			});
		}),
	});

	const updateGeneralSettings = defineTool({
		name: "update_general_settings",
		label: "Update General App Settings",
		description:
			"Update Dazzi's general app preferences stored in settings-state.json (appearance Light/Dark, interface language, showing hidden dot-files in Finder, launch at login, automatic updates).",
		parameters: Type.Object({
			appearance: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")])),
			language: Type.Optional(Type.Union([Type.Literal("ko"), Type.Literal("en"), Type.Literal("ja"), Type.Literal("zh")])),
			showHiddenFiles: Type.Optional(Type.Boolean()),
			launchAtLogin: Type.Optional(Type.Boolean()),
			autoInstallUpdates: Type.Optional(Type.Boolean()),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const patch: Partial<AppSettings> = {
				...(params.appearance === undefined ? {} : { appearance: params.appearance }),
				...(params.language === undefined ? {} : { language: params.language }),
				...(params.showHiddenFiles === undefined ? {} : { showHiddenFiles: params.showHiddenFiles }),
				...(params.launchAtLogin === undefined ? {} : { launchAtLogin: params.launchAtLogin }),
				...(params.autoInstallUpdates === undefined ? {} : { autoInstallUpdates: params.autoInstallUpdates }),
			};
			const fields = Object.keys(patch);
			const updated = await deps.settings.set(patch);
			if (fields.length > 0) {
				changes.push({
					kind: "general",
					summary: summarizeGeneralChange(updated.language, fields),
					fields,
				});
			}
			return textResult({
				ok: true,
				updated: {
					appearance: updated.appearance,
					language: updated.language,
					showHiddenFiles: updated.showHiddenFiles,
					launchAtLogin: updated.launchAtLogin,
					autoInstallUpdates: updated.autoInstallUpdates,
				},
			});
		}),
	});

	const updateContextMenu = defineTool({
		name: "update_context_menu",
		label: "Update Context Menu",
		description:
			"Customize which built-in items and sections appear in the file right-click context menu, reorder sections or custom Magic Actions, or reset the context menu to default. IMPORTANT: `Tags` (`builtin:tags` / section `tags`) is mandatory and can NEVER be hidden, and keyboard shortcuts cannot be reassigned.",
		parameters: Type.Object({
			showItems: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Built-in context menu item IDs or names to show (e.g. 'builtin:quickLook', 'builtin:openWith', 'builtin:toggleIndex', 'builtin:copy', 'builtin:paste', 'builtin:cut', 'builtin:duplicate', 'builtin:rename', 'builtin:copyPath', 'builtin:newFolder', 'builtin:extract', 'builtin:compress', 'builtin:compress7z', 'builtin:share', 'builtin:services', 'builtin:trash').",
				}),
			),
			hideItems: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Built-in context menu item IDs or names to hide. Note: 'builtin:tags' ('태그') is locked and cannot be hidden.",
				}),
			),
			showSections: Type.Optional(
				Type.Array(Type.String(), {
					description: "Context menu sections to show ('open', 'magic', 'index', 'clipboard', 'actions', 'services', 'trash').",
				}),
			),
			hideSections: Type.Optional(
				Type.Array(Type.String(), {
					description: "Context menu sections to hide ('open', 'magic', 'index', 'clipboard', 'actions', 'services', 'trash'). 'tags' cannot be hidden.",
				}),
			),
			sectionOrder: Type.Optional(
				Type.Array(Type.String(), {
					description: "Desired order of context menu sections ('open', 'magic', 'index', 'clipboard', 'actions', 'services', 'tags', 'trash').",
				}),
			),
			magicActionsOrder: Type.Optional(
				Type.Array(Type.String(), {
					description: "Desired order of custom Magic Action IDs.",
				}),
			),
			resetToDefault: Type.Optional(
				Type.Boolean({
					description: "When true, resets the entire file context menu configuration (including Magic Actions) back to factory defaults.",
				}),
			),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			const warnings: string[] = [];
			const touchedFields = new Set<string>();

			if (params.resetToDefault === true) {
				ensureLive();
				await deps.settings.set({ contextMenu: DEFAULT_CONTEXT_MENU_SETTINGS });
				const change: AppCustomizerChange = {
					kind: "contextMenu",
					summary: summarizeContextMenuChange(lang(), ["contextMenu"], { reset: true }),
					fields: ["contextMenu"],
				};
				changes.push(change);
				return textResult({
					ok: true,
					resetToDefault: true,
					change,
					state: await buildInspectionSnapshot(),
				});
			}

			const hiddenItems = new Set<BuiltinContextMenuItemId>(current.hiddenItems);
			if (params.hideItems !== undefined && params.hideItems.length > 0) {
				for (const raw of params.hideItems) {
					if (isLockedContextMenuItemId(raw)) {
						warnings.push(`'Tags' (builtin:tags / 태그) is a required core feature and cannot be hidden. Kept '${raw}' visible.`);
						continue;
					}
					const resolved = normalizeContextMenuItemId(raw);
					if (resolved === "") {
						warnings.push(`Ignored unknown built-in context menu item '${raw}'.`);
						continue;
					}
					hiddenItems.add(resolved);
					touchedFields.add("contextMenu.hiddenItems");
				}
			}
			if (params.showItems !== undefined && params.showItems.length > 0) {
				for (const raw of params.showItems) {
					const resolved = normalizeContextMenuItemId(raw);
					if (resolved !== "") {
						hiddenItems.delete(resolved);
						touchedFields.add("contextMenu.hiddenItems");
					}
				}
			}

			const hiddenSections = new Set<HideableContextMenuSectionId>(current.hiddenSections);
			if (params.hideSections !== undefined && params.hideSections.length > 0) {
				for (const raw of params.hideSections) {
					const normalizedSection = raw.trim().toLowerCase();
					if (normalizedSection === "tags" || normalizedSection === "tag" || normalizedSection === "태그" || normalizedSection === "タグ" || normalizedSection === "标签") {
						warnings.push("The 'Tags' section cannot be hidden because Tags must always remain available in the context menu.");
						continue;
					}
					if (isHideableContextMenuSectionId(normalizedSection)) {
						hiddenSections.add(normalizedSection);
						touchedFields.add("contextMenu.hiddenSections");
					}
				}
			}
			if (params.showSections !== undefined && params.showSections.length > 0) {
				for (const raw of params.showSections) {
					const normalizedSection = raw.trim().toLowerCase();
					if (isHideableContextMenuSectionId(normalizedSection)) {
						hiddenSections.delete(normalizedSection);
						touchedFields.add("contextMenu.hiddenSections");
					}
				}
			}

			let sectionOrder: ContextMenuSectionId[] = [...current.sectionOrder];
			if (params.sectionOrder !== undefined && params.sectionOrder.length > 0) {
				const valid = params.sectionOrder.map((s) => s.trim()).filter(isContextMenuSectionId);
				sectionOrder = [
					...valid,
					...CONTEXT_MENU_SECTION_IDS.filter((s) => !valid.includes(s)),
				];
				touchedFields.add("contextMenu.sectionOrder");
			}

			let magicActions: MagicAction[] = [...current.magicActions];
			if (params.magicActionsOrder !== undefined && params.magicActionsOrder.length > 0) {
				const byId = new Map(magicActions.map((a) => [a.id, a]));
				const ordered: MagicAction[] = [];
				for (const id of params.magicActionsOrder) {
					const found = byId.get(id.trim());
					if (found !== undefined && !ordered.includes(found)) ordered.push(found);
				}
				for (const action of magicActions) {
					if (!ordered.includes(action)) ordered.push(action);
				}
				magicActions = ordered;
				touchedFields.add("contextMenu.magicActions");
			}

			const nextContextMenu: ContextMenuSettings = normalizeContextMenuSettings({
				hiddenItems: [...hiddenItems],
				hiddenSections: [...hiddenSections],
				sectionOrder,
				magicActions,
			});

			ensureLive();
			await deps.settings.set({ contextMenu: nextContextMenu });

			const fields = [...touchedFields];
			if (fields.length > 0 || warnings.length > 0) {
				changes.push({
					kind: "contextMenu",
					summary: summarizeContextMenuChange(lang(), fields),
					fields: fields.length > 0 ? fields : ["contextMenu"],
					...(warnings.length > 0 ? { warnings } : {}),
				});
			}

			return textResult({
				ok: true,
				warnings,
				contextMenu: nextContextMenu,
				state: await buildInspectionSnapshot(),
			});
		}),
	});

	const stringEnum = <const T extends readonly string[]>(values: T, description: string) =>
		Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
	const upsertMagicAction = defineTool({
		name: "upsert_magic_action",
		label: "Upsert Magic Action",
		description:
			"Create or update a custom right-click Magic Action button on files/folders. A Magic Action can run ANY shell command/script (`executionKind: 'script'`) receiving selected files in `\"$@\"` and `DAZZI_FILES_JSON`, OR run an AI agent loop (`executionKind: 'agent'`, `agentMode: 'read' | 'organize'`) with a custom `prompt` on the selected files. Supports filtering by `selection` ('any' | 'single' | 'multiple'), `targetKind` ('any' | 'file' | 'folder'), and `extensions` (e.g. ['pdf', 'png']).",
		parameters: Type.Object({
			id: Type.Optional(Type.String({ description: "Stable slug ID (optional on create; derived from label if omitted; pass existing id to update)." })),
			label: Type.String({ description: "Menu button label shown on right-click (e.g. 'PDF 3줄 요약', '이미지 용량 정리', 'SHA-256 해시 복사')." }),
			description: Type.Optional(Type.String({ description: "Short description shown in Settings." })),
			enabled: Type.Optional(Type.Boolean({ description: "Whether this Magic Action is enabled (default true)." })),
			selection: Type.Optional(
				stringEnum(["any", "single", "multiple"], "When to show: 'single' (1 item), 'multiple' (2+ items batch), or 'any' (1 or more items)."),
			),
			targetKind: Type.Optional(
				stringEnum(["any", "file", "folder"], "Target type filter: 'file', 'folder', or 'any'."),
			),
			extensions: Type.Optional(
				Type.Array(Type.String(), {
					description: "File extensions filter (e.g. ['pdf', 'docx'] or ['png', 'jpg']). Omit or pass [] to match all extensions.",
				}),
			),
			executionKind: stringEnum(["script", "agent"], "'script' runs a shell command/code; 'agent' runs a pi AI agent loop on the target files."),
			command: Type.Optional(
				Type.String({
					description: "Required when executionKind='script'. Shell command to execute. Selected file paths are passed as positional arguments (\"$@\") and in env vars DAZZI_FILES_JSON (JSON string array), DAZZI_FILE (first path), DAZZI_FILE_COUNT.",
				}),
			),
			agentMode: Type.Optional(
				stringEnum(["read", "organize"], "Used when executionKind='agent': 'read' for read-only analysis/summary/Q&A; 'organize' when the agent may create, edit, convert, rename, move, or run tools on files."),
			),
			prompt: Type.Optional(
				Type.String({
					description: "Required when executionKind='agent'. Instruction telling the agent what to do with the selected file(s).",
				}),
			),
			useSkills: Type.Optional(
				Type.Boolean({
					description:
						"Used when executionKind='agent'. Share installed Skills with the AutoRAG Agent (default: true; set false to disable skills for this action).",
				}),
			),
			useMcp: Type.Optional(
				Type.Boolean({
					description:
						"Used when executionKind='agent'. Share connected MCP servers (such as Aside MCP in mcp.json) with the AutoRAG Agent (default: true; set false to disable MCP servers for this action).",
				}),
			),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const execution =
				params.executionKind === "script"
					? { kind: "script" as const, command: params.command ?? "" }
					: {
							kind: "agent" as const,
							mode: params.agentMode === "organize" ? ("organize" as const) : ("read" as const),
							prompt: params.prompt ?? "",
							useSkills: params.useSkills ?? true,
							useMcp: params.useMcp ?? true,
						};
			const normalized = normalizeMagicAction({
				id: params.id,
				label: params.label,
				description: params.description,
				enabled: params.enabled ?? true,
				selection: params.selection ?? "any",
				targetKind: params.targetKind ?? "file",
				extensions: params.extensions ?? [],
				execution,
			});
			if (normalized === null) {
				return textResult({
					ok: false,
					error: "Invalid Magic Action: ensure label is non-empty and command (for script) or prompt (for agent) is provided.",
				});
			}
			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			const existingIdx = current.magicActions.findIndex((item) => item.id === normalized.id);
			const nextActions = [...current.magicActions];
			if (existingIdx >= 0) nextActions[existingIdx] = normalized;
			else nextActions.push(normalized);

			const nextContextMenu = normalizeContextMenuSettings({
				...current,
				magicActions: nextActions,
			});
			ensureLive();
			await deps.settings.set({ contextMenu: nextContextMenu });

			const change: AppCustomizerChange = {
				kind: "contextMenu",
				summary: summarizeContextMenuChange(lang(), ["contextMenu.magicActions"], { upsertedLabel: normalized.label }),
				fields: ["contextMenu.magicActions"],
			};
			changes.push(change);
			return textResult({
				ok: true,
				magicAction: normalized,
				contextMenu: nextContextMenu,
			});
		}),
	});

	const deleteMagicAction = defineTool({
		name: "delete_magic_action",
		label: "Delete Magic Action",
		description: "Remove a custom right-click Magic Action by its ID or display label.",
		parameters: Type.Object({
			idOrLabel: Type.String({ description: "The ID or exact label of the Magic Action to delete." }),
		}),
		execute: (_callId, params) => serialized(async () => {
			ensureLive();
			const needle = params.idOrLabel.trim().toLowerCase();
			const currentApp = await deps.settings.get();
			const current = normalizeContextMenuSettings(currentApp.contextMenu);
			const target = current.magicActions.find(
				(action) => action.id.toLowerCase() === needle || action.label.toLowerCase() === needle,
			);
			if (target === undefined) {
				return textResult({
					ok: false,
					error: `No Magic Action found matching '${params.idOrLabel}'.`,
				});
			}
			const nextContextMenu = normalizeContextMenuSettings({
				...current,
				magicActions: current.magicActions.filter((action) => action.id !== target.id),
			});
			ensureLive();
			await deps.settings.set({ contextMenu: nextContextMenu });
			changes.push({
				kind: "contextMenu",
				summary: summarizeContextMenuChange(lang(), ["contextMenu.magicActions"], { deletedLabel: target.label }),
				fields: ["contextMenu.magicActions"],
			});
			return textResult({
				ok: true,
				deleted: target,
				contextMenu: nextContextMenu,
			});
		}),
	});

	return {
		tools: [getAppSettings, updateSidebar, updateContextMenu, upsertMagicAction, deleteMagicAction, updateGeneralSettings],
		takeChanges: () => changes.splice(0),
		peekChanges: () => [...changes],
	};
}

function systemPrompt(language: ReplyLanguage): string {
	const replyLang = LANGUAGE_NAME[language];
	return [
		"You are Dazzi's dedicated App Customization Assistant (`app-customizer`), embedded inside Settings.",
		`Always reply in ${replyLang}, concisely and warmly.`,
		"",
		"## Role & Scope",
		"- You customize Dazzi's own app settings (stored in `settings-state.json`, completely separate from the AutoRAG index config).",
		"- **Finder Sidebar (`update_sidebar`)**: show or hide items (`place:recents`, `place:home`, `place:applications`, `place:desktop`, `place:documents`, `place:downloads`, `place:music`, `place:movies`, `place:pictures`, `place:trash`, cloud drives, mounted volumes, tags), reorder Favorites or sections, pin or remove custom folders, or reset the sidebar to default.",
		"- **File Right-Click Context Menu (`update_context_menu`, `upsert_magic_action`, `delete_magic_action`)**:",
		"  - Show or hide built-in right-click items (`builtin:quickLook`, `builtin:open`, `builtin:openWith`, `builtin:showInEnclosingFolder`, `builtin:toggleIndex`, `builtin:copy`, `builtin:paste`, `builtin:cut`, `builtin:duplicate`, `builtin:rename`, `builtin:copyPath`, `builtin:newFolder`, `builtin:extract`, `builtin:compress`, `builtin:compress7z`, `builtin:share`, `builtin:services`, `builtin:trash`) or whole sections (`open`, `magic`, `index`, `clipboard`, `actions`, `services`, `trash`), and reorder sections.",
		"  - Create, update, or remove custom **Magic Actions** (`upsert_magic_action` / `delete_magic_action`) that appear when right-clicking files or folders! A Magic Action can run ANY shell command/script (`executionKind: 'script'`, receiving selected files via `\"$@\"`, `DAZZI_FILES_JSON`, `DAZZI_FILE`, `DAZZI_FILE_COUNT`) OR run a pi AI agent loop (`executionKind: 'agent'`, `agentMode: 'read'` for analysis/summary or `'organize'` for file creation/editing/conversion/shell actions, with `useSkills` and `useMcp` both enabled `true` by default so the Magic Action shares AutoRAG Agent's Skills and connected MCP servers such as Aside MCP unless the user asks to turn `useSkills: false` or `useMcp: false` off) with conditions (`selection: 'single' | 'multiple' | 'any'`, `targetKind: 'file' | 'folder' | 'any'`, `extensions: ['pdf', ...]`).",
		"- **General App Preferences (`update_general_settings`)**: adjust `appearance` (`light` | `dark`), `language` (`ko` | `en` | `ja` | `zh`), `showHiddenFiles`, `launchAtLogin`, `autoInstallUpdates`.",
		"",
		"## Non-Negotiable Invariants: Locked Core Items & Shortcuts",
		"- Sidebar: `AI Search` (`app:aiSearch`, 'AI 검색') and `Automations` (`app:automations`, '자동화') at the top of Favorites can NEVER be hidden or removed.",
		"- Right-Click Context Menu: `Tags` (`builtin:tags`, '태그', and section `tags`) can NEVER be hidden or removed. Keyboard shortcuts on built-in items cannot be reassigned here.",
		"- If the person asks to hide any locked item (or asks to 'hide everything'), keep the locked items visible, apply the rest of their request, and explain politely which core items always remain shown.",
		"",
		"## Workflow",
		"1. Call `get_app_settings` when you need to inspect the current sidebar, right-click context menu, Magic Actions, or app preferences.",
		"2. Call `update_sidebar`, `update_context_menu`, `upsert_magic_action`, `delete_magic_action`, and/or `update_general_settings` to apply the requested changes immediately.",
		"3. After tool calls finish, summarize clearly in 1-3 short sentences what you changed.",
		intentPromptLine(language),
	].join("\n");
}

export function appCustomizerProfile(input: {
	readonly language: ReplyLanguage;
	readonly toolkit: AppCustomizerToolkit;
}): AgentProfile {
	return {
		id: "app-customizer",
		systemPrompt: systemPrompt(input.language),
		tools: [],
		customTools: withIntentTools(input.toolkit.tools, { language: input.language }),
		thinking: "low",
	};
}
