/**
 * Keyboard shortcut customization contract shared by the main process,
 * the `shortcut-customizer` helper agent profile, the preload bridge,
 * and the renderer.
 *
 * Strictly closed catalog: only actions that already have default shortcuts in
 * Dazzi appear in {@link SHORTCUT_CATALOG}. Arbitrary new actions or macros
 * cannot be added; users customize or reset key chords within this fixed set.
 * `Escape` (`dismiss`) and plain directional arrow navigation remain reserved
 * system bindings so modals, menus, recording cancellation, and list navigation
 * can never be broken.
 */

export type ShortcutGroupId = "window" | "view" | "files" | "aiSearch";

/**
 * Execution scope for conflict detection:
 * - `window`: active across every tab (Finder, Settings, AI Search, Automations).
 * - `finder`: active on Finder folder/search tabs.
 * - `aiSearch`: active on AI Search tabs.
 */
export type ShortcutScope = "window" | "finder" | "aiSearch";

export const LOCKED_SHORTCUT_IDS = ["dismiss"] as const;
export type LockedShortcutId = (typeof LOCKED_SHORTCUT_IDS)[number];

export const SHORTCUT_IDS = [
	// Window & Navigation
	"focusSearch",
	"focusComposer",
	"openSettings",
	"newTab",
	"reopenTab",
	"closeTab",
	"editPath",
	"parentFolder",
	// View Modes
	"viewIcons",
	"viewList",
	"viewColumns",
	"quickLook",
	// File Operations
	"openItem",
	"newFolder",
	"newFile",
	"rename",
	"duplicate",
	"copy",
	"cut",
	"paste",
	"pasteMove",
	"trash",
	"undo",
	"redo",
	// AI Search
	"aiNewChat",
	"aiToggleHistory",
] as const;

export type ShortcutId = (typeof SHORTCUT_IDS)[number];

export interface ShortcutCatalogItem {
	readonly id: ShortcutId;
	readonly group: ShortcutGroupId;
	readonly scope: ShortcutScope;
	readonly defaultChord: string;
	/**
	 * Whether a `Mod+…` chord for this action may fire while focus is inside a
	 * text input. File clipboard/undo chords stay `false` so native text editing
	 * (`⌘C`/`⌘X`/`⌘V`/`⌘Z`) is never swallowed.
	 */
	readonly allowWhileTyping: boolean;
}

export const SHORTCUT_CATALOG: readonly ShortcutCatalogItem[] = [
	// Window & Navigation
	{ id: "focusSearch", group: "window", scope: "window", defaultChord: "Mod+F", allowWhileTyping: true },
	{ id: "focusComposer", group: "window", scope: "window", defaultChord: "Mod+K", allowWhileTyping: true },
	{ id: "openSettings", group: "window", scope: "window", defaultChord: "Mod+,", allowWhileTyping: true },
	{ id: "newTab", group: "window", scope: "window", defaultChord: "Mod+T", allowWhileTyping: true },
	{ id: "reopenTab", group: "window", scope: "window", defaultChord: "Mod+Shift+T", allowWhileTyping: true },
	{ id: "closeTab", group: "window", scope: "window", defaultChord: "Mod+W", allowWhileTyping: true },
	{ id: "editPath", group: "window", scope: "finder", defaultChord: "Mod+L", allowWhileTyping: true },
	{ id: "parentFolder", group: "window", scope: "finder", defaultChord: "Alt+ArrowUp", allowWhileTyping: false },
	// View Modes
	{ id: "viewIcons", group: "view", scope: "window", defaultChord: "Mod+1", allowWhileTyping: true },
	{ id: "viewList", group: "view", scope: "window", defaultChord: "Mod+2", allowWhileTyping: true },
	{ id: "viewColumns", group: "view", scope: "window", defaultChord: "Mod+3", allowWhileTyping: true },
	{ id: "quickLook", group: "view", scope: "finder", defaultChord: "Space", allowWhileTyping: false },
	// File Operations
	{ id: "openItem", group: "files", scope: "finder", defaultChord: "Enter", allowWhileTyping: false },
	{ id: "newFolder", group: "files", scope: "finder", defaultChord: "Mod+Shift+N", allowWhileTyping: false },
	{ id: "newFile", group: "files", scope: "finder", defaultChord: "Mod+Alt+N", allowWhileTyping: false },
	{ id: "rename", group: "files", scope: "finder", defaultChord: "Mod+R", allowWhileTyping: false },
	{ id: "duplicate", group: "files", scope: "finder", defaultChord: "Mod+D", allowWhileTyping: false },
	{ id: "copy", group: "files", scope: "finder", defaultChord: "Mod+C", allowWhileTyping: false },
	{ id: "cut", group: "files", scope: "finder", defaultChord: "Mod+X", allowWhileTyping: false },
	{ id: "paste", group: "files", scope: "finder", defaultChord: "Mod+V", allowWhileTyping: false },
	{ id: "pasteMove", group: "files", scope: "finder", defaultChord: "Mod+Alt+V", allowWhileTyping: false },
	{ id: "trash", group: "files", scope: "finder", defaultChord: "Backspace", allowWhileTyping: false },
	{ id: "undo", group: "files", scope: "finder", defaultChord: "Mod+Z", allowWhileTyping: false },
	{ id: "redo", group: "files", scope: "finder", defaultChord: "Mod+Shift+Z", allowWhileTyping: false },
	// AI Search
	{ id: "aiNewChat", group: "aiSearch", scope: "aiSearch", defaultChord: "Mod+N", allowWhileTyping: true },
	{ id: "aiToggleHistory", group: "aiSearch", scope: "aiSearch", defaultChord: "Mod+Shift+H", allowWhileTyping: true },
] as const;

