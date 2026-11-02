/**
 * File right-click context menu customization & Magic Actions contract,
 * shared by the main process, `settings-state.json`, the `app-customizer` and
 * `magic-action` pi agent profiles, and the renderer (`context-menu.ts`,
 * `ContextMenu.tsx`, `ContextMenuPage.tsx`).
 *
 * Hard invariant:
 * - `Tags` (`builtin:tags`, colour swatches + Tags… submenu) is a locked item /
 *   section and can NEVER be hidden by user settings or AI customization,
 *   regardless of what is written on disk, sent over IPC, or asked of the agent.
 * - Keyboard shortcuts remain visual hints on built-in items and are never
 *   reassigned or overridden here.
 */

export const LOCKED_CONTEXT_MENU_ITEM_IDS = ["builtin:tags"] as const;
export type LockedContextMenuItemId = (typeof LOCKED_CONTEXT_MENU_ITEM_IDS)[number];

export const CONTEXT_MENU_SECTION_IDS = [
	"open",
	"magic",
	"index",
	"clipboard",
	"actions",
	"services",
	"tags",
	"trash",
] as const;
export type ContextMenuSectionId = (typeof CONTEXT_MENU_SECTION_IDS)[number];

export const HIDEABLE_CONTEXT_MENU_SECTION_IDS = [
	"open",
	"magic",
	"index",
	"clipboard",
	"actions",
	"services",
	"trash",
] as const;
export type HideableContextMenuSectionId = (typeof HIDEABLE_CONTEXT_MENU_SECTION_IDS)[number];

export const BUILTIN_CONTEXT_MENU_ITEM_IDS = [
	"builtin:quickLook",
	"builtin:open",
	"builtin:openWith",
	"builtin:showInEnclosingFolder",
	"builtin:toggleIndex",
	"builtin:copy",
	"builtin:paste",
	"builtin:cut",
	"builtin:duplicate",
	"builtin:rename",
	"builtin:copyPath",
	"builtin:newFolder",
	"builtin:extract",
	"builtin:compress",
	"builtin:compress7z",
	"builtin:share",
	"builtin:services",
	"builtin:tags",
	"builtin:trash",
] as const;
export type BuiltinContextMenuItemId = (typeof BUILTIN_CONTEXT_MENU_ITEM_IDS)[number];

/** Preset hidden items for the "핵심만 표시 (미니멀)" quick preset on the context menu. */
export const MINIMAL_HIDDEN_CONTEXT_MENU_IDS = [
	"builtin:cut",
	"builtin:duplicate",
	"builtin:copyPath",
	"builtin:newFolder",
	"builtin:compress7z",
	"builtin:services",
] as const satisfies readonly BuiltinContextMenuItemId[];

export type MagicActionSelectionRule = "any" | "single" | "multiple";
export type MagicActionTargetKind = "any" | "file" | "folder";
export type MagicActionAgentMode = "read" | "organize";

export type MagicActionExecution =
	| {
			readonly kind: "script";
			/** Shell command executed with target files passed via positional `"$@"` args, `DAZZI_FILES_JSON`, `DAZZI_FILE`, and `DAZZI_FILE_COUNT`. */
			readonly command: string;
	  }
	| {
			readonly kind: "agent";
			/** `read`: read-only analysis (`read`, `grep`, `find`, `ls`); `organize`: full file/code tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`). */
			readonly mode: MagicActionAgentMode;
			/** Natural-language instruction for the pi agent loop on the selected target file(s). */
			readonly prompt: string;
			/** Share installed Skills (`<agentDir>/skills` & user skills) with the AutoRAG Agent. Defaults to `true`. */
			readonly useSkills?: boolean;
			/** Share connected MCP servers (`<agentDir>/mcp.json`, e.g. Aside MCP) with the AutoRAG Agent. Defaults to `true`. */
			readonly useMcp?: boolean;
	  };

export interface MagicAction {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly enabled: boolean;
	readonly selection: MagicActionSelectionRule;
	readonly targetKind: MagicActionTargetKind;
	/** Lowercase extensions without leading dots (e.g. `["pdf", "md", "tar.gz"]`). Empty = all extensions. */
	readonly extensions: readonly string[];
	readonly execution: MagicActionExecution;
}

export interface ContextMenuSettings {
	/**
	 * Built-in item IDs hidden from the file context menu (`builtin:copy`, `builtin:compress7z`, etc.).
	 * `builtin:tags` is NEVER stored here.
	 */
	readonly hiddenItems: readonly BuiltinContextMenuItemId[];
	/**
	 * Context menu sections hidden as a whole.
	 * `tags` cannot be hidden.
	 */
	readonly hiddenSections: readonly HideableContextMenuSectionId[];
	/**
	 * Order of sections in the file context menu. Every section in `CONTEXT_MENU_SECTION_IDS` appears once.
	 */
	readonly sectionOrder: readonly ContextMenuSectionId[];
	/**
	 * User-defined custom right-click Magic Actions (script or pi agent loop), in display order.
	 */
	readonly magicActions: readonly MagicAction[];
}

