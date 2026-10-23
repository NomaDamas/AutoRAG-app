import {
	IDLE_AUTOMATIONS,
	type AutomationBridge,
	type AutomationRemoval,
	type AutomationRule,
	type AutomationsSnapshot,
} from "../../../shared/automation-contract";
import { t } from "../../../shared/i18n/core";
import { enterKeyLabel } from "../lib/shortcuts";
import type { FinderMenuEntry, FinderMenuItem, MenuTone } from "./context-menu";

/* ------------------------------------------------------------------ list -- */

/**
 * The rule selected after ↑/↓. The list stops at both ends like Finder's, and a
 * selection that no longer exists (a rule deleted elsewhere) starts from the edge
 * the arrow points away from.
 */
export function stepRuleSelection(rules: readonly AutomationRule[], selected: string | null, direction: 1 | -1): string | null {
	if (rules.length === 0) return null;
	const index = rules.findIndex((rule) => rule.id === selected);
	if (index === -1) return (direction === 1 ? rules[0] : rules[rules.length - 1])?.id ?? null;
	return rules[Math.min(rules.length - 1, Math.max(0, index + direction))]?.id ?? null;
}

function menuItem(action: FinderMenuItem["action"], label: string, options: { keycap?: string; tone?: MenuTone } = {}): FinderMenuItem {
	return { kind: "item", action, label, keycap: options.keycap ?? null, tone: options.tone ?? "default", disabled: false };
}

/** The right-click menu of a rule row, or (rule null) of the list's empty space. */
export function ruleMenuEntries(input: {
	readonly rule: AutomationRule | null;
	readonly canOpenFolder: boolean;
	/** Offered from a folder's rule row, where the rules list is not already in view. */
	readonly canReveal?: boolean;
}): FinderMenuEntry[] {
	const add = menuItem("addRule", t("automations.menu.add"));
	if (input.rule === null) return [add];
	return [
		menuItem("quickLook", t("automations.menu.preview"), { keycap: "space" }),
		{ kind: "separator" },
		menuItem("editRule", t("automations.menu.edit"), { keycap: enterKeyLabel() }),
		...(input.canReveal === true ? [menuItem("revealRule", t("automations.menu.reveal"))] : []),
		...(input.canOpenFolder ? [menuItem("openRuleFolder", t("automations.menu.openFolder"))] : []),
		add,
		{ kind: "separator" },
		menuItem("deleteRule", t("automations.menu.delete"), { tone: "danger" }),
	];
}

/* ----------------------------------------------------------------- store -- */

/** What the last delete took out, until the toast that offers to undo it goes away. */
export interface AutomationUndo {
	readonly rule: AutomationRule;
	readonly removal: AutomationRemoval;
}

export interface AutomationsView {
	readonly state: AutomationsSnapshot;
	readonly undo: AutomationUndo | null;
	/** The background service is being switched on or off. */
	readonly daemonBusy: boolean;
}

export interface AutomationsStore {
	subscribe(listener: () => void): () => void;
	getSnapshot(): AutomationsView;
	remove(id: string): Promise<void>;
	undo(): Promise<void>;
	clearUndo(): void;
	setDaemon(enabled: boolean): Promise<void>;
	dispose(): void;
}

/** Electron wraps a handler's error as "Error invoking remote method 'x': Error: <message>"; show only the message. */
export function ipcMessage(cause: unknown): string {
	const text = cause instanceof Error ? cause.message : String(cause);
	return text.replace(/^Error invoking remote method '[^']*': (?:Error: )?/u, "");
}

/**
 * One window-wide copy of the rules, shared by the 자동화 tab, its inspector, and
 * every folder inspector, so a rule deleted in one place disappears from all of them.
 * It listens to the main process only while something is subscribed, and the main
 * process pushes whenever the rules file, a run log, or the daemon changes, including
 * changes the librarian agent made from an AI Search tab.
 */
export function createAutomationsStore(bridge: AutomationBridge | undefined): AutomationsStore {
	let view: AutomationsView = { state: IDLE_AUTOMATIONS, undo: null, daemonBusy: false };
	const listeners = new Set<() => void>();
	let stopListening: (() => void) | null = null;

	const publish = (next: Partial<AutomationsView>): void => {
		view = { ...view, ...next };
		for (const listener of listeners) listener();
	};

	function connect(): void {
		if (bridge === undefined) return;
		stopListening = bridge.onChange((state) => publish({ state }));
		void bridge.get().then(
			(state) => publish({ state }),
			(cause: unknown) => publish({ state: { ...view.state, ready: true, error: ipcMessage(cause) } }),
		);
	}

	return {
		subscribe(listener) {
			if (listeners.size === 0) connect();
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					stopListening?.();
					stopListening = null;
				}
			};
		},
		getSnapshot: () => view,
		async remove(id) {
			if (bridge === undefined) return;
			const rule = view.state.rules.find((candidate) => candidate.id === id);
			try {
				const { snapshot, removal } = await bridge.remove(id);
				publish({ state: snapshot, undo: rule === undefined ? null : { rule, removal } });
			} catch (cause) {
				throw new Error(ipcMessage(cause));
			}
		},
		async undo() {
			const pending = view.undo;
			if (bridge === undefined || pending === null) return;
			publish({ undo: null });
			try {
				publish({ state: await bridge.restore(pending.removal) });
			} catch (cause) {
				throw new Error(ipcMessage(cause));
			}
		},
		clearUndo() {
			if (view.undo !== null) publish({ undo: null });
		},
		async setDaemon(enabled) {
			if (bridge === undefined) return;
			publish({ daemonBusy: true });
			try {
				publish({ state: await bridge.setDaemon(enabled), daemonBusy: false });
			} catch (cause) {
				publish({ daemonBusy: false });
				throw new Error(ipcMessage(cause));
			}
		},
		dispose() {
			stopListening?.();
			stopListening = null;
			listeners.clear();
		},
	};
}
