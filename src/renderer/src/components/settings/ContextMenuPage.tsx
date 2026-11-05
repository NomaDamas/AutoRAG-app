import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
	Archive,
	ChevronDown,
	ChevronUp,
	Clipboard,
	Copy,
	Eye,
	FilePlus2,
	FolderOpen,
	Lock,
	Pencil,
	Pin,
	RotateCcw,
	Share2,
	Sparkles,
	Tag,
	Terminal,
	Trash2,
	Wand2,
	Wrench,
	X,
	type LucideIcon,
} from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppSettings, SettingsBridge } from "../../../../shared/settings-contract";
import {
	DEFAULT_CONTEXT_MENU_SETTINGS,
	isDefaultContextMenuSettings,
	MINIMAL_HIDDEN_CONTEXT_MENU_IDS,
	normalizeContextMenuSettings,
	normalizeExtensionList,
	normalizeMagicAction,
	type BuiltinContextMenuItemId,
	type ContextMenuSectionId,
	type ContextMenuSettings,
	type HideableContextMenuSectionId,
	type MagicAction,
	type MagicActionAgentMode,
	type MagicActionSelectionRule,
	type MagicActionTargetKind,
} from "../../../../shared/context-menu-contract";
import type { ShortcutId } from "../../../../shared/shortcuts-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { formatContextMenuKeycap } from "../../state/context-menu";
import { Switch } from "../primitives/Switch";
import { ModalActions, ModalShell, Note, Section, SettingsPageHead } from "./SettingsKit";

type ContextMenuBridgeWindow = Window & {
	readonly autorag?: {
		readonly settings?: Pick<SettingsBridge, "set">;
	};
};

function getSettingsWriter(): Pick<SettingsBridge, "set"> | undefined {
	return (window as ContextMenuBridgeWindow).autorag?.settings;
}

const SECTION_ICONS: Readonly<Record<ContextMenuSectionId, LucideIcon>> = {
	open: FolderOpen,
	magic: Wand2,
	index: Sparkles,
	clipboard: Clipboard,
	actions: Archive,
	services: Wrench,
	tags: Tag,
	trash: Trash2,
};

interface BuiltinRowSpec {
	readonly id: BuiltinContextMenuItemId;
	readonly labelKey:
		| "settingsCore.contextMenu.items.quickLook"
		| "settingsCore.contextMenu.items.open"
		| "settingsCore.contextMenu.items.openWith"
		| "settingsCore.contextMenu.items.showInEnclosingFolder"
		| "settingsCore.contextMenu.items.toggleIndex"
		| "settingsCore.contextMenu.items.copy"
		| "settingsCore.contextMenu.items.paste"
		| "settingsCore.contextMenu.items.cut"
		| "settingsCore.contextMenu.items.duplicate"
		| "settingsCore.contextMenu.items.rename"
		| "settingsCore.contextMenu.items.copyPath"
		| "settingsCore.contextMenu.items.newFolder"
		| "settingsCore.contextMenu.items.pinToSidebar"
		| "settingsCore.contextMenu.items.extract"
		| "settingsCore.contextMenu.items.compress"
		| "settingsCore.contextMenu.items.compress7z"
		| "settingsCore.contextMenu.items.share"
		| "settingsCore.contextMenu.items.services"
		| "settingsCore.contextMenu.items.tags"
		| "settingsCore.contextMenu.items.trash";
	readonly icon: LucideIcon;
	readonly shortcutId?: ShortcutId;
	readonly locked?: boolean;
}

