/**
 * Settings → 일반 toolkit (`createGeneralCustomizerToolkit`), composed by `settings-customizer`.
 *
 * Changes Dazzi's own app preferences (`settings-state.json`) and document read languages
 * (`config.json`) through the same validated `SettingsBridge` calls the page uses.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAppLanguage } from "../../../shared/language-contract";
import { isGlobalChord, normalizeQuickSearchSettings, type QuickSearchSettings } from "../../../shared/quick-search-contract";
import type { AppSettings, AutoRagConfigUpdate } from "../../../shared/settings-contract";
import { DOC_LANGUAGES, isDocLanguage } from "../../../shared/settings-options";
import { parseShortcutChord } from "../../../shared/shortcuts-contract";
import type { ReplyLanguage } from "../profile-progress";
import {
	createCustomizerKit,
	textResult,
	type ConfigCustomizerDeps,
	type CustomizerToolkit,
	type Localized,
} from "./customizer-kit";

export type { ReplyLanguage };

const LANGUAGES_SUMMARY: Localized = {
	ko: "문서 읽기 언어를 변경",
	en: "Updated the document read languages",
	ja: "文書の読み込み言語を変更",
	zh: "已更新文档读取语言",
};

const APP_LANGUAGE_NAMES = ["ko", "en", "ja", "zh"] as const;
const APPEARANCES = ["light", "dark"] as const;

/** Preference field → its name for the change summary, in every interface language. */
const FIELD_LABELS: Readonly<Record<ReplyLanguage, Readonly<Record<string, string>>>> = {
	ko: {
		appearance: "화면 모드",
		language: "앱 언어",
		showHiddenFiles: "숨김 파일",
		launchAtLogin: "로그인 시 실행",
		osMenuIntegration: "우클릭 메뉴 연동",
		autoInstallUpdates: "자동 업데이트",
		errorReporting: "오류 보고",
		usageAnalytics: "사용 통계",
		"quickSearch.enabled": "빠른 검색",
		"quickSearch.chord": "빠른 검색 단축키",
	},
	en: {
		appearance: "Appearance",
		language: "App Language",
		showHiddenFiles: "Hidden Files",
		launchAtLogin: "Launch at Login",
		osMenuIntegration: "Right-Click Menu Integration",
		autoInstallUpdates: "Auto Updates",
		errorReporting: "Error Reporting",
		usageAnalytics: "Usage Analytics",
		"quickSearch.enabled": "Quick Search",
		"quickSearch.chord": "Quick Search Shortcut",
	},
	ja: {
		appearance: "画面モード",
		language: "アプリの言語",
		showHiddenFiles: "隠しファイル",
		launchAtLogin: "ログイン時に起動",
		osMenuIntegration: "右クリックメニュー連携",
		autoInstallUpdates: "自動アップデート",
		errorReporting: "エラー報告",
		usageAnalytics: "利用統計",
		"quickSearch.enabled": "クイック検索",
		"quickSearch.chord": "クイック検索ショートカット",
	},
	zh: {
		appearance: "显示模式",
		language: "应用语言",
		showHiddenFiles: "隐藏文件",
		launchAtLogin: "登录时启动",
		osMenuIntegration: "右键菜单集成",
		autoInstallUpdates: "自动更新",
		errorReporting: "错误报告",
		usageAnalytics: "使用统计",
		"quickSearch.enabled": "快速搜索",
		"quickSearch.chord": "快速搜索快捷键",
	},
};

/** One short sentence per interface language describing an app-preferences change. */
function summarizeChange(fields: readonly string[]): Localized {
	const sentence = (language: ReplyLanguage): string => {
		const labels = FIELD_LABELS[language];
		const names = fields.map((field) => labels[field] ?? field).join(", ");
		switch (language) {
			case "ko":
				return `앱 설정 변경 (${names})`;
			case "ja":
				return `アプリ設定を変更 (${names})`;
			case "zh":
				return `应用设置已更改 (${names})`;
			default:
				return `Updated app settings (${names})`;
		}
	};
	return { ko: sentence("ko"), en: sentence("en"), ja: sentence("ja"), zh: sentence("zh") };
}

