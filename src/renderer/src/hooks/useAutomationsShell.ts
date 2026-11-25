import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomationRule } from "../../../shared/automation-contract";
import { t } from "../../../shared/i18n/core";
import type { AutomationsViewProps } from "../components/AutomationsView";
import { addPrompt, ruleTitle } from "../state/automations";
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
	/** The names people gave their rules; passed so the list redraws when one changes. */
	readonly names?: Readonly<Record<string, string>>;
	/**
	 * Turn the background service on by itself when there are rules and it is off (the desktop window). The phone
	 * layout keeps its own switch and leaves this off, so a person who switched it off there is not overruled.
	 */
	readonly autoStartService?: boolean;
	/** Store a rule's name (an empty one goes back to the derived title). */
	readonly renameRule?: (id: string, name: string) => Promise<void>;
	/** The 채팅 half of the AI 에이전트 tab's segment. */
	readonly showChat?: () => void;
	/** 새 자동화 and 말로 만들기: bring the AI chat column up to make a rule in words. */
	readonly talk?: () => void;
}

export interface AutomationsShell {
	/** Everything the list view takes, ready to spread. */
	readonly props: AutomationsViewProps;
	readonly selectedRule: AutomationRule | null;
	/** The rule the 새 자동화 card is making, for the inspector while nothing is picked. */
	readonly draft: AutomationRule | null;
	readonly preview: AutomationRule | null;
	readonly confirm: AutomationRule | null;
	readonly menu: { readonly cursor: { readonly x: number; readonly y: number }; readonly entries: readonly FinderMenuEntry[] } | null;
	/** While the confirmed delete runs, the toast reads 삭제 중… with no undo (`onUndo` null); then the undo toast. */
	readonly undoToast: { readonly message: string; readonly onUndo: (() => Promise<void>) | null; readonly busy?: boolean } | null;
	/** The toast's close button: the delete stands, the undo is gone. */
	readonly dismissUndoToast: () => void;
	/** Edit (AI draft) a rule: shared by the list, Quick Look, and the inspectors. */
	readonly edit: (rule: AutomationRule) => void;
	readonly askDelete: (rule: AutomationRule) => void;
	readonly editFromPreview: () => void;
	readonly closePreview: () => void;
	readonly confirmDelete: () => Promise<void>;
	readonly cancelDelete: () => void;
	/** The confirmed delete is running: the confirm stays up and reads 삭제 중… until it is done. */
	readonly deleting: boolean;
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
	const [draft, setDraft] = useState<AutomationRule | null>(null);
	// The rule 수정 put in the 새 자동화 card; null while the card makes a new one.
	const [editingId, setEditingId] = useState<string | null>(null);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	// The 삭제 중… toast, shown while the delete runs; the window stays usable meanwhile (no modal over it).
	const [deletingMessage, setDeletingMessage] = useState<string | null>(null);
	// Making or saving a rule says so in the toast (만드는 중… → 만들었습니다), not on the card's button, so the window stays free.
	const [progress, setProgress] = useState<{ readonly message: string; readonly busy: boolean } | null>(null);
	const progressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const showProgress = useCallback((message: string, busy: boolean) => {
		clearTimeout(progressTimer.current);
		setProgress({ message, busy });
		if (!busy) progressTimer.current = setTimeout(() => setProgress(null), UNDO_MS);
	}, []);
	const clearProgress = useCallback(() => {
		clearTimeout(progressTimer.current);
		setProgress(null);
	}, []);
	const [menuState, setMenuState] = useState<MenuState | null>(null);
	const [undoMessage, setUndoMessage] = useState<string | null>(null);
	const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const latest = useRef(deps);
	latest.current = deps;

	// No rule runs while the service is off, so the window turns it on once there is something to run: once per
	// launch, so a failure (shown as a toast) or a later 끄기 is not fought over.
	const autoStarted = useRef(false);
	const daemon = view.state.daemon;
	useEffect(() => {
		if (deps.autoStartService !== true || autoStarted.current || view.daemonBusy) return;
		if (!view.state.ready || rules.length === 0 || daemon === null || daemon.running === true) return;
		autoStarted.current = true;
		store.setDaemon(true).catch((cause: unknown) => latest.current.onError(cause instanceof Error ? cause.message : String(cause)));
	}, [deps.autoStartService, view.state.ready, rules.length, daemon?.running, daemon === null, view.daemonBusy]);

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

	// 수정 opens the rule's own page in the 자동화 tab, wherever it was asked from (the list, the inspectors, Quick Look, a menu).
	const edit = useCallback((rule: AutomationRule) => {
		setMenuState(null);
		setPreviewId(null);
		setEditingId(rule.id);
		setSelectedId(rule.id);
		latest.current.showInList(rule.id);
	}, []);
	const add = useCallback(() => latest.current.openAiDraft(addPrompt()), []);