const SECTION_ITEMS: Readonly<Record<Exclude<ContextMenuSectionId, "magic">, readonly BuiltinRowSpec[]>> = {
	open: [
		{ id: "builtin:quickLook", labelKey: "settingsCore.contextMenu.items.quickLook", icon: Eye, shortcutId: "quickLook" },
		{ id: "builtin:open", labelKey: "settingsCore.contextMenu.items.open", icon: FolderOpen, shortcutId: "openItem" },
		{ id: "builtin:openWith", labelKey: "settingsCore.contextMenu.items.openWith", icon: FolderOpen },
		{ id: "builtin:showInEnclosingFolder", labelKey: "settingsCore.contextMenu.items.showInEnclosingFolder", icon: FolderOpen },
	],
	index: [
		{ id: "builtin:toggleIndex", labelKey: "settingsCore.contextMenu.items.toggleIndex", icon: Sparkles },
	],
	clipboard: [
		{ id: "builtin:copy", labelKey: "settingsCore.contextMenu.items.copy", icon: Copy, shortcutId: "copy" },
		{ id: "builtin:paste", labelKey: "settingsCore.contextMenu.items.paste", icon: Clipboard, shortcutId: "paste" },
		{ id: "builtin:cut", labelKey: "settingsCore.contextMenu.items.cut", icon: Clipboard, shortcutId: "cut" },
		{ id: "builtin:duplicate", labelKey: "settingsCore.contextMenu.items.duplicate", icon: Copy, shortcutId: "duplicate" },
		{ id: "builtin:rename", labelKey: "settingsCore.contextMenu.items.rename", icon: Pencil, shortcutId: "rename" },
		{ id: "builtin:copyPath", labelKey: "settingsCore.contextMenu.items.copyPath", icon: Copy },
	],
	actions: [
		{ id: "builtin:newFolder", labelKey: "settingsCore.contextMenu.items.newFolder", icon: FilePlus2 },
		{ id: "builtin:pinToSidebar", labelKey: "settingsCore.contextMenu.items.pinToSidebar", icon: Pin },
		{ id: "builtin:extract", labelKey: "settingsCore.contextMenu.items.extract", icon: Archive },
		{ id: "builtin:compress", labelKey: "settingsCore.contextMenu.items.compress", icon: Archive },
		{ id: "builtin:compress7z", labelKey: "settingsCore.contextMenu.items.compress7z", icon: Archive },
		{ id: "builtin:share", labelKey: "settingsCore.contextMenu.items.share", icon: Share2 },
	],
	services: [
		{ id: "builtin:services", labelKey: "settingsCore.contextMenu.items.services", icon: Wrench },
	],
	tags: [
		{ id: "builtin:tags", labelKey: "settingsCore.contextMenu.items.tags", icon: Tag, locked: true },
	],
	trash: [
		{ id: "builtin:trash", labelKey: "settingsCore.contextMenu.items.trash", icon: Trash2, shortcutId: "trash" },
	],
};

