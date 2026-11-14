import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Info, Lock, Pencil, Plus, RotateCcw, Sparkles, Terminal, X } from "lucide-react";
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
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";
import { Switch } from "../primitives/Switch";
import { ModalActions, ModalShell, Note, SettingsPageHead } from "./SettingsKit";
import { useReorder, useSlideAnimation } from "./reorder";
import { SelectField } from "./SelectField";

type ContextMenuBridgeWindow = Window & {
	readonly autorag?: {
		readonly settings?: Pick<SettingsBridge, "set">;
	};
};

function getSettingsWriter(): Pick<SettingsBridge, "set"> | undefined {
	return (window as ContextMenuBridgeWindow).autorag?.settings;
}

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
	readonly shortcutId?: ShortcutId;
	readonly locked?: boolean;
}

const SECTION_ITEMS: Readonly<Record<Exclude<ContextMenuSectionId, "magic">, readonly BuiltinRowSpec[]>> = {
	open: [
		{ id: "builtin:quickLook", labelKey: "settingsCore.contextMenu.items.quickLook", shortcutId: "quickLook" },
		{ id: "builtin:open", labelKey: "settingsCore.contextMenu.items.open", shortcutId: "openItem" },
		{ id: "builtin:openWith", labelKey: "settingsCore.contextMenu.items.openWith" },
		{ id: "builtin:showInEnclosingFolder", labelKey: "settingsCore.contextMenu.items.showInEnclosingFolder" },
	],
	index: [
		{ id: "builtin:toggleIndex", labelKey: "settingsCore.contextMenu.items.toggleIndex" },
	],
	clipboard: [
		{ id: "builtin:copy", labelKey: "settingsCore.contextMenu.items.copy", shortcutId: "copy" },
		{ id: "builtin:paste", labelKey: "settingsCore.contextMenu.items.paste", shortcutId: "paste" },
		{ id: "builtin:cut", labelKey: "settingsCore.contextMenu.items.cut", shortcutId: "cut" },
		{ id: "builtin:duplicate", labelKey: "settingsCore.contextMenu.items.duplicate", shortcutId: "duplicate" },
		{ id: "builtin:rename", labelKey: "settingsCore.contextMenu.items.rename", shortcutId: "rename" },
		{ id: "builtin:copyPath", labelKey: "settingsCore.contextMenu.items.copyPath" },
	],
	actions: [
		{ id: "builtin:newFolder", labelKey: "settingsCore.contextMenu.items.newFolder" },
		{ id: "builtin:pinToSidebar", labelKey: "settingsCore.contextMenu.items.pinToSidebar" },
		{ id: "builtin:extract", labelKey: "settingsCore.contextMenu.items.extract" },
		{ id: "builtin:compress", labelKey: "settingsCore.contextMenu.items.compress" },
		{ id: "builtin:compress7z", labelKey: "settingsCore.contextMenu.items.compress7z" },
		{ id: "builtin:share", labelKey: "settingsCore.contextMenu.items.share" },
	],
	services: [
		{ id: "builtin:services", labelKey: "settingsCore.contextMenu.items.services" },
	],
	tags: [
		{ id: "builtin:tags", labelKey: "settingsCore.contextMenu.items.tags", locked: true },
	],
	trash: [
		{ id: "builtin:trash", labelKey: "settingsCore.contextMenu.items.trash", shortcutId: "trash" },
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
					<SelectField
						data-testid="magic-editor-kind"
						value={executionKind}
						options={[{ value: "agent", label: t("settingsCore.contextMenu.editor.kindAgent") }, { value: "script", label: t("settingsCore.contextMenu.editor.kindScript") }]}
						onValueChange={(value) => setExecutionKind(value === "script" ? "script" : "agent")}
					/>
				</label>

				{executionKind === "agent" ? (
					<>
						<label>
							{t("settingsCore.contextMenu.editor.agentModeField")}
							<SelectField
								data-testid="magic-editor-agent-mode"
								value={agentMode}
								options={[{ value: "read", label: t("settingsCore.contextMenu.editor.modeRead") }, { value: "organize", label: t("settingsCore.contextMenu.editor.modeOrganize") }]}
								onValueChange={(value) => setAgentMode(value === "organize" ? "organize" : "read")}
							/>
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
					<SelectField
						data-testid="magic-editor-selection"
						value={selection}
						options={[{ value: "any", label: t("settingsCore.contextMenu.condAnySelection") }, { value: "single", label: t("settingsCore.contextMenu.condSingle") }, { value: "multiple", label: t("settingsCore.contextMenu.condMultiple") }]}
						onValueChange={(value) => setSelection(value === "single" || value === "multiple" ? value : "any")}
					/>
				</label>

				<label>
					{t("settingsCore.contextMenu.editor.targetKindField")}
					<SelectField
						data-testid="magic-editor-target-kind"
						value={targetKind}
						options={[{ value: "file", label: t("settingsCore.contextMenu.condFileOnly") }, { value: "folder", label: t("settingsCore.contextMenu.condFolderOnly") }, { value: "any", label: t("settingsCore.contextMenu.condAnyKind") }]}
						onValueChange={(value) => setTargetKind(value === "file" || value === "folder" ? value : "any")}
					/>
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

	const moveSectionTo = (from: number, to: number): void => {
		if (to < 0 || to >= contextMenu.sectionOrder.length || to === from) return;
		const order = [...contextMenu.sectionOrder];
		const [moved] = order.splice(from, 1);
		if (moved === undefined) return;
		order.splice(to, 0, moved);
		void updateContextMenu({ ...contextMenu, sectionOrder: order });
	};

	const moveMagicActionTo = (from: number, to: number): void => {
		if (to < 0 || to >= contextMenu.magicActions.length || to === from) return;
		const actions = [...contextMenu.magicActions];
		const [moved] = actions.splice(from, 1);
		if (moved === undefined) return;
		actions.splice(to, 0, moved);
		void updateContextMenu({ ...contextMenu, magicActions: actions });
	};

	// Drag and drop by the handles (Figma 472:2581): sections among sections, magic actions among magic actions; the
	// others slide out of the way while one is dragged.
	const reorder = useReorder();
	const pageRef = useRef<HTMLDivElement>(null);
	useSlideAnimation(pageRef);
	const sectionCount = contextMenu.sectionOrder.length;
	const magicCount = contextMenu.magicActions.length;

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
				className={cn("sidebar-row", !action.enabled && "is-muted", reorder.isDragging("magic", index) && "is-dragging")}
				data-magic-row={action.id}
				data-reorder-key={`${prefix}:${action.id}`}
				{...reorder.target("magic", index, magicCount, moveMagicActionTo)}
			>
				{reorder.grip({
					kind: "magic",
					index,
					length: magicCount,
					id: `${prefix}:${action.id}`,
					label: t("settingsCore.contextMenu.dragHint", { name: action.label }),
					attr: "data-cmenu-grip",
					onMove: moveMagicActionTo,
				})}
				<span className="sidebar-row-label">
					<RowIcon size={14} strokeWidth={1.5} className="sidebar-row-icon is-accent" aria-hidden="true" />
					<span className="sidebar-row-name">{action.label}</span>
					<span className="sidebar-always-badge is-plain">{badgeLabel}</span>
				</span>
				<span className="sidebar-row-path" title={summary}>
					{summary}
				</span>
				<span className="sidebar-row-spacer" />
				<button
					type="button"
					className="shortcuts-reset"
					data-action={`edit-magic-${action.id}`}
					title={t("settingsCore.contextMenu.editMagicAction", { name: action.label })}
					aria-label={t("settingsCore.contextMenu.editMagicAction", { name: action.label })}
					onClick={() => setEditorState({ open: true, initial: action })}
				>
					<Pencil size={14} strokeWidth={1.5} />
				</button>
				<button
					type="button"
					className="shortcuts-reset"
					data-action={`remove-magic-${action.id}`}
					title={t("settingsCore.contextMenu.removeMagicAction", { name: action.label })}
					aria-label={t("settingsCore.contextMenu.removeMagicAction", { name: action.label })}
					onClick={() => removeMagicAction(action.id)}
				>
					<X size={14} strokeWidth={1.5} />
				</button>
				<Switch
					checked={action.enabled}
					dataSwitchId={`magic:${action.id}`}
					ariaLabel={action.label}
					onChange={() => toggleMagicActionEnabled(action.id)}
				/>
			</div>
		);
	};

	const magicRows = (prefix: string): ReactElement[] =>
		reorder.order("magic", magicCount).map((index) => renderMagicActionRow(contextMenu.magicActions[index]!, index, prefix));

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

			{/* Figma 472:2581: 빠른 구성, 나만의 매직 액션, then each menu section as a head over a bordered card. */}
			<div className="sidebar-page" ref={pageRef}>
				<div className="sidebar-quick" role="group" aria-label={t("settingsCore.contextMenu.presetsTitle")}>
					<span className="sidebar-quick-label">{t("settingsCore.contextMenu.presetsTitle")}</span>
					<div className="shortcuts-segmented">
						<button
							type="button"
							className={cn("shortcuts-segment", isShowAllActive && "is-active")}
							data-action="context-menu-preset-all"
							aria-pressed={isShowAllActive}
							onClick={() => void updateContextMenu({ ...contextMenu, hiddenItems: [], hiddenSections: [] })}
						>
							{t("settingsCore.contextMenu.presetShowAll")}
						</button>
						<button
							type="button"
							className={cn("shortcuts-segment", isMinimalActive && "is-active")}
							data-action="context-menu-preset-minimal"
							aria-pressed={isMinimalActive}
							onClick={() => void updateContextMenu({ ...contextMenu, hiddenItems: [...MINIMAL_HIDDEN_CONTEXT_MENU_IDS] })}
						>
							{t("settingsCore.contextMenu.presetMinimal")}
						</button>
					</div>
					<span className="sidebar-row-spacer" />
					<button
						type="button"
						className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
						data-action="context-menu-reset-default"
						disabled={isDefault}
						onClick={() => void updateContextMenu(DEFAULT_CONTEXT_MENU_SETTINGS)}
					>
						<RotateCcw aria-hidden="true" />
						{t("settingsCore.contextMenu.resetDefault")}
					</button>
				</div>

				<section className="cmenu-block">
					<h3 className="cmenu-block-title">{t("settingsCore.contextMenu.magicTitle")}</h3>
					<p className="cmenu-block-desc">{t("settingsCore.contextMenu.magicDesc")}</p>
					<div className="sidebar-card cmenu-block-card" data-context-menu-magic-card="true" {...reorder.zone("magic", moveMagicActionTo)}>
						{magicCount === 0 ? <p className="sidebar-card-empty is-compact">{t("settingsCore.contextMenu.magicEmpty")}</p> : magicRows("magic")}
						<div className="sidebar-row is-add">
							<button
								type="button"
								className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
								data-action="add-magic-action"
								onClick={() => setEditorState({ open: true, initial: null })}
							>
								<Plus aria-hidden="true" />
								{t("settingsCore.contextMenu.addMagicAction")}
							</button>
						</div>
					</div>
				</section>

				<div className="cmenu-block">
					<h3 className="cmenu-block-title">{t("settingsCore.contextMenu.sectionsTitle")}</h3>
					<p className="cmenu-block-desc">{t("settingsCore.contextMenu.sectionsDesc")}</p>
				</div>

				<div className="sidebar-sections-stack" {...reorder.zone("section", moveSectionTo)}>
					{reorder.order("section", sectionCount).map((idx) => {
						const sectionId = contextMenu.sectionOrder[idx]!;
						const isTags = sectionId === "tags";
						const sectionVisible = isTags ? true : !hiddenSections.has(sectionId);
						const label = sectionLabel(sectionId);
						const counts = sectionCounts(sectionId);

						return (
							<section
								key={sectionId}
								className={cn("sidebar-section", !sectionVisible && "is-collapsed", reorder.isDragging("section", idx) && "is-dragging")}
								data-context-menu-section={sectionId}
								data-reorder-key={`section:${sectionId}`}
								{...reorder.target("section", idx, sectionCount, moveSectionTo)}
							>
								<div className="sidebar-section-head">
									{reorder.grip({
										kind: "section",
										index: idx,
										length: sectionCount,
										id: sectionId,
										label: t("settingsCore.contextMenu.dragHint", { name: label }),
										attr: "data-cmenu-section-grip",
										onMove: moveSectionTo,
									})}
									<span className="sidebar-section-title">{label}</span>
									{isTags ? (
										<span className="sidebar-always-badge" title={t("settingsCore.contextMenu.sectionAlwaysShown")}>
											{t("settingsCore.contextMenu.lockedBadge")}
										</span>
									) : null}
									<span className="sidebar-row-spacer" />
									{counts !== null && sectionVisible ? (
										<span className="sidebar-section-count">{t("settingsCore.contextMenu.sectionCount", counts)}</span>
									) : null}
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
									<div className="sidebar-card" {...(sectionId === "magic" ? reorder.zone("magic", moveMagicActionTo) : {})}>
										{sectionId === "magic" ? (
											magicCount === 0 ? (
												<p className="sidebar-card-empty">{t("settingsCore.contextMenu.magicEmpty")}</p>
											) : (
												magicRows("section-magic")
											)
										) : (
											SECTION_ITEMS[sectionId].map((spec) => {
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
														className={cn("sidebar-row cmenu-row", locked ? "is-locked" : !visible && "is-muted")}
														data-cmenu-row={spec.id}
														title={locked ? t("settingsCore.contextMenu.lockedHint") : undefined}
													>
														<span className="sidebar-row-name">{itemLabel}</span>
														{locked ? <Lock size={14} strokeWidth={1.5} className="cmenu-row-lock" aria-label={t("settingsCore.contextMenu.lockedBadge")} /> : null}
														{keycap !== undefined ? <span className="sidebar-row-path">{keycap}</span> : null}
														<span className="sidebar-row-spacer" />
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
							</section>
						);
					})}
				</div>

				<p className="cmenu-note">
					<Info size={14} strokeWidth={1.5} aria-hidden="true" />
					<span>{t("settingsCore.contextMenu.shortcutNote")}</span>
				</p>
			</div>

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
