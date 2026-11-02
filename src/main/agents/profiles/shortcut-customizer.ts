import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentProfile } from "@autorag/librarian/profiles";
import type { AppCustomizerChange } from "../../../shared/app-customizer-contract";
import type { SettingsBridge } from "../../../shared/settings-contract";
import {
	DEFAULT_SHORTCUT_SETTINGS,
	findShortcutConflict,
	formatShortcutChord,
	isLockedShortcutId,
	normalizeShortcutActionId,
	normalizeShortcutSettings,
	parseShortcutChord,
	resolveEffectiveShortcuts,
	SHORTCUT_BY_ID,
	SHORTCUT_CATALOG,
	shortcutScopesOverlap,
	swapShortcutBinding,
	type ShortcutId,
	type ShortcutSettings,
} from "../../../shared/shortcuts-contract";
import { intentPromptLine, withIntentTools, type ReplyLanguage } from "../profile-progress";

export type { ReplyLanguage };

const LANGUAGE_NAME: Readonly<Record<ReplyLanguage, string>> = {
	ko: "Korean",
	en: "English",
	ja: "Japanese",
	zh: "Simplified Chinese",
};

const ACTION_LABELS: Readonly<Record<ReplyLanguage, Readonly<Record<ShortcutId, string>>>> = {
	ko: {
		focusSearch: "검색창 포커스",
		focusComposer: "AI 검색 열기",
		openSettings: "설정 열기",
		newTab: "새 탭",
		reopenTab: "닫은 탭 다시 열기",
		closeTab: "탭 닫기",
		editPath: "경로 직접 입력",
		parentFolder: "상위 폴더로 이동",
		viewIcons: "아이콘 보기",
		viewList: "목록 보기",
		viewColumns: "계층 보기",
		quickLook: "훑어보기 (Quick Look)",
		openItem: "열기",
		newFolder: "새 폴더",
		newFile: "새 텍스트 파일",
		rename: "이름 변경",
		duplicate: "복제",
		copy: "복사",
		cut: "잘라내기",
		paste: "붙여넣기",
		pasteMove: "여기로 항목 이동",
		trash: "휴지통으로 이동",
		undo: "실행 취소",
		redo: "다시 실행",
		aiNewChat: "새 대화 시작",
		aiToggleHistory: "대화 기록 토글",
	},
	en: {
		focusSearch: "Focus Search",
		focusComposer: "Open AI Search",
		openSettings: "Open Settings",
		newTab: "New Tab",
		reopenTab: "Reopen Closed Tab",
		closeTab: "Close Tab",
		editPath: "Edit Path Bar",
		parentFolder: "Enclosing Folder",
		viewIcons: "View as Icons",
		viewList: "View as List",
		viewColumns: "View as Columns",
		quickLook: "Quick Look",
		openItem: "Open Selected Item",
		newFolder: "New Folder",
		newFile: "New Text File",
		rename: "Rename",
		duplicate: "Duplicate",
		copy: "Copy",
		cut: "Cut",
		paste: "Paste",
		pasteMove: "Move Item Here",
		trash: "Move to Trash",
		undo: "Undo",
		redo: "Redo",
		aiNewChat: "New AI Chat",
		aiToggleHistory: "Toggle Chat History",
	},
	ja: {
		focusSearch: "検索欄にフォーカス",
		focusComposer: "AI 検索を開く",
		openSettings: "設定を開く",
		newTab: "新しいタブ",
		reopenTab: "閉じたタブを再度開く",
		closeTab: "タブを閉じる",
		editPath: "パスを直接入力",
		parentFolder: "上のフォルダへ移動",
		viewIcons: "アイコン表示",
		viewList: "リスト表示",
		viewColumns: "カラム表示",
		quickLook: "クイックルック",
		openItem: "開く",
		newFolder: "新規フォルダ",
		newFile: "新規テキストファイル",
		rename: "名前を変更",
		duplicate: "複製",
		copy: "コピー",
		cut: "切り取り",
		paste: "ペースト",
		pasteMove: "ここに項目を移動",
		trash: "ゴミ箱に入れる",
		undo: "元に戻す",
		redo: "やり直す",
		aiNewChat: "新しいチャット",
		aiToggleHistory: "チャット履歴を切替",
	},
	zh: {
		focusSearch: "聚焦搜索框",
		focusComposer: "打开 AI 搜索",
		openSettings: "打开设置",
		newTab: "新建标签页",
		reopenTab: "重新打开关闭的标签页",
		closeTab: "关闭标签页",
		editPath: "编辑路径栏",
		parentFolder: "前往上级文件夹",
		viewIcons: "图标视图",
		viewList: "列表视图",
		viewColumns: "分栏视图",
		quickLook: "快速查看",
		openItem: "打开所选项",
		newFolder: "新建文件夹",
		newFile: "新建文本文件",
		rename: "重命名",
		duplicate: "创建副本",
		copy: "复制",
		cut: "剪切",
		paste: "粘贴",
		pasteMove: "将项目移到此处",
		trash: "移到废纸篓",
		undo: "撤销",
		redo: "重做",
		aiNewChat: "新建 AI 对话",
		aiToggleHistory: "切换对话历史",
	},
};