export const SHORTCUT_BY_ID: Readonly<Record<ShortcutId, ShortcutCatalogItem>> = Object.fromEntries(
	SHORTCUT_CATALOG.map((item) => [item.id, item]),
) as Record<ShortcutId, ShortcutCatalogItem>;

export interface ShortcutSettings {
	/** Non-default canonical chords keyed by {@link ShortcutId}. */
	readonly overrides: Readonly<Partial<Record<ShortcutId, string>>>;
}

export const DEFAULT_SHORTCUT_SETTINGS: ShortcutSettings = {
	overrides: {},
};

/** Optional quick preset familiar to Explorer/cross-platform users (`F2` rename, `Mod+Y` redo). */
export const FAMILIAR_SHORTCUT_OVERRIDES: Readonly<Partial<Record<ShortcutId, string>>> = {
	rename: "F2",
	redo: "Mod+Y",
};

const SHORTCUT_ID_MAP: Readonly<Record<string, true>> = Object.fromEntries(
	SHORTCUT_IDS.map((id) => [id, true]),
);

export function isShortcutId(value: string): value is ShortcutId {
	return SHORTCUT_ID_MAP[value] === true;
}

const LOCKED_ALIAS_MAP: Readonly<Record<string, true>> = {
	dismiss: true,
	escape: true,
	esc: true,
	cancel: true,
	closemodal: true,
	닫기: true,
	취소: true,
	닫기및취소: true,
	閉じる: true,
	キャンセル: true,
	关闭: true,
	取消: true,
};

export function isLockedShortcutId(raw: string): boolean {
	const compact = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
	return LOCKED_ALIAS_MAP[compact] === true;
}

