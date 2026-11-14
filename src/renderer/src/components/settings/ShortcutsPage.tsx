import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeftRight, Lock, RotateCcw, Search, X } from "lucide-react";
import dazziMark from "../../assets/dazzi-mark.png";
import type { AppSettings, SettingsBridge } from "../../../../shared/settings-contract";
import {
	activeShortcutPreset,
	chordFromKeyEvent,
	findShortcutConflict,
	formatShortcutChord,
	normalizeShortcutSettings,
	resolveEffectiveShortcuts,
	SHORTCUT_CATALOG,
	shortcutChordParts,
	shortcutSettingsForPreset,
	swapShortcutBinding,
	type ShortcutCatalogItem,
	type ShortcutGroupId,
	type ShortcutId,
	type ShortcutInvalidReason,
	type ShortcutSettings,
} from "../../../../shared/shortcuts-contract";
import { hostPlatform } from "../../lib/shortcuts";
import { SettingsPageHead } from "./SettingsKit";
import { cn } from "../../lib/cn";
import { buttonClass } from "../primitives/button";

type ShortcutsBridgeWindow = Window & {
	readonly autorag?: {
		readonly settings?: Pick<SettingsBridge, "set">;
	};
};

function getSettingsWriter(): Pick<SettingsBridge, "set"> | undefined {
	return (window as ShortcutsBridgeWindow).autorag?.settings;
}