export interface ShortcutCustomizerToolkitDeps {
	readonly settings: Pick<SettingsBridge, "get" | "set">;
	readonly platform?: string;
	readonly language?: () => ReplyLanguage;
	readonly cancelled?: () => boolean;
}

export interface ShortcutCustomizerToolkit {
	readonly tools: readonly ToolDefinition[];
	takeChanges(): readonly AppCustomizerChange[];
	peekChanges(): readonly AppCustomizerChange[];
}

function textResult(value: unknown): {
	readonly content: [{ readonly type: "text"; readonly text: string }];
	readonly details: undefined;
} {
	const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return { content: [{ type: "text", text }], details: undefined };
}

function summarizeShortcutChange(
	language: ReplyLanguage,
	touchedIds: readonly ShortcutId[],
	resetAll: boolean,
): string {
	if (resetAll) {
		switch (language) {
			case "ko":
				return "모든 단축키를 기본값으로 복원";
			case "ja":
				return "すべてのショートカットを初期設定に復元";
			case "zh":
				return "已将所有快捷键恢复为默认设置";
			default:
				return "Reset all shortcuts to default";
		}
	}
	const labels = ACTION_LABELS[language];
	const names = touchedIds.slice(0, 3).map((id) => labels[id]);
	const suffix = touchedIds.length > 3 ? ` +${touchedIds.length - 3}` : "";
	const joined = `${names.join(", ")}${suffix}`;
	switch (language) {
		case "ko":
			return joined.length > 0 ? `단축키 변경 (${joined})` : "단축키 설정 업데이트";
		case "ja":
			return joined.length > 0 ? `ショートカット変更 (${joined})` : "ショートカット設定を更新";
		case "zh":
			return joined.length > 0 ? `已更改快捷键 (${joined})` : "快捷键设置已更新";
		default:
			return joined.length > 0 ? `Updated shortcuts (${joined})` : "Updated shortcut settings";
	}
}

