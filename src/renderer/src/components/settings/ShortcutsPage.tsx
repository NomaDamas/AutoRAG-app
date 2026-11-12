import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
	AlertTriangle,
	ArrowLeftRight,
	Eye,
	Folder,
	Keyboard,
	LayoutGrid,
	Lock,
	RotateCcw,
	Search,
	SlidersHorizontal,
	Sparkles,
	X,
	type LucideIcon,
} from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppSettings, SettingsBridge } from "../../../../shared/settings-contract";
import {
	activeShortcutPreset,
	chordFromKeyEvent,
	decomposeShortcutChord,
	findShortcutConflict,
	formatHeldModifiers,
	formatShortcutChord,
	normalizeShortcutSettings,
	resolveEffectiveShortcuts,
	SELECTABLE_SHORTCUT_KEYS,
	SHORTCUT_CATALOG,
	shortcutChordParts,
	shortcutSettingsForPreset,
	swapShortcutBinding,
	validateShortcutParts,
	type ShortcutCatalogItem,
	type ShortcutGroupId,
	type ShortcutId,
	type ShortcutInvalidReason,
	type ShortcutSettings,
} from "../../../../shared/shortcuts-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { Section, SettingsPageHead } from "./SettingsKit";
import { SelectField } from "./SelectField";

type ShortcutsBridgeWindow = Window & {
	readonly autorag?: {
		readonly settings?: Pick<SettingsBridge, "set">;
	};
};

function getSettingsWriter(): Pick<SettingsBridge, "set"> | undefined {
	return (window as ShortcutsBridgeWindow).autorag?.settings;
}

const GROUP_ORDER: readonly ShortcutGroupId[] = ["window", "view", "files", "aiSearch"];

const GROUP_ICONS: Readonly<Record<ShortcutGroupId, LucideIcon>> = {
	window: LayoutGrid,
	view: Eye,
	files: Folder,
	aiSearch: Sparkles,
};

interface HeldModifiers {
	readonly mod: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
}

interface PendingConflict {
	readonly id: ShortcutId;
	readonly chord: string;
	readonly conflictWith: ShortcutId;
}

interface UiEditorState {
	readonly id: ShortcutId;
	readonly mod: boolean;
	readonly alt: boolean;
	readonly shift: boolean;
	readonly key: string;
}

function renderKeycapSequence(chord: string, platform: string): ReactElement {
	const parts = shortcutChordParts(chord, platform);
	const isMac = platform === "darwin";
	return (
		<span className="shortcut-keycap-seq">
			{parts.map((part, idx) => (
				<span key={`${part}-${idx}`} className="shortcut-keycap-piece">
					{!isMac && idx > 0 ? <span className="shortcut-keycap-plus">+</span> : null}
					<kbd className="shortcut-keycap">{part}</kbd>
				</span>
			))}
		</span>
	);
}

