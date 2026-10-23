import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationRule } from "../../../shared/automation-contract";
import { t } from "../../../shared/i18n/core";
import type { AutomationsViewProps } from "../components/AutomationsView";
import { addPrompt, editPrompt, ruleTitle } from "../state/automations";
import { ruleKeyAction } from "../state/automations-keys";
import { ruleMenuEntries, stepRuleSelection, type AutomationsStore, type AutomationsView } from "../state/automations-store";
import type { FinderMenuAction, FinderMenuEntry } from "../state/context-menu";

/** How long the "삭제했어요 · 실행 취소" toast offers its undo. */
const UNDO_MS = 5000;

export interface AutomationsShellDeps {
	readonly store: AutomationsStore;
	readonly view: AutomationsView;
	/** The focused pane shows the 자동화 tab: only then does the list answer the keyboard. */
	readonly active: boolean;
	/** Open a new AI Search tab with `draft` left in its composer, unsent. */
	readonly openAiDraft: (draft: string) => void;
	/** Open a watched folder in a Finder tab. */
	readonly openFolder: (path: string) => void;
	/** Focus the 자동화 tab (a rule chosen from a folder inspector). */
	readonly showInList: (id: string) => void;
	/** Surface an error the way the window shows one: a toast. */
	readonly onError: (message: string) => void;
}

export interface AutomationsShell {
	/** Everything the list view takes, ready to spread. */
	readonly props: AutomationsViewProps;
	readonly selectedRule: AutomationRule | null;
	readonly preview: AutomationRule | null;
	readonly confirm: AutomationRule | null;
	readonly menu: { readonly cursor: { readonly x: number; readonly y: number }; readonly entries: readonly FinderMenuEntry[] } | null;
	readonly undoToast: { readonly message: string; readonly onUndo: () => Promise<void> } | null;
	/** Edit (AI draft) a rule: shared by the list, Quick Look, and the inspectors. */
	readonly edit: (rule: AutomationRule) => void;
	readonly askDelete: (rule: AutomationRule) => void;
	readonly editFromPreview: () => void;
	readonly closePreview: () => void;
	readonly confirmDelete: () => Promise<void>;
	readonly cancelDelete: () => void;
	readonly menuSelect: (action: FinderMenuAction, format: unknown, serviceId: unknown, tagName: unknown) => void;
	readonly closeMenu: () => void;
	/** A rule row's right-click menu from a folder inspector: adds "show in list". */
	readonly openRuleMenu: (rule: AutomationRule, cursor: { readonly x: number; readonly y: number }) => void;
}

interface MenuState {
	readonly ruleId: string | null;
	readonly cursor: { readonly x: number; readonly y: number };
	readonly fromFolder: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest('[role="menu"]') !== null;
}

/**
 * The 자동화 tab's behaviour: what is selected, Quick Look, the delete confirm and its
 * undo toast, the right-click menu, and the list's own keys. Editing and adding never
 * send anything: they open an AI Search tab with a draft the person finishes.
 */