export function createShortcutCustomizerToolkit(deps: ShortcutCustomizerToolkitDeps): ShortcutCustomizerToolkit {
	const platform = deps.platform ?? process.platform;
	const lang = (): ReplyLanguage => deps.language?.() ?? "ko";
	const isCancelled = (): boolean => deps.cancelled?.() === true;
	const changes: AppCustomizerChange[] = [];

	function ensureLive(): void {
		if (isCancelled()) throw new Error("The shortcut customization request was cancelled.");
	}

	async function buildInspectionSnapshot(): Promise<Record<string, unknown>> {
		const appSettings = await deps.settings.get();
		const shortcuts = normalizeShortcutSettings(appSettings.shortcuts);
		const effective = resolveEffectiveShortcuts(shortcuts);
		const labels = ACTION_LABELS[lang()];

		return {
			platform,
			lockedShortcuts: [
				{
					id: "dismiss",
					label: lang() === "ko" ? "닫기 및 취소" : lang() === "ja" ? "閉じる・キャンセル" : lang() === "zh" ? "关闭与取消" : "Dismiss / Cancel",
					chord: "Escape",
					displayChord: "Esc",
					locked: true,
				},
			],
			shortcuts: SHORTCUT_CATALOG.map((item) => {
				const currentChord = effective[item.id];
				return {
					id: item.id,
					label: labels[item.id],
					group: item.group,
					scope: item.scope,
					defaultChord: item.defaultChord,
					defaultDisplay: formatShortcutChord(item.defaultChord, platform),
					currentChord,
					currentDisplay: formatShortcutChord(currentChord, platform),
					customized: currentChord !== item.defaultChord,
				};
			}),
		};
	}

	const getShortcuts = defineTool({
		name: "get_shortcuts",
		label: "Inspect Keyboard Shortcuts",
		description:
			"Read Dazzi's fixed catalog of 26 customizable keyboard shortcuts, their default chords, current customized chords, execution scopes, and locked system keys (`Esc`).",
		parameters: Type.Object({}),
		execute: async () => {
			ensureLive();
			return textResult(await buildInspectionSnapshot());
		},
	});

	const updateShortcuts = defineTool({
		name: "update_shortcuts",
		label: "Update Keyboard Shortcuts",
		description:
			"Edit or reset keyboard shortcuts within Dazzi's fixed catalog of default-bound actions. Arbitrary new actions cannot be added, and `Esc` (`dismiss`) cannot be changed.",
		parameters: Type.Object({
			bindings: Type.Optional(
				Type.Array(
					Type.Object({
						action: Type.String({
							description:
								"Existing catalog ShortcutId (`rename`, `newFolder`, `focusSearch`, …) or localized action name (`이름 변경`, `새 폴더`, …).",
						}),
						shortcut: Type.String({
							description:
								"Target key chord (`Mod+Shift+P`, `⌘⇧P`, `Ctrl+Y`, `Alt+ArrowUp`, `F2`, `Space`, `Enter`, …).",
						}),
					}),
					{ description: "Shortcut chord updates to apply to existing catalog actions." },
				),
			),
			swapConflicts: Type.Optional(
				Type.Boolean({
					description:
						"When true, if a target chord is currently used by an overlapping action, swap that action onto the edited action's previous chord.",
				}),
			),
			resetActions: Type.Optional(
				Type.Array(Type.String(), {
					description: "Catalog actions to restore to their default shortcuts.",
				}),
			),
			resetAll: Type.Optional(
				Type.Boolean({
					description: "Restore all 26 shortcuts to their default bindings.",
				}),
			),
		}),
		execute: async (_callId, params) => {
			ensureLive();
			const currentSettings = await deps.settings.get();
			let working: ShortcutSettings =
				params.resetAll === true ? DEFAULT_SHORTCUT_SETTINGS : normalizeShortcutSettings(currentSettings.shortcuts);

			const warnings: string[] = [];
			const touchedIds: ShortcutId[] = [];
			const recordTouched = (id: ShortcutId): void => {
				if (!touchedIds.includes(id)) touchedIds.push(id);
			};

			if (params.resetActions !== undefined && params.resetActions.length > 0) {
				const nextOverrides: Partial<Record<ShortcutId, string>> = { ...working.overrides };
				for (const rawAction of params.resetActions) {
					if (isLockedShortcutId(rawAction)) {
						warnings.push(`'${rawAction}' (Esc) is a locked system shortcut and is always Esc.`);
						continue;
					}
					const resolved = normalizeShortcutActionId(rawAction);
					if (resolved === null) {
						warnings.push(
							`'${rawAction}' is not an existing shortcut action in Dazzi's catalog; new actions cannot be added.`,
						);
						continue;
					}
					delete nextOverrides[resolved];
					recordTouched(resolved);
				}
				working = normalizeShortcutSettings({ overrides: nextOverrides });
			}

			if (params.bindings !== undefined && params.bindings.length > 0) {
				// First validate all requested bindings in the batch.
				const validBatch: Array<{ readonly id: ShortcutId; readonly chord: string }> = [];
				for (const entry of params.bindings) {
					if (isLockedShortcutId(entry.action)) {
						warnings.push(`'${entry.action}' (Esc) is a locked system shortcut and cannot be reassigned.`);
						continue;
					}
					const resolvedId = normalizeShortcutActionId(entry.action);
					if (resolvedId === null) {
						warnings.push(
							`'${entry.action}' is not in Dazzi's default shortcut catalog. Arbitrary new actions cannot be added; only existing shortcuts can be edited.`,
						);
						continue;
					}
					const parsed = parseShortcutChord(entry.shortcut);
					if (!parsed.ok) {
						warnings.push(
							`Cannot bind '${entry.shortcut}' to '${resolvedId}': invalid shortcut (${parsed.reason}). Letter/number/symbol keys require Mod (⌘/Ctrl) or Alt (⌥/Alt), and Esc / plain arrows are reserved.`,
						);
						continue;
					}
					validBatch.push({ id: resolvedId, chord: parsed.chord });
				}

				if (params.swapConflicts === true) {
					for (const item of validBatch) {
						const conflictId = findShortcutConflict(item.id, item.chord, working);
						working = swapShortcutBinding(working, item.id, item.chord);
						recordTouched(item.id);
						if (conflictId !== null) recordTouched(conflictId);
					}
				} else {
					// Apply the batch together so simultaneous swaps (`[{rename:"Enter"},{openItem:"Mod+R"}]`) succeed cleanly.
					const batchIds: Partial<Record<ShortcutId, string>> = {};
					for (const item of validBatch) {
						batchIds[item.id] = item.chord;
					}
					const effectiveBefore = resolveEffectiveShortcuts(working);
					const proposedEffective: Record<ShortcutId, string> = { ...effectiveBefore, ...batchIds };

					const nextOverrides: Partial<Record<ShortcutId, string>> = { ...working.overrides };
					for (const item of validBatch) {
						const targetMeta = SHORTCUT_BY_ID[item.id];
						let conflictWith: ShortcutId | null = null;
						for (const other of SHORTCUT_CATALOG) {
							if (other.id === item.id) continue;
							if (!shortcutScopesOverlap(targetMeta.scope, other.scope)) continue;
							if (proposedEffective[other.id] === item.chord) {
								conflictWith = other.id;
								break;
							}
						}
						if (conflictWith !== null) {
							warnings.push(
								`'${formatShortcutChord(item.chord, platform)}' (${item.chord}) is already used by '${conflictWith}' (${ACTION_LABELS[lang()][conflictWith]}). Pass swapConflicts: true or reassign '${conflictWith}' as well to swap them.`,
							);
							proposedEffective[item.id] = effectiveBefore[item.id];
							continue;
						}
						if (item.chord === targetMeta.defaultChord) {
							delete nextOverrides[item.id];
						} else {
							nextOverrides[item.id] = item.chord;
						}
						recordTouched(item.id);
					}
					working = normalizeShortcutSettings({ overrides: nextOverrides });
				}
			}

			ensureLive();
			await deps.settings.set({ shortcuts: working });

			if (params.resetAll === true || touchedIds.length > 0 || warnings.length > 0) {
				const fields =
					params.resetAll === true
						? ["shortcuts.overrides"]
						: touchedIds.length > 0
							? touchedIds.map((id) => `shortcuts.overrides.${id}`)
							: ["shortcuts"];
				changes.push({
					kind: "shortcuts",
					summary: summarizeShortcutChange(lang(), touchedIds, params.resetAll === true && touchedIds.length === 0),
					fields,
					...(warnings.length > 0 ? { warnings } : {}),
				});
			}

			return textResult({
				ok: true,
				warnings,
				shortcuts: working,
				state: await buildInspectionSnapshot(),
			});
		},
	});

	return {
		tools: [getShortcuts, updateShortcuts],
		takeChanges: () => changes.splice(0),
		peekChanges: () => [...changes],
	};
}