const OS_MENU_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "win32"];

/** `Partial<AppSettings>` is read-only; this lets the tool collect fields before one write. */
type MutableSettingsPatch = { -readonly [K in keyof AppSettings]?: AppSettings[K] };

/** The app preferences the general page owns, and the local settings service the page writes through. */
export interface GeneralCustomizerToolkitDeps extends ConfigCustomizerDeps {
	readonly platform?: NodeJS.Platform;
}

function isOsMenuPlatform(platform: NodeJS.Platform): boolean {
	return OS_MENU_PLATFORMS.includes(platform);
}

export function createGeneralCustomizerToolkit(deps: GeneralCustomizerToolkitDeps): CustomizerToolkit {
	const platform = deps.platform ?? process.platform;
	const kit = createCustomizerKit(deps);

	const getGeneralSettings = defineTool({
		name: "get_general_settings",
		label: "Inspect General Settings",
		description:
			"Read Dazzi's current app preferences from Settings → 일반: appearance, interface language, hidden files, launch at login, OS right-click menu integration, automatic updates, error reporting, usage analytics, and the system-wide quick-search shortcut. Also reports which of them this platform cannot change.",
		parameters: Type.Object({}),
		execute: async () => {
			kit.ensureLive();
			const [settings, snapshot] = await Promise.all([deps.settings.get(), deps.settings.configGet()]);
			const quickSearch = normalizeQuickSearchSettings(settings.quickSearch);
			return textResult({
				platform,
				unavailable: isOsMenuPlatform(platform) ? [] : ["osMenuIntegration"],
				current: {
					appearance: settings.appearance,
					language: settings.language,
					showHiddenFiles: settings.showHiddenFiles,
					launchAtLogin: settings.launchAtLogin,
					osMenuIntegration: settings.osMenuIntegration,
					autoInstallUpdates: settings.autoInstallUpdates,
					errorReporting: settings.errorReporting,
					usageAnalytics: settings.usageAnalytics,
					quickSearch: { enabled: quickSearch.enabled, chord: quickSearch.chord },
				},
				allowed: {
					appearance: APPEARANCES,
					language: APP_LANGUAGE_NAMES,
					quickSearchChordExample: "Alt+Space",
				},
				documentLanguages: {
					languages: Array.isArray(snapshot.config.languages) ? snapshot.config.languages.filter((entry): entry is string => typeof entry === "string") : ["ko", "en"],
					configured: snapshot.config.languages !== undefined,
					options: DOC_LANGUAGES.map((language) => language.value),
				},
				notCovered: ["remoteAccess", "remotePort", "remoteTunnelHostname", "approvalMode", "dupeyScanIntervalMinutes", "sidebar", "contextMenu", "shortcuts"],
			});
		},
	});

	const updateGeneralSettings = defineTool({
		name: "update_general_settings",
		label: "Update General Settings",
		description:
			"Change Dazzi's app preferences in Settings → 일반: appearance, interface language, hidden files, launch at login, OS right-click menu integration (macOS/Windows only), automatic updates, error reporting, usage analytics, and the system-wide quick-search shortcut. Only these are in scope; remote access, AI approval mode, duplicate scanning, sidebar/context menu/shortcuts, models, and indexing are never touched.",
		parameters: Type.Object({
			appearance: Type.Optional(Type.Union([Type.Literal("light"), Type.Literal("dark")], { description: "Light or dark screen mode." })),
			language: Type.Optional(
				Type.Union([Type.Literal("ko"), Type.Literal("en"), Type.Literal("ja"), Type.Literal("zh")], {
					description: "Interface language: Korean, English, Japanese, or Simplified Chinese.",
				}),
			),
			showHiddenFiles: Type.Optional(Type.Boolean({ description: "Show dot-prefixed files, rendered dimmed." })),
			launchAtLogin: Type.Optional(Type.Boolean({ description: "Start Dazzi when the user logs in." })),
			osMenuIntegration: Type.Optional(
				Type.Boolean({ description: "Install the OS right-click menu entries (macOS Quick Actions / Windows Explorer verbs). macOS and Windows only." }),
			),
			autoInstallUpdates: Type.Optional(Type.Boolean({ description: "Install app updates automatically." })),
			errorReporting: Type.Optional(Type.Boolean({ description: "Send crash and indexing-failure reports to the maintainers." })),
			usageAnalytics: Type.Optional(Type.Boolean({ description: "Send anonymous product-usage statistics to the maintainers." })),
			quickSearchEnabled: Type.Optional(Type.Boolean({ description: "Register the system-wide quick-search launcher shortcut." })),
			quickSearchChord: Type.Optional(
				Type.String({ description: "New quick-search shortcut (e.g. `Alt+Space`, `Cmd+Shift+K`). It must be a valid chord held with ⌘/Ctrl or ⌥/Alt; a bare key is refused." }),
			),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const current = await deps.settings.get();
			const patch: MutableSettingsPatch = {};
			const fields: string[] = [];
			const warnings: string[] = [];

			if (params.appearance !== undefined) {
				if (!APPEARANCES.includes(params.appearance)) {
					return textResult({ ok: false, error: `Unsupported appearance '${params.appearance}'. Use 'light' or 'dark'.` });
				}
				patch.appearance = params.appearance;
				fields.push("appearance");
			}

			if (params.language !== undefined) {
				if (!isAppLanguage(params.language)) {
					return textResult({ ok: false, error: `Unsupported interface language '${String(params.language)}'. Use 'ko', 'en', 'ja', or 'zh'.` });
				}
				patch.language = params.language;
				fields.push("language");
			}

			if (params.showHiddenFiles !== undefined) {
				patch.showHiddenFiles = params.showHiddenFiles;
				fields.push("showHiddenFiles");
			}
			if (params.launchAtLogin !== undefined) {
				patch.launchAtLogin = params.launchAtLogin;
				fields.push("launchAtLogin");
			}
			if (params.autoInstallUpdates !== undefined) {
				patch.autoInstallUpdates = params.autoInstallUpdates;
				fields.push("autoInstallUpdates");
			}
			if (params.errorReporting !== undefined) {
				patch.errorReporting = params.errorReporting;
				fields.push("errorReporting");
			}
			if (params.usageAnalytics !== undefined) {
				patch.usageAnalytics = params.usageAnalytics;
				fields.push("usageAnalytics");
			}

			if (params.osMenuIntegration !== undefined) {
				if (isOsMenuPlatform(platform)) {
					patch.osMenuIntegration = params.osMenuIntegration;
					fields.push("osMenuIntegration");
				} else {
					warnings.push(
						`The OS right-click menu integration is only available on macOS and Windows; it cannot be changed on ${platform}.`,
					);
				}
			}

			const currentQuickSearch = normalizeQuickSearchSettings(current.quickSearch);
			let nextQuickSearch: QuickSearchSettings | null = null;
			if (params.quickSearchEnabled !== undefined) {
				nextQuickSearch = { ...currentQuickSearch, enabled: params.quickSearchEnabled };
				fields.push("quickSearch.enabled");
			}
			if (params.quickSearchChord !== undefined) {
				const parsed = parseShortcutChord(params.quickSearchChord);
				if (parsed.ok !== true) {
					warnings.push(`'${params.quickSearchChord}' is not a valid shortcut (${parsed.reason}); the previous quick-search shortcut is kept.`);
				} else if (!isGlobalChord(parsed.chord)) {
					warnings.push(
						`'${params.quickSearchChord}' has no ⌘/Ctrl or ⌥/Alt modifier, so it cannot be a system-wide shortcut and would be taken from every other app; the previous quick-search shortcut is kept.`,
					);
				} else {
					nextQuickSearch = { ...(nextQuickSearch ?? currentQuickSearch), chord: parsed.chord };
					fields.push("quickSearch.chord");
				}
			}
			if (nextQuickSearch !== null) patch.quickSearch = nextQuickSearch;

			if (fields.length === 0) {
				return textResult({
					ok: false,
					error: warnings.length > 0 ? warnings.join(" ") : "No settings to change were provided.",
					...(warnings.length > 0 ? { warnings } : {}),
				});
			}

			try {
				await deps.settings.set(patch);
			} catch (error) {
				return textResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}

			kit.record({
				kind: "general",
				summary: summarizeChange(fields),
				fields,
				...(warnings.length > 0 ? { warnings } : {}),
			});
			return textResult({
				ok: true,
				applied: fields,
				settings: {
					appearance: patch.appearance ?? current.appearance,
					language: patch.language ?? current.language,
					showHiddenFiles: patch.showHiddenFiles ?? current.showHiddenFiles,
					launchAtLogin: patch.launchAtLogin ?? current.launchAtLogin,
					osMenuIntegration: patch.osMenuIntegration ?? current.osMenuIntegration,
					autoInstallUpdates: patch.autoInstallUpdates ?? current.autoInstallUpdates,
					errorReporting: patch.errorReporting ?? current.errorReporting,
					usageAnalytics: patch.usageAnalytics ?? current.usageAnalytics,
					quickSearch: nextQuickSearch ?? currentQuickSearch,
				},
				...(warnings.length > 0 ? { warnings } : {}),
			});
		},
	});

	const updateReading = defineTool({
		name: "update_reading",
		label: "Update Document Languages",
		description:
			"Set the document languages the parsers read (`languages`). Values must be from the offered list; unknown values are dropped. An empty list or `reset: true` removes the key so the default applies.",
		parameters: Type.Object({
			languages: Type.Optional(Type.Array(Type.String(), { description: "Offered document language tags (e.g. ko, en, ja, zh-hans)." })),
			reset: Type.Optional(Type.Boolean({ description: "Remove the stored language list and fall back to the default." })),
		}),
		execute: async (_callId, params) => {
			kit.ensureLive();
			const warnings: string[] = [];
			const reset = params.reset === true;
			const requested = params.languages;
			let updates: readonly AutoRagConfigUpdate[];

			if (reset || (requested !== undefined && requested.length === 0)) {
				updates = [{ path: ["languages"], remove: true }];
			} else if (requested !== undefined) {
				const valid: string[] = [];
				for (const raw of requested) {
					const value = typeof raw === "string" ? raw.trim() : "";
					if (!isDocLanguage(value)) {
						warnings.push(`'${String(raw)}' was ignored: it is not one of the offered document languages.`);
						continue;
					}
					if (!valid.includes(value)) valid.push(value);
				}
				if (valid.length === 0) {
					warnings.push("No valid document languages were given, so nothing changed.");
					return textResult({ ok: true, warnings });
				}
				updates = [{ path: ["languages"], value: valid }];
			} else {
				return textResult({ ok: true, warnings });
			}

			kit.ensureLive();
			try {
				await deps.settings.configPatch(updates);
			} catch (error) {
				return textResult({ ok: false, error: error instanceof Error ? error.message : String(error), warnings });
			}
			kit.record({ kind: "general", summary: LANGUAGES_SUMMARY, fields: ["languages"], ...(warnings.length > 0 ? { warnings } : {}) });
			return textResult({ ok: true, warnings, fields: ["languages"] });
		},
	});

	return kit.toolkit([getGeneralSettings, updateGeneralSettings, updateReading]);
}