function MagicActionEditorModal({
	initial,
	onCancel,
	onSave,
}: {
	readonly initial: MagicAction | null;
	readonly onCancel: () => void;
	readonly onSave: (action: MagicAction) => void;
}): ReactElement {
	const { t } = useTranslation();
	const isWindows = hostPlatform() === "win32";
	const [label, setLabel] = useState(initial?.label ?? "");
	const [description, setDescription] = useState(initial?.description ?? "");
	const [executionKind, setExecutionKind] = useState<"agent" | "script">(initial?.execution.kind ?? "agent");
	const [agentMode, setAgentMode] = useState<MagicActionAgentMode>(
		initial?.execution.kind === "agent" ? initial.execution.mode : "read",
	);
	const [prompt, setPrompt] = useState(initial?.execution.kind === "agent" ? initial.execution.prompt : "");
	const [useSkills, setUseSkills] = useState<boolean>(
		initial?.execution.kind === "agent" ? initial.execution.useSkills !== false : true,
	);
	const [useMcp, setUseMcp] = useState<boolean>(
		initial?.execution.kind === "agent" ? initial.execution.useMcp !== false : true,
	);
	const [command, setCommand] = useState(initial?.execution.kind === "script" ? initial.execution.command : "");
	const [selection, setSelection] = useState<MagicActionSelectionRule>(initial?.selection ?? "any");
	const [targetKind, setTargetKind] = useState<MagicActionTargetKind>(initial?.targetKind ?? "file");
	const [extensionsInput, setExtensionsInput] = useState(initial?.extensions.join(", ") ?? "");

	const canSave =
		label.trim().length > 0 &&
		(executionKind === "agent" ? prompt.trim().length > 0 : command.trim().length > 0);

	const submit = (): void => {
		if (!canSave) return;
		const normalized = normalizeMagicAction({
			...(initial?.id === undefined ? {} : { id: initial.id }),
			label,
			description,
			enabled: initial?.enabled ?? true,
			selection,
			targetKind,
			extensions: normalizeExtensionList(extensionsInput),
			execution:
				executionKind === "script"
					? { kind: "script", command }
					: { kind: "agent", mode: agentMode, prompt, useSkills, useMcp },
		});
		if (normalized !== null) onSave(normalized);
	};

	return (
		<ModalShell onClose={onCancel}>
			<div data-testid="magic-action-editor-modal">
				<h2>{initial === null ? t("settingsCore.contextMenu.editor.createTitle") : t("settingsCore.contextMenu.editor.editTitle")}</h2>
				<p>{t("settingsCore.contextMenu.editor.desc")}</p>

				<label>
					{t("settingsCore.contextMenu.editor.labelField")}
					<input
						autoFocus
						data-testid="magic-editor-label"
						value={label}
						placeholder={t("settingsCore.contextMenu.editor.labelPlaceholder")}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</label>

				<label>
					{t("settingsCore.contextMenu.editor.descriptionField")}
					<input
						data-testid="magic-editor-description"
						value={description}
						placeholder={t("settingsCore.contextMenu.editor.descriptionPlaceholder")}
						onChange={(e) => setDescription(e.target.value)}
					/>
				</label>

				<label>
					{t("settingsCore.contextMenu.editor.executionField")}
					<select
						data-testid="magic-editor-kind"
						value={executionKind}
						onChange={(e) => setExecutionKind(e.target.value === "script" ? "script" : "agent")}
					>
						<option value="agent">{t("settingsCore.contextMenu.editor.kindAgent")}</option>
						<option value="script">{t("settingsCore.contextMenu.editor.kindScript")}</option>
					</select>
				</label>

				{executionKind === "agent" ? (
					<>
						<label>
							{t("settingsCore.contextMenu.editor.agentModeField")}
							<select
								data-testid="magic-editor-agent-mode"
								value={agentMode}
								onChange={(e) => setAgentMode(e.target.value === "organize" ? "organize" : "read")}
							>
								<option value="read">{t("settingsCore.contextMenu.editor.modeRead")}</option>
								<option value="organize">{t("settingsCore.contextMenu.editor.modeOrganize")}</option>
							</select>
						</label>
						<label>
							{t("settingsCore.contextMenu.editor.promptField")}
							<textarea
								data-testid="magic-editor-prompt"
								value={prompt}
								placeholder={t("settingsCore.contextMenu.editor.promptPlaceholder")}
								onChange={(e) => setPrompt(e.target.value)}
							/>
						</label>
						<div className="mt-14 flex flex-col gap-10 rounded-8 border border-border bg-chrome p-12">
							<div className="flex items-center justify-between gap-12">
								<div className="flex min-w-0 flex-col gap-2">
									<span className="text-[12.5px] font-medium text-ink">{t("settingsCore.contextMenu.editor.useSkillsField")}</span>
									<span className="text-badge text-ink-muted">{t("settingsCore.contextMenu.editor.useSkillsHint")}</span>
								</div>
								<Switch
									checked={useSkills}
									dataSwitchId="magic-editor:useSkills"
									ariaLabel={t("settingsCore.contextMenu.editor.useSkillsField")}
									onChange={() => setUseSkills((prev) => !prev)}
								/>
							</div>
							<div className="flex items-center justify-between gap-12 border-t border-divider pt-10">
								<div className="flex min-w-0 flex-col gap-2">
									<span className="text-[12.5px] font-medium text-ink">{t("settingsCore.contextMenu.editor.useMcpField")}</span>
									<span className="text-badge text-ink-muted">{t("settingsCore.contextMenu.editor.useMcpHint")}</span>
								</div>
								<Switch
									checked={useMcp}
									dataSwitchId="magic-editor:useMcp"
									ariaLabel={t("settingsCore.contextMenu.editor.useMcpField")}
									onChange={() => setUseMcp((prev) => !prev)}
								/>
							</div>
						</div>
					</>
				) : (
					<>
						<label>
							{t("settingsCore.contextMenu.editor.commandField")}
							<textarea
								data-testid="magic-editor-command"
								className="font-mono"
								value={command}
								placeholder={t(
									isWindows
										? "settingsCore.contextMenu.editor.commandPlaceholderWindows"
										: "settingsCore.contextMenu.editor.commandPlaceholder",
								)}
								onChange={(e) => setCommand(e.target.value)}
							/>
						</label>
						<Note>
							{t(
								isWindows
									? "settingsCore.contextMenu.editor.commandHintWindows"
									: "settingsCore.contextMenu.editor.commandHint",
							)}
						</Note>
					</>
				)}

				<label>
					{t("settingsCore.contextMenu.editor.selectionField")}
					<select
						data-testid="magic-editor-selection"
						value={selection}
						onChange={(e) =>
							setSelection(e.target.value === "single" || e.target.value === "multiple" ? e.target.value : "any")
						}
					>
						<option value="any">{t("settingsCore.contextMenu.condAnySelection")}</option>
						<option value="single">{t("settingsCore.contextMenu.condSingle")}</option>
						<option value="multiple">{t("settingsCore.contextMenu.condMultiple")}</option>
					</select>
				</label>

				<label>
					{t("settingsCore.contextMenu.editor.targetKindField")}
					<select
						data-testid="magic-editor-target-kind"
						value={targetKind}
						onChange={(e) =>
							setTargetKind(e.target.value === "file" || e.target.value === "folder" ? e.target.value : "any")
						}
					>
						<option value="file">{t("settingsCore.contextMenu.condFileOnly")}</option>
						<option value="folder">{t("settingsCore.contextMenu.condFolderOnly")}</option>
						<option value="any">{t("settingsCore.contextMenu.condAnyKind")}</option>
					</select>
				</label>

				{targetKind !== "folder" ? (
					<label>
						{t("settingsCore.contextMenu.editor.extensionsField")}
						<input
							data-testid="magic-editor-extensions"
							value={extensionsInput}
							placeholder={t("settingsCore.contextMenu.editor.extensionsPlaceholder")}
							onChange={(e) => setExtensionsInput(e.target.value)}
						/>
					</label>
				) : null}

				<ModalActions>
					<button type="button" className="linear-btn" data-action="cancel-magic-editor" onClick={onCancel}>
						{t("common.cancel")}
					</button>
					<button
						type="button"
						className="linear-btn settings-btn-primary"
						data-action="save-magic-editor"
						disabled={!canSave}
						onClick={submit}
					>
						{t("settingsCore.contextMenu.editor.save")}
					</button>
				</ModalActions>
			</div>
		</ModalShell>
	);
}