export const DEFAULT_CONTEXT_MENU_SETTINGS: ContextMenuSettings = {
	hiddenItems: [],
	hiddenSections: [],
	sectionOrder: [...CONTEXT_MENU_SECTION_IDS],
	magicActions: [],
};

const LOCKED_SET: ReadonlySet<string> = new Set<string>(LOCKED_CONTEXT_MENU_ITEM_IDS);
const SECTION_SET: ReadonlySet<string> = new Set<string>(CONTEXT_MENU_SECTION_IDS);
const HIDEABLE_SECTION_SET: ReadonlySet<string> = new Set<string>(HIDEABLE_CONTEXT_MENU_SECTION_IDS);
const BUILTIN_ITEM_SET: ReadonlySet<string> = new Set<string>(BUILTIN_CONTEXT_MENU_ITEM_IDS);

const ITEM_ALIAS_MAP: Readonly<Record<string, BuiltinContextMenuItemId>> = {
	"builtin:quicklook": "builtin:quickLook",
	"quicklook": "builtin:quickLook",
	"quick look": "builtin:quickLook",
	"훑어보기": "builtin:quickLook",
	"미리보기": "builtin:quickLook",
	"クイックルック": "builtin:quickLook",
	"快速查看": "builtin:quickLook",
	"builtin:open": "builtin:open",
	"open": "builtin:open",
	"열기": "builtin:open",
	"開く": "builtin:open",
	"打开": "builtin:open",
	"builtin:openwith": "builtin:openWith",
	"openwith": "builtin:openWith",
	"open with": "builtin:openWith",
	"다른 앱으로 열기": "builtin:openWith",
	"このアプリケーションで開く": "builtin:openWith",
	"打开方式": "builtin:openWith",
	"builtin:showinenclosingfolder": "builtin:showInEnclosingFolder",
	"showinenclosingfolder": "builtin:showInEnclosingFolder",
	"show in enclosing folder": "builtin:showInEnclosingFolder",
	"상위 폴더에서 보기": "builtin:showInEnclosingFolder",
	"포함된 폴더에서 보기": "builtin:showInEnclosingFolder",
	"builtin:toggleindex": "builtin:toggleIndex",
	"toggleindex": "builtin:toggleIndex",
	"index": "builtin:toggleIndex",
	"indexing": "builtin:toggleIndex",
	"인덱싱": "builtin:toggleIndex",
	"인덱싱에서 제외": "builtin:toggleIndex",
	"인덱싱에 포함": "builtin:toggleIndex",
	"インデックス": "builtin:toggleIndex",
	"索引": "builtin:toggleIndex",
	"builtin:copy": "builtin:copy",
	"copy": "builtin:copy",
	"복사": "builtin:copy",
	"コピー": "builtin:copy",
	"复制": "builtin:copy",
	"builtin:paste": "builtin:paste",
	"paste": "builtin:paste",
	"붙여넣기": "builtin:paste",
	"ペースト": "builtin:paste",
	"粘贴": "builtin:paste",
	"builtin:cut": "builtin:cut",
	"cut": "builtin:cut",
	"잘라내기": "builtin:cut",
	"カット": "builtin:cut",
	"剪切": "builtin:cut",
	"builtin:duplicate": "builtin:duplicate",
	"duplicate": "builtin:duplicate",
	"복제": "builtin:duplicate",
	"複製": "builtin:duplicate",
	"创建副本": "builtin:duplicate",
	"builtin:rename": "builtin:rename",
	"rename": "builtin:rename",
	"이름 변경": "builtin:rename",
	"이름변경": "builtin:rename",
	"名称変更": "builtin:rename",
	"重命名": "builtin:rename",
	"builtin:copypath": "builtin:copyPath",
	"copypath": "builtin:copyPath",
	"copy path": "builtin:copyPath",
	"경로 복사": "builtin:copyPath",
	"경로복사": "builtin:copyPath",
	"パスをコピー": "builtin:copyPath",
	"复制路径": "builtin:copyPath",
	"builtin:newfolder": "builtin:newFolder",
	"newfolder": "builtin:newFolder",
	"new folder": "builtin:newFolder",
	"새 폴더": "builtin:newFolder",
	"새폴더": "builtin:newFolder",
	"新規フォルダ": "builtin:newFolder",
	"新建文件夹": "builtin:newFolder",
	"builtin:extract": "builtin:extract",
	"extract": "builtin:extract",
	"unzip": "builtin:extract",
	"압축 해제": "builtin:extract",
	"압축해제": "builtin:extract",
	"展開": "builtin:extract",
	"解压缩": "builtin:extract",
	"builtin:compress": "builtin:compress",
	"compress": "builtin:compress",
	"zip": "builtin:compress",
	"압축": "builtin:compress",
	"圧縮": "builtin:compress",
	"压缩": "builtin:compress",
	"builtin:compress7z": "builtin:compress7z",
	"compress7z": "builtin:compress7z",
	"7z": "builtin:compress7z",
	"7z로 압축": "builtin:compress7z",
	"7zで圧縮": "builtin:compress7z",
	"压缩为 7z": "builtin:compress7z",
	"builtin:share": "builtin:share",
	"share": "builtin:share",
	"공유": "builtin:share",
	"共有": "builtin:share",
	"共享": "builtin:share",
	"builtin:services": "builtin:services",
	"services": "builtin:services",
	"service": "builtin:services",
	"서비스": "builtin:services",
	"サービス": "builtin:services",
	"服务": "builtin:services",
	"builtin:tags": "builtin:tags",
	"tags": "builtin:tags",
	"tag": "builtin:tags",
	"태그": "builtin:tags",
	"タグ": "builtin:tags",
	"标签": "builtin:tags",
	"builtin:trash": "builtin:trash",
	"trash": "builtin:trash",
	"delete": "builtin:trash",
	"move to trash": "builtin:trash",
	"휴지통": "builtin:trash",
	"휴지통으로 이동": "builtin:trash",
	"ゴミ箱": "builtin:trash",
	"ゴミ箱に入れる": "builtin:trash",
	"废纸篓": "builtin:trash",
	"移到废纸篓": "builtin:trash",
};