const ACTION_ALIAS_MAP: Readonly<Record<string, ShortcutId>> = {
	// focusSearch
	focussearch: "focusSearch",
	search: "focusSearch",
	find: "focusSearch",
	sidebarsearch: "focusSearch",
	검색: "focusSearch",
	검색창: "focusSearch",
	검색창포커스: "focusSearch",
	파일검색: "focusSearch",
	検索: "focusSearch",
	検索欄: "focusSearch",
	搜索: "focusSearch",
	聚焦搜索: "focusSearch",
	// focusComposer
	focuscomposer: "focusComposer",
	aisearch: "focusComposer",
	openaisearch: "focusComposer",
	askai: "focusComposer",
	ai검색: "focusComposer",
	ai검색열기: "focusComposer",
	ai질문: "focusComposer",
	ai検索: "focusComposer",
	ai搜索: "focusComposer",
	// openSettings
	opensettings: "openSettings",
	settings: "openSettings",
	preferences: "openSettings",
	설정: "openSettings",
	설정열기: "openSettings",
	환경설정: "openSettings",
	設定: "openSettings",
	設定を開く: "openSettings",
	设置: "openSettings",
	打开设置: "openSettings",
	// newTab
	newtab: "newTab",
	opentab: "newTab",
	새탭: "newTab",
	탭추가: "newTab",
	新しいタブ: "newTab",
	新規タブ: "newTab",
	新建标签页: "newTab",
	新标签页: "newTab",
	// reopenTab
	reopentab: "reopenTab",
	reopenclosedtab: "reopenTab",
	restoretab: "reopenTab",
	닫은탭다시열기: "reopenTab",
	탭복구: "reopenTab",
	탭다시열기: "reopenTab",
	閉じたタブを開く: "reopenTab",
	恢复关闭的标签页: "reopenTab",
	重新打开关闭的标签页: "reopenTab",
	// closeTab
	closetab: "closeTab",
	탭닫기: "closeTab",
	현재탭닫기: "closeTab",
	タブを閉じる: "closeTab",
	关闭标签页: "closeTab",
	// editPath
	editpath: "editPath",
	pathbar: "editPath",
	gotofolder: "editPath",
	addressbar: "editPath",
	경로입력: "editPath",
	경로직접입력: "editPath",
	경로편집: "editPath",
	주소창: "editPath",
	パス入力: "editPath",
	パス編集: "editPath",
	编辑路径: "editPath",
	输入路径: "editPath",
	// parentFolder
	parentfolder: "parentFolder",
	enclosingfolder: "parentFolder",
	upfolder: "parentFolder",
	goup: "parentFolder",
	상위폴더: "parentFolder",
	상위폴더로이동: "parentFolder",
	부모폴더: "parentFolder",
	上のフォルダ: "parentFolder",
	親フォルダ: "parentFolder",
	上级文件夹: "parentFolder",
	返回上级: "parentFolder",
	// viewIcons
	viewicons: "viewIcons",
	iconsview: "viewIcons",
	asicons: "viewIcons",
	아이콘보기: "viewIcons",
	아이콘뷰: "viewIcons",
	アイコン表示: "viewIcons",
	图标视图: "viewIcons",
	// viewList
	viewlist: "viewList",
	listview: "viewList",
	aslist: "viewList",
	목록보기: "viewList",
	리스트보기: "viewList",
	리스트뷰: "viewList",
	リスト表示: "viewList",
	列表视图: "viewList",
	// viewColumns
	viewcolumns: "viewColumns",
	columnsview: "viewColumns",
	ascolumns: "viewColumns",
	계층보기: "viewColumns",
	컬럼보기: "viewColumns",
	열보기: "viewColumns",
	カラム表示: "viewColumns",
	分栏视图: "viewColumns",
	// quickLook
	quicklook: "quickLook",
	preview: "quickLook",
	훑어보기: "quickLook",
	미리보기: "quickLook",
	퀵룩: "quickLook",
	クイックルック: "quickLook",
	プレビュー: "quickLook",
	快速查看: "quickLook",
	预览: "quickLook",
	// openItem
	openitem: "openItem",
	open: "openItem",
	열기: "openItem",
	항목열기: "openItem",
	파일열기: "openItem",
	開く: "openItem",
	打开: "openItem",
	// newFolder
	newfolder: "newFolder",
	createfolder: "newFolder",
	mkdir: "newFolder",
	새폴더: "newFolder",
	폴더만들기: "newFolder",
	폴더생성: "newFolder",
	新規フォルダ: "newFolder",
	新しいフォルダ: "newFolder",
	新建文件夹: "newFolder",
	// newFile
	newfile: "newFile",
	newtextfile: "newFile",
	createfile: "newFile",
	새파일: "newFile",
	새텍스트파일: "newFile",
	파일만들기: "newFile",
	新規ファイル: "newFile",
	新しいテキストファイル: "newFile",
	新建文件: "newFile",
	新建文本文件: "newFile",
	// rename
	rename: "rename",
	renamefile: "rename",
	이름변경: "rename",
	이름바꾸기: "rename",
	파일이름변경: "rename",
	名前を変更: "rename",
	リネーム: "rename",
	重命名: "rename",
	// duplicate
	duplicate: "duplicate",
	복제: "duplicate",
	사본만들기: "duplicate",
	파일복제: "duplicate",
	複製: "duplicate",
	创建副本: "duplicate",
	复制副本: "duplicate",
	// copy
	copy: "copy",
	복사: "copy",
	복사하기: "copy",
	コピー: "copy",
	复制: "copy",
	// cut
	cut: "cut",
	잘라내기: "cut",
	오려두기: "cut",
	切り取り: "cut",
	カット: "cut",
	剪切: "cut",
	// paste
	paste: "paste",
	붙여넣기: "paste",
	ペースト: "paste",
	貼り付け: "paste",
	粘贴: "paste",
	// pasteMove
	pastemove: "pasteMove",
	moveitemhere: "pasteMove",
	movehere: "pasteMove",
	여기로항목이동: "pasteMove",
	여기로이동: "pasteMove",
	이동붙여넣기: "pasteMove",
	ここに項目を移動: "pasteMove",
	移动到此处: "pasteMove",
	将项目移到此处: "pasteMove",
	// trash
	trash: "trash",
	movetotrash: "trash",
	delete: "trash",
	휴지통: "trash",
	휴지통으로이동: "trash",
	삭제: "trash",
	파일삭제: "trash",
	ゴミ箱に入れる: "trash",
	削除: "trash",
	移到废纸篓: "trash",
	删除: "trash",
	// undo
	undo: "undo",
	실행취소: "undo",
	되돌리기: "undo",
	元に戻す: "undo",
	撤销: "undo",
	// redo
	redo: "redo",
	다시실행: "redo",
	재실행: "redo",
	やり直す: "redo",
	重做: "redo",
	// aiNewChat
	ainewchat: "aiNewChat",
	newchat: "aiNewChat",
	newaichat: "aiNewChat",
	새대화: "aiNewChat",
	새대화시작: "aiNewChat",
	ai새대화: "aiNewChat",
	新しいチャット: "aiNewChat",
	新規チャット: "aiNewChat",
	新对话: "aiNewChat",
	新建对话: "aiNewChat",
	// aiToggleHistory
	aitogglehistory: "aiToggleHistory",
	chathistory: "aiToggleHistory",
	togglehistory: "aiToggleHistory",
	대화기록: "aiToggleHistory",
	대화기록토글: "aiToggleHistory",
	채팅기록: "aiToggleHistory",
	チャット履歴: "aiToggleHistory",
	履歴切替: "aiToggleHistory",
	对话历史: "aiToggleHistory",
	聊天记录: "aiToggleHistory",
};