export function ContextMenuPage({
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
	const platform = hostPlatform();
	const [editorState, setEditorState] = useState<{ readonly open: boolean; readonly initial: MagicAction | null }>({
		open: false,
		initial: null,
	});

	const contextMenu = useMemo(() => normalizeContextMenuSettings(appSettings.contextMenu), [appSettings.contextMenu]);
	const hiddenItems = useMemo(() => new Set<string>(contextMenu.hiddenItems), [contextMenu.hiddenItems]);
	const hiddenSections = useMemo(() => new Set<string>(contextMenu.hiddenSections), [contextMenu.hiddenSections]);

	const updateContextMenu = useCallback(
		async (next: ContextMenuSettings): Promise<void> => {
			const normalized = normalizeContextMenuSettings(next);
			try {
				const writer = getSettingsWriter();
				if (writer === undefined) return;
				const updated = await writer.set({ contextMenu: normalized });
				onAppSettingsChanged(updated);
			} catch (cause) {
				onSettingsError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		[onAppSettingsChanged, onSettingsError],
	);

	const toggleBuiltinItem = (id: BuiltinContextMenuItemId): void => {
		if (id === "builtin:tags") return;
		const nextHidden = new Set<BuiltinContextMenuItemId>(contextMenu.hiddenItems);
		if (nextHidden.has(id)) nextHidden.delete(id);
		else nextHidden.add(id);
		void updateContextMenu({ ...contextMenu, hiddenItems: [...nextHidden] });
	};

	const toggleSection = (sectionId: HideableContextMenuSectionId): void => {
		const next = new Set<HideableContextMenuSectionId>(contextMenu.hiddenSections);
		if (next.has(sectionId)) next.delete(sectionId);
		else next.add(sectionId);
		void updateContextMenu({ ...contextMenu, hiddenSections: [...next] });
	};

	const moveSection = (index: number, delta: -1 | 1): void => {
		const targetIndex = index + delta;
		if (targetIndex < 0 || targetIndex >= contextMenu.sectionOrder.length) return;
		const order = [...contextMenu.sectionOrder];
		const [moved] = order.splice(index, 1);
		if (moved === undefined) return;
		order.splice(targetIndex, 0, moved);
		void updateContextMenu({ ...contextMenu, sectionOrder: order });
	};

	const moveMagicAction = (index: number, delta: -1 | 1): void => {
		const targetIndex = index + delta;
		if (targetIndex < 0 || targetIndex >= contextMenu.magicActions.length) return;
		const actions = [...contextMenu.magicActions];
		const [moved] = actions.splice(index, 1);
		if (moved === undefined) return;
		actions.splice(targetIndex, 0, moved);
		void updateContextMenu({ ...contextMenu, magicActions: actions });
	};

	const toggleMagicActionEnabled = (id: string): void => {
		const next = contextMenu.magicActions.map((item) =>
			item.id === id ? { ...item, enabled: !item.enabled } : item,
		);
		void updateContextMenu({ ...contextMenu, magicActions: next });
	};

	const removeMagicAction = (id: string): void => {
		void updateContextMenu({
			...contextMenu,
			magicActions: contextMenu.magicActions.filter((item) => item.id !== id),
		});
	};

	const saveMagicAction = (saved: MagicAction): void => {
		const existingIdx = contextMenu.magicActions.findIndex((item) => item.id === saved.id);
		const next = [...contextMenu.magicActions];
		if (existingIdx >= 0) next[existingIdx] = saved;
		else next.push(saved);
		setEditorState({ open: false, initial: null });
		void updateContextMenu({
			...contextMenu,
			hiddenSections: contextMenu.hiddenSections.filter((s) => s !== "magic"),
			magicActions: next,
		});
	};

	const sectionLabel = (sectionId: ContextMenuSectionId): string => {
		switch (sectionId) {
			case "open":
				return t("settingsCore.contextMenu.sections.open");
			case "magic":
				return t("settingsCore.contextMenu.sections.magic");
			case "index":
				return t("settingsCore.contextMenu.sections.index");
			case "clipboard":
				return t("settingsCore.contextMenu.sections.clipboard");
			case "actions":
				return t("settingsCore.contextMenu.sections.actions");
			case "services":
				return t("settingsCore.contextMenu.sections.services");
			case "tags":
				return t("settingsCore.contextMenu.sections.tags");
			case "trash":
				return t("settingsCore.contextMenu.sections.trash");
		}
	};

	const sectionCounts = (sectionId: ContextMenuSectionId): { readonly visible: number; readonly total: number } | null => {
		if (sectionId === "magic") {
			if (contextMenu.magicActions.length === 0) return null;
			return {
				visible: contextMenu.magicActions.filter((a) => a.enabled).length,
				total: contextMenu.magicActions.length,
			};
		}
		const specs = SECTION_ITEMS[sectionId];
		return {
			visible: specs.filter((row) => row.locked === true || !hiddenItems.has(row.id)).length,
			total: specs.length,
		};
	};

	const describeConditions = (action: MagicAction): string => {
		const sel =
			action.selection === "single"
				? t("settingsCore.contextMenu.condSingle")
				: action.selection === "multiple"
					? t("settingsCore.contextMenu.condMultiple")
					: t("settingsCore.contextMenu.condAnySelection");
		const kind =
			action.targetKind === "file"
				? t("settingsCore.contextMenu.condFileOnly")
				: action.targetKind === "folder"
					? t("settingsCore.contextMenu.condFolderOnly")
					: t("settingsCore.contextMenu.condAnyKind");
		const ext =
			action.targetKind === "folder"
				? null
				: action.extensions.length > 0
					? action.extensions.map((e) => `.${e}`).join(", ")
					: t("settingsCore.contextMenu.condAllExtensions");
		const extras: string[] = [];
		if (action.execution.kind === "agent") {
			if (action.execution.useSkills !== false) extras.push(t("settingsCore.contextMenu.condSkills"));
			if (action.execution.useMcp !== false) extras.push(t("settingsCore.contextMenu.condMcp"));
		}
		return [sel, kind, ext, ...extras].filter((part): part is string => part !== null).join(" · ");
	};

	const renderMagicActionRow = (action: MagicAction, index: number, prefix: string): ReactElement => {
		const isScript = action.execution.kind === "script";
		const RowIcon = isScript ? Terminal : Sparkles;
		const badgeLabel = isScript
			? t("settingsCore.contextMenu.badgeScript")
			: action.execution.mode === "organize"
				? t("settingsCore.contextMenu.badgeAgentOrganize")
				: t("settingsCore.contextMenu.badgeAgentRead");
		const summary = describeConditions(action);

		return (
			<div
				key={action.id}
				className={`sidebar-custom-row${action.enabled ? "" : " is-muted"}`}
				data-magic-row={action.id}
			>
				<div className="sidebar-custom-row__order">
					<button
						type="button"
						className="sidebar-order-btn"
						data-action={`${prefix}-move-up-${action.id}`}
						disabled={index === 0}
						title={t("settingsCore.contextMenu.moveUp", { name: action.label })}
						aria-label={t("settingsCore.contextMenu.moveUp", { name: action.label })}
						onClick={() => moveMagicAction(index, -1)}
					>
						<ChevronUp size={12} />
					</button>
					<button
						type="button"
						className="sidebar-order-btn"
						data-action={`${prefix}-move-down-${action.id}`}
						disabled={index === contextMenu.magicActions.length - 1}
						title={t("settingsCore.contextMenu.moveDown", { name: action.label })}
						aria-label={t("settingsCore.contextMenu.moveDown", { name: action.label })}
						onClick={() => moveMagicAction(index, 1)}
					>
						<ChevronDown size={12} />
					</button>
				</div>
				<span className="sidebar-custom-row__icon is-accent" aria-hidden="true">
					<RowIcon size={15} />
				</span>
				<div className="sidebar-custom-row__main">
					<span className="sidebar-custom-row__name">{action.label}</span>
					<span className="sidebar-custom-badge">{badgeLabel}</span>
					<span className="sidebar-custom-row__path" title={summary}>
						{summary}
					</span>
				</div>
				<div className="sidebar-custom-row__controls">
					<button
						type="button"
						className="sidebar-order-btn"
						data-action={`edit-magic-${action.id}`}
						title={t("settingsCore.contextMenu.editMagicAction", { name: action.label })}
						aria-label={t("settingsCore.contextMenu.editMagicAction", { name: action.label })}
						onClick={() => setEditorState({ open: true, initial: action })}
					>
						<Pencil size={12} />
					</button>
					<button
						type="button"
						className="sidebar-remove-btn"
						data-action={`remove-magic-${action.id}`}
						title={t("settingsCore.contextMenu.removeMagicAction", { name: action.label })}
						aria-label={t("settingsCore.contextMenu.removeMagicAction", { name: action.label })}
						onClick={() => removeMagicAction(action.id)}
					>
						<X size={13} />
					</button>
					<Switch
						checked={action.enabled}
						dataSwitchId={`magic:${action.id}`}
						ariaLabel={action.label}
						onChange={() => toggleMagicActionEnabled(action.id)}
					/>
				</div>
			</div>
		);
	};

	const isDefault = isDefaultContextMenuSettings(contextMenu);
	const isMinimalActive =
		MINIMAL_HIDDEN_CONTEXT_MENU_IDS.every((id) => hiddenItems.has(id)) &&
		contextMenu.hiddenItems.length === MINIMAL_HIDDEN_CONTEXT_MENU_IDS.length;
	const isShowAllActive = contextMenu.hiddenItems.length === 0 && contextMenu.hiddenSections.length === 0;

	return (
		<>
			<SettingsPageHead
				title={t("settingsCore.nav.contextMenu")}
				description={t("settingsCore.contextMenu.description")}
			/>

			{customizerOpen ? null : (
				<div className="sidebar-ai-hero">
					<div className="sidebar-ai-hero__body">
						<span className="sidebar-ai-hero__logo-wrap" aria-hidden="true">
							<img src={dazziMark} alt="" className="sidebar-ai-hero__logo" draggable={false} />
						</span>
						<div className="sidebar-ai-hero__copy">
							<div className="sidebar-ai-hero__title">{t("settingsCore.contextMenu.aiHeroTitle")}</div>
							<p className="sidebar-ai-hero__desc">{t("settingsCore.contextMenu.aiHeroDesc")}</p>
						</div>
					</div>
					<button
						type="button"
						className="linear-btn settings-btn-primary sidebar-ai-hero__btn"
						data-action="open-context-menu-customizer"
						onClick={onOpenCustomizer}
					>
						<img src={dazziMark} alt="" className="sidebar-ai-hero__btn-logo" aria-hidden="true" draggable={false} />
						<span>{t("settingsCore.contextMenu.aiHeroButton")}</span>
					</button>
				</div>
			)}

			<div className="sidebar-presets-bar" role="group" aria-label={t("settingsCore.contextMenu.presetsTitle")}>
				<span className="sidebar-presets-bar__label">{t("settingsCore.contextMenu.presetsTitle")}</span>
				<div className="sidebar-presets-bar__actions">
					<button
						type="button"
						className={`sidebar-preset-pill${isShowAllActive ? " is-active" : ""}`}
						data-action="context-menu-preset-all"
						onClick={() => void updateContextMenu({ ...contextMenu, hiddenItems: [], hiddenSections: [] })}
					>
						{t("settingsCore.contextMenu.presetShowAll")}
					</button>
					<button
						type="button"
						className={`sidebar-preset-pill${isMinimalActive ? " is-active" : ""}`}
						data-action="context-menu-preset-minimal"
						onClick={() =>
							void updateContextMenu({ ...contextMenu, hiddenItems: [...MINIMAL_HIDDEN_CONTEXT_MENU_IDS] })
						}
					>
						{t("settingsCore.contextMenu.presetMinimal")}
					</button>
					<button
						type="button"
						className="sidebar-preset-pill is-reset"
						data-action="context-menu-reset-default"
						disabled={isDefault}
						onClick={() => void updateContextMenu(DEFAULT_CONTEXT_MENU_SETTINGS)}
					>
						<RotateCcw size={11} aria-hidden="true" />
						<span>{t("settingsCore.contextMenu.resetDefault")}</span>
					</button>
				</div>
			</div>

			<Section title={t("settingsCore.contextMenu.magicTitle")} description={t("settingsCore.contextMenu.magicDesc")}>
				<div className="sidebar-section-card" data-context-menu-magic-card="true">
					<div className="sidebar-section-card__items" style={{ borderTop: 0 }}>
						{contextMenu.magicActions.length === 0 ? (
							<p className="sidebar-section-card__empty">{t("settingsCore.contextMenu.magicEmpty")}</p>
						) : (
							contextMenu.magicActions.map((action, index) => renderMagicActionRow(action, index, "magic"))
						)}
						<div className="sidebar-section-card__foot">
							<button
								type="button"
								className="linear-btn"
								data-action="add-magic-action"
								onClick={() => setEditorState({ open: true, initial: null })}
							>
								{t("settingsCore.contextMenu.addMagicAction")}
							</button>
						</div>
					</div>
				</div>
			</Section>

			<Section
				title={t("settingsCore.contextMenu.sectionsTitle")}
				description={t("settingsCore.contextMenu.sectionsDesc")}
			>
				<div className="sidebar-sections-stack">
					{contextMenu.sectionOrder.map((sectionId, idx) => {
						const isTags = sectionId === "tags";
						const sectionVisible = isTags ? true : !hiddenSections.has(sectionId);
						const label = sectionLabel(sectionId);
						const SectionIcon = SECTION_ICONS[sectionId];
						const counts = sectionCounts(sectionId);

						return (
							<div
								key={sectionId}
								className={`sidebar-section-card${sectionVisible ? "" : " is-collapsed"}`}
								data-context-menu-section={sectionId}
							>
								<div className="sidebar-section-card__head">
									<div className="sidebar-custom-row__order">
										<button
											type="button"
											className="sidebar-order-btn"
											data-action={`move-cmenu-section-up-${sectionId}`}
											disabled={idx === 0}
											title={t("settingsCore.contextMenu.moveUp", { name: label })}
											aria-label={t("settingsCore.contextMenu.moveUp", { name: label })}
											onClick={() => moveSection(idx, -1)}
										>
											<ChevronUp size={12} />
										</button>
										<button
											type="button"
											className="sidebar-order-btn"
											data-action={`move-cmenu-section-down-${sectionId}`}
											disabled={idx === contextMenu.sectionOrder.length - 1}
											title={t("settingsCore.contextMenu.moveDown", { name: label })}
											aria-label={t("settingsCore.contextMenu.moveDown", { name: label })}
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
										{isTags ? (
											<span
												className="sidebar-custom-badge is-locked"
												title={t("settingsCore.contextMenu.sectionAlwaysShown")}
											>
												{t("settingsCore.contextMenu.lockedBadge")}
											</span>
										) : null}
										{counts !== null && sectionVisible ? (
											<span className="sidebar-section-card__count">
												{t("settingsCore.contextMenu.sectionCount", counts)}
											</span>
										) : null}
									</div>
									<Switch
										checked={sectionVisible}
										disabled={isTags}
										dataSwitchId={`cmenu-section:${sectionId}`}
										ariaLabel={label}
										onChange={() => {
											if (!isTags) toggleSection(sectionId);
										}}
									/>
								</div>

								{sectionVisible ? (
									<div className="sidebar-section-card__items">
										{sectionId === "magic" ? (
											contextMenu.magicActions.length === 0 ? (
												<p className="sidebar-section-card__empty">{t("settingsCore.contextMenu.magicEmpty")}</p>
											) : (
												contextMenu.magicActions.map((action, aIdx) =>
													renderMagicActionRow(action, aIdx, "section-magic"),
												)
											)
										) : (
											SECTION_ITEMS[sectionId].map((spec) => {
												const RowIcon = spec.icon;
												const locked = spec.locked === true;
												const visible = locked ? true : !hiddenItems.has(spec.id);
												const itemLabel = t(spec.labelKey);
												const keycap =
													spec.shortcutId === undefined
														? undefined
														: formatContextMenuKeycap(spec.shortcutId, appSettings.shortcuts, platform);
												return (
													<div
														key={spec.id}
														className={`sidebar-custom-row${locked ? " is-locked" : visible ? "" : " is-muted"}`}
														data-cmenu-row={spec.id}
														title={locked ? t("settingsCore.contextMenu.lockedHint") : undefined}
													>
														<div className="sidebar-custom-row__order" aria-hidden="true">
															{locked ? <Lock size={12} className="sidebar-custom-row__lock-glyph" /> : null}
														</div>
														<span className={`sidebar-custom-row__icon${locked ? " is-accent" : ""}`} aria-hidden="true">
															<RowIcon size={15} />
														</span>
														<div className="sidebar-custom-row__main">
															<span className="sidebar-custom-row__name">{itemLabel}</span>
															{locked ? (
																<span className="sidebar-custom-badge is-locked">
																	{t("settingsCore.contextMenu.lockedBadge")}
																</span>
															) : null}
															{keycap !== undefined ? (
																<span className="sidebar-custom-badge">{keycap}</span>
															) : null}
														</div>
														<Switch
															checked={visible}
															disabled={locked}
															dataSwitchId={spec.id}
															ariaLabel={itemLabel}
															onChange={() => toggleBuiltinItem(spec.id)}
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
				<Note>{t("settingsCore.contextMenu.shortcutNote")}</Note>
			</Section>

			{editorState.open ? (
				<MagicActionEditorModal
					initial={editorState.initial}
					onCancel={() => setEditorState({ open: false, initial: null })}
					onSave={saveMagicAction}
				/>
			) : null}
		</>
	);
}