export function useAutomationsShell(deps: AutomationsShellDeps): AutomationsShell {
	const { store, view, active } = deps;
	const rules = view.state.rules;
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [menuState, setMenuState] = useState<MenuState | null>(null);
	const [undoMessage, setUndoMessage] = useState<string | null>(null);
	const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const latest = useRef(deps);
	latest.current = deps;

	const byId = useCallback((id: string | null): AutomationRule | null => (id === null ? null : (rules.find((rule) => rule.id === id) ?? null)), [rules]);
	// A rule deleted elsewhere (the agent, another window) leaves nothing selected, previewed, or asked about.
	const selectedRule = byId(selectedId);
	const preview = byId(previewId);
	const confirm = byId(confirmId);

	const clearUndoTimer = useCallback(() => {
		clearTimeout(undoTimer.current);
		undoTimer.current = undefined;
	}, []);
	useEffect(() => clearUndoTimer, [clearUndoTimer]);

	const edit = useCallback((rule: AutomationRule) => latest.current.openAiDraft(editPrompt(rule)), []);
	const add = useCallback(() => latest.current.openAiDraft(addPrompt()), []);

	const askDelete = useCallback((rule: AutomationRule) => {
		setMenuState(null);
		setPreviewId(null);
		setConfirmId(rule.id);
	}, []);

	const confirmDelete = useCallback(async () => {
		const rule = byId(confirmId);
		setConfirmId(null);
		if (rule === null) return;
		const index = rules.findIndex((candidate) => candidate.id === rule.id);
		try {
			await store.remove(rule.id);
		} catch (cause) {
			latest.current.onError(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		const left = rules.filter((candidate) => candidate.id !== rule.id);
		setSelectedId((current) => (current === rule.id ? (left[Math.min(index, left.length - 1)]?.id ?? null) : current));
		setPreviewId((current) => (current === rule.id ? null : current));
		setUndoMessage(t("automations.toast.deleted", { title: ruleTitle(rule) }));
		clearUndoTimer();
		undoTimer.current = setTimeout(() => {
			undoTimer.current = undefined;
			setUndoMessage(null);
			store.clearUndo();
		}, UNDO_MS);
	}, [byId, confirmId, rules, store, clearUndoTimer]);

	const undo = useCallback(async () => {
		const restored = store.getSnapshot().undo?.rule.id ?? null;
		clearUndoTimer();
		setUndoMessage(null);
		try {
			await store.undo();
		} catch (cause) {
			latest.current.onError(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		if (restored !== null) setSelectedId(restored);
	}, [store, clearUndoTimer]);

	const closeMenu = useCallback(() => setMenuState(null), []);

	const menuRule = byId(menuState?.ruleId ?? null);
	const menu =
		menuState === null
			? null
			: {
					cursor: menuState.cursor,
					entries: ruleMenuEntries({ rule: menuRule, canOpenFolder: menuRule !== null, canReveal: menuState.fromFolder }),
				};

	const menuSelect = useCallback(
		(action: FinderMenuAction) => {
			const rule = byId(menuState?.ruleId ?? null);
			setMenuState(null);
			switch (action) {
				case "quickLook":
					if (rule !== null) {
						setSelectedId(rule.id);
						setPreviewId(rule.id);
					}
					return;
				case "editRule":
					if (rule !== null) edit(rule);
					return;
				case "addRule":
					add();
					return;
				case "deleteRule":
					if (rule !== null) askDelete(rule);
					return;
				case "openRuleFolder": {
					const folder = rule?.paths[0];
					if (folder !== undefined) latest.current.openFolder(folder);
					return;
				}
				case "revealRule":
					if (rule !== null) {
						setSelectedId(rule.id);
						latest.current.showInList(rule.id);
					}
					return;
				default:
					return;
			}
		},
		[add, askDelete, byId, edit, menuState],
	);

	// The list owns its keys while its tab is focused; every layer above it takes Escape first.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			const target = event.target;
			if (target instanceof HTMLElement && target.tagName === "BUTTON" && (event.key === "Enter" || event.key === " ")) return;
			const overlay = confirmId !== null ? "confirm" : menuState !== null ? "menu" : previewId !== null ? "preview" : "none";
			const action = ruleKeyAction(
				{ key: event.key, meta: event.metaKey || event.ctrlKey, shift: event.shiftKey, alt: event.altKey },
				{ typing: isTypingTarget(target), overlay, hasSelection: selectedRule !== null },
			);
			// While another tab has the focus only Escape is answered, to close a menu or confirm the folder inspector opened.
			if (action === null || (!active && action.type !== "dismiss")) return;
			event.preventDefault();
			switch (action.type) {
				case "step": {
					const next = stepRuleSelection(rules, selectedId, action.direction);
					setSelectedId(next);
					// Like Finder, an open Quick Look follows the selection.
					if (previewId !== null && next !== null) setPreviewId(next);
					return;
				}
				case "preview":
					setPreviewId((current) => (current === null ? selectedId : null));
					return;
				case "edit":
					if (selectedRule !== null) edit(selectedRule);
					return;
				case "delete":
					if (selectedRule !== null) askDelete(selectedRule);
					return;
				case "dismiss":
					if (confirmId !== null) setConfirmId(null);
					else if (menuState !== null) setMenuState(null);
					else setPreviewId(null);
					return;
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [active, askDelete, confirmId, edit, menuState, previewId, rules, selectedId, selectedRule]);

	// Quick Look belongs to the list tab. A menu or confirm may have been opened from a folder inspector, so they stay.
	useEffect(() => {
		if (!active) setPreviewId(null);
	}, [active]);

	const props: AutomationsViewProps = {
		state: view.state,
		daemonBusy: view.daemonBusy,
		selectedId: selectedRule?.id ?? null,
		onSelect: setSelectedId,
		onEdit: (id) => {
			const rule = byId(id);
			if (rule !== null) edit(rule);
		},
		onAdd: add,
		onPreview: (id) => {
			setSelectedId(id);
			setPreviewId(id);
		},
		onAskDelete: (id) => {
			const rule = byId(id);
			if (rule !== null) askDelete(rule);
		},
		onSetDaemon: (enabled) => {
			store.setDaemon(enabled).catch((cause: unknown) => latest.current.onError(cause instanceof Error ? cause.message : String(cause)));
		},
		onContextMenu: (id, cursor) => {
			// Like Finder, a right click selects its row first, so the menu and the inspector speak about the same rule.
			if (id !== null) setSelectedId(id);
			setMenuState({ ruleId: id, cursor, fromFolder: false });
		},
		onOpenFolder: (path) => latest.current.openFolder(path),
	};

	return {
		props,
		selectedRule,
		preview,
		confirm,
		menu,
		undoToast: undoMessage === null ? null : { message: undoMessage, onUndo: undo },
		edit,
		askDelete,
		editFromPreview: () => {
			const rule = byId(previewId);
			setPreviewId(null);
			if (rule !== null) edit(rule);
		},
		closePreview: () => setPreviewId(null),
		confirmDelete,
		cancelDelete: () => setConfirmId(null),
		menuSelect,
		closeMenu,
		openRuleMenu: (rule, cursor) => setMenuState({ ruleId: rule.id, cursor, fromFolder: true }),
	};
}