/**
 * Resolves a canonical {@link ShortcutId} or natural-language alias in
 * Korean, English, Japanese, or Simplified Chinese. Returns `null` when the
 * input does not match any existing catalog action (enforcing the closed catalog).
 */
export function normalizeShortcutActionId(raw: string): ShortcutId | null {
	const trimmed = raw.trim();
	if (isShortcutId(trimmed)) return trimmed;
	const compact = trimmed.toLowerCase().replace(/[\s_.:/-]+/g, "");
	return ACTION_ALIAS_MAP[compact] ?? null;
}

export function shortcutScopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
	if (a === "window" || b === "window") return true;
	return a === b;
}

export type ShortcutInvalidReason =
	| "empty"
	| "modifier-only"
	| "reserved-escape"
	| "reserved-navigation"
	| "missing-modifier"
	| "unknown-key";

export interface ParsedShortcutParts {
	readonly mod: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly key: string;
}

export type ParsedShortcutResult =
	| { readonly ok: true; readonly chord: string }
	| { readonly ok: false; readonly reason: ShortcutInvalidReason };

/** Selectable canonical keys for UI dropdowns and validation. */
export const SELECTABLE_SHORTCUT_KEYS: readonly string[] = [
	..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
	..."0123456789".split(""),
	"Space",
	"Enter",
	"Backspace",
	"Delete",
	"Tab",
	",",
	".",
	"/",
	"\\",
	"[",
	"]",
	"-",
	"=",
	";",
	"'",
	"`",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	"F1",
	"F2",
	"F3",
	"F4",
	"F5",
	"F6",
	"F7",
	"F8",
	"F9",
	"F10",
	"F11",
	"F12",
] as const;

const VALID_KEY_MAP: Readonly<Record<string, true>> = Object.fromEntries(
	SELECTABLE_SHORTCUT_KEYS.map((key) => [key, true]),
);

const SINGLE_KEY_ALLOWED_WITHOUT_MOD: Readonly<Record<string, true>> = {
	Space: true,
	Enter: true,
	Backspace: true,
	Delete: true,
	F1: true,
	F2: true,
	F3: true,
	F4: true,
	F5: true,
	F6: true,
	F7: true,
	F8: true,
	F9: true,
	F10: true,
	F11: true,
	F12: true,
};

const ARROW_KEYS: Readonly<Record<string, true>> = {
	ArrowUp: true,
	ArrowDown: true,
	ArrowLeft: true,
	ArrowRight: true,
};

const CODE_PUNCTUATION_MAP: Readonly<Record<string, string>> = {
	Comma: ",",
	Period: ".",
	Slash: "/",
	Backslash: "\\",
	BracketLeft: "[",
	BracketRight: "]",
	Minus: "-",
	Equal: "=",
	Semicolon: ";",
	Quote: "'",
	Backquote: "`",
};

const SHIFTED_SYMBOL_TO_BASE: Readonly<Record<string, string>> = {
	"<": ",",
	">": ".",
	"?": "/",
	"|": "\\",
	"{": "[",
	"}": "]",
	_: "-",
	"+": "=",
	":": ";",
	'"': "'",
	"~": "`",
	"!": "1",
	"@": "2",
	"#": "3",
	$: "4",
	"%": "5",
	"^": "6",
	"&": "7",
	"*": "8",
	"(": "9",
	")": "0",
};