	const askDelete = useCallback((rule: AutomationRule) => {
		setMenuState(null);
		setPreviewId(null);
		setConfirmId(rule.id);
	}, []);

	const confirmDelete = useCallback(async () => {
		const rule = byId(confirmId);
		setConfirmId(null);
		if (rule === null || deleting) return;
		const index = rules.findIndex((candidate) => candidate.id === rule.id);
		// A rule deleted from its own page leaves for the list at once, not when the CLI has finished removing it.
		const leftItsPage = editingId === rule.id;
		if (leftItsPage) setEditingId(null);
		setDeleting(true);
		clearUndoTimer();
		setUndoMessage(null);
		setDeletingMessage(t("automations.toast.deleting", { title: ruleTitle(rule) }));
		try {
			await store.remove(rule.id);
		} catch (cause) {
			// Not deleted after all: back to the page it was deleted from.
			if (leftItsPage) setEditingId(rule.id);
			latest.current.onError(cause instanceof Error ? cause.message : String(cause));
			return;
		} finally {
			setDeleting(false);
			setDeletingMessage(null);
		}
		const left = rules.filter((candidate) => candidate.id !== rule.id);
		// A rule deleted from its own page leaves for the list.
		setEditingId((current) => (current === rule.id ? null : current));
		setSelectedId((current) => (current === rule.id ? (left[Math.min(index, left.length - 1)]?.id ?? null) : current));
		setPreviewId((current) => (current === rule.id ? null : current));
		setUndoMessage(t("automations.toast.deleted", { title: ruleTitle(rule) }));
		clearUndoTimer();
		undoTimer.current = setTimeout(() => {
			undoTimer.current = undefined;
			setUndoMessage(null);
			store.clearUndo();
		}, UNDO_MS);
	}, [byId, confirmId, deleting, editingId, rules, store, clearUndoTimer]);

	const dismissUndoToast = useCallback(() => {
		setDeletingMessage(null);
		clearTimeout(progressTimer.current);
		setProgress(null);
		clearUndoTimer();
		setUndoMessage(null);
		store.clearUndo();
	}, [store, clearUndoTimer]);

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
	}, [active, askDelete, confirmId, deleting, edit, menuState, previewId, rules, selectedId, selectedRule]);

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
		onShowChat: () => latest.current.showChat?.(),
		onTalk: () => latest.current.talk?.(),
		onCreate: async (draft) => {
			showProgress(t("automations.toast.creating"), true);
			try {
				const id = await store.create(draft);
				if (id !== null) setSelectedId(id);
				if (id !== null) showProgress(t("automations.toast.created"), false);
				else clearProgress();
				return id !== null;
			} catch (cause) {
				clearProgress();
				latest.current.onError(cause instanceof Error ? cause.message : String(cause));
				return false;
			}
		},
		editing: byId(editingId),
		onUpdate: async (id, next) => {
			showProgress(t("automations.toast.saving"), true);
			try {
				const ok = await store.update(id, next);
				// Saving keeps the rule's page open: its 실행 기록 is right under the card.
				if (ok) setSelectedId(id);
				if (ok) showProgress(t("automations.toast.saved"), false);
				else clearProgress();
				return ok;
			} catch (cause) {
				clearProgress();
				latest.current.onError(cause instanceof Error ? cause.message : String(cause));
				return false;
			}
		},
		onCancelEdit: () => setEditingId(null),
		names: deps.names ?? {},
		onRename: async (id, name) => {
			try {
				await latest.current.renameRule?.(id, name);
			} catch (cause) {
				latest.current.onError(cause instanceof Error ? cause.message : String(cause));
			}
		},
		onDraftChange: (next) => {
			setDraft(next);
			// Making a rule takes the inspector over from the one picked.
			if (next !== null) setSelectedId(null);
		},
		onPreview: (id) => {
			setSelectedId(id);
			setPreviewId(id);
		},
		onAskDelete: (id) => {
			const rule = byId(id);
			if (rule !== null) askDelete(rule);
		},
		onRetryStatus: () => {
			void store.reload();
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
		draft,
		preview,
		confirm,
		menu,
		undoToast:
			deletingMessage !== null
				? { message: deletingMessage, onUndo: null, busy: true }
				: progress !== null
					? { message: progress.message, onUndo: null, busy: progress.busy }
					: undoMessage === null
						? null
						: { message: undoMessage, onUndo: undo },
		dismissUndoToast,
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
		deleting,
		menuSelect,
		closeMenu,
		openRuleMenu: (rule, cursor) => setMenuState({ ruleId: rule.id, cursor, fromFolder: true }),
	};
}