export function normalizeContextMenuItemId(raw: string): BuiltinContextMenuItemId | "" {
	const trimmed = raw.trim();
	if (trimmed === "") return "";
	const alias = ITEM_ALIAS_MAP[trimmed.toLowerCase()];
	if (alias !== undefined) return alias;
	if (BUILTIN_ITEM_SET.has(trimmed)) return trimmed as BuiltinContextMenuItemId;
	return "";
}

export function isLockedContextMenuItemId(raw: string): boolean {
	const normalized = normalizeContextMenuItemId(raw);
	return normalized !== "" && LOCKED_SET.has(normalized);
}

export function isContextMenuSectionId(value: unknown): value is ContextMenuSectionId {
	return typeof value === "string" && SECTION_SET.has(value);
}

export function isHideableContextMenuSectionId(value: unknown): value is HideableContextMenuSectionId {
	return typeof value === "string" && HIDEABLE_SECTION_SET.has(value);
}

function uniqueStrings<T extends string>(values: Iterable<T>): T[] {
	const seen = new Set<T>();
	const out: T[] = [];
	for (const value of values) {
		if (value === "" || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export function slugifyMagicActionId(raw: string): string {
	const cleaned = raw
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9가-힣ぁ-んァ-ヶ一-龥_-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return cleaned.slice(0, 64);
}

export function normalizeExtensionList(raw: unknown): string[] {
	const parts: string[] = [];
	if (typeof raw === "string") {
		parts.push(...raw.split(/[\s,;]+/u));
	} else if (Array.isArray(raw)) {
		for (const item of raw) {
			if (typeof item === "string") parts.push(...item.split(/[\s,;]+/u));
		}
	}
	return uniqueStrings(
		parts
			.map((ext) => ext.trim().toLowerCase().replace(/^\.+/u, ""))
			.filter((ext) => ext.length > 0 && ext.length <= 32 && !ext.includes("/") && !ext.includes("\\")),
	);
}

export function normalizeMagicAction(raw: unknown): MagicAction | null {
	if (typeof raw !== "object" || raw === null) return null;
	const rec = raw as Record<string, unknown>;
	const label = typeof rec.label === "string" ? rec.label.trim().slice(0, 80) : "";
	if (label.length === 0) return null;

	const rawId = typeof rec.id === "string" && rec.id.trim().length > 0 ? rec.id : label;
	const id = slugifyMagicActionId(rawId);
	if (id.length === 0) return null;

	const execRaw = rec.execution;
	if (typeof execRaw !== "object" || execRaw === null) return null;
	const execRec = execRaw as Record<string, unknown>;

	let execution: MagicActionExecution | null = null;
	if (execRec.kind === "script") {
		const command = typeof execRec.command === "string" ? execRec.command.trim() : "";
		if (command.length === 0) return null;
		execution = { kind: "script", command };
	} else if (execRec.kind === "agent") {
		const prompt = typeof execRec.prompt === "string" ? execRec.prompt.trim() : "";
		if (prompt.length === 0) return null;
		const mode: MagicActionAgentMode = execRec.mode === "organize" ? "organize" : "read";
		const useSkills = execRec.useSkills !== false;
		const useMcp = execRec.useMcp !== false;
		execution = { kind: "agent", mode, prompt, useSkills, useMcp };
	}
	if (execution === null) return null;

	const enabled = rec.enabled !== false;
	const selection: MagicActionSelectionRule =
		rec.selection === "single" || rec.selection === "multiple" ? rec.selection : "any";
	const targetKind: MagicActionTargetKind =
		rec.targetKind === "file" || rec.targetKind === "folder" ? rec.targetKind : "any";
	const extensions = targetKind === "folder" ? [] : normalizeExtensionList(rec.extensions);
	const description =
		typeof rec.description === "string" && rec.description.trim().length > 0
			? rec.description.trim().slice(0, 200)
			: undefined;

	return {
		id,
		label,
		...(description === undefined ? {} : { description }),
		enabled,
		selection,
		targetKind,
		extensions,
		execution,
	};
}

export function normalizeContextMenuSettings(raw: unknown): ContextMenuSettings {
	if (typeof raw !== "object" || raw === null) return DEFAULT_CONTEXT_MENU_SETTINGS;
	const candidate = raw as Partial<Record<keyof ContextMenuSettings, unknown>>;

	const hiddenItems = Array.isArray(candidate.hiddenItems)
		? uniqueStrings(
				candidate.hiddenItems
					.filter((item): item is string => typeof item === "string")
					.map(normalizeContextMenuItemId)
					.filter((id): id is BuiltinContextMenuItemId => id !== "" && !LOCKED_SET.has(id)),
			)
		: [];

	const hiddenSections = Array.isArray(candidate.hiddenSections)
		? uniqueStrings(candidate.hiddenSections.filter(isHideableContextMenuSectionId))
		: [];

	const rawSections = Array.isArray(candidate.sectionOrder)
		? uniqueStrings(candidate.sectionOrder.filter(isContextMenuSectionId))
		: [];
	const sectionOrder: ContextMenuSectionId[] = [
		...rawSections,
		...CONTEXT_MENU_SECTION_IDS.filter((section) => !rawSections.includes(section)),
	];

	const magicActions: MagicAction[] = [];
	const seenIds = new Set<string>();
	if (Array.isArray(candidate.magicActions)) {
		for (const entry of candidate.magicActions) {
			const normalized = normalizeMagicAction(entry);
			if (normalized === null || seenIds.has(normalized.id)) continue;
			seenIds.add(normalized.id);
			magicActions.push(normalized);
		}
	}

	return {
		hiddenItems,
		hiddenSections,
		sectionOrder,
		magicActions,
	};
}

export function isDefaultContextMenuSettings(contextMenu: ContextMenuSettings | undefined): boolean {
	if (contextMenu === undefined) return true;
	const norm = normalizeContextMenuSettings(contextMenu);
	return (
		norm.hiddenItems.length === 0 &&
		norm.hiddenSections.length === 0 &&
		norm.magicActions.length === 0 &&
		norm.sectionOrder.every((section, idx) => section === DEFAULT_CONTEXT_MENU_SETTINGS.sectionOrder[idx])
	);
}

export interface MagicActionTargetDescriptor {
	readonly name: string;
	readonly kind: "file" | "folder";
}

function fileMatchesExtensions(fileName: string, extensions: readonly string[]): boolean {
	if (extensions.length === 0) return true;
	const lower = fileName.toLowerCase();
	return extensions.some((ext) => lower.endsWith(`.${ext}`));
}

/**
 * Evaluates whether `action` should appear in the right-click context menu for
 * the currently targeted selection (`targets` must have at least 1 item).
 */
export function matchesMagicAction(
	action: MagicAction,
	targets: readonly MagicActionTargetDescriptor[],
): boolean {
	if (!action.enabled || targets.length === 0) return false;

	if (action.selection === "single" && targets.length !== 1) return false;
	if (action.selection === "multiple" && targets.length < 2) return false;

	if (action.targetKind === "file") {
		if (targets.some((t) => t.kind !== "file")) return false;
	} else if (action.targetKind === "folder") {
		if (targets.some((t) => t.kind !== "folder")) return false;
	}

	if (action.extensions.length > 0) {
		// Extension filters require files matching one of the configured extensions.
		if (targets.some((t) => t.kind !== "file" || !fileMatchesExtensions(t.name, action.extensions))) {
			return false;
		}
	}

	return true;
}
