import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Eye, FilePen, Info, Lock, Pencil, Plus, Sparkles, Terminal, X } from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppSettings, SettingsBridge } from "../../../../shared/settings-contract";
import {
	contextMenuPresetLayout,
	contextMenuPresetOf,
	normalizeContextMenuSettings,
	normalizeMagicAction,
	type BuiltinContextMenuItemId,
	type ContextMenuSectionId,
	type ContextMenuSettings,
	type HideableContextMenuSectionId,
	type MagicAction,
	type MagicActionAgentMode,
	type MagicActionExecution,
	type MagicActionSelectionRule,
	withContextMenuLayout,
} from "../../../../shared/context-menu-contract";
import type { ShortcutId } from "../../../../shared/shortcuts-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { formatContextMenuKeycap } from "../../state/context-menu";
import { cn } from "../../lib/cn";
import { autoMagicLabel, newMagicActionId, rightClickKindOf, rightClickTarget, type RightClickKind } from "../../state/right-click-trigger";
import { ChipSelect, type ChipOption } from "../primitives/ChipSelect";
import { RightClickWhen, RunKindSegment, type RunKind } from "../RightClickWhen";
import { buttonClass } from "../primitives/button";
import { Switch } from "../primitives/Switch";
import { ModalActions, ModalShell, SettingsPageHead } from "./SettingsKit";
import { useReorder, useSlideAnimation } from "./reorder";

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

/**
 * The 매직 액션 modal: the same form as a 새 자동화 card set to 우클릭하면, so a right-click action reads the same
 * wherever it is made. The name is the title, filled from what the action does until the person types one; 언제 is
 * the right-click sentence, its trigger fixed (this list holds only right-click actions); 할 일 is the instruction
 * or, under 스크립트, the command. The permission chip shows only when an action is changed: a new one starts
 * read-only. What the form no longer shows (the description, skills and MCP) is kept as the action had it.
 */