const KEY_TOKEN_ALIASES: Readonly<Record<string, string>> = {
	space: "Space",
	spacebar: "Space",
	스페이스: "Space",
	스페이스바: "Space",
	enter: "Enter",
	return: "Enter",
	"↩": "Enter",
	엔터: "Enter",
	리턴: "Enter",
	backspace: "Backspace",
	"⌫": "Backspace",
	백스페이스: "Backspace",
	delete: "Delete",
	del: "Delete",
	"⌦": "Delete",
	딜리트: "Delete",
	tab: "Tab",
	"⇥": "Tab",
	탭: "Tab",
	arrowup: "ArrowUp",
	up: "ArrowUp",
	"↑": "ArrowUp",
	위: "ArrowUp",
	위쪽화살표: "ArrowUp",
	arrowdown: "ArrowDown",
	down: "ArrowDown",
	"↓": "ArrowDown",
	아래: "ArrowDown",
	아래쪽화살표: "ArrowDown",
	arrowleft: "ArrowLeft",
	left: "ArrowLeft",
	"←": "ArrowLeft",
	왼쪽: "ArrowLeft",
	왼쪽화살표: "ArrowLeft",
	arrowright: "ArrowRight",
	right: "ArrowRight",
	"→": "ArrowRight",
	오른쪽: "ArrowRight",
	오른쪽화살표: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pgup: "PageUp",
	pagedown: "PageDown",
	pgdn: "PageDown",
	comma: ",",
	period: ".",
	dot: ".",
	slash: "/",
	backslash: "\\",
	minus: "-",
	plus: "=",
	equal: "=",
	equals: "=",
	semicolon: ";",
	quote: "'",
	backquote: "`",
	backtick: "`",
};

const ESCAPE_TOKENS: Readonly<Record<string, true>> = {
	escape: true,
	esc: true,
	"⎋": true,
	이스케이프: true,
};
const MOD_TOKENS: Readonly<Record<string, true>> = {
	mod: true,
	meta: true,
	cmd: true,
	command: true,
	ctrl: true,
	control: true,
	cmdorctrl: true,
	commandorcontrol: true,
	"⌘": true,
	"⌃": true,
	커맨드: true,
	컨트롤: true,
};
const ALT_TOKENS: Readonly<Record<string, true>> = {
	alt: true,
	opt: true,
	option: true,
	"⌥": true,
	옵션: true,
	알트: true,
};
const SHIFT_TOKENS: Readonly<Record<string, true>> = {
	shift: true,
	"⇧": true,
	시프트: true,
	쉬프트: true,
};

function serializeChordParts(parts: ParsedShortcutParts): string {
	const tokens: string[] = [];
	if (parts.mod) tokens.push("Mod");
	if (parts.alt) tokens.push("Alt");
	if (parts.shift) tokens.push("Shift");
	tokens.push(parts.key);
	return tokens.join("+");
}