function systemPrompt(language: ReplyLanguage, platform: string): string {
	const replyLang = LANGUAGE_NAME[language];
	const modLabel = platform === "darwin" ? "⌘ (Mod)" : "Ctrl (Mod)";
	const altLabel = platform === "darwin" ? "⌥ (Alt)" : "Alt";
	const catalogLines = SHORTCUT_CATALOG.map(
		(item) => `- \`${item.id}\` (${ACTION_LABELS.ko[item.id]} / ${ACTION_LABELS.en[item.id]}): default \`${item.defaultChord}\` [scope: ${item.scope}]`,
	).join("\n");

	return [
		"You are Dazzi's dedicated Keyboard Shortcut Customization Assistant (`shortcut-customizer`), embedded inside Settings → Shortcuts.",
		`Always reply in ${replyLang}, concisely and warmly.`,
		"",
		"## Role & Scope",
		"- You customize Dazzi's keyboard shortcuts stored in `settings-state.json` (separate from the shared AutoRAG config).",
		`- Current host platform modifier display: primary modifier is ${modLabel}, secondary modifier is ${altLabel}, Shift is ⇧/Shift. Canonical chords use \`Mod\`, \`Alt\`, \`Shift\` (e.g. \`Mod+Shift+P\`, \`Alt+ArrowUp\`, \`F2\`, \`Space\`, \`Enter\`).`,
		"",
		"## Fixed Shortcut Catalog (26 Default-Bound Actions)",
		catalogLines,
		"",
		"## Non-Negotiable Invariants",
		"1. **Closed Action Catalog**: You can ONLY edit, swap, or reset shortcuts for the 26 existing actions listed above. You can NEVER create new actions, macros, custom shell commands, or shortcuts for features that do not already have a default shortcut in Dazzi. If the person asks to add a shortcut for an unsupported/new feature, apply any valid requests and politely explain that only existing default-bound shortcuts can be customized.",
		"2. **Locked System Keys**: `Esc` (`dismiss`, 닫기/취소) and unmodified arrow keys (`↑`, `↓`, `←`, `→`) are reserved system keys and can NEVER be reassigned.",
		"3. **Modifier Rule**: Letter, digit, and punctuation keys require `Mod` (`⌘`/`Ctrl`) or `Alt` (`⌥`/`Alt`). `Space`, `Enter`, `Backspace`, `Delete`, and `F1`–`F12` work with or without modifiers.",
		"4. **Conflicts**: If the person asks to bind a chord already used by an overlapping action (or asks to swap two shortcuts), pass `swapConflicts: true` or update both actions in `bindings`.",
		"",
		"## Workflow",
		"1. Call `get_shortcuts` when you need to inspect current customized bindings or check conflicts.",
		"2. Call `update_shortcuts` to apply changes or reset shortcuts immediately.",
		"3. Summarize clearly in 1-3 short sentences what changed (using platform-friendly key labels like `⌘⇧P` or `F2`).",
		"",
		intentPromptLine(language),
	].join("\n");
}

export function shortcutCustomizerProfile(input: {
	readonly language: ReplyLanguage;
	readonly toolkit: ShortcutCustomizerToolkit;
	readonly platform?: string;
}): AgentProfile {
	return {
		id: "shortcut-customizer",
		systemPrompt: systemPrompt(input.language, input.platform ?? process.platform),
		tools: [],
		customTools: withIntentTools(input.toolkit.tools, { language: input.language }),
		thinking: "low",
	};
}