export function ShortcutsPage({
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
	const isMac = platform === "darwin";

	const [filterQuery, setFilterQuery] = useState("");
	const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);
	const [heldMods, setHeldMods] = useState<HeldModifiers>({ mod: false, alt: false, shift: false });
	const [invalidNotice, setInvalidNotice] = useState<{
		readonly id: ShortcutId;
		readonly reason: ShortcutInvalidReason;
	} | null>(null);
	const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
	const [uiEditor, setUiEditor] = useState<UiEditorState | null>(null);

	const shortcuts = useMemo(() => normalizeShortcutSettings(appSettings.shortcuts), [appSettings.shortcuts]);
	const effective = useMemo(() => resolveEffectiveShortcuts(shortcuts), [shortcuts]);

	const updateShortcuts = useCallback(
		async (nextShortcuts: ShortcutSettings): Promise<boolean> => {
			const writer = getSettingsWriter();
			if (writer === undefined) return false;
			try {
				const normalized = normalizeShortcutSettings(nextShortcuts);
				const updated = await writer.set({ shortcuts: normalized });
				onAppSettingsChanged(updated);
				return true;
			} catch (cause: unknown) {
				onSettingsError(cause instanceof Error ? cause.message : String(cause));
				return false;
			}
		},
		[onAppSettingsChanged, onSettingsError],
	);

	const actionLabel = useCallback(
		(id: ShortcutId): string => t(`settingsCore.shortcuts.actions.${id}`),
		[t],
	);

	const invalidMessage = useCallback(
		(reason: ShortcutInvalidReason): string => {
			switch (reason) {
				case "missing-modifier":
					return t("settingsCore.shortcuts.invalidMissingModifier");
				case "reserved-escape":
					return t("settingsCore.shortcuts.invalidReservedEscape");
				case "reserved-navigation":
					return t("settingsCore.shortcuts.invalidReservedNavigation");
				default:
					return t("settingsCore.shortcuts.invalidGeneric");
			}
		},
		[t],
	);

	const applyRecordedChord = useCallback(
		async (id: ShortcutId, chord: string): Promise<void> => {
			const conflictId = findShortcutConflict(id, chord, shortcuts);
			if (conflictId !== null) {
				setInvalidNotice(null);
				setPendingConflict({ id, chord, conflictWith: conflictId });
				setRecordingId(null);
				setHeldMods({ mod: false, alt: false, shift: false });
				return;
			}
			const meta = SHORTCUT_CATALOG.find((item) => item.id === id);
			const nextOverrides: Partial<Record<ShortcutId, string>> = { ...shortcuts.overrides };
			if (meta !== undefined && chord === meta.defaultChord) {
				delete nextOverrides[id];
			} else {
				nextOverrides[id] = chord;
			}
			setRecordingId(null);
			setHeldMods({ mod: false, alt: false, shift: false });
			setInvalidNotice(null);
			setPendingConflict(null);
			await updateShortcuts({ overrides: nextOverrides });
		},
		[shortcuts, updateShortcuts],
	);

	// Capture-phase keyboard listener during active key-press shortcut recording.
	useEffect(() => {
		if (recordingId === null) return;

		const onKeyDown = (event: KeyboardEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();

			const decoded = chordFromKeyEvent(event, platform);
			if (decoded.kind === "cancel") {
				setRecordingId(null);
				setHeldMods({ mod: false, alt: false, shift: false });
				setInvalidNotice(null);
				return;
			}
			if (decoded.kind === "modifier-only") {
				setHeldMods({ mod: decoded.mod, alt: decoded.alt, shift: decoded.shift });
				return;
			}
			if (decoded.kind === "invalid") {
				setHeldMods({ mod: false, alt: false, shift: false });
				setInvalidNotice({ id: recordingId, reason: decoded.reason });
				return;
			}
			void applyRecordedChord(recordingId, decoded.chord);
		};

		const onKeyUp = (event: KeyboardEvent): void => {
			event.preventDefault();
			event.stopPropagation();
			setHeldMods({
				mod: isMac ? event.metaKey || event.ctrlKey : event.ctrlKey,
				alt: event.altKey,
				shift: event.shiftKey,
			});
		};

		const onPointerDown = (event: MouseEvent): void => {
			if (
				event.target instanceof HTMLElement &&
				event.target.closest(`[data-shortcut-row="${recordingId}"]`) !== null
			) {
				return;
			}
			setRecordingId(null);
			setHeldMods({ mod: false, alt: false, shift: false });
		};

		window.addEventListener("keydown", onKeyDown, { capture: true });
		window.addEventListener("keyup", onKeyUp, { capture: true });
		window.addEventListener("mousedown", onPointerDown, { capture: true });
		return () => {
			window.removeEventListener("keydown", onKeyDown, { capture: true });
			window.removeEventListener("keyup", onKeyUp, { capture: true });
			window.removeEventListener("mousedown", onPointerDown, { capture: true });
		};
	}, [recordingId, applyRecordedChord, platform, isMac]);

	const startRecording = (id: ShortcutId): void => {
		if (recordingId === id) {
			setRecordingId(null);
			setHeldMods({ mod: false, alt: false, shift: false });
			return;
		}
		setUiEditor(null);
		setPendingConflict(null);
		setInvalidNotice(null);
		setHeldMods({ mod: false, alt: false, shift: false });
		setRecordingId(id);
	};

	const toggleUiEditor = (id: ShortcutId): void => {
		setRecordingId(null);
		setHeldMods({ mod: false, alt: false, shift: false });
		setPendingConflict(null);
		setInvalidNotice(null);
		if (uiEditor?.id === id) {
			setUiEditor(null);
			return;
		}
		const currentParts = decomposeShortcutChord(effective[id]) ?? {
			mod: true,
			alt: false,
			shift: false,
			key: "A",
		};
		setUiEditor({
			id,
			mod: currentParts.mod,
			alt: currentParts.alt,
			shift: currentParts.shift,
			key: currentParts.key,
		});
	};

	const resetSingleShortcut = async (id: ShortcutId): Promise<void> => {
		const nextOverrides: Partial<Record<ShortcutId, string>> = { ...shortcuts.overrides };
		delete nextOverrides[id];
		setPendingConflict((prev) => (prev?.id === id ? null : prev));
		setInvalidNotice((prev) => (prev?.id === id ? null : prev));
		await updateShortcuts({ overrides: nextOverrides });
	};

	const applyPreset = (preset: "macFinder" | "windowsExplorer" | "default"): void => {
		setRecordingId(null);
		setHeldMods({ mod: false, alt: false, shift: false });
		setPendingConflict(null);
		setInvalidNotice(null);
		setUiEditor(null);
		void updateShortcuts(shortcutSettingsForPreset(preset));
	};

	const normalizedQuery = filterQuery.trim().toLowerCase();

	const groupedItems = useMemo(() => {
		const byGroup: Record<ShortcutGroupId, ShortcutCatalogItem[]> = {
			window: [],
			view: [],
			files: [],
			aiSearch: [],
		};
		for (const item of SHORTCUT_CATALOG) {
			if (normalizedQuery.length > 0) {
				const label = actionLabel(item.id).toLowerCase();
				const currentStr = formatShortcutChord(effective[item.id], platform).toLowerCase();
				const defaultStr = formatShortcutChord(item.defaultChord, platform).toLowerCase();
				const rawCurrent = effective[item.id].toLowerCase();
				if (
					!label.includes(normalizedQuery) &&
					!item.id.toLowerCase().includes(normalizedQuery) &&
					!currentStr.includes(normalizedQuery) &&
					!defaultStr.includes(normalizedQuery) &&
					!rawCurrent.includes(normalizedQuery)
				) {
					continue;
				}
			}
			byGroup[item.group].push(item);
		}
		return byGroup;
	}, [normalizedQuery, actionLabel, effective, platform]);

	const showLockedDismiss =
		normalizedQuery.length === 0 ||
		t("settingsCore.shortcuts.actions.dismiss").toLowerCase().includes(normalizedQuery) ||
		"esc".includes(normalizedQuery) ||
		"escape".includes(normalizedQuery);

	const totalMatching =
		GROUP_ORDER.reduce((sum, group) => sum + groupedItems[group].length, 0) + (showLockedDismiss ? 1 : 0);

	const customizedCount = Object.keys(shortcuts.overrides).length;
	const activePreset = activeShortcutPreset(shortcuts);

	return (
		<>
			<SettingsPageHead title={t("settingsCore.nav.shortcuts")} description={t("settingsCore.shortcuts.description")} />

			{customizerOpen ? null : (
				<div className="sidebar-ai-hero">
					<div className="sidebar-ai-hero__body">
						<span className="sidebar-ai-hero__logo-wrap" aria-hidden="true">
							<img src={dazziMark} alt="" className="sidebar-ai-hero__logo" draggable={false} />
						</span>
						<div className="sidebar-ai-hero__copy">
							<div className="sidebar-ai-hero__title">{t("settingsCore.shortcuts.aiHeroTitle")}</div>
							<p className="sidebar-ai-hero__desc">{t("settingsCore.shortcuts.aiHeroDesc")}</p>
						</div>
					</div>
					<button
						type="button"
						className="linear-btn settings-btn-primary sidebar-ai-hero__btn"
						data-action="open-shortcut-customizer"
						onClick={onOpenCustomizer}
					>
						<img src={dazziMark} alt="" className="sidebar-ai-hero__btn-logo" aria-hidden="true" draggable={false} />
						<span>{t("settingsCore.shortcuts.aiHeroButton")}</span>
					</button>
				</div>
			)}

			<div className="sidebar-presets-bar" role="group" aria-label={t("settingsCore.shortcuts.presetsTitle")}>
				<span className="sidebar-presets-bar__label">{t("settingsCore.shortcuts.presetsTitle")}</span>
				<div className="sidebar-presets-bar__actions">
					<button
						type="button"
						className={`sidebar-preset-pill${activePreset === "macFinder" ? " is-active" : ""}`}
						data-action="shortcuts-preset-mac-finder"
						aria-pressed={activePreset === "macFinder"}
						onClick={() => applyPreset("macFinder")}
					>
						{t("settingsCore.shortcuts.presetMacFinder")}
					</button>
					<button
						type="button"
						className={`sidebar-preset-pill${activePreset === "windowsExplorer" ? " is-active" : ""}`}
						data-action="shortcuts-preset-windows-explorer"
						aria-pressed={activePreset === "windowsExplorer"}
						onClick={() => applyPreset("windowsExplorer")}
					>
						{t("settingsCore.shortcuts.presetWindowsExplorer")}
					</button>
					<button
						type="button"
						className={`sidebar-preset-pill${activePreset === "default" ? " is-active" : ""}`}
						data-action="shortcuts-preset-default"
						aria-pressed={activePreset === "default"}
						onClick={() => applyPreset("default")}
					>
						{t("settingsCore.shortcuts.presetDefault")}
					</button>
				</div>
			</div>

			<div className="shortcuts-toolbar">
				<label className="shortcuts-filter-box">
					<Search size={13} className="shortcuts-filter-box__icon" aria-hidden="true" />
					<input
						type="text"
						data-testid="shortcuts-filter-input"
						className="shortcuts-filter-box__input"
						value={filterQuery}
						placeholder={t("settingsCore.shortcuts.filterPlaceholder")}
						aria-label={t("settingsCore.shortcuts.filterPlaceholder")}
						onChange={(event) => setFilterQuery(event.target.value)}
					/>
					{filterQuery.length > 0 ? (
						<button
							type="button"
							className="shortcuts-filter-box__clear"
							data-action="clear-shortcuts-filter"
							aria-label={t("common.close")}
							onClick={() => setFilterQuery("")}
						>
							<X size={12} />
						</button>
					) : null}
				</label>
				{customizedCount > 0 ? (
					<span className="sidebar-custom-badge">{t("settingsCore.shortcuts.customizedCount", { count: customizedCount })}</span>
				) : null}
			</div>

			<Section title={t("settingsCore.shortcuts.sectionsTitle")} description={t("settingsCore.shortcuts.sectionsDesc")}>
				{totalMatching === 0 ? (
					<p className="linear-section-desc">{t("settingsCore.shortcuts.filterEmpty")}</p>
				) : (
					<div className="sidebar-sections-stack">
						{GROUP_ORDER.map((groupId) => {
							const items = groupedItems[groupId];
							const includeLocked = groupId === "window" && showLockedDismiss;
							if (items.length === 0 && !includeLocked) return null;
							const GroupIcon = GROUP_ICONS[groupId];
							const groupTitle = t(`settingsCore.shortcuts.groups.${groupId}`);

							return (
								<div key={groupId} className="sidebar-section-card" data-shortcut-group={groupId}>
									<div className="sidebar-section-card__head">
										<span className="sidebar-section-card__glyph" aria-hidden="true">
											<GroupIcon size={15} />
										</span>
										<div className="sidebar-section-card__title-wrap">
											<span className="sidebar-section-card__title">{groupTitle}</span>
										</div>
									</div>

									<div className="sidebar-section-card__items">
										{includeLocked ? (
											<div
												className="sidebar-custom-row shortcut-row is-locked"
												data-shortcut-row="dismiss"
												title={t("settingsCore.shortcuts.lockedHint")}
											>
												<div className="sidebar-custom-row__order" aria-hidden="true">
													<Lock size={12} className="sidebar-custom-row__lock-glyph" />
												</div>
												<div className="sidebar-custom-row__main">
													<span className="sidebar-custom-row__name">{t("settingsCore.shortcuts.actions.dismiss")}</span>
													<span className="sidebar-custom-badge is-locked">{t("settingsCore.shortcuts.lockedBadge")}</span>
												</div>
												<div className="shortcut-row__controls">
													<span className="shortcut-recorder-btn is-locked" aria-disabled="true">
														<kbd className="shortcut-keycap">Esc</kbd>
													</span>
												</div>
											</div>
										) : null}

										{items.map((item) => {
											const label = actionLabel(item.id);
											const currentChord = effective[item.id];
											const currentFormatted = formatShortcutChord(currentChord, platform);
											const defaultFormatted = formatShortcutChord(item.defaultChord, platform);
											const customized = currentChord !== item.defaultChord;
											const isRecording = recordingId === item.id;
											const heldPreview = isRecording ? formatHeldModifiers(heldMods, platform) : "";
											const rowConflict = pendingConflict?.id === item.id ? pendingConflict : null;
											const rowInvalid = invalidNotice?.id === item.id ? invalidNotice : null;
											const rowUi = uiEditor?.id === item.id ? uiEditor : null;

											const uiValidation =
												rowUi === null
													? null
													: validateShortcutParts({
															mod: rowUi.mod,
															alt: rowUi.alt,
															shift: rowUi.shift,
															key: rowUi.key,
														});
											const uiConflictId =
												rowUi !== null && uiValidation !== null && uiValidation.ok
													? findShortcutConflict(item.id, uiValidation.chord, shortcuts)
													: null;

											return (
												<div
													key={item.id}
													className={`shortcut-row-wrap${customized ? " is-customized" : ""}`}
													data-shortcut-row={item.id}
												>
													<div className="sidebar-custom-row shortcut-row">
														<span className="sidebar-custom-row__icon" aria-hidden="true">
															<Keyboard size={14} />
														</span>
														<div className="sidebar-custom-row__main">
															<span className="sidebar-custom-row__name">{label}</span>
															{customized ? (
																<>
																	<span className="sidebar-custom-badge">{t("settingsCore.shortcuts.customizedBadge")}</span>
																	<span className="sidebar-custom-row__sub">
																		{t("settingsCore.shortcuts.defaultHint", { shortcut: defaultFormatted })}
																	</span>
																</>
															) : null}
														</div>
														<div className="shortcut-row__controls">
															<button
																type="button"
																className={`shortcut-recorder-btn${isRecording ? " is-recording" : ""}${customized ? " is-customized" : ""}`}
																data-shortcut-record={item.id}
																title={t("settingsCore.shortcuts.recordButtonHint", { shortcut: currentFormatted })}
																aria-label={t("settingsCore.shortcuts.recordButtonHint", { shortcut: currentFormatted })}
																aria-pressed={isRecording}
																onClick={() => startRecording(item.id)}
															>
																{isRecording ? (
																	<>
																		<span className="shortcut-recorder-btn__dot" aria-hidden="true" />
																		<span className="shortcut-recorder-btn__prompt">
																			{heldPreview.length > 0 ? heldPreview : t("settingsCore.shortcuts.recordingPrompt")}
																		</span>
																	</>
																) : (
																	renderKeycapSequence(currentChord, platform)
																)}
															</button>

															<button
																type="button"
																className={`shortcut-icon-btn${rowUi !== null ? " is-active" : ""}`}
																data-shortcut-ui-edit={item.id}
																title={t("settingsCore.shortcuts.uiEditHint", { name: label })}
																aria-label={t("settingsCore.shortcuts.uiEditHint", { name: label })}
																aria-expanded={rowUi !== null}
																onClick={() => toggleUiEditor(item.id)}
															>
																<SlidersHorizontal size={13} />
															</button>

															{customized ? (
																<button
																	type="button"
																	className="shortcut-icon-btn"
																	data-action={`reset-shortcut-${item.id}`}
																	title={t("settingsCore.shortcuts.resetOneHint", {
																		name: label,
																		shortcut: defaultFormatted,
																	})}
																	aria-label={t("settingsCore.shortcuts.resetOneHint", {
																		name: label,
																		shortcut: defaultFormatted,
																	})}
																	onClick={() => void resetSingleShortcut(item.id)}
																>
																	<RotateCcw size={13} />
																</button>
															) : null}
														</div>
													</div>

													{rowInvalid !== null ? (
														<div className="shortcut-feedback is-warning" role="status">
															<AlertTriangle size={13} aria-hidden="true" />
															<span>{invalidMessage(rowInvalid.reason)}</span>
														</div>
													) : null}

													{rowConflict !== null ? (
														<div className="shortcut-feedback is-conflict" role="alert">
															<div className="shortcut-feedback__text">
																<AlertTriangle size={13} aria-hidden="true" />
																<span>
																	{t("settingsCore.shortcuts.conflictNotice", {
																		shortcut: formatShortcutChord(rowConflict.chord, platform),
																		target: actionLabel(rowConflict.conflictWith),
																	})}
																</span>
															</div>
															<div className="shortcut-feedback__actions">
																<button
																	type="button"
																	className="linear-btn settings-btn-primary shortcut-feedback__btn"
																	data-action="swap-shortcut-conflict"
																	onClick={() => {
																		const swapped = swapShortcutBinding(shortcuts, item.id, rowConflict.chord);
																		setPendingConflict(null);
																		void updateShortcuts(swapped);
																	}}
																>
																	<ArrowLeftRight size={12} aria-hidden="true" />
																	<span>{t("settingsCore.shortcuts.swapConflict")}</span>
																</button>
																<button
																	type="button"
																	className="linear-btn shortcut-feedback__btn"
																	data-action="cancel-shortcut-conflict"
																	onClick={() => setPendingConflict(null)}
																>
																	{t("settingsCore.shortcuts.cancelUi")}
																</button>
															</div>
														</div>
													) : null}

													{rowUi !== null ? (
														<div className="shortcut-ui-editor">
															<div className="shortcut-ui-editor__controls">
																<div className="shortcut-ui-editor__mods" role="group">
																	<button
																		type="button"
																		className={`shortcut-mod-chip${rowUi.mod ? " is-active" : ""}`}
																		data-shortcut-mod="mod"
																		aria-pressed={rowUi.mod}
																		onClick={() => setUiEditor({ ...rowUi, mod: !rowUi.mod })}
																	>
																		{isMac ? "⌘ Cmd" : "Ctrl"}
																	</button>
																	<button
																		type="button"
																		className={`shortcut-mod-chip${rowUi.alt ? " is-active" : ""}`}
																		data-shortcut-mod="alt"
																		aria-pressed={rowUi.alt}
																		onClick={() => setUiEditor({ ...rowUi, alt: !rowUi.alt })}
																	>
																		{isMac ? "⌥ Opt" : "Alt"}
																	</button>
																	<button
																		type="button"
																		className={`shortcut-mod-chip${rowUi.shift ? " is-active" : ""}`}
																		data-shortcut-mod="shift"
																		aria-pressed={rowUi.shift}
																		onClick={() => setUiEditor({ ...rowUi, shift: !rowUi.shift })}
																	>
																		{isMac ? "⇧ Shift" : "Shift"}
																	</button>
																</div>

																<SelectField
																	data-testid="shortcut-key-select"
																	className="shortcut-key-select"
																	value={rowUi.key}
																	options={SELECTABLE_SHORTCUT_KEYS.map((keyOption) => ({ value: keyOption, label: keyOption }))}
																	onValueChange={(key) => setUiEditor({ ...rowUi, key })}
																/>
															</div>

															<div className="shortcut-ui-editor__actions">
																{uiValidation !== null && !uiValidation.ok ? (
																	<span className="shortcut-ui-editor__hint">
																		{invalidMessage(uiValidation.reason)}
																	</span>
																) : uiConflictId !== null && uiValidation !== null && uiValidation.ok ? (
																	<>
																		<span className="shortcut-ui-editor__hint is-conflict">
																			{t("settingsCore.shortcuts.conflictNotice", {
																				shortcut: formatShortcutChord(uiValidation.chord, platform),
																				target: actionLabel(uiConflictId),
																			})}
																		</span>
																		<button
																			type="button"
																			className="linear-btn settings-btn-primary shortcut-feedback__btn"
																			data-action="swap-shortcut-conflict"
																			onClick={() => {
																				const swapped = swapShortcutBinding(shortcuts, item.id, uiValidation.chord);
																				setUiEditor(null);
																				void updateShortcuts(swapped);
																			}}
																		>
																			<ArrowLeftRight size={12} aria-hidden="true" />
																			<span>{t("settingsCore.shortcuts.swapConflict")}</span>
																		</button>
																	</>
																) : (
																	<button
																		type="button"
																		className="linear-btn settings-btn-primary shortcut-feedback__btn"
																		data-action="save-ui-shortcut"
																		disabled={uiValidation === null || !uiValidation.ok}
																		onClick={() => {
																			if (uiValidation !== null && uiValidation.ok) {
																				setUiEditor(null);
																				void applyRecordedChord(item.id, uiValidation.chord);
																			}
																		}}
																	>
																		{t("settingsCore.shortcuts.saveUi")}
																	</button>
																)}
																<button
																	type="button"
																	className="linear-btn shortcut-feedback__btn"
																	data-action="cancel-ui-shortcut"
																	onClick={() => setUiEditor(null)}
																>
																	{t("settingsCore.shortcuts.cancelUi")}
																</button>
															</div>
														</div>
													) : null}
												</div>
											);
										})}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</Section>
		</>
	);
}