const GROUP_ORDER: readonly ShortcutGroupId[] = ["window", "view", "files", "aiSearch"];


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
	const [changedOnly, setChangedOnly] = useState(false);

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

	/**
	 * Clicking the keycaps starts recording (Figma 445:2249): the keycaps wait for keys, and the chord pressed is
	 * applied at once, with no picker and no 저장. Esc, a click elsewhere or the same keycaps again stops it.
	 */
	const startRecording = (id: ShortcutId): void => {
		setPendingConflict(null);
		setInvalidNotice(null);
		setHeldMods({ mod: false, alt: false, shift: false });
		setRecordingId((current) => (current === id ? null : id));
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
			if (changedOnly && effective[item.id] === item.defaultChord) continue;
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
	}, [normalizedQuery, actionLabel, effective, platform, changedOnly]);

	const showLockedDismiss =
		!changedOnly &&
		(normalizedQuery.length === 0 ||
		t("settingsCore.shortcuts.actions.dismiss").toLowerCase().includes(normalizedQuery) ||
		"esc".includes(normalizedQuery) ||
		"escape".includes(normalizedQuery));

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

			{/* Figma 445:2249: 빠른 구성 (the platform presets as a segmented control, reset and the changed-only filter), the search, then one bordered card per group. */}
			<div className="shortcuts-page">
				<div className="shortcuts-quick">
					<span className="shortcuts-quick-label">{t("settingsCore.shortcuts.presetsTitle")}</span>
					<div className="shortcuts-quick-row">
						<div className="shortcuts-segmented" role="group" aria-label={t("settingsCore.shortcuts.presetsTitle")} data-shortcut-presets>
							<button
								type="button"
								className={cn("shortcuts-segment", activePreset === "macFinder" && "is-active")}
								data-action="shortcuts-preset-mac-finder"
								aria-pressed={activePreset === "macFinder"}
								onClick={() => applyPreset("macFinder")}
							>
								{t("settingsCore.shortcuts.presetMacFinder")}
							</button>
							<button
								type="button"
								className={cn("shortcuts-segment", activePreset === "windowsExplorer" && "is-active")}
								data-action="shortcuts-preset-windows-explorer"
								aria-pressed={activePreset === "windowsExplorer"}
								onClick={() => applyPreset("windowsExplorer")}
							>
								{t("settingsCore.shortcuts.presetWindowsExplorer")}
							</button>
						</div>
						<div className="shortcuts-quick-actions">
							<button
								type="button"
								className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
								data-action="shortcuts-preset-default"
								disabled={activePreset === "default"}
								onClick={() => applyPreset("default")}
							>
								{t("settingsCore.shortcuts.resetAll")}
							</button>
							<button
								type="button"
								className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn", changedOnly && "is-active")}
								data-action="shortcuts-changed-only"
								aria-pressed={changedOnly}
								disabled={!changedOnly && customizedCount === 0}
								onClick={() => setChangedOnly((value) => !value)}
							>
								{t("settingsCore.shortcuts.changedOnly", { count: customizedCount })}
							</button>
						</div>
					</div>
					<label className="shortcuts-search">
						<Search size={14} strokeWidth={1.5} className="shortcuts-search__icon" aria-hidden="true" />
						<input
							type="text"
							data-testid="shortcuts-filter-input"
							className="shortcuts-search__input"
							value={filterQuery}
							placeholder={t("settingsCore.shortcuts.filterPlaceholder")}
							aria-label={t("settingsCore.shortcuts.filterPlaceholder")}
							onChange={(event) => setFilterQuery(event.target.value)}
						/>
						{filterQuery.length > 0 ? (
							<button
								type="button"
								className="shortcuts-search__clear"
								data-action="clear-shortcuts-filter"
								aria-label={t("common.close")}
								onClick={() => setFilterQuery("")}
							>
								<X size={12} />
							</button>
						) : null}
					</label>
				</div>

				{totalMatching === 0 ? (
					<p className="shortcuts-empty">{t("settingsCore.shortcuts.filterEmpty")}</p>
				) : (
					GROUP_ORDER.map((groupId) => {
						const items = groupedItems[groupId];
						const includeLocked = groupId === "window" && showLockedDismiss;
						if (items.length === 0 && !includeLocked) return null;
						return (
							<section key={groupId} className="shortcuts-group" data-shortcut-group={groupId}>
								<h3 className="shortcuts-group-title">{t(`settingsCore.shortcuts.groups.${groupId}`)}</h3>
								<div className="shortcuts-card">
									{includeLocked ? (
										<div className="shortcuts-row is-locked" data-shortcut-row="dismiss" title={t("settingsCore.shortcuts.lockedHint")}>
											<span className="shortcuts-row-name">{t("settingsCore.shortcuts.actions.dismiss")}</span>
											<Lock size={14} strokeWidth={1.5} className="shortcuts-row-lock" aria-label={t("settingsCore.shortcuts.lockedBadge")} />
											<span className="shortcuts-row-spacer" />
											<span className="shortcuts-keycaps is-locked" aria-disabled="true">
												<kbd className="shortcut-keycap">Esc</kbd>
											</span>
										</div>
									) : null}

									{items.map((item) => {
										const label = actionLabel(item.id);
										const currentChord = effective[item.id];
										const currentFormatted = formatShortcutChord(currentChord, platform);
										const defaultFormatted = formatShortcutChord(item.defaultChord, platform);
										const customized = currentChord !== item.defaultChord;
										const isRecording = recordingId === item.id;
										const rowConflict = pendingConflict?.id === item.id ? pendingConflict : null;
										const rowInvalid = invalidNotice?.id === item.id ? invalidNotice : null;
										const held = isRecording ? heldMods : { mod: false, alt: false, shift: false };
										const heldParts = [held.mod ? (isMac ? "⌘" : "Ctrl") : null, held.alt ? (isMac ? "⌥" : "Alt") : null, held.shift ? (isMac ? "⇧" : "Shift") : null].filter(
											(part): part is string => part !== null,
										);

										return (
											<div key={item.id} className={cn("shortcuts-row-wrap", customized && "is-customized")} data-shortcut-row={item.id}>
												<div className="shortcuts-row">
													<span className="shortcuts-row-name">{label}</span>
													{customized ? <span className="shortcuts-badge">{t("settingsCore.shortcuts.customizedBadge")}</span> : null}
													<span className="shortcuts-row-spacer" />
													{customized ? (
														<button
															type="button"
															className="shortcuts-reset"
															data-action={`reset-shortcut-${item.id}`}
															title={t("settingsCore.shortcuts.resetOneHint", { name: label, shortcut: defaultFormatted })}
															aria-label={t("settingsCore.shortcuts.resetOneHint", { name: label, shortcut: defaultFormatted })}
															onClick={() => void resetSingleShortcut(item.id)}
														>
															<RotateCcw size={14} strokeWidth={1.5} />
														</button>
													) : null}
													<button
														type="button"
														className={cn("shortcuts-keycaps", isRecording && "is-editing")}
														data-shortcut-record={item.id}
														title={t("settingsCore.shortcuts.recordButtonHint", { shortcut: currentFormatted })}
														aria-label={t("settingsCore.shortcuts.recordButtonHint", { shortcut: currentFormatted })}
														aria-pressed={isRecording}
														onClick={() => startRecording(item.id)}
													>
														{isRecording ? (
															<span className="shortcut-keycap-seq is-recording" aria-live="polite">
																{heldParts.map((part, idx) => (
																	<span key={part} className="shortcut-keycap-piece">
																		{!isMac && idx > 0 ? <span className="shortcut-keycap-plus">+</span> : null}
																		<kbd className="shortcut-keycap">{part}</kbd>
																	</span>
																))}
																<span className="shortcuts-recording-prompt">{t("settingsCore.shortcuts.recorderPrompt")}</span>
															</span>
														) : (
															renderKeycapSequence(currentChord, platform)
														)}
													</button>
												</div>

												{rowInvalid !== null ? (
													<div className="shortcuts-feedback is-warning" role="status">
														<AlertTriangle size={13} aria-hidden="true" />
														<span>{invalidMessage(rowInvalid.reason)}</span>
													</div>
												) : null}

												{rowConflict !== null ? (
													<div className="shortcuts-feedback is-conflict" role="alert">
														<AlertTriangle size={13} aria-hidden="true" />
														<span className="shortcuts-feedback-text">
															{t("settingsCore.shortcuts.conflictNotice", {
																shortcut: formatShortcutChord(rowConflict.chord, platform),
																target: actionLabel(rowConflict.conflictWith),
															})}
														</span>
														<button
															type="button"
															className={cn(buttonClass({ size: "sm" }), "shortcuts-outline-btn")}
															data-action="cancel-shortcut-conflict"
															onClick={() => setPendingConflict(null)}
														>
															{t("settingsCore.shortcuts.cancelUi")}
														</button>
														<button
															type="button"
															className={cn(buttonClass({ size: "sm" }), "shortcuts-primary-btn")}
															data-action="swap-shortcut-conflict"
															onClick={() => {
																const swapped = swapShortcutBinding(shortcuts, item.id, rowConflict.chord);
																setPendingConflict(null);
																void updateShortcuts(swapped);
															}}
														>
															<ArrowLeftRight aria-hidden="true" />
															{t("settingsCore.shortcuts.swapConflict")}
														</button>
													</div>
												) : null}
											</div>
										);
									})}
								</div>
							</section>
						);
					})
				)}
			</div>
		</>
	);
}