function normalizeSingleKeyToken(raw: string): string | "Escape" | null {
	if (raw === " ") return "Space";
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	const lower = trimmed.toLowerCase();
	if (ESCAPE_TOKENS[lower] === true) return "Escape";
	const aliased = KEY_TOKEN_ALIASES[lower];
	if (aliased !== undefined) return aliased;
	if (/^[a-z]$/i.test(trimmed)) return trimmed.toUpperCase();
	if (/^[0-9]$/.test(trimmed)) return trimmed;
	if (/^f([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
	if (VALID_KEY_MAP[trimmed] === true) return trimmed;
	const unshifted = SHIFTED_SYMBOL_TO_BASE[trimmed];
	if (unshifted !== undefined) return unshifted;
	return null;
}

export function validateShortcutParts(parts: {
	readonly mod: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly key: string | "Escape" | null;
}): ParsedShortcutResult {
	if (parts.key === null) {
		return { ok: false, reason: parts.mod || parts.alt || parts.shift ? "modifier-only" : "empty" };
	}
	if (parts.key === "Escape") {
		return { ok: false, reason: "reserved-escape" };
	}
	if (VALID_KEY_MAP[parts.key] !== true) {
		return { ok: false, reason: "unknown-key" };
	}
	if (!parts.mod && !parts.alt) {
		if (ARROW_KEYS[parts.key] === true) {
			return { ok: false, reason: "reserved-navigation" };
		}
		if (SINGLE_KEY_ALLOWED_WITHOUT_MOD[parts.key] !== true) {
			return { ok: false, reason: "missing-modifier" };
		}
	}
	const normalized: ParsedShortcutParts = {
		mod: parts.mod,
		alt: parts.alt,
		shift: parts.shift,
		key: parts.key,
	};
	return {
		ok: true,
		chord: serializeChordParts(normalized),
	};
}

/**
 * Parses a canonical chord (`"Mod+Shift+P"`), macOS glyph string (`"⌘⇧P"`, `"⌥↑"`),
 * or human string (`"Ctrl+Shift+P"`, `"Cmd + Alt + N"`, `"F2"`) into a validated
 * canonical chord (`{ ok: true, chord, parts }`) or structured failure reason.
 */
export function parseShortcutChord(raw: string): ParsedShortcutResult {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: false, reason: "empty" };

	let rest = trimmed;
	let mod = false;
	let alt = false;
	let shift = false;

	// Strip leading glyph modifiers (`⌘`, `⌃`, `⌥`, `⇧`) when written compactly (`⌘⇧P`, `⌥↑`).
	let strippedGlyph = true;
	while (strippedGlyph && rest.length > 0) {
		strippedGlyph = false;
		if (rest.startsWith("⌘") || rest.startsWith("⌃")) {
			mod = true;
			rest = rest.slice(1).trimStart();
			if (rest.startsWith("+")) rest = rest.slice(1).trimStart();
			strippedGlyph = true;
		} else if (rest.startsWith("⌥")) {
			alt = true;
			rest = rest.slice(1).trimStart();
			if (rest.startsWith("+")) rest = rest.slice(1).trimStart();
			strippedGlyph = true;
		} else if (rest.startsWith("⇧")) {
			shift = true;
			rest = rest.slice(1).trimStart();
			if (rest.startsWith("+")) rest = rest.slice(1).trimStart();
			strippedGlyph = true;
		}
	}

	if (rest.length === 0) {
		return { ok: false, reason: "modifier-only" };
	}

	// Tokenize `+` or whitespace-separated words, preserving literal `+` (`Mod+=` or trailing `+`).
	const segments =
		rest === "+"
			? ["="]
			: rest.includes("+")
				? rest
						.split("+")
						.map((s) => s.trim())
						.filter((s) => s.length > 0)
				: rest.split(/\s+/).filter((s) => s.length > 0);

	let key: string | "Escape" | null = null;
	for (const seg of segments) {
		const lower = seg.toLowerCase();
		if (MOD_TOKENS[lower] === true) {
			mod = true;
			continue;
		}
		if (ALT_TOKENS[lower] === true) {
			alt = true;
			continue;
		}
		if (SHIFT_TOKENS[lower] === true) {
			shift = true;
			continue;
		}
		const candidate = normalizeSingleKeyToken(seg);
		if (candidate === null) {
			return { ok: false, reason: "unknown-key" };
		}
		if (key !== null) {
			return { ok: false, reason: "unknown-key" };
		}
		key = candidate;
	}

	return validateShortcutParts({ mod, alt, shift, key });
}

/** Decomposes a canonical chord string (`"Mod+Shift+P"`) into modifier flags + key. */
export function decomposeShortcutChord(chord: string): ParsedShortcutParts | null {
	const parsed = parseShortcutChord(chord);
	if (!parsed.ok) return null;
	const tokens = parsed.chord.split("+");
	const key = tokens[tokens.length - 1] ?? "";
	const mods = tokens.slice(0, -1);
	return {
		mod: mods.includes("Mod"),
		alt: mods.includes("Alt"),
		shift: mods.includes("Shift"),
		key,
	};
}

export interface RecordableKeyEvent {
	readonly key: string;
	readonly code?: string | undefined;
	readonly metaKey?: boolean | undefined;
	readonly ctrlKey?: boolean | undefined;
	readonly altKey?: boolean | undefined;
	readonly shiftKey?: boolean | undefined;
	/** Compatibility fields for `KeyEventLike` in `state/keymap.ts`. */
	readonly meta?: boolean | undefined;
	readonly ctrl?: boolean | undefined;
	readonly alt?: boolean | undefined;
	readonly shift?: boolean | undefined;
}

export type RecordedKeyEventResult =
	| { readonly kind: "cancel" }
	| { readonly kind: "modifier-only"; readonly mod: boolean; readonly alt: boolean; readonly shift: boolean }
	| { readonly kind: "valid"; readonly chord: string }
	| { readonly kind: "invalid"; readonly reason: ShortcutInvalidReason; readonly rawChord: string };

const MODIFIER_EVENT_KEYS: Readonly<Record<string, true>> = {
	Meta: true,
	Control: true,
	Alt: true,
	Shift: true,
	AltGraph: true,
	CapsLock: true,
	Fn: true,
	FnLock: true,
	Hyper: true,
	Super: true,
	OS: true,
};

const MODIFIER_EVENT_CODES: Readonly<Record<string, true>> = {
	MetaLeft: true,
	MetaRight: true,
	ControlLeft: true,
	ControlRight: true,
	AltLeft: true,
	AltRight: true,
	ShiftLeft: true,
	ShiftRight: true,
	CapsLock: true,
};

export function resolveEventKeyName(key: string, code?: string): string | "Escape" | "Modifier" | null {
	if (MODIFIER_EVENT_KEYS[key] === true || (code !== undefined && MODIFIER_EVENT_CODES[code] === true)) {
		return "Modifier";
	}
	if (key === "Escape" || code === "Escape") {
		return "Escape";
	}
	if (code !== undefined && code.length > 0) {
		if (/^Key[A-Z]$/.test(code)) return code.slice(3);
		if (/^Digit[0-9]$/.test(code)) return code.slice(5);
		if (/^F([1-9]|1[0-2])$/.test(code)) return code;
		if (code === "Space") return "Space";
		if (code === "Enter" || code === "NumpadEnter") return "Enter";
		if (code === "Backspace") return "Backspace";
		if (code === "Delete") return "Delete";
		if (code === "Tab") return "Tab";
		if (code === "ArrowUp" || code === "ArrowDown" || code === "ArrowLeft" || code === "ArrowRight") return code;
		if (code === "Home" || code === "End" || code === "PageUp" || code === "PageDown") return code;
		const punct = CODE_PUNCTUATION_MAP[code];
		if (punct !== undefined) return punct;
	}
	return normalizeSingleKeyToken(key);
}

/**
 * Decodes a live DOM/synthetic keyboard event for both the key-press shortcut
 * recorder and `state/keymap.ts` runtime matching. Uses `event.code` first so
 * Korean Hangul IME (`⌘ㅍ` on `KeyP`) and macOS Option dead-keys (`⌥⌘V` → `√`
 * on `KeyV`) resolve to their physical canonical key.
 */
export function chordFromKeyEvent(event: RecordableKeyEvent): RecordedKeyEventResult {
	const mod = (event.metaKey ?? event.meta ?? false) || (event.ctrlKey ?? event.ctrl ?? false);
	const alt = event.altKey ?? event.alt ?? false;
	const shift = event.shiftKey ?? event.shift ?? false;

	const keyName = resolveEventKeyName(event.key, event.code);
	if (keyName === "Modifier") {
		return { kind: "modifier-only", mod, alt, shift };
	}
	if (keyName === "Escape" && !mod && !alt && !shift) {
		return { kind: "cancel" };
	}
	if (keyName === "Escape") {
		return { kind: "invalid", reason: "reserved-escape", rawChord: "Escape" };
	}
	if (keyName === null) {
		return { kind: "invalid", reason: "unknown-key", rawChord: event.key };
	}

	const rawPreview = serializeChordParts({ mod, alt, shift, key: keyName });
	const validated = validateShortcutParts({ mod, alt, shift, key: keyName });
	if (!validated.ok) {
		return { kind: "invalid", reason: validated.reason, rawChord: rawPreview };
	}
	return { kind: "valid", chord: validated.chord };
}

function displayKeyGlyph(key: string, platform: string): string {
	const isMac = platform === "darwin";
	switch (key) {
		case "Space":
			return "Space";
		case "Enter":
			return isMac ? "↩" : "Enter";
		case "Backspace":
			return isMac ? "⌫" : "Backspace";
		case "Delete":
			return isMac ? "⌦" : "Del";
		case "Tab":
			return isMac ? "⇥" : "Tab";
		case "ArrowUp":
			return "↑";
		case "ArrowDown":
			return "↓";
		case "ArrowLeft":
			return "←";
		case "ArrowRight":
			return "→";
		default:
			return key;
	}
}

/** Splits a canonical chord into per-keycap display tokens (`["⌘", "⇧", "P"]` or `["Ctrl", "Shift", "P"]`). */
export function shortcutChordParts(chord: string, platform = "darwin"): readonly string[] {
	const parts = decomposeShortcutChord(chord);
	if (parts === null) return [chord];
	const { mod, alt, shift, key } = parts;
	const isMac = platform === "darwin";
	const out: string[] = [];
	if (mod) out.push(isMac ? "⌘" : "Ctrl");
	if (alt) out.push(isMac ? "⌥" : "Alt");
	if (shift) out.push(isMac ? "⇧" : "Shift");
	out.push(displayKeyGlyph(key, platform));
	return out;
}

/** Formats a canonical chord for tooltips, badges, and buttons (`⌘⇧P` on macOS, `Ctrl+Shift+P` elsewhere). */
export function formatShortcutChord(chord: string, platform = "darwin"): string {
	const parts = shortcutChordParts(chord, platform);
	if (platform === "darwin") {
		return parts.join("");
	}
	return parts.join("+");
}

/** Formats held modifiers during live key recording (`⌘⇧…` or `Ctrl+Shift+…`). */
export function formatHeldModifiers(
	mods: { readonly mod: boolean; readonly alt: boolean; readonly shift: boolean },
	platform = "darwin",
): string {
	const isMac = platform === "darwin";
	const parts: string[] = [];
	if (mods.mod) parts.push(isMac ? "⌘" : "Ctrl");
	if (mods.alt) parts.push(isMac ? "⌥" : "Alt");
	if (mods.shift) parts.push(isMac ? "⇧" : "Shift");
	if (parts.length === 0) return "";
	return isMac ? `${parts.join("")}…` : `${parts.join("+")}+…`;
}

export function resolveEffectiveShortcuts(
	settings: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS,
): Readonly<Record<ShortcutId, string>> {
	const normalized = normalizeShortcutSettings(settings);
	const out = {} as Record<ShortcutId, string>;
	for (const item of SHORTCUT_CATALOG) {
		out[item.id] = normalized.overrides[item.id] ?? item.defaultChord;
	}
	return out;
}

/**
 * Returns the conflicting {@link ShortcutId} if assigning `chord` to `id`
 * collides with another overlapping-scope action in `settings`, or `null`.
 */
export function findShortcutConflict(
	id: ShortcutId,
	chord: string,
	settings: ShortcutSettings = DEFAULT_SHORTCUT_SETTINGS,
): ShortcutId | null {
	const parsed = parseShortcutChord(chord);
	if (!parsed.ok) return null;
	const target = SHORTCUT_BY_ID[id];
	const effective = resolveEffectiveShortcuts(settings);
	for (const item of SHORTCUT_CATALOG) {
		if (item.id === id) continue;
		if (!shortcutScopesOverlap(target.scope, item.scope)) continue;
		if (effective[item.id] === parsed.chord) {
			return item.id;
		}
	}
	return null;
}

/**
 * Assigns `nextChord` to `id`; if an overlapping-scope action currently holds
 * `nextChord`, swaps that action onto `id`'s previous chord so all 26 actions
 * remain uniquely bound.
 */
export function swapShortcutBinding(
	current: ShortcutSettings,
	id: ShortcutId,
	nextChord: string,
): ShortcutSettings {
	const parsed = parseShortcutChord(nextChord);
	if (!parsed.ok) return normalizeShortcutSettings(current);

	const effective = resolveEffectiveShortcuts(current);
	const previousChord = effective[id];
	const conflictId = findShortcutConflict(id, parsed.chord, current);

	const nextOverrides: Partial<Record<ShortcutId, string>> = {
		...normalizeShortcutSettings(current).overrides,
		[id]: parsed.chord,
	};
	if (conflictId !== null) {
		nextOverrides[conflictId] = previousChord;
	}
	return normalizeShortcutSettings({ overrides: nextOverrides });
}

/**
 * Sanitizes persisted or user-supplied shortcut settings:
 * - Drops unknown/non-catalog action IDs and locked system IDs.
 * - Canonicalizes chords (`"⌘⇧r"` → `"Mod+Shift+R"`) and drops invalid chords.
 * - Drops overrides identical to `defaultChord`.
 * - Resolves any scope-overlapping duplicate chords so untouched default
 *   bindings never break silently.
 */
export function normalizeShortcutSettings(raw: unknown): ShortcutSettings {
	if (typeof raw !== "object" || raw === null) return DEFAULT_SHORTCUT_SETTINGS;
	const candidate = raw as { readonly overrides?: unknown };
	if (typeof candidate.overrides !== "object" || candidate.overrides === null || Array.isArray(candidate.overrides)) {
		return DEFAULT_SHORTCUT_SETTINGS;
	}

	const rawOverrides = candidate.overrides as Record<string, unknown>;
	const candidateOverrides = new Map<ShortcutId, string>();

	for (const item of SHORTCUT_CATALOG) {
		const rawChord = rawOverrides[item.id];
		if (typeof rawChord !== "string") continue;
		const parsed = parseShortcutChord(rawChord);
		if (!parsed.ok) continue;
		if (parsed.chord === item.defaultChord) continue;
		candidateOverrides.set(item.id, parsed.chord);
	}

	// Fixed-point conflict elimination across overlapping scopes.
	let changed = true;
	while (changed && candidateOverrides.size > 0) {
		changed = false;
		const effective = new Map<ShortcutId, string>();
		for (const item of SHORTCUT_CATALOG) {
			effective.set(item.id, candidateOverrides.get(item.id) ?? item.defaultChord);
		}

		for (const item of SHORTCUT_CATALOG) {
			if (!candidateOverrides.has(item.id)) continue;
			const chord = effective.get(item.id)!;

			for (const other of SHORTCUT_CATALOG) {
				if (other.id === item.id) continue;
				if (!shortcutScopesOverlap(item.scope, other.scope)) continue;
				if (effective.get(other.id) !== chord) continue;

				// Conflict detected! If `other` is untouched, drop `item`'s override.
				// If both are overridden to the same chord, drop the later catalog entry.
				if (!candidateOverrides.has(other.id)) {
					candidateOverrides.delete(item.id);
					changed = true;
					break;
				}
				candidateOverrides.delete(other.id);
				effective.set(other.id, other.defaultChord);
				changed = true;
			}
			if (changed) break;
		}
	}

	if (candidateOverrides.size === 0) return DEFAULT_SHORTCUT_SETTINGS;
	const overrides: Partial<Record<ShortcutId, string>> = {};
	for (const [id, chord] of candidateOverrides) {
		overrides[id] = chord;
	}
	return { overrides };
}

export function isDefaultShortcutSettings(settings: ShortcutSettings): boolean {
	const normalized = normalizeShortcutSettings(settings);
	return Object.keys(normalized.overrides).length === 0;
}