function MagicActionEditorModal({
	initial,
	takenIds,
	onCancel,
	onSave,
}: {
	readonly initial: MagicAction | null;
	/** The ids the other actions have, so a new one never replaces one of them. */
	readonly takenIds: readonly string[];
	readonly onCancel: () => void;
	readonly onSave: (action: MagicAction) => void;
}): ReactElement {
	const { t } = useTranslation();
	const isWindows = hostPlatform() === "win32";
	const start = initial === null ? { kind: "pdf" as RightClickKind, custom: null } : rightClickKindOf(initial.targetKind, initial.extensions);
	const [label, setLabel] = useState(initial?.label ?? "");
	const [runKind, setRunKind] = useState<RunKind>(initial?.execution.kind === "script" ? "script" : "agent");
	const [agentMode, setAgentMode] = useState<MagicActionAgentMode>(initial?.execution.kind === "agent" ? initial.execution.mode : "read");
	const [prompt, setPrompt] = useState(initial?.execution.kind === "agent" ? initial.execution.prompt : "");
	const [command, setCommand] = useState(initial?.execution.kind === "script" ? initial.execution.command : "");
	const [selection, setSelection] = useState<MagicActionSelectionRule>(initial === null ? "single" : initial.selection);
	const [kind, setKind] = useState<RightClickKind>(start.kind);
	const [customExtensions, setCustomExtensions] = useState<readonly string[] | null>(start.custom);

	const task = runKind === "agent" ? prompt : command;
	const name = label.trim().length > 0 ? label.trim() : autoMagicLabel(task);
	const canSave = name.length > 0 && task.trim().length > 0;

	const submit = (): void => {
		if (!canSave) return;
		const execution: MagicActionExecution =
			runKind === "script"
				? { kind: "script", command }
				: {
						kind: "agent",
						mode: agentMode,
						prompt,
						useSkills: initial?.execution.kind === "agent" ? initial.execution.useSkills !== false : true,
						useMcp: initial?.execution.kind === "agent" ? initial.execution.useMcp !== false : true,
					};
		const normalized = normalizeMagicAction({
			id: initial?.id ?? newMagicActionId(name, takenIds),
			label: name,
			...(initial?.description === undefined ? {} : { description: initial.description }),
			enabled: initial?.enabled ?? true,
			selection,
			...rightClickTarget(kind, customExtensions),
			execution,
		});
		if (normalized !== null) onSave(normalized);
	};

	const modes: readonly ChipOption<MagicActionAgentMode>[] = [
		{ value: "read", label: t("settingsCore.contextMenu.editor.modeReadShort"), hint: t("settingsCore.contextMenu.editor.modeRead"), icon: <Eye size={13} aria-hidden="true" /> },
		{ value: "organize", label: t("settingsCore.contextMenu.editor.modeOrganizeShort"), hint: t("settingsCore.contextMenu.editor.modeOrganize"), icon: <FilePen size={13} aria-hidden="true" /> },
	];

	return (
		<ModalShell
			onClose={onCancel}
			className="magic-editor-modal"
			label={initial === null ? t("settingsCore.contextMenu.editor.createTitle") : t("settingsCore.contextMenu.editor.editTitle")}
		>
			<div className="magic-editor" data-testid="magic-action-editor-modal">
				<div className="magic-editor-name">
					<input
						autoFocus
						data-testid="magic-editor-label"
						aria-label={t("settingsCore.contextMenu.editor.labelField")}
						value={label}
						placeholder={autoMagicLabel(task) || t("settingsCore.contextMenu.editor.labelPlaceholder")}
						onChange={(e) => setLabel(e.target.value)}
					/>
				</div>

				<div className="magic-editor-body">
					<span className="magic-editor-label">{t("rightClickWhen.when")}</span>
					<RightClickWhen
						kind={kind}
						custom={customExtensions}
						selection={selection}
						testId="magic-editor-rc"
						onKind={(next) => {
							setKind(next);
							setCustomExtensions(null);
						}}
						onCustom={setCustomExtensions}
						onSelection={setSelection}
					/>
					<div className="magic-editor-label-row">
						<span className="magic-editor-label">{t("rightClickWhen.task")}</span>
						<RunKindSegment value={runKind} testId="magic-editor-kind" onChange={setRunKind} />
					</div>
					{runKind === "agent" ? (
						<textarea
							data-testid="magic-editor-prompt"
							aria-label={t("settingsCore.contextMenu.editor.promptField")}
							value={prompt}
							placeholder={t("settingsCore.contextMenu.editor.promptPlaceholder")}
							onChange={(e) => setPrompt(e.target.value)}
						/>
					) : (
						<textarea
							data-testid="magic-editor-command"
							className="is-mono"
							aria-label={t("settingsCore.contextMenu.editor.commandField")}
							value={command}
							placeholder={t(isWindows ? "settingsCore.contextMenu.editor.commandPlaceholderWindows" : "settingsCore.contextMenu.editor.commandPlaceholder")}
							onChange={(e) => setCommand(e.target.value)}
						/>
					)}
					{runKind === "script" ? (
						<p className="magic-editor-card-hint">{t(isWindows ? "settingsCore.contextMenu.editor.commandHintWindows" : "settingsCore.contextMenu.editor.commandHint")}</p>
					) : null}
					{/* The permission is for changing an action, not for making one: a new one starts read-only. */}
					{initial !== null && runKind === "agent" ? (
						<div>
							<ChipSelect value={agentMode} options={modes} label={t("settingsCore.contextMenu.editor.agentModeField")} round testId="magic-editor-agent-mode" onChange={setAgentMode} />
						</div>
					) : null}
				</div>

				<ModalActions>
					<button type="button" className="linear-btn" data-action="cancel-magic-editor" onClick={onCancel}>
						{t("common.cancel")}
					</button>
					<button type="button" className="linear-btn settings-btn-primary" data-action="save-magic-editor" disabled={!canSave} onClick={submit}>
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
		// Skills and MCP are the agent's own choice, so the row does not list them.
		return [sel, kind, ext].filter((part): part is string => part !== null).join(" · ");
	};

	/**
	 * One magic action, drawn for one of its two places. In 나만의 매직 액션 (`"card"`) it is where the action is
	 * edited: its conditions, 수정 and 삭제, no switch. In 우클릭 메뉴 섹션 및 항목 (`"section"`) it is one more menu
	 * item: the name and the on/off switch, nothing else.
	 */
	const renderMagicActionRow = (action: MagicAction, index: number, prefix: string, place: "card" | "section"): ReactElement => {
		const RowIcon = action.execution.kind === "script" ? Terminal : Sparkles;

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
				</span>
				{place === "card" ? (
					<span className="sidebar-row-path" title={describeConditions(action)}>
						{describeConditions(action)}
					</span>
				) : null}
				<span className="sidebar-row-spacer" />
				{place === "card" ? (
					<>
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
					</>
				) : (
					<Switch
						checked={action.enabled}
						dataSwitchId={`magic:${action.id}`}
						ariaLabel={action.label}
						onChange={() => toggleMagicActionEnabled(action.id)}
					/>
				)}
			</div>
		);
	};

	const magicRows = (prefix: string, place: "card" | "section"): ReactElement[] =>
		reorder
			.order("magic", contextMenu.magicActions.map((action) => action.id))
			.map((index) => renderMagicActionRow(contextMenu.magicActions[index]!, index, prefix, place));

	// 전체 표시 is the default layout, so it doubles as the reset; 사용자 지정 is the last layout arranged by hand.
	const activePreset = contextMenuPresetOf(contextMenu);
	const customLayout = contextMenu.custom;

	return (
		<>
			<SettingsPageHead
				title={t("settingsCore.nav.contextMenu")}
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
						<span>{t("settingsCore.contextMenu.aiHeroButton")}</span>
					</button>
				</div>
			)}

			{/* Figma 472:2581: 나만의 매직 액션, then 우클릭 메뉴 섹션 및 항목 with its 빠른 구성 under the title (as on the sidebar page), then each menu section as a head over a bordered card. */}
			<div className="sidebar-page" ref={pageRef}>
				<section className="cmenu-block">
					<h3 className="cmenu-block-title">{t("settingsCore.contextMenu.magicTitle")}</h3>
					<div className="sidebar-card cmenu-block-card" data-context-menu-magic-card="true" {...reorder.zone("magic", moveMagicActionTo)}>
						{magicCount === 0 ? <p className="sidebar-card-empty is-compact">{t("settingsCore.contextMenu.magicEmpty")}</p> : magicRows("magic", "card")}
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
					<div className="sidebar-quick cmenu-block-quick" role="group" aria-label={t("settingsCore.contextMenu.presetsTitle")}>
						<span className="sidebar-quick-label">{t("settingsCore.contextMenu.presetsTitle")}</span>
						<div className="shortcuts-segmented">
							<button
								type="button"
								className={cn("shortcuts-segment", activePreset === "all" && "is-active")}
								data-action="context-menu-preset-all"
								aria-pressed={activePreset === "all"}
								onClick={() => void updateContextMenu(withContextMenuLayout(contextMenu, contextMenuPresetLayout("all")))}
							>
								{t("settingsCore.contextMenu.presetShowAll")}
							</button>
							<button
								type="button"
								className={cn("shortcuts-segment", activePreset === "minimal" && "is-active")}
								data-action="context-menu-preset-minimal"
								aria-pressed={activePreset === "minimal"}
								onClick={() => void updateContextMenu(withContextMenuLayout(contextMenu, contextMenuPresetLayout("minimal")))}
							>
								{t("settingsCore.contextMenu.presetMinimal")}
							</button>
							<button
								type="button"
								className={cn("shortcuts-segment", activePreset === null && "is-active")}
								data-action="context-menu-preset-custom"
								aria-pressed={activePreset === null}
								disabled={customLayout === undefined}
								title={customLayout === undefined ? t("settingsCore.contextMenu.presetCustomEmpty") : undefined}
								onClick={() => {
									if (customLayout !== undefined && activePreset !== null) void updateContextMenu(withContextMenuLayout(contextMenu, customLayout));
								}}
							>
								{t("settingsCore.contextMenu.presetCustom")}
							</button>
						</div>
					</div>
				</div>

				<div className="sidebar-sections-stack" {...reorder.zone("section", moveSectionTo)}>
					{reorder.order("section", contextMenu.sectionOrder).map((idx) => {
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
												magicRows("section-magic", "section")
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
					takenIds={contextMenu.magicActions.filter((item) => item.id !== editorState.initial?.id).map((item) => item.id)}
					onCancel={() => setEditorState({ open: false, initial: null })}
					onSave={saveMagicAction}
				/>
			) : null}
		</>
	);
}
